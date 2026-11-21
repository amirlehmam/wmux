/**
 * wsl-local.ts — a constant script as a process in a WSL distro, for a folder on a WSL share.
 *
 * The ssh route reaches a host as `wsl.exe -d <distro> --exec ssh <options> <destination> <command>`.
 * A folder that is already in a distro has no host to reach, so the same command is
 * run by the distro's own `sh`:
 *
 *     wsl.exe -d <distro> --exec sh -c "set -f;IFS=;eval $(echo <base64>|base64 -d)"
 *
 * The base64 is `sh -c '<script>' sh '<arg>'...` with every value quoted
 * (`posixRemoteCommand`, the one function the ssh route builds its command with), so the
 * argv holds no byte of the script's arguments and none that wsl.exe could re-parse
 * (no quote, backslash or percent sign): what is user-controlled, a path, a git
 * argument, reaches the script as a positional argument inside the base64. Nothing is
 * `--cd`'d to: the script is given the directory as its first argument and runs
 * `git -C` there, as git would from that directory.
 *
 * No environment is forwarded (no WSLENV): the scripts set what they need (a batch
 * exports `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`, as `git()` passes them
 * to a per-call spawn through WSLENV).
 */

import type { BatchInvocation } from './exec-git-batch';
import type { WslGitContext } from './exec-location';
import { wslRemoteCommand } from './ssh-exec';
import { posixRemoteCommand } from './ssh-command';
import { wslExecutable, wslSystemRoot } from './system32';

/**
 * Run `script` with `args` (the first of which is the directory it works in) inside
 * the distro of `context`. The directory is checked as `sshScriptCommand` checks a
 * remote path: absolute, no NUL.
 */
export function wslScriptCommand(
  context: WslGitContext,
  script: string,
  cwd: string,
  args: string[],
): BatchInvocation {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
    throw new Error('Not a path in the WSL distro');
  }
  return {
    file: wslExecutable(),
    args: ['-d', context.wsl.distro, '--exec', 'sh', '-c', wslRemoteCommand(posixRemoteCommand(script, args))],
    // Only has to exist: nothing in the distro sees it.
    cwd: wslSystemRoot(),
    env: { ...process.env },
    wsl: false,
  };
}
