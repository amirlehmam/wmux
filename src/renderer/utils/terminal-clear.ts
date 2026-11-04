import type { Terminal } from '@xterm/xterm';
import { rebaseForClear } from './prompt-log';

/**
 * Clear terminal buffer (#434): drop the scrollback and the screen, keep the
 * cursor's row, and leave the PTY and the prompt log agreeing with what is left.
 *
 * Three things have to move together, in this order:
 *
 *   1. The prompt log, while the buffer still has the coordinates it describes.
 *      A prompt the shell is still waiting on is re-based, not forgotten, or the
 *      command typed right after the clear never reaches the log.
 *   2. ConPTY's own screen copy (`pty.clear`). Without it ConPTY still believes
 *      the cursor is on the old bottom row and echoes the next keystroke there
 *      with an absolute CUP, over the emptied screen.
 *   3. xterm itself.
 *
 * On the alternate screen it does nothing: that screen has no scrollback, and
 * the full-screen program drawing on it owns every row (the same reasoning as
 * Reset terminal state, #357). Returns whether it cleared.
 */
export function clearTerminalBuffer(
  terminal: Terminal,
  surfaceId: string,
  ptyId: string | null,
  clearPty: ((id: string) => void) | undefined,
): boolean {
  if (terminal.buffer.active.type !== 'normal') return false;
  rebaseForClear(terminal, surfaceId);
  if (ptyId && clearPty) clearPty(ptyId);
  terminal.clear();
  return true;
}
