/**
 * ssh-diff.ts — the Diff tab for a workspace whose session lives on a remote host.
 *
 * `diff:get-files` and `diff:get-diff` take an absolute `cwd` from the renderer and
 * run git on the LOCAL disk, which for a remote workspace is a path that does not
 * exist on this machine. When the request names a surface whose workspace has an
 * ssh target, the handlers call these instead: the checkout comes from the registry
 * (`target.path`), the renderer's `cwd` is ignored, and the same diff provider
 * runs with its git going over ssh (`runWithSshGit`, ssh-git.ts).
 *
 * Read-only, like the provider. An unreachable remote host is an ERROR with the
 * fixed sentence, never an empty file list: "no changes" would be a statement
 * about a checkout nobody could look at.
 */

import { getChangedFiles, getFileDiff, type ChangedFile } from './diff-provider';
import { canonicalRemoteRelPath } from './ssh-path';
import { runWithSshGit, SSH_UNREACHABLE_MESSAGE, type SshGitContext } from './ssh-git';
import { senderLocationFor } from './ssh-access';
import type { SshTarget, SshTargetWindow } from './ssh-targets';

export interface RemoteDiffError { error: string; code: 'ssh-unreachable' | 'read_failed' | 'invalid_path' }

function failure(err: unknown): RemoteDiffError {
  if (err instanceof Error && err.message === SSH_UNREACHABLE_MESSAGE) {
    return { error: SSH_UNREACHABLE_MESSAGE, code: 'ssh-unreachable' };
  }
  // git's own stderr can carry paths; the renderer gets a fixed sentence.
  console.error('[ssh-diff] remote diff failed:', err instanceof Error ? err.message : err);
  return { error: 'Failed to load changed files', code: 'read_failed' };
}

/**
 * The remote host a Diff request is about, or undefined for a local one.
 *
 * Ownership is "the SENDER's own window holds this surface": the lookup asks
 * only that window, so a renderer cannot name another window's workspace. It is
 * not `ownsLiveSurface` (a live PTY) because the caller here is a Diff tab, and
 * a Diff tab has no PTY of its own: it is resolved through its workspace, as
 * the Git view's surface is. A surface this window does not hold is answered as
 * a local request, which never yields remote data.
 */
export async function diffTargetFor(
  surfaceId: unknown,
  win: SshTargetWindow | null | undefined,
): Promise<SshTarget | undefined> {
  return (await senderLocationFor(surfaceId, win))?.target;
}

/** `tool` is the ssh executable resolver; tests replace it, production leaves it. */
export async function remoteChangedFiles(
  target: SshTarget,
  baseRef?: string,
  tool?: SshGitContext['tool'],
): Promise<{ files: ChangedFile[] } | RemoteDiffError> {
  try {
    const files = await runWithSshGit({ target, tool }, () => getChangedFiles(target.path, baseRef));
    return { files };
  } catch (err) {
    return failure(err);
  }
}

/**
 * `file` as a path below the checkout when it is an absolute path of that checkout, else untouched.
 *
 * An agent's edit hook reports the file it wrote as an ABSOLUTE path on the host it runs on
 * (`tool_input.file_path`), and the Diff tab selects exactly that on the next refresh. On a remote
 * workspace the host is the target's, so a path under `target.path` is the same file as the relative one
 * git prints; refusing it showed "Invalid path" in the tab after every edit. Only the prefix is cut: the
 * result still has to pass `canonicalRemoteRelPath`, so `<root>/../x`, an empty rest and a path outside the
 * checkout stay refused.
 */
export function relativeToCheckout(file: unknown, root: string): unknown {
  if (typeof file !== 'string') return file;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * One file's diff. `file` comes from the renderer and ends up in a git
 * pathspec, and for an untracked file in `git diff --no-index -- /dev/null
 * <file>`, which would read ANY file on the remote host: it must be a relative path
 * below the checkout, the same rule as every explorer path.
 */
export async function remoteFileDiff(
  target: SshTarget,
  file: unknown,
  baseRef?: string,
  tool?: SshGitContext['tool'],
): Promise<{ diff: string } | RemoteDiffError> {
  const relPath = canonicalRemoteRelPath(relativeToCheckout(file, target.path));
  if (relPath === null) return { error: 'Invalid path', code: 'invalid_path' };
  try {
    const diff = await runWithSshGit({ target, tool }, () => getFileDiff(target.path, relPath, baseRef));
    return { diff };
  } catch (err) {
    return failure(err);
  }
}
