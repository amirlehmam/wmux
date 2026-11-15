/**
 * terminal-keys.ts — key decisions that are easier to reason about (and test)
 * outside the 800-line terminal effect.
 */

/** ESC+CR: what Alt/Option+Enter produces, and what TUI apps read as "newline". */
export const SHIFT_ENTER_SEQUENCE = '\x1b\r';

/** The subset of KeyboardEvent this module looks at. */
export interface TerminalKeyEvent {
  type: string;
  key: string;
  /** The physical key, e.g. 'KeyC'. Unlike `key`, it does not vary by layout. */
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

/**
 * True when `event` is the physical key for `letter`.
 *
 * event.key is the character the key produces, so on a non-Latin layout
 * Ctrl+C arrives as key === 'с' (Cyrillic) and never matches 'c'. event.code
 * is the physical key and is layout-independent, so it fixes every non-Latin
 * layout at once.
 *
 * event.key is still checked first: on Dvorak / Colemak the user presses the
 * key that *shows* C, which is a different physical key, and matching code
 * alone would break them.
 *
 * The compare ignores case, and says nothing about Shift. Case is not Shift:
 * Caps Lock uppercases event.key with no Shift held (Ctrl+V arrives as 'V'),
 * and Caps Lock + Shift lowercases it again (Ctrl+Shift+V arrives as 'v').
 * Reading Shift off the case made Ctrl+V type a raw ^V and Ctrl+Shift+V paste
 * twice whenever Caps Lock was on (#453). Callers that care about Shift ask
 * `isBareCtrlLetter`, which reads the modifier flags.
 */
export function isLetterKey(event: TerminalKeyEvent, letter: string, code: string): boolean {
  if (event.key.toLowerCase() === letter) return true;
  return event.code === code && !/^[a-z]$/i.test(event.key);
}

/**
 * A keydown of Ctrl+`letter` and nothing else: no Shift, Alt or Meta.
 *
 * The terminal's own Ctrl+C (copy) and Ctrl+V (paste) branches use this, so
 * the modified combos stay with whoever owns them: Ctrl+Shift+V is the
 * configurable `paste` shortcut, and claiming it here as well pasted twice
 * (#453); Ctrl+Alt is AltGr on Windows and produces characters.
 */
export function isBareCtrlLetter(event: TerminalKeyEvent, letter: string, code: string): boolean {
  return event.type === 'keydown'
    && event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && !event.metaKey
    && isLetterKey(event, letter, code);
}

/**
 * Shift+Enter must insert a newline instead of submitting: xterm sends a plain
 * \r for both Enter and Shift+Enter, so a TUI can't tell them apart.
 *
 * Ctrl/Alt/Meta are excluded so Ctrl+Shift+Enter (zoom pane) still reaches the
 * global shortcut handler.
 */
export function isShiftEnter(event: TerminalKeyEvent): boolean {
  return (
    event.type === 'keydown' &&
    event.key === 'Enter' &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

/**
 * Emit the Shift+Enter newline, cancelling the DOM event on the way out.
 *
 * The preventDefault is the entire fix for issue #119 and is easy to drop as
 * "redundant": returning false from xterm's custom key handler makes _keyDown
 * bail, but it does not cancel the event, so the browser goes on to fire
 * `keypress` — and xterm's _keyPress sends Enter's charCode 13 as a second,
 * plain \r. The app received our newline *and* xterm's, which is the blank line
 * users saw after every Shift+Enter. Cancelling keydown suppresses the keypress
 * that produced the duplicate.
 *
 * Returns false, the "xterm should not handle this" value, so callers can
 * `return handleShiftEnter(...)`.
 */
export function handleShiftEnter(
  event: TerminalKeyEvent,
  emit: (data: string) => void,
): false {
  event.preventDefault();
  emit(SHIFT_ENTER_SEQUENCE);
  return false;
}
