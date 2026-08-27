import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  ANCHOR_EVENT,
  anchorAt,
  anchorFor,
  canAnchor,
  handleScroll,
  isEngaged,
  forgetSurface,
  release,
  releaseAll,
  __holdNow,
  __resetAnchors,
  type AnchorEventDetail,
} from '../../src/renderer/utils/prompt-anchor';

/**
 * A terminal stand-in with just the surface prompt-anchor touches — plus, and
 * this is the whole point of it, xterm's REAL scroll semantics.
 *
 * The first version of these tests passed against a fake whose `scrollToLine`
 * moved the viewport anywhere it was asked, and that is exactly why they missed
 * the defect that made the feature do nothing (#207 review): real xterm cannot
 * scroll below `baseY`, and it snaps the viewport back to the bottom on every
 * write until something has actually scrolled it away. Both are modelled here.
 */
interface FakeTerminal extends Terminal {
  /** Simulate xterm appending `n` lines of output past the bottom of the buffer. */
  __write(n: number): void;
  __scrolledToBottom: number;
  __state: { type: string; baseY: number; cursorY: number; viewportY: number };
  /** Set by scrollToLine, exactly as xterm's BufferService does. */
  __isUserScrolling: boolean;
  __onScroll: (() => void) | null;
}

function fakeTerminal(over: { type?: 'normal' | 'alternate'; rows?: number } = {}): FakeTerminal {
  /** Total lines used in the buffer; baseY and cursorY are derived from it. */
  let lines = 1;
  const state = { type: over.type ?? 'normal', baseY: 0, cursorY: 0, viewportY: 0 };
  const term = {
    rows: over.rows ?? 24,
    cols: 80,
    buffer: { active: state },
    __state: state,
    __isUserScrolling: false,
    __onScroll: null as (() => void) | null,
    __scrolledToBottom: 0,
    scrollToLine(line: number) {
      // xterm clamps to the bottom and, crucially, treats a scroll to or past
      // the bottom as "not user scrolling" — which is what let the first
      // implementation's anchor die on the next write.
      if (line >= state.baseY) {
        this.__isUserScrolling = false;
        state.viewportY = state.baseY;
        return;
      }
      this.__isUserScrolling = true;
      state.viewportY = line;
    },
    scrollToBottom() {
      this.__scrolledToBottom++;
      this.__isUserScrolling = false;
      state.viewportY = state.baseY;
    },
    /**
     * Append `n` lines the way xterm does: the screen fills FIRST, and only
     * once it is full does `baseY` start growing. Modelling that matters —
     * "the prompt is still on the last screen" is precisely the state the
     * armed-but-not-engaged rule exists for, and a fake that grows baseY from
     * line one can never reach it.
     */
    __write(n: number) {
      lines += n;
      state.baseY = Math.max(0, lines - this.rows);
      state.cursorY = lines - state.baseY - 1;
      if (!this.__isUserScrolling) state.viewportY = state.baseY;
      this.__onScroll?.();
    },
  };
  return term as unknown as FakeTerminal;
}

let events: AnchorEventDetail[] = [];

beforeEach(() => {
  __resetAnchors();
  events = [];
  const target = new EventTarget();
  target.addEventListener(ANCHOR_EVENT, (e: Event) =>
    events.push((e as CustomEvent<AnchorEventDetail>).detail));
  vi.stubGlobal('document', target);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  __resetAnchors();
  vi.unstubAllGlobals();
});

/** Resolver for a prompt sitting permanently at `line`. */
const at = (line: number) => () => line;

describe('canAnchor', () => {
  it('accepts the normal buffer and refuses the alt buffer', () => {
    expect(canAnchor(fakeTerminal())).toBe(true);
    expect(canAnchor(fakeTerminal({ type: 'alternate' }))).toBe(false);
  });
});

describe('arming vs engaging', () => {
  // THE REGRESSION TEST. A prompt is submitted at the bottom of the buffer, so
  // there is nothing to hold yet; the old code anchored anyway and then released
  // itself on the first line of output, so the feature never held anything.
  it('stays armed but not engaged while the prompt is still on the last screen', () => {
    const term = fakeTerminal({ rows: 24 });
    expect(anchorAt(term, 'surf-a', at(0))).toBe(true);
    expect(isEngaged('surf-a')).toBe(false);
    expect(events.filter((e) => e.active)).toEqual([]);
  });

  it('survives output that scrolls the viewport, and engages once there is something to hold', () => {
    const term = fakeTerminal({ rows: 24 });
    anchorAt(term, 'surf-a', at(0));

    term.__onScroll = () => handleScroll(term, 'surf-a');
    term.__write(10);                 // still on the first screen
    __holdNow(term, 'surf-a');
    expect(anchorFor('surf-a')).not.toBeNull();
    expect(isEngaged('surf-a')).toBe(false);

    term.__write(30);                 // now the buffer has grown past the anchor
    __holdNow(term, 'surf-a');
    expect(isEngaged('surf-a')).toBe(true);
    expect(term.__state.viewportY).toBe(0);
    expect(term.__isUserScrolling).toBe(true);
    expect(anchorFor('surf-a')?.pending).toBe(40 - 23);
  });

  it('keeps holding across further writes once engaged', () => {
    const term = fakeTerminal({ rows: 24 });
    anchorAt(term, 'surf-a', at(0));
    term.__onScroll = () => handleScroll(term, 'surf-a');
    term.__write(50);
    __holdNow(term, 'surf-a');
    term.__write(50);
    __holdNow(term, 'surf-a');
    expect(isEngaged('surf-a')).toBe(true);
    expect(term.__state.viewportY).toBe(0);
    expect(anchorFor('surf-a')?.pending).toBe(100 - 23);
  });

  it('refuses the alt buffer and a resolver with nothing to point at', () => {
    expect(anchorAt(fakeTerminal({ type: 'alternate' }), 'surf-a', at(5))).toBe(false);
    expect(anchorAt(fakeTerminal(), 'surf-a', () => null)).toBe(false);
    expect(anchorFor('surf-a')).toBeNull();
  });
});

