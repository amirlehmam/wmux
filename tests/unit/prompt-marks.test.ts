import { describe, it, expect, beforeEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  __markCount,
  forgetSurface,
  jumpTo,
  lineOf,
  lineResolver,
  lineText,
  openMark,
  openMarkAt,
  readRange,
  reconcile,
  refineMark,
} from '../../src/renderer/utils/prompt-marks';

/**
 * A terminal stand-in that models the two xterm behaviours this module is built
 * on: a marker knows its own line, and a marker DISPOSES ITSELF (reporting
 * line -1) once its row is trimmed out of the scrollback.
 */
interface FakeMarker { line: number; dispose(): void; isDisposed: boolean }

function fakeTerminal(rows: string[], cursorLine = rows.length - 1) {
  const markers: FakeMarker[] = [];
  const state = { baseY: 0, cursorY: cursorLine, cursorX: 0 };
  const term = {
    rows: 24,
    cols: 80,
    buffer: {
      active: {
        ...state,
        get baseY() { return state.baseY; },
        get cursorY() { return state.cursorY; },
        get cursorX() { return state.cursorX; },
        getLine: (y: number) => (rows[y] === undefined
          ? undefined
          : { translateToString: () => rows[y] }),
      },
    },
    registerMarker(offset: number): FakeMarker {
      const marker: FakeMarker = {
        line: state.baseY + state.cursorY + offset,
        isDisposed: false,
        dispose() { this.isDisposed = true; },
      };
      markers.push(marker);
      return marker;
    },
    registerDecoration() { return { onRender() {}, dispose() {} }; },
    scrollToLine(line: number) { scrolled.push(line); },
    __markers: markers,
  };
  const scrolled: number[] = [];
  return { term: term as unknown as Terminal, markers, scrolled, state };
}

const ROWS = [
  'PS C:\\repo> npm test',
  '  ok 1',
  '  ok 2',
  'PS C:\\repo> fix the flaky pty-manager test   ',
  '',
];

beforeEach(() => {
  for (const id of ['surf-a', 'surf-b', 'surf-c']) forgetSurface(id);
});

describe('lineText and readRange', () => {
  it('reads a single row', () => {
    const { term } = fakeTerminal(ROWS);
    expect(lineText(term, 1)).toBe('  ok 1');
  });

  it('answers empty for a row the buffer does not have', () => {
    const { term } = fakeTerminal(ROWS);
    expect(lineText(term, 99)).toBe('');
  });

  it('joins an inclusive range and trims the trailing blanks', () => {
    const { term } = fakeTerminal(ROWS);
    expect(readRange(term, 1, 4)).toBe('  ok 1\n  ok 2\nPS C:\\repo> fix the flaky pty-manager test');
  });

  it('answers empty for an inverted or nonsense range', () => {
    const { term } = fakeTerminal(ROWS);
    expect(readRange(term, 3, 1)).toBe('');
    expect(readRange(term, Number.NaN, 2)).toBe('');
  });
});

describe('openMark / lineOf / jumpTo', () => {
  it('marks the cursor line and reports it back', () => {
    const { term } = fakeTerminal(ROWS, 3);
    expect(openMark(term, 'surf-a', 'surf-a:1')).toBe(3);
    expect(lineOf('surf-a', 'surf-a:1')).toBe(3);
  });

  it('marks a line resolved earlier — the shell path, which learns the row at 133;A', () => {
    const { term } = fakeTerminal(ROWS, 4);
    expect(openMarkAt(term, 'surf-a', 'surf-a:1', 1)).toBe(1);
    expect(lineOf('surf-a', 'surf-a:1')).toBe(1);
  });

  // A marker reports -1 once its row leaves the scrollback. That must surface as
  // "not jumpable", never as line 0 — a confidently wrong jump is worse than
  // a disabled one.
  it('reports null, not 0, once the marker has been trimmed away', () => {
    const { term, markers } = fakeTerminal(ROWS, 3);
    openMark(term, 'surf-a', 'surf-a:1');
    markers[0].line = -1;
    expect(lineOf('surf-a', 'surf-a:1')).toBeNull();
    expect(jumpTo(term, 'surf-a', 'surf-a:1')).toBeNull();
  });

  it('jumpTo scrolls to the mark and returns the line', () => {
    const { term, scrolled } = fakeTerminal(ROWS, 3);
    openMark(term, 'surf-a', 'surf-a:1');
    expect(jumpTo(term, 'surf-a', 'surf-a:1')).toBe(3);
    expect(scrolled).toEqual([3]);
  });

  it('jumpTo answers null for a mark that was never opened', () => {
    const { term } = fakeTerminal(ROWS);
    expect(jumpTo(term, 'surf-a', 'nope')).toBeNull();
  });
});

