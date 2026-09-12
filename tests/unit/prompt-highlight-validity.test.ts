// @vitest-environment jsdom
//
// jsdom for the same reason prompt-highlight-color.test.ts needs it: everything
// asserted here runs inside `applyHighlight`'s try/catch, and under the suite's
// default `node` environment a `document.createElement` throw there is
// indistinguishable from "the decoration was never registered".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { applyHighlight, buildNeedle, forgetSurface, openMarkAt } from '../../src/renderer/utils/prompt-marks';

/**
 * The highlight has to keep meaning what it claims (issue #230).
 *
 * A band says "the prompt is on these rows". A marker only says "this buffer
 * line". For a shell those are the same sentence; for an agent TUI repainting
 * its input box and spinner over the same lines they are not, and the reported
 * symptom was the default blue band sitting on `✳ Germinating… (1m 15s)`.
 *
 * So the fake here models the one thing the older fakes could not: rows whose
 * CONTENT changes under a live decoration, and a renderer that fires `onRender`
 * again afterwards — which is exactly what a TUI plus xterm do together.
 */
interface FakeDecoration {
  options: Record<string, unknown>;
  element: HTMLElement;
  disposed: boolean;
  render(): void;
  onRender(cb: (el: HTMLElement) => void): void;
  dispose(): void;
}

function fakeTerminal(rows: string[]) {
  const decorations: FakeDecoration[] = [];
  const state = { baseY: 0, cursorY: rows.length - 1 };
  const term = {
    rows: 24,
    cols: 80,
    options: { theme: { background: '#1e1e1e' } },
    buffer: {
      active: {
        get baseY() { return state.baseY; },
        get cursorY() { return state.cursorY; },
        get cursorX() { return 0; },
        getLine: (y: number) => (rows[y] === undefined
          ? undefined
          : { translateToString: () => rows[y] }),
      },
    },
    registerMarker(offset: number) {
      return {
        line: state.baseY + state.cursorY + offset,
        isDisposed: false,
        dispose() { this.isDisposed = true; },
      };
    },
    registerDecoration(options: Record<string, unknown>): FakeDecoration {
      const callbacks: ((el: HTMLElement) => void)[] = [];
      const decoration: FakeDecoration = {
        options,
        element: document.createElement('div'),
        disposed: false,
        render() { for (const cb of callbacks) cb(this.element); },
        onRender(cb) { callbacks.push(cb); },
        dispose() { this.disposed = true; },
      };
      decorations.push(decoration);
      return decoration;
    },
  };
  return { term: term as unknown as Terminal, decorations, rows };
}

const SURFACE = 'surf-230';
const PROMPT = 'fix the flaky pty-manager test';

/** The rows an agent pane looks like: transcript above, live TUI region below. */
function agentRows() {
  return [
    'welcome to the agent',
    `> ${PROMPT}`,
    '  reading pty-manager.ts…',
    '✳ Germinating… (1m 15s · ↓ 4.1k tokens)',
  ];
}

/** The last decoration registered — the one `applyHighlight` just made. */
function latest(decorations: FakeDecoration[]): FakeDecoration | undefined {
  return decorations[decorations.length - 1];
}

const live = (decorations: FakeDecoration[]) => decorations.filter((d) => !d.disposed);

beforeEach(() => forgetSurface(SURFACE));
afterEach(() => vi.useRealTimers());

describe('a band is only painted on a row that carries the prompt', () => {
  it('tints the row the prompt was echoed on', () => {
    const { term, decorations } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 1);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: true, needle: buildNeedle(PROMPT), confirmed: false,
    });
    expect(latest(decorations)?.options.backgroundColor).toBeTruthy();
  });

  // The reported bug, reduced: the mark stayed on the submit-time cursor, which
  // for an agent is inside the region its TUI repaints.
  it('does NOT tint the spinner row the mark was left on', () => {
    const { term, decorations } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 3); // the spinner row
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: true, needle: buildNeedle(PROMPT), confirmed: false,
    });
    expect(latest(decorations)?.options.backgroundColor).toBeUndefined();
  });

  // Dropping the tint must not drop the tick: a tick claims "the prompt is
  // somewhere around here", which is still true, and losing it would make the
  // fix read as the workaround (highlighting switched off).
  it('keeps the overview-ruler tick when the tint is withheld', () => {
    const { term, decorations } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 3);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: true, needle: buildNeedle(PROMPT), confirmed: false,
    });
    expect(latest(decorations)?.options.overviewRulerOptions).toBeTruthy();
  });

  it('registers nothing at all when there is neither a tint nor a tick to draw', () => {
    const { term, decorations } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 3);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: false, needle: buildNeedle(PROMPT), confirmed: false,
    });
    expect(decorations).toHaveLength(0);
  });

  // The needle is whitespace-collapsed on the way in; the row has to be
  // collapsed on the way out or a prompt that is verbatim on screen misses.
  it('matches a row whose spacing the program re-wrapped', () => {
    const { term, decorations } = fakeTerminal(['│  git   status   --short  │']);
    openMarkAt(term, SURFACE, 'e1', 0);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: false, needle: buildNeedle('git status --short'), confirmed: false,
    });
    expect(latest(decorations)?.options.backgroundColor).toBeTruthy();
  });

  it('looks across every row the band covers, not only the first', () => {
    const { term, decorations } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 0); // band spans rows 0-2; the prompt is on 1
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 3, ruler: false, needle: buildNeedle(PROMPT), confirmed: false,
    });
    expect(latest(decorations)?.options.backgroundColor).toBeTruthy();
  });
});