describe('the line resolver', () => {
  // An absolute line stops meaning the same row once the scrollback trims, so
  // the anchor asks each time instead of caching one.
  it('follows the prompt as the resolver reports it moving', () => {
    const term = fakeTerminal({ rows: 24 });
    let row = 0;
    anchorAt(term, 'surf-a', () => row);
    term.__write(60);
    __holdNow(term, 'surf-a');
    expect(term.__state.viewportY).toBe(0);
    row = 12;                          // e.g. the buffer trimmed and the marker moved
    __holdNow(term, 'surf-a');
    expect(term.__state.viewportY).toBe(12);
  });

  it('releases when the prompt leaves the scrollback entirely', () => {
    const term = fakeTerminal({ rows: 24 });
    let row: number | null = 0;
    anchorAt(term, 'surf-a', () => row);
    term.__write(60);
    __holdNow(term, 'surf-a');
    row = null;
    __holdNow(term, 'surf-a');
    expect(anchorFor('surf-a')).toBeNull();
  });
});

describe('handleScroll', () => {
  // The rule the whole feature turns on: scrolling DOWN through an answer must
  // not cancel the anchor, or it is useless for the case it exists for.
  it('keeps the anchor when the user scrolls but is not caught up', () => {
    const term = fakeTerminal({ rows: 24 });
    anchorAt(term, 'surf-a', at(0));
    term.__write(200);
    __holdNow(term, 'surf-a');

    term.__state.viewportY = 50;
    handleScroll(term, 'surf-a');
    expect(anchorFor('surf-a')).not.toBeNull();
    // It follows the user rather than yanking them back to the prompt...
    expect(anchorFor('surf-a')?.line).toBe(50);
    // ...and from here the user's choice wins over the resolver.
    __holdNow(term, 'surf-a');
    expect(term.__state.viewportY).toBe(50);
  });

  it('releases once the user scrolls back to the bottom', () => {
    const term = fakeTerminal({ rows: 24 });
    anchorAt(term, 'surf-a', at(0));
    term.__write(200);
    __holdNow(term, 'surf-a');

    term.__state.viewportY = 200;
    handleScroll(term, 'surf-a');
    expect(anchorFor('surf-a')).toBeNull();
    expect(events.at(-1)).toEqual({ surfaceId: 'surf-a', active: false, pending: 0 });
  });

  it('ignores a scroll while merely armed — that is xterm following output', () => {
    const term = fakeTerminal({ rows: 24 });
    anchorAt(term, 'surf-a', at(0));
    term.__onScroll = () => handleScroll(term, 'surf-a');
    term.__write(1);
    expect(anchorFor('surf-a')).not.toBeNull();
  });

  it('is a no-op for an unanchored surface', () => {
    expect(() => handleScroll(fakeTerminal(), 'surf-never')).not.toThrow();
  });
});

describe('release, releaseAll and forgetSurface', () => {
  it('release scrolls to the bottom when given a terminal', () => {
    const term = fakeTerminal();
    anchorAt(term, 'surf-a', at(0));
    release('surf-a', term);
    expect(term.__scrolledToBottom).toBe(1);
    expect(anchorFor('surf-a')).toBeNull();
  });

  it('release works without a terminal, for teardown paths', () => {
    anchorAt(fakeTerminal(), 'surf-a', at(0));
    expect(() => release('surf-a')).not.toThrow();
    expect(anchorFor('surf-a')).toBeNull();
  });

  // Switching the preference off must free panes that are ALREADY held —
  // otherwise the user is left looking at a frozen viewport with a pill on it
  // and nothing in the panel they just used to explain it.
  it('releaseAll frees every held pane and returns each to the bottom', () => {
    const a = fakeTerminal();
    const b = fakeTerminal();
    anchorAt(a, 'surf-a', at(0));
    anchorAt(b, 'surf-b', at(0));
    a.__write(100); __holdNow(a, 'surf-a');
    b.__write(100); __holdNow(b, 'surf-b');

    releaseAll((id) => (id === 'surf-a' ? a : b));
    expect(anchorFor('surf-a')).toBeNull();
    expect(anchorFor('surf-b')).toBeNull();
    expect(a.__scrolledToBottom).toBe(1);
    expect(b.__scrolledToBottom).toBe(1);
  });

  it('announces nothing when there was no anchor to release', () => {
    events = [];
    release('surf-never');
    forgetSurface('surf-never');
    releaseAll(() => undefined);
    expect(events).toEqual([]);
  });

  it('forgetSurface drops the anchor and announces the release', () => {
    anchorAt(fakeTerminal(), 'surf-a', at(0));
    events = [];
    forgetSurface('surf-a');
    expect(anchorFor('surf-a')).toBeNull();
    expect(events).toEqual([{ surfaceId: 'surf-a', active: false, pending: 0 }]);
  });

  it('releases an anchor whose terminal has switched to the alt buffer', () => {
    const term = fakeTerminal();
    anchorAt(term, 'surf-a', at(0));
    term.__write(100);
    __holdNow(term, 'surf-a');
    expect(isEngaged('surf-a')).toBe(true);
    term.__state.type = 'alternate';
    __holdNow(term, 'surf-a');
    expect(anchorFor('surf-a')).toBeNull();
  });
});
