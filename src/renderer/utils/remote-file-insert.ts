/**
 * remote-file-insert.ts — decide what text a paste or drop puts into a terminal
 * when the pane may be sitting inside an ssh session.
 *
 * The decision is here rather than inline in `useTerminal` because it has more
 * branches than it looks: three ways to end up inserting the local path (no
 * remote, upload disabled, user held Shift), one that uploads, and one that
 * inserts nothing at all. Every dependency is injected so the whole table can
 * be exercised without an Electron window or a live ssh host.
 */

import { windowsTerminalQuote, posixShellQuote } from '../../shared/shell-quote';
import type { RemoteTarget, UploadResult } from '../../shared/types';

export type { RemoteTarget, UploadResult };

export interface FileInsertionDeps {
  /** null when the pane is local. */
  detect: (surfaceId: string) => Promise<RemoteTarget | null>;
  upload: (surfaceId: string, localPaths: string[]) => Promise<UploadResult>;
  /** Surface a failure to the user. */
  notify: (message: string) => void;
}

export interface FileInsertionRequest {
  surfaceId: string;
  localPaths: string[];
  mode: 'paste' | 'drop';
  /**
   * The user held Shift while dropping — insert the local path instead of
   * uploading. Drop only: Ctrl+Shift+V is already wmux's paste binding, so
   * Shift is not available as a paste modifier. cmux's FileDropDefaultBehavior
   * documents Shift as a drop modifier for the same reason.
   */
  invert?: boolean;
}

/** Text for local paths — today's behaviour, unchanged. */
export function localInsertionText(paths: string[]): string {
  return paths.map(windowsTerminalQuote).join(' ');
}

/** Text for paths on the far side of an ssh connection. */
export function remoteInsertionText(paths: string[]): string {
  return paths.map(posixShellQuote).join(' ');
}

/**
 * Resolve what to type into the terminal. Returns null when nothing should be
 * inserted — which happens only on a failed upload, where inserting the local
 * path would hand the remote shell a path it cannot open while looking like
 * the operation succeeded.
 */
export async function resolveFileInsertion(
  request: FileInsertionRequest,
  deps: FileInsertionDeps
): Promise<string | null> {
  const { surfaceId, localPaths, mode, invert } = request;
  if (localPaths.length === 0) return null;

  // Shift is an explicit "give me the local path", so detection cannot change
  // the answer and is not worth its latency on the drop path. Detection failing
  // is likewise not a reason to break paste — it is an improvement over the old
  // behaviour, never a gate on it.
  const target = invert ? null : await deps.detect(surfaceId).catch(() => null);
  const uploadable = target && (mode === 'paste' ? target.uploadOnPaste : target.uploadOnDrop);
  if (!uploadable) return localInsertionText(localPaths);

  let outcome: UploadResult;
  try {
    outcome = await deps.upload(surfaceId, localPaths);
  } catch (err) {
    deps.notify(`Upload to ${target.destination} failed: ${(err as Error)?.message ?? 'unknown error'}`);
    return null;
  }

  if (!outcome.ok || outcome.remotePaths.length !== localPaths.length) {
    deps.notify(`Upload to ${target.destination} failed: ${outcome.error ?? 'unknown error'}`);
    return null;
  }

  return remoteInsertionText(outcome.remotePaths);
}