describe('a prompt with nothing distinctive to check falls back to its source', () => {
  // `buildNeedle` refuses anything under MIN_NEEDLE, so "yes" is uncheckable —
  // and for an agent an uncheckable row is a guess sitting in the repaint zone.
  it('withholds the tint for a short AGENT prompt', () => {
    const { term, decorations } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 3);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: true, needle: buildNeedle('yes'), confirmed: false,
    });
    expect(latest(decorations)?.options.backgroundColor).toBeUndefined();
  });

  // A shell's row came from OSC 133 and is never rewritten once it is in
  // scrollback, so the same uncheckable prompt keeps its band.
  it('still tints a short SHELL prompt', () => {
    const { term, decorations } = fakeTerminal(['PS C:\\repo> ls', '']);
    openMarkAt(term, SURFACE, 'e1', 0);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: true, needle: buildNeedle('ls'), confirmed: true,
    });
    expect(latest(decorations)?.options.backgroundColor).toBeTruthy();
  });

  // Pre-#230 callers pass neither field and must be unaffected.
  it('tints when the caller supplies no needle and no verdict', () => {
    const { term, decorations } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 3);
    applyHighlight(term, SURFACE, 'e1', { color: '#6ea8ff', rows: 1, ruler: false });
    expect(latest(decorations)?.options.backgroundColor).toBeTruthy();
  });
});

describe('a band that stops carrying its prompt lets go', () => {
  it('drops the tint once the TUI has repainted the row', () => {
    vi.useFakeTimers();
    const { term, decorations, rows } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 1);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: true, needle: buildNeedle(PROMPT), confirmed: false,
    });
    const first = latest(decorations)!;
    expect(first.options.backgroundColor).toBeTruthy();

    // xterm re-renders a visible decoration; the row it sits on has meanwhile
    // been overwritten by the agent's status line.
    rows[1] = '✳ Germinating… (2m 03s · ↓ 5.4k tokens)';
    first.render();

    // Disposal is deferred out of xterm's render pass on purpose — it is
    // iterating its decoration list at that moment.
    expect(first.disposed).toBe(false);
    vi.runAllTimers();

    expect(first.disposed).toBe(true);
    const remaining = live(decorations);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].options.backgroundColor).toBeUndefined();
    expect(remaining[0].options.overviewRulerOptions).toBeTruthy();
  });

  // The replacement registers no `onRender`, so the re-apply cannot re-arm
  // itself. Without that the pair would trade places forever at render speed.
  it('settles after one re-apply instead of looping', () => {
    vi.useFakeTimers();
    const { term, decorations, rows } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 1);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: true, needle: buildNeedle(PROMPT), confirmed: false,
    });
    rows[1] = 'something else entirely';
    latest(decorations)!.render();
    vi.runAllTimers();

    const settled = latest(decorations)!;
    settled.render();
    vi.runAllTimers();
    expect(decorations).toHaveLength(2);
    expect(settled.disposed).toBe(false);
  });

  // A decoration re-rendering at PTY speed must queue one re-apply, not one per
  // frame — issue #141's shape.
  it('queues a single re-apply however many times the row re-renders', () => {
    vi.useFakeTimers();
    const { term, decorations, rows } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 1);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: true, needle: buildNeedle(PROMPT), confirmed: false,
    });
    rows[1] = 'repainted';
    const first = latest(decorations)!;
    for (let i = 0; i < 20; i++) first.render();
    vi.runAllTimers();
    expect(decorations).toHaveLength(2);
  });

  // The row coming back is not a case that happens in practice, but the check
  // is a plain content test and must not be sticky — a decoration whose row
  // still reads right keeps its band however often it is rendered.
  it('leaves a still-correct band alone', () => {
    vi.useFakeTimers();
    const { term, decorations } = fakeTerminal(agentRows());
    openMarkAt(term, SURFACE, 'e1', 1);
    applyHighlight(term, SURFACE, 'e1', {
      color: '#6ea8ff', rows: 1, ruler: true, needle: buildNeedle(PROMPT), confirmed: false,
    });
    const first = latest(decorations)!;
    for (let i = 0; i < 5; i++) first.render();
    vi.runAllTimers();
    expect(decorations).toHaveLength(1);
    expect(first.disposed).toBe(false);
    expect(first.element.classList.contains('wmux-prompt-mark')).toBe(true);
  });
});
