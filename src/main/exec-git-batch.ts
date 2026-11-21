/**
 * exec-git-batch.ts — several read-only git commands in ONE spawn.
 *
 * Every spawn on the WSL route costs a `wsl.exe` start, so a Git view request that
 * ran several `git` processes in sequence paid that start for each. This runs a list
 * of independent git commands inside one `sh -c` and hands back each command's
 * stdout, stderr and exit status separately. For a remote host that is one
 * `wsl.exe -d <distro> --exec ssh ... sh`; for a folder on a WSL share (exec-location.ts)
 * one `wsl.exe -d <distro> --exec sh -c ...` (wsl-local.ts): the same script and
 * framing, with no ssh in between.
 *
 * ## Why the answer cannot be forged
 *
 * stdout is raw bytes from git (file names, commit subjects, diff text), so nothing in
 * it can be trusted not to look like framing. Each command's output is followed by a
 * marker line holding a per-call random nonce (`\n--<nonce>:<n>:<status>\n`), made
 * here after the commands are chosen and before anything runs, and written nowhere a
 * file name or commit message could have seen it. `parseBatchOutput` takes the first
 * marker for each position, requires them all, in order, with nothing after the last,
 * and refuses the whole answer otherwise.
 *
 * ## Fallback
 *
 * `runGitBatch` returns null when the answer is not framed as expected (a script that
 * could not start, a remote `sh` that mangled it, output cut short), and the caller
 * runs the commands one spawn each. An unreachable host is an error, as for every
 * other remote call, and so is a batch that timed out: re-running it command by
 * command would only be slower. A WSL batch has no "unreachable"; null is its only
 * failure.
 *
 * ## What a command can be
 *
 * The script is a constant. Every value (the checkout, a worktree, each git argument)
 * reaches it as a counted positional argument, so no argument can end a command early.
 * It only runs `git -C <dir> <args…>`, with sub-commands chosen by callers that pass
 * only ones that read (git-view.ts, diff-provider.ts).
 *
 * A group may be the FINGERPRINT (`dir: 'f'`): not a git command but the one fixed
 * function in the script that prints digests of what a poll needs to tell whether
 * anything a view shows has changed (`parseFingerprint`, exec-snapshot.ts), or NOHASH
 * where the host cannot make them. A group may ask for a WORKTREE (`dir: 'w'`): the
 * script runs it only if `git worktree list` there names exactly that path, and
 * otherwise answers status 125. Callers check the path against the same list too.
 */

import { randomBytes } from 'crypto';
import { contextLaneKey, isWslContext, locKind, type GitContext } from './exec-location';
import { withSpawnSlot } from './exec-gate';
import { isSshUnreachable, sshScriptCommand, SSH_UNREACHABLE_MESSAGE } from './ssh-git';
import { traceExitStatus, traceSpawn } from './exec-trace';
import { execFileRouted } from './exec-worker-routed';
import { wslScriptCommand } from './wsl-local';
import { BATCH_SCRIPT } from './exec-git-batch-script';

export { BATCH_SCRIPT };

export type BatchGroup =
  /** The fingerprint function of the script: no git argument, and its answer is for `parseFingerprint`. */
  | { dir: 'f'; args: [] }
  /** In the checkout. */
  | { dir: 'c'; args: string[] }
  /** In `worktree`, but only if `git worktree list` on the remote host names exactly that path. */
  | { dir: 'w'; worktree: string; args: string[] };

/** What to spawn for one batch, on either kind of location (`GitContext`). */
export interface BatchInvocation {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** ssh runs inside WSL, so wsl.exe's own failures read as unreachable. Always false for a WSL folder. */
  wsl: boolean;
}

/** The ssh command could not even be built (no ssh executable, a path that is not remote). */
export class BatchSetupError extends Error {}

export interface BatchOutcome {
  /** git's exit status; 125 for a `w` group whose worktree git did not list (never run). */
  status: number;
  stdout: string;
  /** Up to 2 KiB of git's stderr. */
  stderr: string;
}

/** Windows caps a command line near 32 K characters and wsl.exe's carries the script as base64. */
const MAX_ARG_CHARS = 8000;
const MAX_GROUPS_PER_SPAWN = 100;
/** Mutable only so a test can shorten the timeout. */
export const batchLimits = { timeoutMs: 30_000 };

/**
 * After a WSL batch that was not answered in its format (a distro without `base64` or
 * `mktemp`, a wsl.exe that did not run it, a timeout), the distro is not asked for another for
 * this long: every request would otherwise pay one wasted `wsl.exe` start before the
 * one-git-per-spawn code it falls back to.
 */
export const WSL_BATCH_BACKOFF_MS = 5 * 60_000;
const wslBatchUnusableUntil = new Map<string, number>();

/** Tests only. */
export function resetBatchBackoff(): void {
  wslBatchUnusableUntil.clear();
}
const BATCH_MAX_BUFFER = 32 * 1024 * 1024;

