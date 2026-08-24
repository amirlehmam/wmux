/**
 * ssh-argv.ts — parse an `ssh` command line into the connection facts needed to
 * re-open the same connection with `scp` (remote file upload on paste/drop).
 *
 * Pure: no I/O, no process spawning, no platform calls. Every caller in
 * `ssh-detect.ts` funnels an argv through here, so the detection sources (a
 * `wmux ssh` surface, a shell-integration preexec report, a process-tree probe)
 * cannot disagree about what a given command line means.
 *
 * Ported from cmux's `TerminalSSHSessionDetector.parseSSHCommandLine` and
 * `RemoteShellSessionParsing` (manaflow-ai/cmux). The flag tables and the
 * "bail out rather than guess" posture are theirs; keeping them identical is
 * deliberate, because a mis-parse here does not fail loudly — it uploads a
 * file to the wrong host.
 */

/** Everything `scp` needs to reach the same host as the pane's `ssh`. */
export interface DetectedSsh {
  /** `user@host` or `host` — already merged with any `-l user` / `-o User=`. */
  destination: string;
  port?: number;
  identityFile?: string;
  configFile?: string;
  jumpHost?: string;
  controlPath?: string;
  /**
   * `-4` / `-6`, when the command line forced one. A single field rather than
   * two booleans: the two are mutually exclusive, and every consumer would
   * otherwise have to re-encode that exclusivity when turning it back into a
   * flag.
   */
  addressFamily?: 4 | 6;
  forwardAgent: boolean;
  compression: boolean;
  /** Raw `-o key=value` strings, as written. */
  sshOptions: string[];
  /**
   * The ssh binary this session was launched with, when argv named a path
   * rather than a bare `ssh`.
   *
   * Kept because Windows commonly has more than one ssh, and they are not
   * interchangeable: Git for Windows ships an MSYS2 build that cannot talk to a
   * Windows named-pipe ssh-agent, while `System32\OpenSSH` can. The upload has
   * to use the scp that matches whichever one the pane actually connected with,
   * or it authenticates differently — or not at all — against the same host.
   */
  sshExecutable?: string;
}

// OpenSSH short flags that take no value. From ssh(1); matches cmux's table.
const NO_ARG_FLAGS = new Set('46AaCfGgKkMNnqsTtVvXxYy');
// Short flags that consume a value, either glued (-p22) or separate (-p 22).
const VALUE_ARG_FLAGS = new Set('BbcDEeFIiJLlmOopQRSWw');
/**
 * Flags that mean "this is not an interactive remote shell".
 *
 * `n` (stdin from /dev/null), `T` (no pty), `G` (dump config) and `V` (version)
 * are cmux's set. `N` (no remote command) is added here: it is the flag on a
 * pure port forward — the `ssh -N -L 9787:127.0.0.1:9787` shape that
 * `wmux bridge` documents — which has no remote shell to paste into at all.
 */
const NON_INTERACTIVE_FLAGS = new Set('nTGVN');

/** `C:\Windows\System32\OpenSSH\ssh.exe` -> `ssh`; `/usr/bin/ssh` -> `ssh`. */
export function normalizedExecutableName(executable: string): string {
  const trimmed = executable.trim();
  if (!trimmed) return '';
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base.toLowerCase().replace(/\.exe$/, '');
}

/** The key of an `-o key=value` (or `-o key value`) option, lowercased. */
export function optionKey(raw: string): string | null {
  const match = /^([^=\s]+)/.exec(raw.trim());
  return match ? match[1].toLowerCase() : null;
}

function optionValue(raw: string): string | null {
  const match = /^[^=\s]+[=\s]+(.*)$/.exec(raw.trim());
  return match ? match[1].trim() : null;
}

/** Mutable accumulator shared by the flag loop and the `-o` handler. */
interface Accumulator {
  destination?: string;
  port?: number;
  identityFile?: string;
  configFile?: string;
  jumpHost?: string;
  controlPath?: string;
  loginName?: string;
  addressFamily?: 4 | 6;
  forwardAgent: boolean;
  compression: boolean;
  sshOptions: string[];
}

/**
 * True for an `-o` setting that turns the session into something other than an
 * interactive shell.
 */
function isNonInteractiveOption(raw: string): boolean {
  const key = optionKey(raw);
  const value = optionValue(raw)?.toLowerCase();
  if (key === 'remotecommand') {
    // RemoteCommand=none is OpenSSH's explicit request for the normal
    // interactive shell.
    return value !== 'none';
  }
  if (key === 'requesttty') return value === 'no' || value === 'false';
  if (key === 'stdinnull') return value === 'yes' || value === 'true';
  return key === 'sessiontype' && value === 'none';
}

/**
 * Fold one `-o key=value` into the accumulator. Returns false when the option
 * is malformed, or when it means this is not an interactive session — the
 * caller then abandons the whole parse rather than proceeding on a
 * half-understood command line.
 */
function consumeSshOption(raw: string, acc: Accumulator): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (isNonInteractiveOption(trimmed)) return false;
  const key = optionKey(trimmed);
  const value = optionValue(trimmed);

  switch (key) {
    case 'port': {
      if (!value) return false;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed)) return false;
      acc.port = parsed;
      return true;
    }
    case 'identityfile':
      if (!value) return false;
      acc.identityFile = value;
      return true;
    case 'controlpath':
      if (!value) return false;
      acc.controlPath = value;
      return true;
    case 'proxyjump':
      if (!value) return false;
      acc.jumpHost = value;
      return true;
    case 'user':
      if (!value) return false;
      acc.loginName = value;
      return true;
    default:
      acc.sshOptions.push(trimmed);
      return true;
  }
}

