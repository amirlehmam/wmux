/**
 * ssh-path.ts — the one rule for a renderer-supplied path that is sent to a
 * remote host.
 *
 * A path from the renderer ends up in a git pathspec or, for an untracked
 * file, in `git diff --no-index -- /dev/null <file>`, which reads any file the
 * remote account can read. So it must be a relative path BELOW the checkout, in
 * the one spelling git itself prints.
 *
 * This module imports nothing from the other ssh modules, so the git modules
 * and the explorer can share it without a cycle.
 */

import type { ExplorerListError } from '../shared/types';

const MAX_REL_PATH = 4096;

/**
 * The segments of a renderer-supplied relative path, or the error. POSIX
 * separators only: a backslash is a legal character in a remote host file name.
 * Empty and `.` segments are folded; `..` and NUL are refused outright.
 */
export function remoteRelSegments(relPath: unknown): string[] | ExplorerListError {
  if (typeof relPath !== 'string') return { error: 'Invalid path', code: 'invalid_path' };
  if (relPath.includes('\0')) return { error: 'Invalid path', code: 'invalid_path' };
  if (relPath.startsWith('/')) return { error: 'Invalid path', code: 'invalid_path' };
  const segments: string[] = [];
  for (const segment of relPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { error: 'Path is outside the root', code: 'outside_root' };
    segments.push(segment);
  }
  return segments;
}

/**
 * `file` itself when it is a relative path in the canonical spelling, else null.
 *
 * Canonical means what `git status` prints: no NUL, not absolute, no empty, `.`
 * or `..` segment, and no leading `./`. One trailing `/` is allowed, the way git
 * spells an untracked folder. A segment is also tested with `\` read as a
 * separator, so `..\..\x` is refused even though a POSIX host would take it for
 * one odd file name: no real path is lost to that, and a host that did treat `\`
 * as a separator is not a way out of the checkout.
 */
/**
 * The shell half of the rule, for the one git command that reads a file off the
 * disk by name: `git diff --no-index -- /dev/null <file>`. Every other git
 * command here reads through the index or the object store and cannot leave
 * the checkout; this one follows a symlinked directory wherever it points, so
 * with `etc-link -> /etc` in a checkout, `etc-link/passwd` read the host's
 * `/etc/passwd`. `canonicalRemoteRelPath` cannot see that: it checks a
 * spelling, and the link is on the host.
 *
 * `no_index_ok <dir> <git args…>` answers 0 for any other command. For a
 * `diff --no-index` it walks the LAST argument segment by segment below
 * `<dir>` and answers 1 for an absolute path, a `.` or `..` segment, or a
 * segment that is a symlink, the last one included: the same refusal as the
 * explorer's jail (ssh-explorer.ts). It runs in a subshell, so the caller's
 * IFS and globbing are untouched.
 *
 * A constant, with no backslash in it, so it can be pasted into every script
 * that runs a caller's git arguments: GIT_SCRIPT (ssh-git.ts) and BATCH_SCRIPT
 * (exec-git-batch-script.ts). A worker runs those same scripts.
 */
export const NO_INDEX_GUARD_SH = `no_index_ok() {
  nd=$1; shift
  if [ "$1" != diff ] || [ "$2" != --no-index ]; then return 0; fi
  for nf do :; done
  ( set -f; IFS=/; cur=$nd
    case $nf in /*) exit 1;; esac
    for seg in $nf; do
      case $seg in '') continue;; .|..) exit 1;; esac
      cur=$cur/$seg
      if [ -L "$cur" ]; then exit 1; fi
    done
    exit 0 )
}
`;

/** What a script exits with when `no_index_ok` refuses: never a status of git's own. */
export const NO_INDEX_REFUSED_STATUS = 126;

export function canonicalRemoteRelPath(file: unknown): string | null {
  if (typeof file !== 'string' || file.length === 0 || file.length > MAX_REL_PATH) return null;
  if (file.includes('\0') || file.startsWith('/')) return null;
  const body = file.endsWith('/') ? file.slice(0, -1) : file;
  if (body.length === 0) return null;
  for (const segment of body.split('/')) {
    if (segment === '') return null;
    if (segment.split('\\').some((part) => part === '.' || part === '..')) return null;
  }
  return file;
}
