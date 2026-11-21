/**
 * exec-worker-script.ts — what a persistent worker runs and how a call's argv is recognised for it.
 *
 * The constant scripts (the worker's loop, the single local git call) and the parsers that turn a
 * `wsl.exe` argv into the request a worker serves. No process and no state here: the engine that
 * runs workers is exec-worker.ts, and the runners that route a call to it are exec-worker-routed.ts.
 */

import type { ExecLocKind } from './exec-location';
import { posixShellQuote } from './shell-quote';
import { isWslDistroName } from '../shared/wsl-distro';

// ─── The worker's script ─────────────────────────────────────────────────────

/**
 * What the worker runs: a constant. Nothing a request carries is ever part of
 * it. It reads request lines from stdin, one request at a time, and answers as
 * described in exec-worker.ts's header. Exits (and cleans its temp dir) when stdin closes.
 */
export const LOOP_SCRIPT = `tmp=$(mktemp -d "\${TMPDIR:-/tmp}/wmux-w.XXXXXX") || exit 97
trap 'rm -rf "$tmp"' EXIT
trap 'exit 0' HUP INT TERM
nonce=
while IFS=' ' read -r tag arg; do
  case $tag in
    Q) nonce=$arg; : >"$tmp/c"; : >"$tmp/i";;
    C) printf '%s\\n' "$arg" >>"$tmp/c";;
    I) printf '%s\\n' "$arg" >>"$tmp/i";;
    G)
      if [ -z "$nonce" ] || [ "$arg" != "$nonce" ]; then exit 98; fi
      cmd=$(base64 -d <"$tmp/c" 2>/dev/null)
      base64 -d <"$tmp/i" >"$tmp/in" 2>/dev/null || : >"$tmp/in"
      ( set -f; eval "$cmd" ) <"$tmp/in" >"$tmp/o" 2>"$tmp/e"
      st=$?
      set -- $(wc -c "$tmp/o" "$tmp/e")
      printf '%s BEGIN\\n' "$nonce"
      base64 <"$tmp/o" | sed 's/^/O /'
      base64 <"$tmp/e" | sed 's/^/E /'
      printf 'S %s %s %s\\n%s END\\n' "$st" "$1" "$3" "$nonce"
      nonce=;;
    *) exit 99;;
  esac
done
`;

/**
 * The remote command of a worker. Like the per-call command it is base64 and
 * eval only (no quote, backslash or percent sign for wsl.exe to mangle), and it
 * is a constant: it holds nothing from any request. The login shell decodes the
 * outer layer and replaces itself with a plain POSIX `sh` running the loop.
 */
export const WORKER_REMOTE_COMMAND = (() => {
  const loop = Buffer.from(LOOP_SCRIPT, 'utf8').toString('base64');
  const outer = `exec sh -c "$(echo ${loop}|base64 -d)" sh`;
  return `set -f;IFS=;eval $(echo ${Buffer.from(outer, 'utf8').toString('base64')}|base64 -d)`;
})();

// ─── Recognising the WSL route ───────────────────────────────────────────────

const WSL_COMMAND = /^set -f;IFS=;eval \$\(echo ([A-Za-z0-9+/=]+)\|base64 -d\)$/;

export interface WslSshInvocation {
  distro: string;
  destination: string;
  /** Everything before the remote command: distro, `--exec ssh`, the options and the destination. */
  prefix: string[];
  /** The base64 of the command line the per-call route would run. */
  payload: string;
}

/**
 * The parts of a `wslSshArgs` + `wslRemoteCommand` argv, or undefined when
 * `args` is anything else (the direct route, scp, a plain git in WSL).
 */
export function parseWslSshInvocation(args: readonly string[]): WslSshInvocation | undefined {
  if (args.length < 6 || args[0] !== '-d' || args[2] !== '--exec' || args[3] !== 'ssh') return undefined;
  const match = WSL_COMMAND.exec(args[args.length - 1]);
  if (!match) return undefined;
  return {
    distro: args[1],
    destination: args[args.length - 2],
    prefix: args.slice(0, -1),
    payload: match[1],
  };
}

/** What a routed call is, whichever place it runs in: the engine (exec-worker.ts) is keyed by this. */
export interface WorkerInvocation extends WslSshInvocation {
  loc: ExecLocKind;
  /**
   * A single local `git` call: its exit status 125 means "could not change into the
   * directory" (git itself never exits so), which the per-call `--cd` reports in its own
   * words, so that status is run per call.
   */
  perCallOn125?: true;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What a local `git` call runs in the worker: change into the directory (the first argument),
 * then `env <NAME=value...> git <args>`. A constant; every value reaches it as an argument.
 * Exits 125 when it cannot change directory.
 */
export const LOCAL_GIT_SCRIPT = 'cd -- "$1" 2>/dev/null || exit 125\nshift\nexec env "$@"\n';

/** The command line the worker runs for a local git call: `sh -c '<script>' sh '<dir>' 'NAME=value'... 'git' '<arg>'... */
function localGitCommand(cwd: string, env: Record<string, string>, gitArgs: readonly string[]): string {
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  return ['sh', '-c', posixShellQuote(LOCAL_GIT_SCRIPT), 'sh',
    ...[cwd, ...assignments, 'git', ...gitArgs].map(posixShellQuote)].join(' ');
}

/**
 * The parts of a call into a WSL distro the worker can serve, or undefined for anything else:
 *
 *  - `-d <distro> --exec sh -c <wsl command>`: a script (the git batch, the fingerprint), whose
 *    base64 is the request, as on the ssh route;
 *  - `-d <distro> --cd <dir> --exec git <args>`, when the caller passes `wslEnv` (the variables
 *    it forwards through WSLENV): one git call. Without `wslEnv` the caller has not said what its
 *    environment is, and the call is a spawn.
 */
export function parseWslLocalInvocation(
  args: readonly string[],
  wslEnv?: Record<string, string>,
): WorkerInvocation | undefined {
  if (args.length < 6 || args[0] !== '-d' || !isWslDistroName(args[1])) return undefined;
  const distro = args[1];
  if (args.length === 6 && args[2] === '--exec' && args[3] === 'sh' && args[4] === '-c') {
    const match = WSL_COMMAND.exec(args[5]);
    if (!match) return undefined;
    return { loc: 'wsl', distro, destination: '', prefix: args.slice(0, 5), payload: match[1] };
  }
  if (args.length >= 7 && args[2] === '--cd' && args[4] === '--exec' && args[5] === 'git' && wslEnv !== undefined) {
    const cwd = args[3];
    if (!cwd.startsWith('/') || cwd.includes('\0')) return undefined;
    if (Object.entries(wslEnv).some(([name, value]) => !ENV_NAME.test(name) || value.includes('\0'))) return undefined;
    if (args.slice(6).some((arg) => arg.includes('\0'))) return undefined;
    return {
      loc: 'wsl',
      distro,
      destination: '',
      prefix: ['-d', distro, '--exec', 'sh', '-c'],
      payload: Buffer.from(localGitCommand(cwd, wslEnv, args.slice(6)), 'utf8').toString('base64'),
      perCallOn125: true,
    };
  }
  return undefined;
}

/** Either place's call, or undefined. */
export function parseWorkerInvocation(args: readonly string[], wslEnv?: Record<string, string>): WorkerInvocation | undefined {
  const ssh = parseWslSshInvocation(args);
  return ssh ? { ...ssh, loc: 'ssh' } : parseWslLocalInvocation(args, wslEnv);
}