function consumeValue(value: string, option: string, acc: Accumulator): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  switch (option) {
    case 'p': {
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(parsed)) return false;
      acc.port = parsed;
      return true;
    }
    case 'i':
      acc.identityFile = trimmed;
      return true;
    case 'F':
      acc.configFile = trimmed;
      return true;
    case 'J':
      acc.jumpHost = trimmed;
      return true;
    case 'S':
      acc.controlPath = trimmed;
      return true;
    case 'l':
      acc.loginName = trimmed;
      return true;
    case 'o':
      return consumeSshOption(trimmed, acc);
    case 'W':
      // A stdio forward, not a shell.
      return false;
    default:
      // Any other value-taking flag (-L, -R, -D, …): consume and ignore, so the
      // loop stays aligned and the destination is still found.
      return VALUE_ARG_FLAGS.has(option);
  }
}

/** `-l user` plus a bare `host` -> `user@host`; an explicit `user@host` wins. */
function resolveDestination(destination: string, loginName?: string): string {
  const trimmed = destination.trim();
  if (!trimmed) return '';
  const login = loginName?.trim();
  if (!login || trimmed.includes('@')) return trimmed;
  return `${login}@${trimmed}`;
}

/**
 * Parse an `ssh` argv into a `DetectedSsh`, or null when the command line is
 * not an interactive ssh session we can confidently reconnect to.
 *
 * Returning null is the safe outcome: the caller falls back to today's
 * behaviour (insert the local Windows path), which is merely useless rather
 * than wrong. Guessing would put the user's file on an unintended host.
 *
 * "Interactive" is decided by this same walk rather than by a second pass —
 * port forwards (`-N`, `-W`), remote-command one-shots (`ssh host ls`) and
 * `-o RequestTTY=no` all make it return null. A separate pre-check would mean
 * two copies of the flag tables that could drift apart, and a drift here does
 * not fail loudly.
 */
export function parseSshArgv(argv: string[]): DetectedSsh | null {
  if (argv.length === 0) return null;

  let index = normalizedExecutableName(argv[0]) === 'ssh' ? 1 : 0;
  const acc: Accumulator = { forwardAgent: false, compression: false, sshOptions: [] };

  while (index < argv.length) {
    const argument = argv[index];

    // The destination, either after `--` or as the first bare operand. Anything
    // following it is a remote command, which is not an interactive shell.
    if (argument === '--' || !argument.startsWith('-') || argument === '-') {
      const destinationIndex = argument === '--' ? index + 1 : index;
      if (destinationIndex !== argv.length - 1) return null;
      acc.destination = argv[destinationIndex];
      break;
    }

    const option = argument.length >= 2 ? argument[1] : '';
    // Glued value: -p2222
    if (argument.length > 2 && VALUE_ARG_FLAGS.has(option)) {
      if (!consumeValue(argument.slice(2), option, acc)) return null;
      index += 1;
      continue;
    }
    // Separate value: -p 2222
    if (argument.length === 2 && VALUE_ARG_FLAGS.has(option)) {
      const next = index + 1;
      if (next >= argv.length || !consumeValue(argv[next], option, acc)) return null;
      index += 2;
      continue;
    }

    // A bundle of no-argument flags: -4AC
    const flags = argument.slice(1).split('');
    if (flags.length === 0 || !flags.every((flag) => NO_ARG_FLAGS.has(flag))) return null;
    if (flags.some((flag) => NON_INTERACTIVE_FLAGS.has(flag))) return null;
    for (const flag of flags) {
      switch (flag) {
        case '4':
          acc.addressFamily = 4;
          break;
        case '6':
          acc.addressFamily = 6;
          break;
        case 'A':
          acc.forwardAgent = true;
          break;
        case 'C':
          acc.compression = true;
          break;
        default:
          break;
      }
    }
    index += 1;
  }

  // Ran off the end without ever finding a destination.
  if (!acc.destination) return null;
  const destination = resolveDestination(acc.destination, acc.loginName);
  if (!destination) return null;

  // Only when argv named a path. A bare `ssh` tells us nothing about which of
  // the machine's ssh binaries PATH picked, and guessing would be worse than
  // letting the caller fall back to a known-good default.
  const executable = normalizedExecutableName(argv[0]) === 'ssh' && /[\\/]/.test(argv[0])
    ? argv[0]
    : undefined;

  return {
    destination,
    sshExecutable: executable,
    port: acc.port,
    identityFile: acc.identityFile,
    configFile: acc.configFile,
    jumpHost: acc.jumpHost,
    controlPath: acc.controlPath,
    addressFamily: acc.addressFamily,
    forwardAgent: acc.forwardAgent,
    compression: acc.compression,
    sshOptions: acc.sshOptions,
  };
}

/** True when this argv opens an interactive remote shell. */
export function isInteractiveSshArgv(argv: string[]): boolean {
  return parseSshArgv(argv) !== null;
}

/**
 * Split a raw command-line *string* — what the shell-integration preexec hook
 * and `Win32_Process.CommandLine` both hand us — into an argv.
 *
 * Windows quoting only: double quotes group, and a doubled `""` inside a quoted
 * run is a literal quote. Single quotes are NOT grouping characters here. On
 * Windows they reach the process verbatim, so `ssh 'user@host'` typed in a
 * POSIX-ish shell must keep its quotes rather than have them silently stripped
 * into a destination that looks valid but is not what ran.
 */
export function splitCommandLine(commandLine: string): string[] {
  const argv: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasContent = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    if (ch === '"') {
      if (inQuotes && commandLine[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
        hasContent = true;
      }
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (hasContent) argv.push(current);
      current = '';
      hasContent = false;
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (hasContent) argv.push(current);
  return argv;
}
