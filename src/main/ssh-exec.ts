/**
 * ssh-exec.ts — the one place wmux main builds an `ssh` command line from a
 * parsed session and runs it.
 *
 * Shared by `remote-upload.ts` and the remote explorer and git views: reach the
 * host a pane's ssh reaches, non-interactively, with the pane's own `-F -J -p
 * -i`. Two copies of "which options may be replayed" would be two chances to
 * let one of them prompt for a password or replay a port forward.
 *
 * With a target's `wslDistro` the same command runs inside WSL instead
 * (`wslSshArgs`): see there for why and for what is replayed.
 *
 * A remote command is ONE argument — a POSIX `sh` script quoted with
 * `posixShellQuote` — and anything user-controlled goes to it as a positional
 * argument or on stdin, never interpolated into the script.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { optionKey, type DetectedSsh } from './ssh-argv';
import { opensshPath } from './system32';
import type { SpawnVia } from './exec-trace';

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

/** True when `options` already sets `key`, so we must not add our own default. */
function hasOptionKey(options: string[], key: string): boolean {
  const lowered = key.toLowerCase();
  return options.some((option) => optionKey(option) === lowered);
}

/**
 * Connection flags shared by the upload and its rollback.
 *
 * `BatchMode=yes` is the important one: these run with no TTY attached, so an
 * interactive password or passphrase prompt has nowhere to go and would simply
 * hang until the timeout. Key/agent auth only — the same trade cmux makes.
 */
export function sshArgs(session: DetectedSsh, portFlag: '-P' | '-p'): string[] {
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

/**
 * The options a WSL-hosted ssh must not take from the pushed argv: the ones
 * dropped for a transfer, plus the three this module sets itself. `ControlPath`
 * is replaced rather than reused because the pane's own multiplexed connection
 * is a socket on the Windows side's idea of a path, and a master wmux starts
 * with `ControlPersist` must not land on a socket the user's pane owns.
 */
const REPLACED_FOR_WSL = new Set([...UNSAFE_FOR_TRANSFER, 'controlpath', 'clearallforwardings']);

/**
 * How long the shared ssh connection outlives its last use, in seconds. The
 * persistent worker (exec-worker.ts) keeps its own idle lifetime equal to this, so
 * the worker and the connection under it cannot drift apart.
 */
export const SSH_CONNECTION_PERSIST_S = 300;

/** execFile's own default, for a call that names no `maxBuffer`. */
export const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * One multiplexed connection per remote host, shared by every wmux call, gone five
 * minutes after the last. The first call of a burst pays to open the master, so
 * it should outlive a pause in the user's work. The ssh the sidebar runs when a
 * target is set is the first call, and opens it early.
 */
const WSL_CONTROL_OPTIONS = ['ControlMaster=auto', 'ControlPath=/tmp/wmux-%C', `ControlPersist=${SSH_CONNECTION_PERSIST_S}`];

/**
 * The argv for `wsl.exe` that runs ssh INSIDE `distro`: `-d <distro> --exec ssh
 * <options> <destination> <remote command>`.
 *
 * Windows `ssh.exe` has neither the key a remote host accepts nor the caller's
 * pinned known_hosts (a WSL path), so ssh runs where both are. The words come
 * from the argv the caller pushed, which already holds WSL-side values
 * (`-F`, `-J`, `-i`, `-o UserKnownHostsFile=<WSL path>`): nothing is translated,
 * and no Windows-side file option is added. `--exec` means no shell on the
 * Linux side of wsl.exe either; the only parse left is the one in ssh's own
 * remote command, which `wslRemoteCommand` makes quote-free.
 *
 * The non-interactive options are the ones `sshArgs` sets, minus
 * `ControlMaster=no`: a view makes many calls, and a new ssh connection for each
 * would cost far more than riding one ControlMaster.
 */
export function wslSshArgs(session: DetectedSsh, distro: string, remoteCommand: string): string[] {
  return [...wslSshOptionArgs(session, distro), session.destination, remoteCommand];
}

/** `wslSshArgs` up to, and not including, the destination: `wsl.exe` and ssh's own options. */
export function wslSshOptionArgs(session: DetectedSsh, distro: string): string[] {
  const replayable = session.sshOptions.filter((option) => {
    const key = optionKey(option);
    return !key || !REPLACED_FOR_WSL.has(key);
  });
  const args: string[] = ['-d', distro, '--exec', 'ssh', '-T', '-q'];
  const option = (value: string) => args.push('-o', value);
  if (!hasOptionKey(replayable, 'ConnectTimeout')) option('ConnectTimeout=6');
  if (!hasOptionKey(replayable, 'ServerAliveInterval')) option('ServerAliveInterval=20');
  if (!hasOptionKey(replayable, 'ServerAliveCountMax')) option('ServerAliveCountMax=2');
  option('BatchMode=yes');
  option('ClearAllForwardings=yes');
  for (const control of WSL_CONTROL_OPTIONS) option(control);

  if (session.addressFamily) args.push(`-${session.addressFamily}`);
  if (session.forwardAgent) args.push('-A');
  if (session.compression) args.push('-C');
  if (session.configFile?.trim()) args.push('-F', session.configFile.trim());
  if (session.jumpHost?.trim()) args.push('-J', session.jumpHost.trim());
  if (session.port !== undefined) args.push('-p', String(session.port));
  for (const identityFile of session.identityFiles ?? []) {
    if (identityFile.trim()) args.push('-i', identityFile.trim());
  }
  for (const replayed of replayable) option(replayed);
  return args;
}

/**
 * A POSIX command line as ONE argument that survives Node -> the Windows
 * command line -> wsl.exe -> ssh unchanged.
 *
 * A quoted command is full of `'`, `"`, `$`, newlines and (for a hostile file
 * name) backslashes, and each of those is something one of the three parsers on
 * that route treats as special. How wsl.exe re-parses its command line could not
 * be verified, so nothing is left for it to parse: the command travels as base64
 * (`[A-Za-z0-9+/=]`) and the remote host decodes and evaluates it. `set -f` and an
 * empty `IFS` keep the unquoted substitution one literal word (no glob, no
 * field splitting), and `eval` runs `sh -c '<script>' sh '<args>'` exactly as
 * the direct route does. The child inherits stdin, so a write's content still
 * arrives on it. The text holds no quote, backslash or percent sign. (`echo` rather than `printf %s`
 * for that last reason: base64 has no backslash for echo to interpret and cannot begin with `-`.)
 */
export function wslRemoteCommand(posixCommand: string): string {
  const encoded = Buffer.from(posixCommand, 'utf8').toString('base64');
  return `set -f;IFS=;eval $(echo ${encoded}|base64 -d)`;
}

/**
 * wsl.exe's own failure statuses on the WSL route: it exits -1 (reported
 * unsigned) when the distro does not exist or cannot start.
 */
const WSL_FAILURE_STATUSES = new Set([4294967295, -1]);

/**
 * True when a run on the WSL route never reached the remote host: ssh's 255, wsl.exe
 * refusing the distro, or wsl.exe not starting at all.
 */
export function isWslRouteUnreachable(status: number, spawnFailed: boolean | undefined): boolean {
  return status === 255 || WSL_FAILURE_STATUSES.has(status) || spawnFailed === true;
}

export interface RunResult {
  /** The process exit status; 255 is ssh's own "could not connect". 1 when it never started. */
  status: number;
  stdout: string;
  stderr: string;
  /** The raw bytes of stdout, for a file read that must not be decoded twice. */
  stdoutBuffer: Buffer;
  /** True when the executable could not be started (ENOENT, EACCES...), whatever `status` says. */
  spawnFailed?: boolean;
  /** Which way a WSL-route call travelled (`exec-worker-routed.ts`); absent on other routes and with the worker off. */
  via?: SpawnVia;
  /** True when this call had to start, or wait for the start of, a worker (`exec-worker-routed.ts`, traced as `cold=1`). */
  cold?: boolean;
}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Written to the child's stdin, then closed. */
  input?: string | Buffer;
  /** Defaults to 1 MiB. */
  maxBuffer?: number;
  /**
   * The call only reads, so running it again after an ambiguous failure of a
   * persistent worker is safe (`exec-worker-routed.ts`). Unsaid: it may write, and is never repeated.
   */
  idempotent?: boolean;
}

