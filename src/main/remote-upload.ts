/**
 * remote-upload.ts — copy local files to the host a pane is ssh'd into, so a
 * pasted screenshot or a dropped file is reachable from the remote shell.
 *
 * Ported from cmux's `RemoteSessionCoordinator+Upload.swift` and the
 * `scpArguments` / `cleanupUploadedRemotePaths` halves of
 * `TerminalSSHSessionDetector.swift` (manaflow-ai/cmux).
 */

import * as path from 'path';
import * as crypto from 'crypto';
import type { DetectedSsh } from './ssh-argv';
import { runSsh, sshArgs, toolForSession } from './ssh-exec';
import { posixShellQuote } from './shell-quote';
import { opensshPath } from './system32';


/** Per-file transfer budget, matching cmux. */
const UPLOAD_TIMEOUT_MS = 45_000;
/** Rollback is best-effort and must not hold up the error the user is waiting on. */
const CLEANUP_TIMEOUT_MS = 8_000;
/**
 * How many transfers run at once. Each pays its own ssh handshake (Windows
 * OpenSSH has no ControlMaster to share), so a serial batch costs N x ~500ms —
 * a ten-file drop was measured at 5.4s. Capped rather than unbounded so a large
 * drop cannot open a hundred simultaneous connections to one host.
 */
const UPLOAD_CONCURRENCY = 4;

// Re-exported so the scp/rollback tests can reach it from the module whose
// argv they are pinning. The rule itself lives in system32.ts, because the
// pane wmux spawns has to reach the same host as the scp it uploads with.
export { opensshPath, toolForSession };

export function remoteBatchDirectory(uuid: string = crypto.randomUUID()): string {
  return `/tmp/wmux-drop-${uuid.toLowerCase()}`;
}

/**
 * The `/tmp/wmux-drop-<uuid>[.ext]` path one local file uploads to.
 *
 * A fresh uuid per file rather than the basename: names collide across users
 * sharing a host, `screenshot.png` twice in a session would silently overwrite,
 * and a basename from a Windows filesystem can carry characters that are
 * awkward on the far side. The extension is preserved (lowercased) because
 * tools on the remote — and agents reading the file — key off it.
 */
export function remoteDropPath(localPath: string, uuid: string = crypto.randomUUID()): string {
  const ext = path.extname(localPath).trim();
  const suffix = /^\.[A-Za-z0-9]{1,16}$/.test(ext) ? ext.toLowerCase() : '';
  return `/tmp/wmux-drop-${uuid.toLowerCase()}${suffix}`;
}

export function remotePathInBatch(directory: string, localPath: string, uuid: string = crypto.randomUUID()): string {
  return `${directory}/${path.posix.basename(remoteDropPath(localPath, uuid)).replace('wmux-drop-', '')}`;
}

/**
 * Bracket a bare IPv6 literal so scp's `host:path` split lands on the right
 * colon. Without this, `scp file ::1:/tmp/x` is read as host `` / path `:1:…`.
 * cmux shipped this as a bugfix (PR #6874); ported rather than rediscovered.
 */
export function scpDestination(destination: string): string {
  const trimmed = destination.trim();
  if (!trimmed) return destination;
  const at = trimmed.lastIndexOf('@');
  const user = at === -1 ? null : trimmed.slice(0, at);
  const host = at === -1 ? trimmed : trimmed.slice(at + 1);
  const needsBrackets = host.includes(':') && !host.startsWith('[') && !host.endsWith(']');
  if (!needsBrackets) return trimmed;
  return user === null ? `[${host}]` : `${user}@[${host}]`;
}

/** Full scp argv for one file. Exported so tests can pin it, as cmux does. */
export function scpArgs(session: DetectedSsh, localPath: string, remotePath: string): string[] {
  return [
    ...sshArgs(session, '-P'),
    localPath,
    `${scpDestination(session.destination)}:${remotePath}`,
  ];
}

/** Full ssh argv for the rollback command. */
export function cleanupArgs(session: DetectedSsh, remotePaths: string[]): string[] {
  const script = `rm -f -- ${remotePaths.map(posixShellQuote).join(' ')}`;
  return [
    '-T',
    ...sshArgs(session, '-p'),
    session.destination,
    `sh -c ${posixShellQuote(script)}`,
  ];
}

export function prepareDirectoryArgs(session: DetectedSsh, directory: string): string[] {
  const script = `umask 077 && mkdir -m 700 -- ${posixShellQuote(directory)}`;
  return ['-T', ...sshArgs(session, '-p'), session.destination, `sh -c ${posixShellQuote(script)}`];
}

export function cleanupDirectoryArgs(session: DetectedSsh, directory: string): string[] {
  const script = `rm -rf -- ${posixShellQuote(directory)}`;
  return ['-T', ...sshArgs(session, '-p'), session.destination, `sh -c ${posixShellQuote(script)}`];
}

