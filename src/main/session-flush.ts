/** One total close/quit budget, including layout publication and history I/O. */
export const SESSION_FLUSH_TIMEOUT_MS = 1_000;

interface Waiter {
  token: string;
  layout?: boolean;
  history?: boolean;
  done(saved: boolean): void;
}

/**
 * Periodic/layout-only replies cannot prove a final history attempt finished.
 * Both branches must settle for the same requesting window and opaque token.
 * Failures release the hold with false; an unresponsive branch loses to the
 * original deadline. Windows session-end bypasses this in the lifecycle owner.
 */
export class SessionFlushWaiters {
  private readonly waiters = new Map<number, Set<Waiter>>();

  wait(webContentsId: number, token: string, timeoutMs = SESSION_FLUSH_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        token,
        done: (saved) => {
          clearTimeout(timer);
          this.waiters.get(webContentsId)?.delete(waiter);
          if (!this.waiters.get(webContentsId)?.size) this.waiters.delete(webContentsId);
          resolve(saved);
        },
      };
      const timer = setTimeout(() => waiter.done(false), timeoutMs);
      const list = this.waiters.get(webContentsId) ?? new Set<Waiter>();
      list.add(waiter);
      this.waiters.set(webContentsId, list);
    });
  }

  notifySaved(webContentsId: number, token: unknown, saved: boolean): void {
    this.notify(webContentsId, token, 'layout', saved);
  }

  notifyHistory(webContentsId: number, token: unknown, saved: boolean): void {
    this.notify(webContentsId, token, 'history', saved);
  }

  private notify(owner: number, token: unknown, branch: 'layout' | 'history', saved: boolean): void {
    if (typeof token !== 'string') return;
    for (const waiter of this.waiters.get(owner) ?? []) {
      if (waiter.token !== token) continue;
      waiter[branch] = waiter[branch] === false ? false : saved;
      if (waiter.layout !== undefined && waiter.history !== undefined) waiter.done(waiter.layout && waiter.history);
    }
  }

  pending(webContentsId: number): number {
    return this.waiters.get(webContentsId)?.size ?? 0;
  }
}
