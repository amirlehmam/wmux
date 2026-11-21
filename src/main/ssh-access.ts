/**
 * ssh-access.ts — who may reach a remote workspace's files, as functions with
 * their dependencies passed in.
 *
 * The explorer, code and markdown handlers in ipc-handlers.ts answer a remote
 * surface from the remote host and refuse to fall through to a local path. Those
 * decisions are here, with the window, the grant set and the registry injected,
 * so they can be tested directly, and ipc-handlers.ts only wires the real ones in:
 *
 *  - `ownedRemoteTarget`: a surface the SENDER does not own has no remote data;
 *  - `serveRemoteFirst`: the remote host is asked BEFORE the local gate, which
 *    would answer `no_root` (or act on a local path of the same spelling);
 *  - `saveGrantedRemoteFile` / `readRemoteFile`: a save needs a grant THIS window
 *    got by reading that file; a successful read mints it, a failed one does not.
 */

import { isAllowedMarkdownPath } from './markdown-file';
import { remoteFilePath } from './ssh-command';
import { remoteGrantKey, remoteReadCodeFile, remoteRelSegments, remoteWriteCodeFile } from './ssh-explorer';
import { sshLocationForSurface, type SshTarget, type SshTargetWindow } from './ssh-targets';
import type { CodeReadOk, CodeWriteOk } from './code-file';
import type { ExplorerListError } from '../shared/types';

/** What a gate needs to know about one sender. */
export interface SurfaceGate {
  /** Is this a live surface the sender's window owns? */
  ownsLiveSurface: (surfaceId: unknown) => boolean;
  /** The ssh target of the workspace the surface is in, if it has one (the registry, every window asked). */
  targetForSurface: (surfaceId: string) => Promise<SshTarget | undefined>;
}

/** The remote target of a surface the sender owns; undefined for anything else, which means "serve it locally". */
export function ownedRemoteTarget(surfaceId: unknown, gate: SurfaceGate): Promise<SshTarget | undefined> {
  if (typeof surfaceId !== 'string' || !gate.ownsLiveSurface(surfaceId)) return Promise.resolve(undefined);
  return gate.targetForSurface(surfaceId);
}

/**
 * The workspace and ssh target of a surface, asked of the SENDER's own window only, so
 * a renderer cannot name another window's workspace (the Git view and the Diff tab
 * have no PTY of their own and are resolved through their workspace). A surface that
 * window does not hold, or no window, is undefined: a local request.
 */
export async function senderLocationFor(
  surfaceId: unknown,
  win: SshTargetWindow | null | undefined,
): Promise<{ workspaceId: string; target: SshTarget } | undefined> {
  if (typeof surfaceId !== 'string' || !surfaceId || !win) return undefined;
  return sshLocationForSurface(surfaceId, [win]);
}

/**
 * Answer from the remote host when the surface has a target, and run `local` only
 * when it has none. `find` is asked first and exactly once; `local` is not called,
 * and nothing it would touch is, for a remote surface.
 */
export async function serveRemoteFirst<R, L>(
  find: () => Promise<SshTarget | undefined>,
  remote: (target: SshTarget) => R | Promise<R>,
  local: () => L | Promise<L>,
): Promise<R | L> {
  const target = await find();
  return target ? remote(target) : local();
}

/** Collaborators of a remote save and read; production passes this window's grants and the ssh runners. */
export interface RemoteFileDeps {
  /** Has THIS window read the file the key names? */
  isGranted: (grantKey: string) => boolean;
  grant: (grantKey: string) => void;
  write: (target: SshTarget, relPath: unknown, content: unknown, expectedMtimeMs: number | undefined)
    => Promise<CodeWriteOk | ExplorerListError>;
  read: (target: SshTarget, relPath: unknown) => Promise<CodeReadOk | ExplorerListError>;
}

export const sshRunners = (
  isGranted: RemoteFileDeps['isGranted'],
  grant: RemoteFileDeps['grant'],
): RemoteFileDeps => ({
  isGranted,
  grant,
  write: (target, relPath, content, expected) => remoteWriteCodeFile(target, relPath, content, expected),
  read: (target, relPath) => remoteReadCodeFile(target, relPath),
});

/**
 * `code:write-file` on a remote target: the file must have been opened into THIS
 * window (the grant key is an ssh:// identity, never a local path); the jail, the
 * mtime check and the write are the remote host's (`remoteWriteCodeFile`).
 */
export async function saveGrantedRemoteFile(
  deps: RemoteFileDeps,
  target: SshTarget,
  relPath: unknown,
  content: unknown,
  expectedMtimeMs: number | undefined,
): Promise<CodeWriteOk | ExplorerListError> {
  const segments = remoteRelSegments(relPath);
  if (!Array.isArray(segments)) return segments;
  if (!deps.isGranted(remoteGrantKey(remoteFilePath(target, segments)))) {
    return { error: 'This file was not opened in a pane in this window', code: 'not_granted' };
  }
  return deps.write(target, relPath, content, expectedMtimeMs);
}

/**
 * `code:read-file` (and, with `markdownOnly`, `explorer:read-markdown`) on a remote
 * target. A successful read MINTS the save grant, under the remote key; an error
 * reply mints nothing. `markdownOnly` keeps the markdown handlers' extension
 * whitelist, so a grant cannot be laundered into writing a `.ps1`.
 */
export async function readRemoteFile(
  deps: RemoteFileDeps,
  target: SshTarget,
  relPath: unknown,
  markdownOnly: boolean,
): Promise<CodeReadOk | ExplorerListError | { error: string; code: 'unsupported_type' }> {
  if (markdownOnly && (typeof relPath !== 'string' || !isAllowedMarkdownPath(relPath))) {
    return { error: 'Unsupported file type', code: 'unsupported_type' };
  }
  const read = await deps.read(target, relPath);
  if (!('error' in read)) deps.grant(remoteGrantKey(read.filePath));
  return read;
}
