// ─── IME composition: show WHERE in the composition the IME is (#301) ────────
//
// xterm draws an in-progress composition as `textContent = ev.data` inside
// `.composition-view`, styled `background:#000; color:#FFF` by its own CSS. One
// flat block: with Microsoft Bopomofo the user moves through a multi-character
// phrase with ←/→ and picks candidates with ↓, and nothing on screen says which
// character they are on. conhost and every native text field show it.
//
// What the page can actually know is the textarea's SELECTION. Chromium applies
// the IME's own selection range to the editable on every composition update,
// so inside the composed text it is either a caret (Bopomofo, Hangul) or a
// range (an IME that selects its target clause). That is what this draws: a
// caret, or the selected range highlighted, over an underlined composition —
// the conhost look.
//
// What it deliberately does NOT draw is a guessed "target character". The clause
// attributes TSF hands Chromium (thick underline = the clause being converted)
// reach a web page only through EditContext's `textformatupdate`, and xterm
// types through a plain textarea. Highlighting "the character after the caret"
// would be right for some IMEs and wrong for others, and a wrong highlight
// points the user at a character they are not converting — worse than the flat
// block it replaces. A caret is the IME's own report; a guess is not.
//
// The split is pure (`compositionSegments`) so the part that decides what is
// shown is testable without a DOM or an IME; `installCompositionClauses` is the
// thin impure half.
//
// Verified against real xterm in Electron's Chromium with CDP
// `Input.imeSetComposition`, which only lands after a real
// `Input.dispatchMouseEvent` click on the webview: a DOM `focus()` plus focus
// emulation is not widget focus.

/** What the composition view shows: text around an optional caret or range. */
export interface CompositionSegments {
  before: string;
  /** The IME's selected range. Empty when the selection is a caret. */
  active: string;
  after: string;
  /** True when the selection is a caret, drawn between `before` and `after`. */
  caret: boolean;
}

/**
 * Split the composed text around the textarea selection.
 *
 * `start` is where the composition begins in the textarea's value; the
 * selection offsets are absolute positions in that same value. Returns null
 * — draw the plain text, the way xterm would — when the selection does not
 * lie inside the composition, because then it is not a report about the
 * composition at all and anything drawn from it would be invented.
 */
export function compositionSegments(
  text: string,
  start: number,
  selectionStart: number,
  selectionEnd: number,
): CompositionSegments | null {
  if (!text) return null;
  const from = Math.min(selectionStart, selectionEnd) - start;
  const to = Math.max(selectionStart, selectionEnd) - start;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from < 0 || to > text.length) return null;
  return {
    before: text.slice(0, from),
    active: text.slice(from, to),
    after: text.slice(to),
    caret: from === to,
  };
}

/** The colours the view is painted with, read off the terminal's live theme. */
export interface CompositionColors {
  foreground: string;
  background: string;
  cursor: string;
  selection: string;
}

export interface CompositionSource {
  textarea: HTMLTextAreaElement;
  view: HTMLElement;
  /** True while xterm is composing; nothing is drawn otherwise. */
  isComposing(): boolean;
  /** Where the current composition starts in `textarea.value`. */
  compositionStart(): number;
  colors(): CompositionColors;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * Redraw xterm's composition view with the caret or selected clause visible.
 *
 * xterm resets the view's `textContent` itself on every `compositionupdate`,
 * BEFORE Chromium has written the new text and selection into the textarea.
 * So the redraw is driven by what follows the DOM update — `input`,
 * `selectionchange`, `keyup` — plus a 0 ms timer after `compositionupdate`,
 * which also covers an update that changed only the selection and fired no
 * `input`. Every redraw is idempotent, so the overlap costs nothing.
 *
 * Returns the disposer.
 */
export function installCompositionClauses(source: CompositionSource): () => void {
  const { textarea, view } = source;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const render = (): void => {
    if (!source.isComposing()) return;
    const start = source.compositionStart();
    const text = textarea.value.substring(start);
    const segments = compositionSegments(text, start, textarea.selectionStart, textarea.selectionEnd);
    const c = source.colors();
    view.style.color = c.foreground;
    view.style.background = c.background;
    view.style.setProperty('--wmux-ime-cursor', c.cursor);
    view.style.setProperty('--wmux-ime-selection', c.selection);
    if (!segments) {
      // Not a report about the composition: show the text, nothing on it.
      if (view.textContent !== text) view.textContent = text;
      return;
    }
    view.replaceChildren(
      span('wmux-ime__text', segments.before),
      segments.caret
        ? span('wmux-ime__caret', '')
        : span('wmux-ime__text wmux-ime__text--active', segments.active),
      span('wmux-ime__text', segments.after),
    );
  };

  const later = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; render(); }, 0);
  };
  const onDocumentSelection = (): void => {
    if (document.activeElement === textarea) render();
  };

  textarea.addEventListener('compositionupdate', later);
  textarea.addEventListener('input', render);
  textarea.addEventListener('keyup', render);
  // Chromium fires `selectionchange` at the textarea itself (M127+) and at the
  // document; listening to both costs one idempotent redraw.
  textarea.addEventListener('selectionchange', render);
  document.addEventListener('selectionchange', onDocumentSelection);

  return () => {
    if (timer !== null) clearTimeout(timer);
    textarea.removeEventListener('compositionupdate', later);
    textarea.removeEventListener('input', render);
    textarea.removeEventListener('keyup', render);
    textarea.removeEventListener('selectionchange', render);
    document.removeEventListener('selectionchange', onDocumentSelection);
  };
}

/** The slice of an xterm theme the composition view is painted with. */
interface ThemeLike {
  foreground?: string;
  background?: string;
  cursor?: string;
  selectionBackground?: string;
}

/** Theme colours with xterm's own fallbacks, read at draw time so a theme switch applies. */
export function compositionColors(theme: ThemeLike | undefined): CompositionColors {
  const t = theme ?? {};
  const foreground = t.foreground ?? '#ffffff';
  return {
    foreground,
    background: t.background ?? '#000000',
    cursor: t.cursor ?? foreground,
    selection: t.selectionBackground ?? 'rgba(128, 128, 128, 0.5)',
  };
}

/**
 * The xterm adapter: wires `installCompositionClauses` to a live terminal.
 *
 * Reads two PRIVATE fields of xterm's CompositionHelper (`_compositionView`,
 * `_compositionPosition`), the same ones the Hangul finalize patch beside the
 * call site already depends on — so an xterm upgrade that renames them breaks
 * both in one place. A helper without a view installs nothing.
 */
export function installXtermCompositionClauses(
  terminal: { options: { theme?: ThemeLike } },
  helper: any, // xterm's private CompositionHelper
  textarea: HTMLTextAreaElement,
): () => void {
  const view: HTMLElement | null = helper?._compositionView ?? null;
  if (!view) return () => {};
  return installCompositionClauses({
    textarea,
    view,
    isComposing: () => helper.isComposing === true,
    compositionStart: () => helper._compositionPosition?.start ?? 0,
    colors: () => compositionColors(terminal.options.theme),
  });
}
