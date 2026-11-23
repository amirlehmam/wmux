/**
 * ssh-markdown.ts — saving and re-reading a markdown file that lives on a
 * remote host.
 *
 * A markdown tab opened from the folder view of an ssh workspace holds, as its
 * file path, the file's `ssh://dest[:port]/abs/path` identity
 * (`remoteFilePath`, ssh-explorer.ts). That is not a local path and cannot
 * resolve to one, so `markdown:save-file` and `markdown:read-file` recognise the
 * identity and serve it over ssh, with the SAME gates as `code:write-file`:
 *
 *   1. extension whitelist — the markdown handlers' own guard, kept on the
 *      remote side so a grant cannot be laundered into writing a `.ps1`;
 *   2. the identity must lie under a REGISTERED target's checkout: same
 *      destination and port, and the absolute path below `target.path`,
 *      spelled canonically (no `..`, `.` or empty segment). Nothing else
 *      resolves, so the renderer cannot name a host or a directory wmux was
 *      not told about;
 *   3. the grant: the file must have been read into a pane in THIS window,
 *      under `remoteGrantKey(identity)`, a key no local path can equal;
 *   4. `remoteWriteCodeFile` does the jail on the remote host, the expected-mtime
 *      conflict check and the temp-file-and-rename write.
 *
 * No function here touches the local disk, and none falls back to it.
 */

import { isAllowedMarkdownPath, MAX_MD_BYTES } from './markdown-file';
import { remoteGrantKey, remoteReadCodeFile, remoteRelSegments, remoteWriteCodeFile } from './ssh-explorer';
import { remoteFilePath } from './ssh-command';
import type { SshTarget } from './ssh-targets';
import type { CodeReadOk, CodeWriteOk } from './code-file';
import { isRemoteIdentity } from '../shared/remote-identity';

export { isRemoteIdentity };

/**
 * `{ error, code }` as every markdown handler answers. `code` is wider than
 * ExplorerErrorCode: the markdown pane maps its own vocabulary (`unsupported_type`,
 * `too_large`...) and falls back to `error` for a code it does not know, which
 * is how the explorer's `ssh-unreachable` reaches it as the fixed sentence.
 */
export interface RemoteMarkdownError { error: string; code: string }

const fail = (message: string, code: string): RemoteMarkdownError => ({ error: message, code });

/** What decides which host a target reaches, as one string: its whole connection, not the pane's socket or cwd. */
function connectionKey(target: SshTarget): string {
  const { controlPath: _socket, workingDirectory: _cwd, ...connection } = target.session;
  return JSON.stringify([connection, target.wslDistro ?? null]);
}

/**
 * The registered target an identity belongs to, and the path below its
 * checkout. The most specific target wins when two share a host (one checkout
 * nested in another). Refused when no target matches, when the path escapes the
 * checkout, or when the identity is not spelled exactly as `remoteFilePath`
 * would spell it — the grant key is that spelling, so a second spelling of the
 * same file must never be a way past it.
 */
export function resolveRemoteIdentity(
  filePath: string,
  targets: readonly SshTarget[],
): { target: SshTarget; relPath: string } | RemoteMarkdownError {
  let best: { target: SshTarget; prefix: string } | undefined;
  let reaching = new Set<string>();
  for (const target of targets) {
    const prefix = `${remoteFilePath(target, [])}/`;
    if (!filePath.startsWith(prefix)) continue;
    if (!best || target.path.length > best.target.path.length) { best = { target, prefix }; reaching = new Set(); }
    if (target.path.length === best.target.path.length) reaching.add(connectionKey(target));
  }
  if (!best) return fail('Not a file of a remote workspace', 'outside_root');
  // The identity names a destination, a port and a path, and nothing about HOW the host is reached: an
  // alias with another `-F` or `-J` in another workspace can be a different machine. Writing to the first
  // of them would be a save to the wrong host, so a name that two differently-reached targets share is refused.
  if (reaching.size > 1) {
    return fail('Two remote workspaces reach different hosts under this name; save from a single one', 'ambiguous_target');
  }
  const segments = remoteRelSegments(filePath.slice(best.prefix.length));
  if (!Array.isArray(segments)) return segments;
  if (segments.length === 0 || remoteFilePath(best.target, segments) !== filePath) {
    return fail('Invalid path', 'invalid_path');
  }
  return { target: best.target, relPath: segments.join('/') };
}

