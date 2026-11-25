/**
 * ssh-master.ts — close the ssh connection wmux left open in a WSL distro when it quits.
 *
 * The WSL route shares one ControlMaster per host (`ControlPersist=300`, `ssh-exec.ts`), so that a view's many
 * calls ride one login. The master is a background `ssh` in the distro that outlives wmux by up to five
 * minutes, showing as `ssh: /tmp/wmux-... [mux]`. On a normal quit it is closed here, with `ssh -O exit` on the
 * same ControlPath (the options that name it, `-F`, `-J`, `-p`, the destination, are replayed as for any
 * other call). A killed wmux cannot do that and leaves it for the five minutes: a shorter persist would end
 * the persistent worker's connection sooner too (the two are tied, `SSH_CONNECTION_PERSIST_S`), and cost a new
 * login after every short pause.
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { wslSshOptionArgs } from './ssh-exec';
import type { SshTarget } from './ssh-targets';
import { wslExecutable, wslSystemRoot } from './system32';

/** Most masters closed on one quit, and the longest one may take: a quit must never wait on this. */
export const MAX_MASTERS_CLOSED = 8;
export const MASTER_EXIT_TIMEOUT_MS = 1500;

export interface MasterExit {
  file: string;
  args: string[];
  cwd: string;
}

/**
 * One `wsl.exe -d <distro> --exec ssh ... -O exit <destination>` per distinct connection of the WSL-route
 * `targets`: the same options as a view's call, so ssh derives the same ControlPath, with `-O exit` in place
 * of a command. Targets that are not on the WSL route have no master of ours. Two targets that differ
 * only in their checkout share one.
 */
export function masterExits(targets: readonly SshTarget[]): MasterExit[] {
  const seen = new Set<string>();
  const exits: MasterExit[] = [];
  for (const target of targets) {
    if (target.wslDistro === undefined) continue;
    const args = [...wslSshOptionArgs(target.session, target.wslDistro), '-O', 'exit', target.session.destination];
    const key = JSON.stringify(args);
    if (seen.has(key)) continue;
    seen.add(key);
    exits.push({ file: wslExecutable(), args, cwd: wslSystemRoot() });
  }
  return exits;
}

type Run = (file: string, args: string[], options: { cwd: string; timeout: number; windowsHide: true; stdio: 'ignore' }) => Pick<SpawnSyncReturns<Buffer>, 'status'>;

/**
 * Close the masters of `targets`, one after another, each bounded by `MASTER_EXIT_TIMEOUT_MS`. Synchronous
 * because quit is. A master that is already gone, or an `ssh` that fails, is not an error: nothing here may
 * stop wmux from quitting. Returns how many were asked.
 */
export function closeSshMasters(targets: readonly SshTarget[], run: Run = spawnSync): number {
  let asked = 0;
  for (const exit of masterExits(targets).slice(0, MAX_MASTERS_CLOSED)) {
    asked++;
    try {
      run(exit.file, exit.args, { cwd: exit.cwd, timeout: MASTER_EXIT_TIMEOUT_MS, windowsHide: true, stdio: 'ignore' });
    } catch {
      /* the process could not even start (no wsl.exe): the master dies on its own persist */
    }
  }
  return asked;
}