/** Split `groups` so that no spawn's command line is too long. */
export function chunkGroups(groups: readonly BatchGroup[]): BatchGroup[][] {
  const chunks: BatchGroup[][] = [];
  let current: BatchGroup[] = [];
  let size = 0;
  for (const group of groups) {
    const weight = group.args.reduce((sum, a) => sum + a.length + 3, 8 + (group.dir === 'w' ? group.worktree.length : 0));
    if (current.length > 0 && (size + weight > MAX_ARG_CHARS || current.length >= MAX_GROUPS_PER_SPAWN)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(group);
    size += weight;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * The per-command answers from a batch's stdout, or null when it is not exactly
 * `count` framed answers for `nonce` (see the header: this is what makes a
 * forged or cut-short answer a fallback and not a wrong result).
 */
export function parseBatchOutput(text: string, nonce: string, count: number): BatchOutcome[] | null {
  const outcomes: BatchOutcome[] = [];
  let pos = 0;
  for (let n = 1; n <= count; n++) {
    const head = `\n--${nonce}:${n}:`;
    const headAt = text.indexOf(head, pos);
    if (headAt < 0) return null;
    const statusStart = headAt + head.length;
    const statusEnd = text.indexOf('\n', statusStart);
    if (statusEnd < 0) return null;
    const status = text.slice(statusStart, statusEnd);
    if (!/^\d{1,3}$/.test(status)) return null;
    const tail = `\n--${nonce}:${n}:E\n`;
    const tailAt = text.indexOf(tail, statusEnd + 1);
    if (tailAt < 0) return null;
    outcomes.push({ status: Number(status), stdout: text.slice(pos, headAt), stderr: text.slice(statusEnd + 1, tailAt) });
    pos = tailAt + tail.length;
  }
  return pos === text.length ? outcomes : null;
}

/**
 * The ssh command for one batch and the nonce its answer will carry, for a caller
 * that runs it with a runner of its own (the sidebar's marker does) and reads it
 * with `parseBatchOutput`. Throws `BatchSetupError` when it cannot be built.
 */
export function buildBatchCommand(
  context: GitContext,
  cwd: string,
  groups: readonly BatchGroup[],
): { cmd: BatchInvocation; nonce: string } {
  const nonce = randomBytes(16).toString('hex');
  const args = [cwd, nonce, ...groups.flatMap((g) => {
    if (g.dir === 'f') return ['f', '0'];
    return g.dir === 'w'
      ? ['w', String(g.args.length + 1), g.worktree, ...g.args]
      : ['c', String(g.args.length), ...g.args];
  })];
  try {
    // A WSL folder runs the same script in `wsl.exe -d <distro> --exec sh`, with no ssh in between.
    return { cmd: isWslContext(context) ? wslScriptCommand(context, BATCH_SCRIPT, cwd, args) : sshScriptCommand(context, BATCH_SCRIPT, cwd, args), nonce };
  } catch (err) {
    throw new BatchSetupError(err instanceof Error ? err.message : String(err), { cause: err });
  }
}

function spawnBatch(
  context: GitContext,
  cwd: string,
  groups: readonly BatchGroup[],
  traceOp: string,
): Promise<BatchOutcome[] | null> {
  let built: ReturnType<typeof buildBatchCommand>;
  try {
    built = buildBatchCommand(context, cwd, groups);
  } catch (err) {
    return Promise.reject(err);
  }
  const { cmd, nonce } = built;
  return withSpawnSlot(contextLaneKey(context), (slot) => new Promise<BatchOutcome[] | null>((resolve, reject) => {
    const done = traceSpawn(traceOp, slot, locKind(context));
    execFileRouted(cmd.file, cmd.args, {
      cwd: cmd.cwd,
      windowsHide: true,
      timeout: batchLimits.timeoutMs,
      maxBuffer: BATCH_MAX_BUFFER,
      env: cmd.env,
      idempotent: true, // read-only git commands: repeating one is safe
    }, (err, stdout, _stderr, via, cold) => {
      done?.(traceExitStatus(err), stdout.length, via, cold);
      if (err) {
        // A WSL folder has no "unreachable" of its own: whatever went wrong, the caller runs its git
        // commands one spawn each, and reports whatever those say.
        if (isWslContext(context)) {
          resolve(null);
        } else if (isSshUnreachable(err, cmd.wsl)) {
          context.unreachable = true;
          reject(new Error(SSH_UNREACHABLE_MESSAGE));
        } else if ((err as { killed?: unknown }).killed === true) {
          reject(new Error('git timed out on the remote host'));
        } else {
          resolve(null);
        }
        return;
      }
      resolve(parseBatchOutput(stdout, nonce, groups.length));
    });
  }));
}

/**
 * Run `groups` on the remote host in as few spawns as the command-line limit
 * allows (normally one), in order. Null means "not answered in the batch's
 * format; do it the long way".
 */
export async function runGitBatch(
  context: GitContext,
  cwd: string,
  groups: readonly BatchGroup[],
  /** The trace name of the spawn (exec-trace.ts): a fixed word, never anything from a request. */
  traceOp: 'git:batch' | 'git:fingerprint' = 'git:batch',
): Promise<BatchOutcome[] | null> {
  for (const group of groups) {
    if (group.dir === 'w' && (!group.worktree.startsWith('/') || group.worktree.includes('\0'))) return null;
  }
  const distro = isWslContext(context) ? context.wsl.distro : undefined;
  if (distro !== undefined && Date.now() < (wslBatchUnusableUntil.get(distro) ?? 0)) return null;
  const outcomes: BatchOutcome[] = [];
  for (const chunk of chunkGroups(groups)) {
    const answered = await spawnBatch(context, cwd, chunk, traceOp);
    if (!answered) {
      if (distro !== undefined) wslBatchUnusableUntil.set(distro, Date.now() + WSL_BATCH_BACKOFF_MS);
      return null;
    }
    outcomes.push(...answered);
  }
  return outcomes;
}
