/**
 * Close-window guard (issue #227): "ask before the red × takes every session
 * down with it".
 *
 * The workspace guard (#90, `confirmWorkspaceClose`) protects one session from
 * a stray click on the sidebar ×. Nothing protected the WINDOW: the caption's
 * × — or Alt+F4, or a mis-aimed click on a machine so loaded the pointer barely
 * moves, which is how #227 was reported — ends every PTY in it at once, and the
 * agents in them with it. Opt-in, like #90: most people quit wmux by closing
 * the window and must not be asked every time. Shipped in 2.10.2, behind the
 * pref `confirmAppClose`.
 *
 * This module is the DECISION only. The effect — `event.preventDefault()` and
 * a native `dialog.showMessageBox`, Cancel as the default button — lives in
 * `window-manager.ts`, because a BrowserWindow `close` event needs a real
 * Electron app to reach, and the part worth pinning is which of three things
 * happens to a close request.
 *
 * Why a native dialog rather than the renderer's ConfirmCloseDialog: the close
 * has already been requested in MAIN by the time anyone can intervene, and the
 * renderer may be exactly the thing that is unresponsive (the reporter's
 * machine was "at its limit"). A main-process modal needs nothing from the
 * page to appear, and nothing from the page to answer.
 *
 * Close to tray (issue #442) is the fourth outcome, `hide`: the pref
 * `closeToTray` turns the last visible window's × into `win.hide()`, and the
 * tray icon (`app-tray.ts`) brings it back or quits for real.
 */

export interface CloseGuardInput {
  /**
   * The `confirmAppClose` pref, read at close time. Read off settings.json
   * (the renderer persists it there synchronously), so no IPC.
   */
  enabled: boolean;
  /**
   * The app is quitting on its own account — an update installing, a relaunch
   * for a transparency change, Windows ending the session. The user either
   * already chose this or cannot be asked, and a dialog there would block an
   * update or a shutdown. index.ts supplies `isQuitting || sessionEndHandled`.
   */
  bypass: boolean;
  /**
   * The user has just answered "close" to the dialog for THIS window. Also set
   * by `closeWindow()` in window-manager.ts (the pipe, another window): the
   * same "programmatic closes never prompt" contract as #90.
   */
  confirmed: boolean;
  /** A dialog for this window is already on screen. */
  pending: boolean;
  /**
   * The `closeToTray` pref (issue #442), read at close time like `enabled`.
   * The × hides the window instead of closing it, and the main process keeps
   * every PTY and agent running behind a tray icon (`app-tray.ts`).
   */
  toTray: boolean;
  /**
   * No OTHER wmux window is visible. Close to tray only takes the close that
   * would leave nothing on screen: closing one of several visible windows still
   * closes that window and ends its sessions, as before, because the app stays
   * reachable through the others and a hidden window behind a visible one would
   * be a window the user cannot see is still running. Hidden windows do not
   * count as "other", so the last visible window hides rather than closing
   * while an earlier one sits in the tray.
   */
  lastVisibleWindow: boolean;
}

/**
 * - `allow`   — let the close proceed.
 * - `ask`     — cancel it and put the dialog up.
 * - `swallow` — cancel it and do nothing: a dialog is already up. A second ×
 *               click (or Alt+F4 repeated by a stuck key) must neither close
 *               the window past the question nor stack a second question.
 * - `hide`    — cancel it and hide the window to the tray (issue #442).
 */
export type CloseGuardDecision = 'allow' | 'ask' | 'swallow' | 'hide';

/**
 * Precedence, top down:
 * 1. `confirmed` and `bypass` win over everything: a programmatic close
 *    (`wmux close-window`, another window), "Quit wmux" in the tray, an update,
 *    a relaunch and Windows ending the session all really close. Tray quit runs
 *    `app.quit()`, so it reaches here as `bypass` exactly like an update does.
 * 2. Close to tray wins over the confirm dialog (#227): hiding ends nothing, so
 *    there is nothing to confirm. A dialog already on screen is still honoured
 *    (`swallow`) so the window never hides under its own question.
 * 3. Otherwise the #227 guard as before.
 */
export function decideClose(input: CloseGuardInput): CloseGuardDecision {
  if (input.confirmed) return 'allow';
  if (input.bypass) return 'allow';
  if (input.toTray && input.lastVisibleWindow) return input.pending ? 'swallow' : 'hide';
  if (!input.enabled) return 'allow';
  if (input.pending) return 'swallow';
  return 'ask';
}

export interface CloseDialogCopy {
  message: string;
  detail: string;
  confirmLabel: string;
}

/**
 * What the dialog says. Distinguishes the last window — which quits wmux and
 * ends every session — from one of several, which ends only its own.
 *
 * `ptyCount` is the app-wide live PTY count, which is exact for the last
 * window and is the concrete cost, so it goes in the text rather than being
 * left to the user's memory of what was open. Main does not track PTYs per
 * window, so for a secondary window the text names no number rather than a
 * wrong one.
 */
export function closeDialogCopy(opts: { lastWindow: boolean; ptyCount: number }): CloseDialogCopy {
  if (opts.lastWindow) {
    const n = Math.max(0, Math.floor(opts.ptyCount));
    const sessions = n === 1 ? '1 terminal session' : `${n} terminal sessions`;
    return {
      message: 'Quit wmux?',
      detail: n === 0
        ? 'This closes the last wmux window.'
        : `${sessions} will be terminated, including any agents running in them. The layout is saved and restored on the next launch, but the processes are not.`,
      confirmLabel: 'Quit wmux',
    };
  }
  return {
    message: 'Close this window?',
    detail: 'The terminal sessions in this window will be terminated. Other wmux windows stay open.',
    confirmLabel: 'Close window',
  };
}