/** Collaborators; production passes the registry, this window's grants and the ssh runners. */
export interface RemoteMarkdownDeps {
  targets: () => readonly SshTarget[];
  /** Has THIS window read the file the key names? */
  isGranted: (grantKey: string) => boolean;
  write: (target: SshTarget, relPath: string, content: string, expectedMtimeMs: number | undefined)
    => Promise<CodeWriteOk | RemoteMarkdownError>;
  read: (target: SshTarget, relPath: string) => Promise<CodeReadOk | RemoteMarkdownError>;
}

export const defaultRemoteMarkdownDeps = (
  targets: () => readonly SshTarget[],
  isGranted: (grantKey: string) => boolean,
): RemoteMarkdownDeps => ({
  targets,
  isGranted,
  write: (target, relPath, content, expected) => remoteWriteCodeFile(target, relPath, content, expected),
  read: (target, relPath) => remoteReadCodeFile(target, relPath),
});

/**
 * The result of `markdown:save-file`, in the shape the markdown pane already
 * reads: `{ ok, mtimeMs }`, `{ conflict }` (which opens its conflict banner) or
 * `{ error, code }`.
 */
export type RemoteMarkdownSave =
  | { ok: true; mtimeMs: number }
  | { conflict: true; currentMtimeMs: number }
  | RemoteMarkdownError;

export async function saveRemoteMarkdown(
  filePath: string,
  content: unknown,
  expectedMtimeMs: unknown,
  deps: RemoteMarkdownDeps,
): Promise<RemoteMarkdownSave> {
  if (!isAllowedMarkdownPath(filePath)) return fail('Unsupported file type', 'unsupported_type');
  if (typeof content !== 'string') return fail('No content to write', 'invalid_path');
  if (Buffer.byteLength(content, 'utf-8') > MAX_MD_BYTES) return fail('Content exceeds the 5MB limit', 'too_large');
  const resolved = resolveRemoteIdentity(filePath, deps.targets());
  if ('error' in resolved) return resolved;
  if (!deps.isGranted(remoteGrantKey(filePath))) {
    return fail('This file was not opened in wmux — use Save As', 'not_granted');
  }
  const expected = typeof expectedMtimeMs === 'number' && Number.isFinite(expectedMtimeMs) ? expectedMtimeMs : undefined;
  const written = await deps.write(resolved.target, resolved.relPath, content, expected);
  if (!('error' in written)) return { ok: true, mtimeMs: written.mtimeMs };
  // The pane keys its conflict banner on `conflict`. The remote host's current mtime
  // is not reported back by the writer, and the pane does not read it.
  if (written.code === 'conflict') return { conflict: true, currentMtimeMs: 0 };
  return written;
}

/** "Reload from disk" for a remote markdown tab: same gates, read instead of write. */
export async function readRemoteMarkdown(
  filePath: string,
  deps: RemoteMarkdownDeps,
): Promise<CodeReadOk | RemoteMarkdownError> {
  if (!isAllowedMarkdownPath(filePath)) return fail('Unsupported file type', 'unsupported_type');
  const resolved = resolveRemoteIdentity(filePath, deps.targets());
  if ('error' in resolved) return resolved;
  if (!deps.isGranted(remoteGrantKey(filePath))) {
    return fail('This file was not opened in wmux — use Save As', 'not_granted');
  }
  return deps.read(resolved.target, resolved.relPath);
}
