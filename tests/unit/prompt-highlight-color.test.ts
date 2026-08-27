// @vitest-environment jsdom
//
// The suite default is `node`, and it has to stay that way — almost everything
// here is main-process logic. But this file asserts on real DOM elements, and
// under `node` the fake's `document.createElement` throws INSIDE
// `applyHighlight`'s try/catch, so every assertion fails as "no decoration was
// ever registered" — the same symptom a genuine bug produces.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { applyHighlight, forgetSurface, openMarkAt } from '../../src/renderer/utils/prompt-marks';

/**
 * The highlight COLOUR path (issue #207 follow-up).
 *
 * prompt-marks.test.ts's fake answers `registerDecoration` with
 * `{ onRender() {}, dispose() {} }` — a stub that never invokes its callback. So
 * everything `applyHighlight` actually paints with (the class, and the custom
 * property carrying the user's colour) has never once run under test, which is
 * how "the rail is always grey" shipped.
 *
 * This fake models what xterm really does instead: it keeps the callback, and
 * the renderer fires it — repeatedly, with the SAME element for a given
 * decoration, exactly as `BufferDecorationRenderer._refreshStyle` does.
 */
interface FakeDecoration {
  options: Record<string, unknown>;
  element: HTMLElement;
  disposed: boolean;
  render(): void;
  onRender(cb: (el: HTMLElement) => void): void;
  dispose(): void;
}

function fakeTerminal(background: string | undefined = '#1e1e1e') {
  const decorations: FakeDecoration[] = [];
  const state = { baseY: 0, cursorY: 4 };
  const term = {
    rows: 24,
    cols: 80,
    options: { theme: { background } },
    buffer: {
      active: {
        get baseY() { return state.baseY; },
        get cursorY() { return state.cursorY; },
        get cursorX() { return 0; },
        getLine: () => ({ translateToString: () => 'a prompt' }),
      },
    },
    registerMarker(offset: number) {
      return { line: state.baseY + state.cursorY + offset, isDisposed: false, dispose() { this.isDisposed = true; } };
    },
    registerDecoration(options: Record<string, unknown>): FakeDecoration {
      const callbacks: ((el: HTMLElement) => void)[] = [];
      const decoration: FakeDecoration = {
        options,
        element: document.createElement('div'),
        disposed: false,
        render() { for (const cb of callbacks) cb(this.element); },
        onRender(cb) { callbacks.push(cb); },
        dispose() { this.disposed = true; this.element.remove(); },
      };
      decorations.push(decoration);
      return decoration;
    },
  };
  return { term: term as unknown as Terminal, decorations };
}

const SURFACE = 'surf-color';

beforeEach(() => forgetSurface(SURFACE));

describe('applyHighlight paints the configured colour', () => {
  it('puts the class and the colour on the decoration element', () => {
    const { term, decorations } = fakeTerminal();
    openMarkAt(term, SURFACE, 'e1', 2);

    applyHighlight(term, SURFACE, 'e1', { color: '#ff2d55', rows: 2, ruler: true });
    decorations[0].render();

    const el = decorations[0].element;
    expect(el.classList.contains('wmux-prompt-mark')).toBe(true);
    expect(el.style.getPropertyValue('--wmux-prompt-color')).toBe('#ff2d55');
  });

  /**
   * The regression itself. The tint has to reach the RENDERER, because the DOM
   * element it used to live on paints over the glyphs — which forced an alpha so
   * low that every hue came out the same grey.
   *
   * Pre-blended and opaque because xterm's renderers ignore the alpha channel on
   * a decoration background: `#ff2d5540` and `#ff2d55` paint identically.
   */
  it('hands the renderer an opaque tint blended into the terminal background', () => {
    const { term, decorations } = fakeTerminal('#1e1e1e');
    openMarkAt(term, SURFACE, 'e1', 2);

    applyHighlight(term, SURFACE, 'e1', { color: '#ff2d55', rows: 1, ruler: false });

    // 26% of #ff2d55 over #1e1e1e.
    expect(decorations[0].options.backgroundColor).toBe('#59222c');
  });

  it('mixes into whatever background the theme actually has', () => {
    const { term, decorations } = fakeTerminal('#ffffff');
    openMarkAt(term, SURFACE, 'e1', 2);

    applyHighlight(term, SURFACE, 'e1', { color: '#ff2d55', rows: 1, ruler: false });

    // The same colour over a light theme must land somewhere else entirely.
    expect(decorations[0].options.backgroundColor).toBe('#ffc8d3');
  });

  it('reads a translucent background (issue #89) by dropping its alpha', () => {
    const { term, decorations } = fakeTerminal('rgba(30, 30, 30, 0.6)');
    openMarkAt(term, SURFACE, 'e1', 2);

    applyHighlight(term, SURFACE, 'e1', { color: '#ff2d55', rows: 1, ruler: false });

    // Same answer as the opaque #1e1e1e above: the alpha is dropped, not honoured.
    expect(decorations[0].options.backgroundColor).toBe('#59222c');
  });

  /**
   * The degrade path: no parseable background means no blend, so the old
   * over-the-glyphs tint is switched back on — and it must NEVER be on at the
   * same time as a renderer tint, or the two double up.
   */
  it('falls back to the CSS tint only when it cannot blend', () => {
    const unparseable = fakeTerminal('var(--nope)');
    openMarkAt(unparseable.term, SURFACE, 'e1', 2);
    applyHighlight(unparseable.term, SURFACE, 'e1', { color: '#ff2d55', rows: 1, ruler: false });
    unparseable.decorations[0].render();

    expect(unparseable.decorations[0].options.backgroundColor).toBeUndefined();
    expect(unparseable.decorations[0].element.classList.contains('wmux-prompt-mark--css-tint')).toBe(true);

    forgetSurface(SURFACE);
    const normal = fakeTerminal('#1e1e1e');
    openMarkAt(normal.term, SURFACE, 'e2', 2);
    applyHighlight(normal.term, SURFACE, 'e2', { color: '#ff2d55', rows: 1, ruler: false });
    normal.decorations[0].render();

    expect(normal.decorations[0].element.classList.contains('wmux-prompt-mark--css-tint')).toBe(false);
  });

  it('carries the colour to the overview ruler tick', () => {
    const { term, decorations } = fakeTerminal();
    openMarkAt(term, SURFACE, 'e1', 2);

    applyHighlight(term, SURFACE, 'e1', { color: '#ff2d55', rows: 1, ruler: true });

    expect(decorations[0].options.overviewRulerOptions)
      .toEqual({ color: '#ff2d55', position: 'left' });
  });

  /**
   * The user-visible bug: changing the colour in Settings must repaint. A
   * re-applied highlight has to reach the element with the NEW colour, not leave
   * the old decoration's element on screen.
   */
  it('repaints with a new colour when the preference changes', () => {
    const { term, decorations } = fakeTerminal();
    openMarkAt(term, SURFACE, 'e1', 2);

    applyHighlight(term, SURFACE, 'e1', { color: '#6ea8ff', rows: 1, ruler: true });
    decorations[0].render();

    applyHighlight(term, SURFACE, 'e1', { color: '#ff2d55', rows: 1, ruler: true });
    decorations[1].render();

    expect(decorations[0].disposed).toBe(true);
    expect(decorations[1].element.style.getPropertyValue('--wmux-prompt-color')).toBe('#ff2d55');
  });
});
