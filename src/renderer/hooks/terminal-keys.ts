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
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
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
