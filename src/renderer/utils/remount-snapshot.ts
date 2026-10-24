/**
 * What a remount carries across of a terminal's buffer (issue #49).
 *
 * A split-tree restructure disposes the xterm instance and builds a new one
 * while the PTY, and the application on the other end of it, keep running.
 * The snapshot taken here is replayed into the replacement terminal.
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
