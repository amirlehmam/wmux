/**
 * exec-warm.ts — start a workspace's persistent worker before the first click.
 *
 * The worker (exec-worker.ts) is started lazily by the first request of a host and ends
 * after its idle lifetime, so the request after a pause pays a `wsl.exe` start and two
 * handshakes. When a person comes back to a workspace, that start can already be running.
 *
 * Called when a target is set (`workspace.set_ssh_target`) and when an ssh workspace or a
 * WSL folder is the one on screen (the window showing it, or a switch to it):
 *
 *  - only for a VISIBLE workspace: the callers decide that (the active workspace of a
 *    window that is shown and not minimised);
 *  - only where the worker exists, and not when `WMUX_SSH_WORKER=0` (`warmExecWorker`);
 *  - through the same lazy path and handshake as a request, never blocking the caller:
 *    every error is swallowed into the ordinary worker back-off, and the requests use
 *    spawns;
 *  - at background priority: the start waits for a free background slot of the host's
 *    gate (`exec-gate.ts`), so it never takes the slot kept for a click;
 *  - once: a host that has a worker, one starting, or one backed off is left alone, so a
 *    window focus every few seconds costs a map lookup.
 *
 * It starts nothing the next request would not have started itself, only earlier; a
 * request that arrives while it runs waits for the same start.
 */

import { contextLaneKey } from './exec-location';
import { wslGitContextFor } from './git-view';
import { remoteInvocation } from './ssh-command';
import { sshLaneKey, withSpawnSlot } from './exec-gate';
import { getSshTarget, type SshTarget } from './ssh-targets';
import { warmExecWorker } from './exec-worker';
import { wslScriptCommand } from './wsl-local';

/** Lanes with a warm-up waiting for a slot or running, so a burst of triggers asks once. */
const pending = new Set<string>();

/**
 * Start the worker of `lane` in the background, with the argv `buildArgv` makes for it (only
 * its options and destination matter: the worker never runs the command). Returns at once;
 * never throws. `stillWanted` is asked when the start's slot opens: a target cleared while
 * it queued starts nothing.
 */
function warm(
  lane: string,
  buildArgv: () => { file: string; args: string[]; cwd?: string },
  stillWanted: () => boolean = () => true,
): void {
  if (pending.has(lane)) return;
  let argv: ReturnType<typeof buildArgv>;
  try {
    argv = buildArgv();
  } catch {
    return;
  }
  pending.add(lane);
  void withSpawnSlot(lane, async () => { if (stillWanted()) await warmExecWorker(argv.file, argv.args, argv.cwd); }, 'bg')
    .catch(() => undefined)
    .finally(() => pending.delete(lane));
}

/** Start the worker for `target`'s host in the background. Nothing for a target that is not on the WSL route. */
export function warmSshTarget(target: SshTarget, stillWanted?: () => boolean): void {
  if (target.wslDistro === undefined) return;
  // `true` is never run.
  warm(sshLaneKey(target), () => remoteInvocation(target, 'true', [], () => ''), stillWanted);
}

/**
 * Warm what a workspace uses, if `visible` says the workspace is on screen: the worker of its ssh
 * target when it has one on the WSL route, and the worker of the WSL distro when `folder` is on a WSL
 * share. `visible` is asked first and a failure counts as "no". A folder that is not on a WSL share
 * (a drive path, an ssh workspace's) starts nothing.
 */
export async function warmWorkspace(
  workspaceId: string,
  folder: unknown,
  visible: () => boolean | Promise<boolean>,
): Promise<void> {
  const target = getSshTarget(workspaceId);
  const ssh = target?.wslDistro !== undefined ? target : undefined;
  const wsl = wslGitContextFor(folder);
  if (!ssh && !wsl) return;
  let shown: boolean;
  try {
    shown = await visible();
  } catch {
    return;
  }
  if (!shown) return;
  if (ssh) warmSshTarget(ssh, () => getSshTarget(workspaceId) === ssh);
  if (wsl) warm(contextLaneKey(wsl), () => wslScriptCommand(wsl, 'true', '/', ['/']));
}

/** Tests only. */
export function resetExecWarmForTests(): void {
  pending.clear();
}

/** What `windowShowsWorkspace` needs of an Electron window. */
export interface WarmWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  webContents: { executeJavaScript(code: string): Promise<unknown> };
}

/**
 * True when `win` is on screen (shown, not minimised) and the workspace it has
 * selected is `workspaceId`. A reloading renderer or one that predates the
 * global answers no.
 */
export async function windowShowsWorkspace(win: WarmWindow, workspaceId: string): Promise<boolean> {
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
  try {
    return (await win.webContents.executeJavaScript('window.__wmux_getActiveWorkspaceId?.() ?? null')) === workspaceId;
  } catch {
    return false;
  }
}

/** True when some window shows `workspaceId` (see `windowShowsWorkspace`). */
export async function anyWindowShowsWorkspace(windows: readonly WarmWindow[], workspaceId: string): Promise<boolean> {
  for (const win of windows) if (await windowShowsWorkspace(win, workspaceId)) return true;
  return false;
}
