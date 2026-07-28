// ─── Per-window session state (issue #118) ───────────────────────────────────
// The auto-save is a broadcast: main sends `session:request` to every window and
// each renderer answers with its OWN state, wrapped as `{ windows: [ me ] }`.
// That payload used to be handed straight to saveSession(), which writes the
// whole file — so with two windows open, whichever renderer answered last
// overwrote the other one's workspaces, every 30 seconds and again on quit.
// Users saw it as "auto-backup lost my tabs / my browser pages".
//
// This registry is the missing merge step: each window owns a slot, a save
// upserts one slot and serializes all of them, and the restore side hands each
// window back its own slot instead of everyone re-reading windows[0] (which is
// also why a second window used to come up as a clone of the first).

import type { SessionData } from './session-persistence';

export type SessionWindowState = SessionData['windows'][number];

/**
 * Cap on windows restored from a session file. Restoring is unbounded work
 * (each window spawns PTYs), so a corrupted or hand-edited file should not be
 * able to open an arbitrary number of windows at launch.
 */
export const MAX_RESTORED_WINDOWS = 8;

export class SessionWindowRegistry {
  // Insertion-ordered: Map preserves it, which keeps a window's position in the
  // saved file stable across saves, so restore reopens windows in the order
  // they were created rather than the order they happened to answer in.
  private slots = new Map<string, SessionWindowState>();

  /** Seed a freshly created window with the state it was restored from. */
  prime(windowId: string, state: SessionWindowState): void {
    this.slots.set(windowId, state);
  }

  /** Record the state a window just reported, replacing whatever it had. */
  update(windowId: string, state: SessionWindowState): void {
    this.slots.set(windowId, state);
  }

  /** The slot belonging to one window, or null if it has never had one. */
  get(windowId: string): SessionWindowState | null {
    return this.slots.get(windowId) ?? null;
  }

  /** Drop one window's slot — it was closed and should not come back. */
  forget(windowId: string): void {
    this.slots.delete(windowId);
  }

  /**
   * Drop slots for windows that no longer exist. Called on save while the app
   * is running, so closing a window really does forget it — but deliberately
   * NOT during shutdown, where every window is being destroyed and pruning
   * would erase the very state we are trying to persist.
   */
  retainOnly(liveWindowIds: readonly string[]): void {
    const live = new Set(liveWindowIds);
    for (const id of [...this.slots.keys()]) {
      if (!live.has(id)) this.slots.delete(id);
    }
  }

  /** Every window's state, in creation order — the array written to disk. */
  toArray(): SessionWindowState[] {
    return [...this.slots.values()];
  }

  get size(): number {
    return this.slots.size;
  }
}

/** Shared instance: written by the `session:save` listener in ./index, read by
 *  the SESSION_LOAD_AUTO handler in ./ipc-handlers. */
export const sessionWindows = new SessionWindowRegistry();

/**
 * Flatten one window's slot into the shape the renderer's restore code expects.
 * Returns null when the window has no saved state — a window opened during this
 * run, which must come up empty rather than inheriting another window's tabs.
 */
export function toRestorePayload(state: SessionWindowState | null): {
  workspaces: SessionWindowState['workspaces'];
  sidebarWidth: number;
  activeIndex: number;
} | null {
  if (!state || !Array.isArray(state.workspaces) || state.workspaces.length === 0) return null;
  const activeIndex = state.activeWorkspaceId
    ? state.workspaces.findIndex((w) => w.id === state.activeWorkspaceId)
    : 0;
  return {
    workspaces: state.workspaces,
    sidebarWidth: state.sidebarWidth,
    activeIndex: activeIndex >= 0 ? activeIndex : 0,
  };
}
