/**
 * remote-upload.ts — copy local files to the host a pane is ssh'd into, so a
 * pasted screenshot or a dropped file is reachable from the remote shell.
 *
 * Ported from cmux's `RemoteSessionCoordinator+Upload.swift` and the
 * `scpArguments` / `cleanupUploadedRemotePaths` halves of
 * `TerminalSSHSessionDetector.swift` (manaflow-ai/cmux).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { optionKey, type DetectedSsh } from './ssh-argv';
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

/**
 * `-o` keys deliberately dropped when composing an scp/ssh invocation.
 *
 * These are session-shaping options that are meaningless for a one-shot copy,
 * and `RemoteCommand` / `RequestTTY` actively break the transfer. The filter
 * lives here rather than in the parser because "what scp tolerates" is this
 * module's concern; the parser's job is to report the command line as written.
 * cmux's `filteredSSHOptionKeys`.
 */
const UNSAFE_FOR_TRANSFER = new Set([
  'batchmode',
  'controlmaster',
  'controlpersist',
  'forkafterauthentication',
  'localcommand',
  'permitlocalcommand',
  'remotecommand',
  'requesttty',
  'sendenv',
  'sessiontype',
  'setenv',
  'stdioforward',
]);

// Re-exported so the scp/rollback tests can reach it from the module whose
// argv they are pinning. The rule itself lives in system32.ts, because the
// pane wmux spawns has to reach the same host as the scp it uploads with.
export { opensshPath };

/**
 * The ssh/scp binary to reach this session's host with.
 *
 * Prefers the sibling of the ssh the pane actually connected with, because the
 * two builds on a typical Windows box do not share an agent (see opensshPath).
 * Falls back to Windows OpenSSH when the session did not name a path (a bare
 * `ssh`, so PATH decided and we cannot know what it chose) or when the sibling
 * is missing.
 */
export function toolForSession(
  session: DetectedSsh,
  tool: 'ssh' | 'scp',
  exists: (p: string) => boolean = fs.existsSync
): string {
  const configured = session.sshExecutable?.trim();
  if (configured) {
    const sibling = path.join(path.dirname(configured), `${tool}${path.extname(configured) || '.exe'}`);
    if (exists(sibling)) return sibling;
    throw new Error(`matching ${tool} executable not found beside ${configured}`);
  }
  return opensshPath(tool);
}

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

/** True when `options` already sets `key`, so we must not add our own default. */
function hasOptionKey(options: string[], key: string): boolean {
  const lowered = key.toLowerCase();
  return options.some((option) => optionKey(option) === lowered);
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

/**
 * Connection flags shared by the upload and its rollback.
 *
 * `BatchMode=yes` is the important one: these run with no TTY attached, so an
 * interactive password or passphrase prompt has nowhere to go and would simply
 * hang until the timeout. Key/agent auth only — the same trade cmux makes.
 */
function commonArgs(session: DetectedSsh, portFlag: '-P' | '-p'): string[] {
  const replayable = session.sshOptions.filter((option) => {
    const key = optionKey(option);
    return !key || !UNSAFE_FOR_TRANSFER.has(key);
  });

  const args: string[] = [
    '-q',
    '-o', 'ConnectTimeout=6',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'BatchMode=yes',
    '-o', 'ControlMaster=no',
    // A file copy has no business replaying the user's port forwards. Measured
    // at ~150ms of every upload on a config with a RemoteForward in it, since
    // ssh sets the forwards up during the handshake — and when the port is
    // already bound (a live `wmux bridge` tunnel) it also prints a warning onto
    // stderr that has nothing to do with the transfer.
    '-o', 'ClearAllForwardings=yes',
  ];

  if (session.addressFamily) args.push(`-${session.addressFamily}`);
  if (session.forwardAgent) args.push('-A');
  if (session.compression) args.push('-C');
  if (session.configFile?.trim()) args.push('-F', session.configFile.trim());
  if (session.jumpHost?.trim()) args.push('-J', session.jumpHost.trim());
  if (session.port !== undefined) args.push(portFlag, String(session.port));
  for (const identityFile of session.identityFiles ?? []) {
    if (identityFile.trim()) args.push('-i', identityFile.trim());
  }
  // Reuse the pane's existing multiplexed connection when it has one: no second
  // authentication, so an agent that prompts on use stays quiet.
  if (session.controlPath?.trim() && !hasOptionKey(replayable, 'ControlPath')) {
    args.push('-o', `ControlPath=${session.controlPath.trim()}`);
  }
  for (const option of replayable) args.push('-o', option);

  return args;
}

/** Full scp argv for one file. Exported so tests can pin it, as cmux does. */
export function scpArgs(session: DetectedSsh, localPath: string, remotePath: string): string[] {
  return [
    ...commonArgs(session, '-P'),
    localPath,
    `${scpDestination(session.destination)}:${remotePath}`,
  ];
}

/** Full ssh argv for the rollback command. */
export function cleanupArgs(session: DetectedSsh, remotePaths: string[]): string[] {
  const script = `rm -f -- ${remotePaths.map(posixShellQuote).join(' ')}`;
  return [
    '-T',
    ...commonArgs(session, '-p'),
    session.destination,
    `sh -c ${posixShellQuote(script)}`,
  ];
}

export function prepareDirectoryArgs(session: DetectedSsh, directory: string): string[] {
  const script = `umask 077 && mkdir -m 700 -- ${posixShellQuote(directory)}`;
  return ['-T', ...commonArgs(session, '-p'), session.destination, `sh -c ${posixShellQuote(script)}`];
}

export function cleanupDirectoryArgs(session: DetectedSsh, directory: string): string[] {
  const script = `rm -rf -- ${posixShellQuote(directory)}`;
  return ['-T', ...commonArgs(session, '-p'), session.destination, `sh -c ${posixShellQuote(script)}`];
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(
  executable: string,
  args: string[],
  timeout: number,
  cwd?: string,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        executable,
        args,
        { windowsHide: true, timeout, maxBuffer: 1024 * 1024, cwd, signal },
        (err, stdout, stderr) => {
          if (err) {
            const code = typeof (err as NodeJS.ErrnoException).code === 'number'
              ? ((err as NodeJS.ErrnoException).code as unknown as number)
              : 1;
            resolve({ status: code || 1, stdout: String(stdout), stderr: String(stderr || err.message) });
            return;
          }
          resolve({ status: 0, stdout: String(stdout), stderr: String(stderr) });
        }
      );
    } catch (err) {
      resolve({ status: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
    }
  });
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
  const prepared = await run(
    ssh,
    prepareDirectoryArgs(session, directory),
    CLEANUP_TIMEOUT_MS,
    session.workingDirectory,
    signal,
  );
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
    const result = await run(
      scp,
      scpArgs(session, localPath, remotePath),
      UPLOAD_TIMEOUT_MS,
      session.workingDirectory,
      signal,
    );
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
    await run(
      toolForSession(session, 'ssh'),
      cleanupArgs(session, remotePaths),
      CLEANUP_TIMEOUT_MS,
      session.workingDirectory,
    );
  } catch {
    // Rollback is a courtesy. Leaving a stray file in the remote's /tmp is a far
    // smaller problem than masking the upload error the caller is about to show.
  }
}


/** Best-effort recursive removal of one private upload batch. */
export async function cleanupRemoteDirectory(session: DetectedSsh, directory: string): Promise<void> {
  try {
    await run(
      toolForSession(session, 'ssh'),
      cleanupDirectoryArgs(session, directory),
      CLEANUP_TIMEOUT_MS,
      session.workingDirectory,
    );
  } catch {
    // Cleanup must never mask the transfer error.
  }
}
