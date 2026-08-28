// ─── Explorer: which directory a surface's tree is rooted at ─────────────────
// Fed from the same report_pwd call site that feeds sshDetector.reportCwd
// (index.ts), so this adds a CONSUMER of an existing mechanism rather than a
// second mechanism. The root is the trusted end of the jail: it is resolved
// through fs.realpath.native exactly once, here, so 8.3 short names and casing
// aliases are normalized before explorer-fs.ts ever reasons about them.
//
// The reported cwd is NOT a consent boundary — a process running in the
// terminal can influence it. It is a UX root; the jail's job is to keep
// enumeration inside whatever that root turned out to be.

import * as fs from 'fs';
import * as path from 'path';
import { trustedWindowsCwd } from './ssh-detect';

export interface ExplorerRoot {
  /** Exactly what the shell reported, for display. */
  cwd: string;
  /** realpath'd and absolute — what listDir() is called with. */
  realRoot: string;
}

const roots = new Map<string, ExplorerRoot>();

/**
 * A prompt reported its working directory.
 *
 * Short-circuits when the cwd is unchanged, which is the common case: this runs
 * on EVERY prompt, and realpath is a syscall. Without the guard the explorer
 * would add a filesystem hit to every command the user runs.
 */
export function reportExplorerCwd(surfaceId: string, cwd: string): void {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (!trimmed) {
    roots.delete(surfaceId);
    return;
  }
  const existing = roots.get(surfaceId);
  if (existing && existing.cwd === trimmed) return;

  // Route through the same normalization ssh-detect.ts uses for report_pwd:
  // Git Bash reports /c/foo, which is not a path realpath.native can resolve
  // as-is — falling back to path.resolve on the raw string would coincidentally
  // land on a wrong-but-real Windows directory (e.g. /tmp -> C:\tmp). WSL's
  // /mnt/c/foo is deliberately left unresolved rather than guessed at.
  const windowsCwd = trustedWindowsCwd(trimmed);
  if (!windowsCwd) {
    roots.delete(surfaceId);
    return;
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(windowsCwd);
  } catch {
    // The directory may not exist locally at all — a remote path, or one
    // deleted under the shell. Store the resolved form anyway; listDir returns
    // not_found, which is the honest answer.
    realRoot = path.resolve(windowsCwd);
  }
  roots.set(surfaceId, { cwd: trimmed, realRoot });
}

export function getExplorerRoot(surfaceId: string): ExplorerRoot | null {
  return roots.get(surfaceId) ?? null;
}

export function forgetExplorerRoot(surfaceId: string): void {
  roots.delete(surfaceId);
}

/** Test seam — the module-level map would otherwise leak between cases. */
export function resetExplorerRoots(): void {
  roots.clear();
}
