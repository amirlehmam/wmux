// The last save before a window goes away (issue #285).
//
// session.json used to be written only by the 30-second auto-save tick and by a
// `session:request` broadcast in `before-quit`. Neither covers the way most
// people quit wmux — the caption × on the LAST window: Electron runs `close`,
// `closed`, then `window-all-closed` → `app.quit()` → `before-quit`, and by then
// there is no window left to answer the broadcast. So anything changed since
// the last tick (up to 30 s of it) never reached disk. The reporter set a
// pane's startup command, quit nine seconds later, and it was gone.
//
// The fix is to ASK and WAIT: hold the close, send `session:request`, and let it
// go once that window's `session:save` has arrived — or once a deadline passes,
// because a renderer that is not answering is exactly the window the user is
// trying to close, and "cannot quit" is worse than "lost the last 30 s".
//
// Two holds, both in ./index: `WindowManager.beforeClose` holds the LAST
// window's close, and `before-quit` holds the quit — once, guarded by
// `quitFlushDone` — until each window's `session:save` lands, bounded by
// SESSION_FLUSH_TIMEOUT_MS (1 s). Both are skipped on `session-end`: Windows
// is ending the session and the OS is on a deadline. The startup-command
// dialog also writes at once, via `requestSessionSaveNow()`
// (`renderer/utils/session-save-now.ts`).
//
// Pure bookkeeping, no Electron: the waiters are keyed by webContents id and
// resolved from the `session:save` listener in ./index.

/** How long a close or quit waits for a window's state. A healthy renderer
 *  answers in a few ms; this only bounds a hung one. */
export const SESSION_FLUSH_TIMEOUT_MS = 1_000;

type Waiter = (saved: boolean) => void;

export class SessionFlushWaiters {
  private readonly waiters = new Map<number, Waiter[]>();

  /**
   * Resolves `true` when `notifySaved(webContentsId)` is called, `false` when
   * `timeoutMs` passes first. Never rejects: every caller proceeds either way.
   */
  wait(webContentsId: number, timeoutMs: number = SESSION_FLUSH_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done: Waiter = (saved) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.remove(webContentsId, done);
        resolve(saved);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const list = this.waiters.get(webContentsId) ?? [];
      list.push(done);
      this.waiters.set(webContentsId, list);
    });
  }

  /** A `session:save` from this webContents has been written. */
  notifySaved(webContentsId: number): void {
    const list = this.waiters.get(webContentsId);
    if (!list) return;
    this.waiters.delete(webContentsId);
    for (const w of list) w(true);
  }

  pending(webContentsId: number): number {
    return this.waiters.get(webContentsId)?.length ?? 0;
  }

  private remove(webContentsId: number, waiter: Waiter): void {
    const list = this.waiters.get(webContentsId);
    if (!list) return;
    const rest = list.filter((w) => w !== waiter);
    if (rest.length) this.waiters.set(webContentsId, rest);
    else this.waiters.delete(webContentsId);
  }
}
