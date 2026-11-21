/**
 * exec-location.ts — WHERE a read-only git (or batch, fingerprint, worker) call runs.
 *
 * Two places have the same cost model, a `wsl.exe` start per call, and so
 * get the same optimisations (one batched spawn, a per-lane gate with a click's
 * priority, a shared fingerprint with back-off, a persistent worker, the trace):
 *
 *  - `ssh`: a workspace whose session lives on a remote host (`SshGitContext`,
 *    ssh-git.ts), reached over `wsl.exe -d <distro> --exec ssh ...` or Windows ssh;
 *  - `wsl`: a workspace whose folder is on a WSL share (`\\wsl.localhost\<distro>\...`),
 *    where git runs inside the distro as `wsl.exe -d <distro> --cd <dir> --exec git ...`
 *    (`WslGitContext`, below).
 *
 * `GitContext` is either, and the helpers here are the only places that tell them
 * apart: a lane (what shares a spawn cap), a location (what one cached answer or one
 * fingerprint belongs to), the directory the call is about, and a word for the trace.
 * The batch (exec-git-batch.ts), snapshot (exec-snapshot.ts) and worker (exec-worker.ts)
 * modules are keyed by these, so there is one copy of each.
 *
 * Nothing here decides WHETHER a call is optimised: for a WSL folder that is up to the
 * caller, which only does so for a UNC path it can name a distro and a directory for,
 * and any failure there is the per-call `wsl.exe --exec git`.
 */

import { remoteFilePath } from './ssh-command';
import { sshLaneKey } from './exec-gate';
import type { SshGitContext } from './ssh-git';

/** What a trace line calls the two places (exec-trace.ts). */
export type ExecLocKind = 'ssh' | 'wsl';

/** A folder on a WSL share: the distro and the directory in it, as POSIX. */
export interface WslGitContext {
  wsl: { distro: string; posix: string };
  /** Mirrors `SshGitContext.unreachable`; never set, since a WSL call that fails is just run again per call. */
  unreachable?: boolean;
}

export type GitContext = SshGitContext | WslGitContext;

export const isWslContext = (context: GitContext): context is WslGitContext => 'wsl' in context;

export function locKind(context: GitContext): ExecLocKind {
  return isWslContext(context) ? 'wsl' : 'ssh';
}

/**
 * What shares one spawn cap (exec-gate.ts): a host connection for ssh, a distro for a
 * WSL folder (every folder of a distro starts the same `wsl.exe`). The two never collide.
 */
export function contextLaneKey(context: GitContext): string {
  return isWslContext(context) ? `\0wsl\0${context.wsl.distro}` : sshLaneKey(context.target);
}

/** What one cached answer or one fingerprint belongs to: the checkout, on its host or in its distro. */
export function contextLocationKey(context: GitContext): string {
  return isWslContext(context) ? `wsl://${context.wsl.distro}${context.wsl.posix}` : remoteFilePath(context.target, []);
}

/** The directory the context is about, as the place it runs names it (always POSIX). */
export function contextPath(context: GitContext): string {
  return isWslContext(context) ? context.wsl.posix : context.target.path;
}
