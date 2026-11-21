/**
 * ssh-branch.ts — the sidebar's branch and dirty marker for a workspace whose
 * session lives on a remote host.
 *
 * Split out of ssh-git.ts: the marker needs the batch runner (exec-git-batch.ts),
 * which in turn needs ssh-git's command builder, so keeping both in one module
 * made them import each other.
 */

import { isSshUnreachable, sshGitCommand } from './ssh-git';
import { buildBatchCommand, parseBatchOutput } from './exec-git-batch';
import { runSshRouted } from './exec-worker-routed';
import { runWithSpawnPriority, sshLaneKey, withSpawnSlot } from './exec-gate';
import { traceSpawn } from './exec-trace';
import type { SshRunner } from './ssh-exec';
import type { SshTarget, SshTargetWindow } from './ssh-targets';
import type { GitRepoInfo } from '../shared/git-view';

/** The marker's calls: nobody waits on them, so a generous limit and a buffer for a large `worktree list`. */
const BRANCH_TIMEOUT_MS = 20_000;
const BRANCH_MAX_BUFFER = 8 * 1024 * 1024;

/** Two remote paths are the same checkout when they differ only by trailing slashes. */
const samePath = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export interface BranchStatus {
  /** Null for a detached HEAD. */
  branch: string | null;
  dirty: boolean;
}

/** `git status --porcelain=v2 --branch` output to the sidebar's two facts. */
export function parseBranchStatus(output: string): BranchStatus | null {
  let branch: string | null = null;
  let sawHead = false;
  let dirty = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      sawHead = true;
      const name = line.slice('# branch.head '.length).trim();
      branch = name === '(detached)' ? null : name;
    } else if (line && !line.startsWith('#')) {
      dirty = true;
    }
  }
  return sawHead ? { branch, dirty } : null;
}

/**
 * The same facts from a `repo` answer the Git view already fetched, so a
 * refreshing view costs no extra ssh call. The worktree at the checkout path
 * is the one the sidebar is about; the primary tree is the fallback.
 */
export function branchStatusFromRepo(repo: GitRepoInfo, checkoutPath: string): BranchStatus | null {
  const wt = repo.worktrees.find((w) => samePath(w.path, checkoutPath))
    ?? repo.worktrees.find((w) => w.primary);
  if (!wt || wt.bare || !wt.summary) return null;
  const s = wt.summary;
  return { branch: wt.branch, dirty: s.staged + s.unstaged + s.untracked + s.conflicted > 0 };
}

/** The branch `git worktree list --porcelain` names for the worktree at `checkout`: null for a detached one, undefined when it lists none there. */
function listedBranch(list: string, checkout: string): string | null | undefined {
  for (const block of list.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined || !samePath(path, checkout)) continue;
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    return branch ? branch.replace(/^refs\/heads\//, '') : null;
  }
  return undefined;
}

/**
 * The sidebar's marker from ONE batched spawn, run through `run`: the checkout's
 * status and the worktree list together, read as the Git view's `repo` answer is
 * (the worktree at the checkout path, else the status of the checkout itself).
 * Null when the host cannot be reached or ssh cannot be run (the sidebar keeps
 * what it had); undefined when the batch was not understood or the status
 * failed, and the caller reads the status with a spawn of its own.
 */
async function batchedBranchStatus(
  target: SshTarget,
  run: SshRunner,
  tool?: (target: SshTarget) => string,
): Promise<BranchStatus | null | undefined> {
  let built: ReturnType<typeof buildBatchCommand>;
  try {
    built = buildBatchCommand({ target, tool }, target.path, [
      { dir: 'c', args: ['status', '--porcelain=v2', '--branch', '-unormal'] },
      { dir: 'c', args: ['worktree', 'list', '--porcelain'] },
    ]);
  } catch {
    return null; // no ssh to run: a spawn would fail the same way
  }
  const { cmd, nonce } = built;
  const ran = await withSpawnSlot(sshLaneKey(target), async (slot) => {
    const done = traceSpawn('git:batch', slot);
    const result = await run(cmd.file, cmd.args, BRANCH_TIMEOUT_MS, { maxBuffer: BRANCH_MAX_BUFFER, cwd: cmd.cwd, idempotent: true });
    done?.(result.status, result.stdoutBuffer.length, result.via, result.cold);
    return result;
  });
  if (ran.spawnFailed || isSshUnreachable({ code: ran.status }, cmd.wsl)) return null;
  const [status, list] = (ran.status === 0 ? parseBatchOutput(ran.stdout, nonce, 2) : null) ?? [];
  if (!status || status.status !== 0) return undefined;
  const parsed = parseBranchStatus(status.stdout);
  if (!parsed) return undefined;
  const listed = list && list.status === 0 ? listedBranch(list.stdout, target.path) : undefined;
  return listed === undefined ? parsed : { branch: listed, dirty: parsed.dirty };
}

/**
 * One ssh spawn for the branch and dirty marker (status and worktree list in
 * one batch), or null for any failure: the sidebar keeps what it had rather
 * than showing an error under a name. A batch the host did not answer in the
 * expected format is read with a single `git status` spawn.
 */
export async function remoteBranchStatus(
  target: SshTarget,
  run: SshRunner = runSshRouted,
  tool?: (target: SshTarget) => string,
): Promise<BranchStatus | null> {
  try {
    // Nobody waits on the sidebar's marker: a poll-class spawn (exec-gate.ts).
    const batched = await runWithSpawnPriority('bg', () => batchedBranchStatus(target, run, tool));
    if (batched !== undefined) return batched;
  } catch {
    return null; // unreachable, or no ssh to run: a spawn would fail the same way
  }
  try {
    const cmd = sshGitCommand({ target, tool }, target.path, ['status', '--porcelain=v2', '--branch', '-unormal']);
    const result = await runWithSpawnPriority('bg', () => withSpawnSlot(sshLaneKey(target), async (slot) => {
      const done = traceSpawn('git:status', slot);
      const ran = await run(cmd.file, cmd.args, BRANCH_TIMEOUT_MS, { maxBuffer: BRANCH_MAX_BUFFER, cwd: cmd.cwd, idempotent: true });
      done?.(ran.status, ran.stdoutBuffer.length, ran.via, ran.cold);
      return ran;
    }));
    return result.status === 0 ? parseBranchStatus(result.stdout) : null;
  } catch {
    return null;
  }
}

/** The renderer expression. Every value is JSON-encoded: it reaches `executeJavaScript` as source. */
export function setWorkspaceGitJs(workspaceId: string, status: BranchStatus): string {
  const S = JSON.stringify;
  return `window.__wmux_setWorkspaceGit?.(${S(workspaceId)}, ${S(status.branch)}, ${S(status.dirty)}) ?? null`;
}

/** Write a status into the sidebar of whichever window holds the workspace. Never throws. */
export async function pushWorkspaceGit(
  windows: readonly SshTargetWindow[],
  workspaceId: string,
  status: BranchStatus | null,
): Promise<void> {
  if (!status) return;
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    try {
      if (await win.webContents.executeJavaScript(setWorkspaceGitJs(workspaceId, status))) return;
    } catch {
      continue; // reloading or torn down: this window doesn't have it
    }
  }
}