/** What the explorer and git code call, so a test can pass a fake. */
export type SshRunner = (
  executable: string,
  args: string[],
  timeout: number,
  options?: RunOptions,
) => Promise<RunResult>;

/** The OS refusing to start the child. Not `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`: that child did run. */
const SPAWN_ERROR_CODES = new Set<unknown>(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ENOEXEC', 'E2BIG', 'EMFILE', 'ENFILE', 'ENOMEM']);

/** True for an execFile `err.code` that means the executable could not be started. */
export function isSpawnErrorCode(code: unknown): boolean {
  return SPAWN_ERROR_CODES.has(code);
}

export function runSsh(
  executable: string,
  args: string[],
  timeout: number,
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        executable,
        args,
        {
          windowsHide: true,
          timeout,
          maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
          cwd: options.cwd,
          signal: options.signal,
          encoding: 'buffer',
        },
        (err, stdout, stderr) => {
          const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''));
          const errText = String(stderr ?? '');
          if (err) {
            const rawCode = (err as NodeJS.ErrnoException).code as unknown;
            const code = typeof rawCode === 'number' ? rawCode : 1;
            resolve({
              status: code || 1,
              stdout: out.toString(),
              stderr: errText || err.message,
              stdoutBuffer: out,
              ...(isSpawnErrorCode(rawCode) ? { spawnFailed: true } : {}),
            });
            return;
          }
          resolve({ status: 0, stdout: out.toString(), stderr: errText, stdoutBuffer: out });
        },
      );
      // stdin is ALWAYS ended, input or not. Windows OpenSSH (9.5) waits on an open
      // stdin pipe before it lets the session finish: left open, about one read in
      // four hung until the timeout, holding one of the host's three spawn slots.
      // A child that exits before reading all of its input raises EPIPE here; the
      // exit status is the answer, not this.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ status: 1, stdout: '', stderr: message, stdoutBuffer: Buffer.alloc(0), spawnFailed: true });
    }
  });
}