describe('lineResolver', () => {
  // The anchor holds a resolver rather than a number, so it tracks the row
  // through scrollback trimming and lets go when the prompt is gone.
  it('tracks the marker and answers null once it dies', () => {
    const { term, markers } = fakeTerminal(ROWS, 3);
    openMark(term, 'surf-a', 'surf-a:1');
    const resolve = lineResolver('surf-a', 'surf-a:1');
    expect(resolve()).toBe(3);
    markers[0].line = 7;
    expect(resolve()).toBe(7);
    markers[0].line = -1;
    expect(resolve()).toBeNull();
  });
});

describe('refineMark', () => {
  it('moves the mark onto the row where the prompt was echoed', () => {
    const { term } = fakeTerminal(ROWS, 0);
    openMark(term, 'surf-a', 'surf-a:1');           // lands on row 0
    const moved = refineMark(term, 'surf-a', 'surf-a:1', 'fix the flaky pty-manager test');
    expect(moved).toBe(3);
    expect(lineOf('surf-a', 'surf-a:1')).toBe(3);
  });

  // Matching a short prompt against a screen of output finds the wrong row
  // confidently, which is worse than not moving at all.
  it('refuses to search on a needle too short to be distinctive', () => {
    const { term } = fakeTerminal(ROWS, 0);
    openMark(term, 'surf-a', 'surf-a:1');
    expect(refineMark(term, 'surf-a', 'surf-a:1', 'ok')).toBe(0);
  });

  it('keeps the original line when nothing matches', () => {
    const { term } = fakeTerminal(ROWS, 0);
    openMark(term, 'surf-a', 'surf-a:1');
    expect(refineMark(term, 'surf-a', 'surf-a:1', 'something never printed here')).toBe(0);
  });

  it('is a no-op for an unknown mark', () => {
    const { term } = fakeTerminal(ROWS);
    expect(refineMark(term, 'surf-a', 'nope', 'fix the flaky pty-manager test')).toBeNull();
  });
});

describe('reconcile', () => {
  // The store bounds itself; the registry does not. A live marker costs
  // something on every trimmed line, so the two have to stay in step.
  it('disposes marks the store no longer lists', () => {
    const { term, markers } = fakeTerminal(ROWS, 3);
    openMark(term, 'surf-a', 'surf-a:1');
    openMark(term, 'surf-a', 'surf-a:2');
    openMark(term, 'surf-a', 'surf-a:3');
    expect(__markCount('surf-a')).toBe(3);

    reconcile({ 'surf-a': [{ id: 'surf-a:2' }, { id: 'surf-a:3' }] });
    expect(__markCount('surf-a')).toBe(2);
    expect(markers[0].isDisposed).toBe(true);
    expect(markers[1].isDisposed).toBe(false);
    expect(lineOf('surf-a', 'surf-a:1')).toBeNull();
    expect(lineOf('surf-a', 'surf-a:2')).toBe(3);
  });

  it('drops a whole surface the store has evicted', () => {
    const { term } = fakeTerminal(ROWS, 3);
    openMark(term, 'surf-a', 'surf-a:1');
    openMark(term, 'surf-b', 'surf-b:1');
    reconcile({ 'surf-b': [{ id: 'surf-b:1' }] });
    expect(__markCount('surf-a')).toBe(0);
    expect(__markCount('surf-b')).toBe(1);
  });

  it('keeps everything when the store still lists it', () => {
    const { term } = fakeTerminal(ROWS, 3);
    openMark(term, 'surf-a', 'surf-a:1');
    reconcile({ 'surf-a': [{ id: 'surf-a:1' }] });
    expect(__markCount('surf-a')).toBe(1);
  });

  it('is a no-op when the registry is empty', () => {
    expect(() => reconcile({ 'surf-z': [{ id: 'surf-z:1' }] })).not.toThrow();
  });
});

describe('forgetSurface', () => {
  it('disposes every marker and empties the surface', () => {
    const { term, markers } = fakeTerminal(ROWS, 3);
    openMark(term, 'surf-a', 'surf-a:1');
    openMark(term, 'surf-a', 'surf-a:2');
    forgetSurface('surf-a');
    expect(__markCount('surf-a')).toBe(0);
    expect(markers.every((m) => m.isDisposed)).toBe(true);
  });

  it('is safe for a surface that was never marked', () => {
    expect(() => forgetSurface('surf-never')).not.toThrow();
  });
});
