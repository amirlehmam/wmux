/**
 * ssh-command.ts — how a command for a remote host becomes a process, and how a
 * remote file is named in the renderer.
 *
 * Split out of ssh-explorer.ts because the git modules, the worker and the
 * location types all need these builders, while ssh-explorer needs the snapshot
 * cache: with the builders in ssh-explorer the modules imported each other in a
 * ring. This module imports only ssh-exec, shell-quote and system32 (and types),
 * so it can be loaded first by anything.
 */

import { posixShellQuote } from './shell-quote';
import { sshArgs, wslRemoteCommand, wslSshArgs } from './ssh-exec';
import { wslExecutable, wslSystemRoot } from './system32';
import type { SshTarget } from './ssh-targets';
import { REMOTE_IDENTITY_PREFIX } from '../shared/remote-identity';

/**
 * The identity of a remote file in the renderer. NOT a local path and cannot
 * resolve to one: anything that mistakes it for a local file (a markdown reload,
 * a drag) finds nothing, rather than reading or writing a local file that
 * happens to sit at the same spelling.
 */
export function remoteFilePath(target: SshTarget, relSegments: string[]): string {
  const { destination, port } = target.session;
  const host = port !== undefined ? `${destination}:${port}` : destination;
  return `${REMOTE_IDENTITY_PREFIX}${host}${[target.path, ...relSegments].join('/')}`;
}

/** The remote command: `sh -c '<script>' sh '<arg>'…`, every value quoted, the script a constant. */
export function posixRemoteCommand(script: string, args: string[]): string {
  return ['sh', '-c', posixShellQuote(script), 'sh', ...args.map(posixShellQuote)].join(' ');
}

/** The ssh argv: connection options from the target, then the destination, then one command string. */
export function remoteCommandArgs(target: SshTarget, script: string, args: string[]): string[] {
  return ['-T', ...sshArgs(target.session, '-p'), target.session.destination, posixRemoteCommand(script, args)];
}

/** What to spawn for one remote command. */
export interface SshInvocation {
  file: string;
  args: string[];
  /** Set on the WSL route: the Windows directory, since `session.workingDirectory` means nothing inside WSL. */
  cwd?: string;
  /** True when ssh runs inside WSL, so wsl.exe's own failures read as unreachable. */
  viaWsl: boolean;
}

/**
 * THE one place an explorer or git command becomes a process: the target's
 * `wslDistro` picks between the host's ssh (`tool`) and ssh inside WSL, with no
 * fallback from one to the other. On the WSL route `tool` is never asked:
 * Windows OpenSSH is not what runs there.
 */
export function remoteInvocation(
  target: SshTarget,
  script: string,
  args: string[],
  tool: (target: SshTarget) => string,
): SshInvocation {
  if (target.wslDistro !== undefined) {
    return {
      file: wslExecutable(),
      args: wslSshArgs(target.session, target.wslDistro, wslRemoteCommand(posixRemoteCommand(script, args))),
      cwd: wslSystemRoot(),
      viaWsl: true,
    };
  }
  return { file: tool(target), args: remoteCommandArgs(target, script, args), viaWsl: false };
}
