/**
 * What a remount carries across of a terminal's buffer (issue #49).
 *
 * When an xterm instance is disposed and rebuilt while the PTY, and the
 * application on the other end of it, keep running, the snapshot taken here is
 * replayed into the replacement terminal. A split-tree restructure used to be
 * the everyday cause; since #346 it moves the live terminal instead
 * (components/Terminal/terminal-keepalive.ts), and this is the fallback for a
 * terminal that genuinely is rebuilt (see RemountSnapshotCache below).
 *
 * ## Why the alternate screen is part of it
 *
 * The snapshot used to be the normal buffer only, on the theory that a TUI
 * redraws its own screen after the post-remount SIGWINCH. It redraws, but it
 * never re-sends `ESC[?1049h` — from its side nothing happened — so the
 * replacement terminal stayed on the NORMAL buffer with the TUI drawn into it.
 * Every frame after that went into the shell's scrollback (a full-screen clear
 * wiped the shell's own lines), and the TUI's exit `ESC[?1049l` had no alternate
 * screen to leave: xterm still runs its restoreCursor(), which homes a cursor
 * nothing saved, so the shell prompt was printed over row 1 of the stale frame.
 *
 * With the alternate buffer included, SerializeAddon writes the normal buffer
 * and its cursor first, then `ESC[?1049h ESC[H` and the alternate screen. The
 * `?1049h` saves the cursor at the shell's real position, so the exit puts the
 * shell back exactly where it was.
 */

/** The slice of a SerializeAddon this module touches. */
export interface RemountSerializer {
  serialize(): string;
}

/** Serialize a terminal for replay into its replacement after a remount. */
export function serializeRemountSnapshot(serializer: RemountSerializer): string {
  return serializer.serialize();
}

/** What a disposed terminal leaves for its replacement. */
export interface RemountSnapshot {
  /** SerializeAddon output — the normal buffer, then the alternate one if active. */
  text: string;
  /** The size the terminal (and so the PTY) had when it was taken. */
  cols: number;
  rows: number;
}

export interface RemountSnapshotCacheOptions {
  /** Does the surface still exist in this window's store? */
  isOpen: (surfaceId: string) => boolean;
  /** Most entries kept; the oldest is dropped first. */
  capacity: number;
}

/**
 * Snapshots keyed by surface id, from a terminal's dispose to its
 * replacement's PTY attach.
 *
 * Since #346 a terminal is disposed only when it is genuinely rebuilt (the
 * root ErrorBoundary's retry remounts every terminal, as do StrictMode and
 * Fast Refresh in dev) or when its surface has left the store (closed, or
 * dropped by Load session). Only the first kind has a replacement on the same
 * PTY, so two rules keep a snapshot from outliving the PTY it describes:
 *
 * - **No snapshot for a surface that is gone.** Its PTY was killed, or is
 *   writing into a window nothing listens on, so anything taken now is either
 *   never read or stale by the time it is. Serializing the whole scrollback on
 *   every close was pure cost.
 * - **No replay into a fresh PTY.** Load session keeps saved surface ids, so a
 *   closed pane's id comes back on a new shell. Replaying a snapshot of an
 *   alternate screen there put the new shell's prompt on the alternate buffer
 *   and kept its output out of scrollback.
 */
export class RemountSnapshotCache {
  private readonly entries = new Map<string, RemountSnapshot>();

  constructor(private readonly options: RemountSnapshotCacheOptions) {}

  /**
   * A terminal on `surfaceId` is being disposed. `capture` serializes it, and
   * is called only when a replacement could still use the result.
   */
  retire(surfaceId: string, capture: () => RemountSnapshot | null): void {
    this.entries.delete(surfaceId);
    if (!this.options.isOpen(surfaceId)) return;
    let snapshot: RemountSnapshot | null;
    try {
      snapshot = capture();
    } catch {
      // Serialization failure is non-fatal — just lose the snapshot.
      return;
    }
    if (!snapshot) return;
    if (this.entries.size >= this.options.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(surfaceId, snapshot);
  }

  /**
   * The replacement terminal has found its PTY. Hands the snapshot back only
   * when that PTY is the one it was taken from, and drops it either way.
   */
  take(surfaceId: string, ptyReused: boolean): RemountSnapshot | undefined {
    const snapshot = this.entries.get(surfaceId);
    this.entries.delete(surfaceId);
    return ptyReused ? snapshot : undefined;
  }
}