/**
 * The most useful line of an scp failure. scp's real complaint
 * ("Permission denied (publickey).", "No route to host") is usually the last
 * non-empty stderr line; the rest is noise the user cannot act on.
 */
function bestErrorLine(stderr: string, stdout: string): string | null {
  for (const stream of [stderr, stdout]) {
    const lines = stream
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      // ssh emits this whenever the user's ssh_config carries a RemoteForward
      // that is already bound (a live `wmux bridge` tunnel does exactly that).
      // It is not why the copy failed, and it would mask the line that is.
      .filter((line) => !/^Warning: remote port forwarding failed/i.test(line));
    if (lines.length === 0) continue;
    // scp prefixes its own argv[0] — an absolute Windows path here, which tells
    // the reader nothing and crowds a toast. "Connection closed" is the message.
    return lines[lines.length - 1].replace(/^[A-Za-z]:\\[^:]*?\.exe:\s*/, '');
  }
  return null;
}

/** Result of scp-ing local files to a surface's remote host. */
export interface UploadResult {
  ok: boolean;
  /** Remote paths, in the order the local paths were given. */
  remotePaths: string[];
  /** Present when `ok` is false — the transport's own complaint, one line. */
  error?: string;
}

/** Run `task` over `items` with at most `limit` in flight, preserving order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Upload each local file to a unique name inside one private
 * `/tmp/wmux-drop-<batch-id>/` directory, returning the remote paths in the
 * order the local paths were given.
 *
 * All-or-nothing: if any file fails, the ones that succeeded are deleted again
 * before returning. A partial batch is worse than none — the user would get
 * some remote paths and some silence, with no way to tell which is which.
 */
export async function uploadFiles(
  session: DetectedSsh,
  localPaths: string[],
  signal?: AbortSignal,
): Promise<UploadResult> {
  if (localPaths.length === 0) return { ok: true, remotePaths: [] };
  if (signal?.aborted) return { ok: false, remotePaths: [], error: 'upload cancelled' };

  let scp: string;
  let ssh: string;
  try {
    scp = toolForSession(session, 'scp');
    ssh = toolForSession(session, 'ssh');
  } catch (err) {
    return { ok: false, remotePaths: [], error: err instanceof Error ? err.message : String(err) };
  }
  const directory = remoteBatchDirectory();
  const prepared = await runSsh(ssh, prepareDirectoryArgs(session, directory), CLEANUP_TIMEOUT_MS, {
    cwd: session.workingDirectory,
    signal,
  });
  if (prepared.status !== 0) {
    return {
      ok: false,
      remotePaths: [],
      error: bestErrorLine(prepared.stderr, prepared.stdout) ?? `ssh exited ${prepared.status}`,
    };
  }
  const outcomes = await mapWithLimit(localPaths, UPLOAD_CONCURRENCY, async (localPath) => {
    if (signal?.aborted) return { remotePath: '', ok: false, error: 'upload cancelled' };
    const remotePath = remotePathInBatch(directory, localPath);
    const result = await runSsh(scp, scpArgs(session, localPath, remotePath), UPLOAD_TIMEOUT_MS, {
      cwd: session.workingDirectory,
      signal,
    });
    return {
      remotePath,
      ok: result.status === 0,
      error: result.status === 0
        ? null
        : bestErrorLine(result.stderr, result.stdout) ?? `scp exited ${result.status}`,
    };
  });

  const failure = outcomes.find((outcome) => !outcome.ok);
  if (failure) {
    await cleanupRemoteDirectory(session, directory);
    return { ok: false, remotePaths: [], error: failure.error ?? 'upload failed' };
  }

  return { ok: true, remotePaths: outcomes.map((outcome) => outcome.remotePath) };
}

/** Best-effort `rm -f` of paths from a batch that did not complete. */
export async function cleanupRemotePaths(session: DetectedSsh, remotePaths: string[]): Promise<void> {
  if (remotePaths.length === 0) return;
  try {
    await runSsh(toolForSession(session, 'ssh'), cleanupArgs(session, remotePaths), CLEANUP_TIMEOUT_MS, {
      cwd: session.workingDirectory,
    });
  } catch {
    // Rollback is a courtesy. Leaving a stray file in the remote's /tmp is a far
    // smaller problem than masking the upload error the caller is about to show.
  }
}


/** Best-effort recursive removal of one private upload batch. */
export async function cleanupRemoteDirectory(session: DetectedSsh, directory: string): Promise<void> {
  try {
    await runSsh(toolForSession(session, 'ssh'), cleanupDirectoryArgs(session, directory), CLEANUP_TIMEOUT_MS, {
      cwd: session.workingDirectory,
    });
  } catch {
    // Cleanup must never mask the transfer error.
  }
}
