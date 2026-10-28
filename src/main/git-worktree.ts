/**
 * Git worktree workspaces (#366) — the main-process half.
 *
 * A worktree workspace is a checkout wmux created on a NEW branch, under
 * `%LOCALAPPDATA%\wmux\wt\<repo-slug>\<branch-dir>`, from
 * `wmux new-workspace --worktree <branch> [--base <ref>]` or the sidebar menu,
 * and recorded (repo, branch, base SHA) in `worktrees.json` at the `wt` root
 * (`registryPath`). Creating
 * one is cheap; REMOVING one is where user work dies, so the whole module is
 * organised around one rule: **wmux never destroys work it was not explicitly
 * told to destroy, and when in doubt it leaves the files on disk and says so.**
 *
 * - There is no background sweep. A startup collector once removed "unclaimed
 *   clean" worktrees, and every update restored from an Auto-backup that had
 *   dropped the `worktree` binding, so it removed live checkouts. The binding
 *   now survives auto-save, the Auto-backup, named sessions and snapshots
 *   (session-persistence.ts).
 * - Only the close dialog removes, and only after a read-only `inspect`
 *   (`inspectWorktree`) while the workspace is still open. The CLI, closing
 *   the last tab, or any other way of closing a worktree workspace than the
 *   dialog's two buttons leaves the folder on disk.
 * - Keep (the default) never forces. `git worktree remove` without `--force`
 *   refuses modified and untracked files but deletes IGNORED ones (`.env`,
 *   local config) and exits 0, so a `status --ignored --untracked-files=all`
 *   that lists anything at all makes Keep refuse with `has-work`.
 * - A git failure is never followed by a recursive delete. `fs.rm` is reached
 *   only after git exited 0 for the same path, and in Keep mode only on an
 *   EMPTY leftover directory.
 * - Only what main created is removable: the path must sit exactly two levels
 *   under the worktree root, be recorded in main's own registry (repo, branch,
 *   base — never anything the renderer says), and be listed by
 *   `git worktree list --porcelain` of that repository.
 * - Git is an ABSOLUTE executable (`gitExecutable` in git-view.ts, so a
 *   `git.exe` committed to the repo never runs) with no shell and
 *   `GIT_TERMINAL_PROMPT=0` / `GIT_OPTIONAL_LOCKS=0`; a ref or a branch name
 *   can never reach an option slot (`--base` passes `isSafeRev`, the branch
 *   the whitelist plus `check-ref-format --branch`).
 *
 * Two rules that live outside this file but are about it:
 *
 * - A pipe-created worktree branches from the CALLER's folder (`--cwd`, else
 *   the caller surface's reported cwd, via `prepareWorkspaceCreateParams` in
 *   v2-bridge.ts), never the focused workspace (#246).
 * - The Diff view compares against `baseSha` only for a surface whose cwd is
 *   inside the worktree (renderer/components/Diff/diff-base.ts).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { getLocalAppDataDir } from '../shared/instance';
import type { WorktreeCloseMode, WorktreeMetadata, WorktreeRemoveResult, WorktreeInspectResult } from '../shared/types';
import { gitExecutable, isSafeRev, parseWorktreePorcelain, worktreeKey } from './git-view';

/** 24 each, measured: root is 37 chars and this repo's deepest node_modules
 *  path is 116, against a 260 limit with core.longpaths unset (D5). */
export const SLUG_MAX = 24;

/**
 * How long a close waits for the workspace's shells to exit before asking git
 * to remove the directory. On Windows a process whose cwd is inside the
 * directory keeps it from being deleted, and git deletes the admin entry even
 * when deleting the files failed — so removing too early leaves a half-removed
 * checkout. Waiting costs a second; a premature attempt costs a broken tree.
 */
export const WORKTREE_CLOSE_DRAIN_MS = 1000;

export function isValidBranchName(name: unknown): name is string {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 200) return false;
  if (name.startsWith('-')) return false;
  if (name.includes('..')) return false;
  if (name.endsWith('.lock')) return false;
  if (name.startsWith('.') || name.startsWith('/')) return false;
  if (name.endsWith('/')) return false;
  // Whitelist: [A-Za-z0-9._/-] (D8 security boundary)
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

/** A `--base` as the user may write it: omitted (HEAD) or one safe revision. */
export function isValidBaseRef(ref: unknown): boolean {
  if (ref === undefined) return true;
  if (typeof ref !== 'string') return false;
  return ref.trim() === '' || isSafeRev(ref.trim());
}

function trimDashes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '-') start++;
  while (end > start && text[end - 1] === '-') end--;
  return text.slice(start, end);
}

export function slugSegment(text: string, max: number = SLUG_MAX): string {
  if (!text || typeof text !== 'string') return '';
  const collapsed = text.replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-');
  return trimDashes(trimDashes(collapsed).slice(0, max));
}

export function worktreeRoot(): string {
  return path.join(getLocalAppDataDir(), 'wt');
}

export function worktreeSlug(repoRoot: string, branch: string): string {
  const repoSlug = slugSegment(path.basename(repoRoot)) || 'repo';
  const branchSlug = slugSegment(branch) || 'branch';
  const hashInput = (repoRoot || '').toLowerCase() + '\0' + (branch || '');
  const sha = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 8);
  return `${repoSlug}/${branchSlug}-${sha}`;
}

/**
 * True only for `<root>\<repo-slug>\<branch-dir>` — exactly two levels under
 * the root. The root itself, the repo-slug folder, anything deeper and
 * anything outside are all refused: a single `git worktree remove` aimed one
 * level too high is the whole set of checkouts for a repository.
 */
export function isManagedWorktreePath(root: string, candidate: string): boolean {
  if (!root || !candidate || typeof candidate !== 'string') return false;
  if (!path.isAbsolute(candidate)) return false;
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (!rel || path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/);
  if (parts.length !== 2) return false;
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

export function addArgs(worktreePath: string, branch: string, baseSha: string): string[] {
  return ['worktree', 'add', '-b', branch, worktreePath, baseSha];
}

export function removeArgs(worktreePath: string, force: boolean): string[] {
  return force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath];
}

/** Everything Keep must not lose: modified, staged, untracked AND ignored. */
export const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all'];

/** Number of entries in `git status --porcelain=v1 -z` output. */
export function countStatusEntries(out: string): number {
  const tokens = out.split('\0');
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length < 4) continue;
    count++;
    // A rename or copy carries its source path as the NEXT token.
    if (tok[0] === 'R' || tok[0] === 'C') i++;
  }
  return count;
}

export type AddErrorCode =
  | 'invalid_branch'
  | 'invalid_base'
  | 'not_a_repo'
  | 'branch_exists'
  | 'branch_in_use'
  | 'exists'
  | 'git_failed';

export function classifyAddError(stderr: string): AddErrorCode {
  if (!stderr) return 'git_failed';
  const lower = stderr.toLowerCase();
  if (lower.includes('is already used by worktree at')) return 'branch_in_use';
  if (lower.includes('a branch named') || lower.includes('already exists')) return 'branch_exists';
  return 'git_failed';
}

// ─── Impure half ─────────────────────────────────────────────────────────────

export type WorktreeRecord = WorktreeMetadata;

export type CreateResult =
  | { ok: true; worktree: WorktreeRecord }
  | { ok: false; code: AddErrorCode; error: string };

interface GitRun { code: number; stdout: string; stderr: string }

/**
 * Run git, never throwing: the exit code is the decision every caller makes,
 * and a thrown error is too easy to read as "probably fine". `LC_ALL=C` so the
 * few messages classified by text are English whatever the machine's locale.
 */
function runGit(cwd: string, args: string[], maxBuffer = 5 * 1024 * 1024): Promise<GitRun> {
  return new Promise((resolve) => {
    let exe: string;
    try {
      exe = gitExecutable();
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message });
      return;
    }
    execFile(exe, args, {
      cwd,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer,
      env: {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    }, (err, stdout, stderr) => {
      const out = String(stdout ?? '');
      const errText = String(stderr ?? '');
      if (!err) {
        resolve({ code: 0, stdout: out, stderr: errText });
        return;
      }
      const code = typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (err as unknown as { code: number }).code
        : -1;
      resolve({ code: code === 0 ? -1 : code, stdout: out, stderr: errText || err.message });
    });
  });
}

function isDirectory(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * The root of the MAIN checkout: `--git-common-dir`, then its parent. Never
 * `--show-toplevel`, which inside a worktree answers the worktree and would
 * nest a new worktree inside another one (F1).
 */
export async function repoRootFor(dir: string): Promise<string | null> {
  if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir) || !isDirectory(dir)) return null;
  const res = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const trimmed = res.code === 0 ? res.stdout.trim() : '';
  if (!trimmed) return null;
  return path.resolve(path.dirname(trimmed));
}

export async function probeRepo(dir: string): Promise<{ repoRoot: string; currentBranch: string } | null> {
  const root = await repoRootFor(dir);
  if (!root) return null;
  const res = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = res.code === 0 ? res.stdout.trim() : '';
  return { repoRoot: root, currentBranch: currentBranch || 'HEAD' };
}

/**
 * A base ref to its name and commit SHA (D6 — the name moves, the SHA does
 * not). `isSafeRev` first: the ref lands in argv and must never read as an
 * option. Not `check-ref-format`, which refuses the legal `HEAD~3` (F5).
 */
export async function resolveBase(
  repoRoot: string,
  ref?: string,
): Promise<{ name: string; sha: string } | null> {
  if (!repoRoot || typeof repoRoot !== 'string') return null;
  const targetRef = ref?.trim() ? ref.trim() : 'HEAD';
  if (!isSafeRev(targetRef)) return null;
  const res = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${targetRef}^{commit}`]);
  const sha = res.code === 0 ? res.stdout.trim() : '';
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) return null;
  return { name: targetRef, sha };
}

// ─── Registry: what main created ─────────────────────────────────────────────

/**
 * `worktrees.json` beside the checkouts. The renderer's copy of a workspace's
 * worktree metadata is for display only; every destructive operation reads the
 * repository and branch from HERE, so a renderer (or a hand-edited
 * session.json) can never point a removal or a `branch -D` somewhere else.
 */
export function registryPath(): string {
  return path.join(worktreeRoot(), 'worktrees.json');
}

type Registry = Record<string, WorktreeRecord & { createdAt: number }>;

function readRegistry(): Registry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Registry : {};
  } catch {
    return {};
  }
}

function writeRegistry(reg: Registry): void {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// worktreeKey, not a lowercase compare: a recorded path and a probed one can
// differ only by an 8.3 short name or a junction (#362).
function samePath(a: string, b: string): boolean {
  return worktreeKey(a) === worktreeKey(b);
}

/** The record main wrote when it created this worktree, or null. */
export function lookupWorktree(worktreePath: string): WorktreeRecord | null {
  if (typeof worktreePath !== 'string' || !worktreePath) return null;
  const reg = readRegistry();
  const key = worktreeKey(worktreePath);
  const hit = reg[key] ?? Object.values(reg).find((r) => r && typeof r.worktreePath === 'string' && samePath(r.worktreePath, worktreePath));
  if (!hit || !isValidBranchName(hit.branch) || typeof hit.repoRoot !== 'string') return null;
  return {
    repoRoot: hit.repoRoot,
    branch: hit.branch,
    baseBranch: hit.baseBranch,
    baseSha: hit.baseSha,
    worktreePath: hit.worktreePath,
  };
}

function recordWorktree(rec: WorktreeRecord): void {
  const reg = readRegistry();
  reg[worktreeKey(rec.worktreePath)] = { ...rec, createdAt: Date.now() };
  writeRegistry(reg);
}

function forgetWorktree(worktreePath: string): void {
  const reg = readRegistry();
  let changed = false;
  for (const [key, rec] of Object.entries(reg)) {
    if (key === worktreeKey(worktreePath) || (rec && typeof rec.worktreePath === 'string' && samePath(rec.worktreePath, worktreePath))) {
      delete reg[key];
      changed = true;
    }
  }
  if (changed) writeRegistry(reg);
}

// ─── Create ──────────────────────────────────────────────────────────────────

function fail(code: AddErrorCode, error: string): CreateResult {
  return { ok: false, code, error };
}

async function classifyFailedAdd(root: string, branch: string, stderr: string): Promise<AddErrorCode> {
  const code = classifyAddError(stderr);
  if (code !== 'branch_exists') return code;
  const list = await runGit(root, ['worktree', 'list', '--porcelain']);
  const inUse = list.code === 0
    && parseWorktreePorcelain(list.stdout).some((wt) => wt.branch === branch);
  return inUse ? 'branch_in_use' : code;
}

/**
 * Creates a worktree on a NEW branch. Order: whitelist, repo, git's own
 * `check-ref-format --branch`, base validation and resolution, refuse an
 * existing target, `git worktree add -b`, then record it in the registry.
 */
export async function createWorktree(i: { repoRoot: string; branch: string; base?: string }): Promise<CreateResult> {
  if (!i || !isValidBranchName(i.branch)) return fail('invalid_branch', 'Invalid branch name');
  if (!isValidBaseRef(i.base)) return fail('invalid_base', 'Invalid base ref');

  const root = await repoRootFor(i.repoRoot);
  if (!root) return fail('not_a_repo', 'Directory is not inside a git repository');

  const format = await runGit(root, ['check-ref-format', '--branch', i.branch]);
  if (format.code !== 0) return fail('invalid_branch', 'Git rejected the branch name');

  const base = await resolveBase(root, i.base);
  if (!base) return fail('invalid_base', `Could not resolve base ref: ${i.base?.trim() || 'HEAD'}`);

  const targetPath = path.join(worktreeRoot(), worktreeSlug(root, i.branch));
  if (fs.existsSync(targetPath)) return fail('exists', 'Worktree path already exists');

  try {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  } catch (err) {
    return fail('git_failed', (err as Error).message || 'Failed to create worktree directory');
  }

  const add = await runGit(root, addArgs(targetPath, i.branch, base.sha));
  if (add.code !== 0) {
    return fail(await classifyFailedAdd(root, i.branch, add.stderr), add.stderr.trim() || 'git worktree add failed');
  }

  const record: WorktreeRecord = {
    repoRoot: root,
    branch: i.branch,
    baseBranch: base.name,
    baseSha: base.sha,
    worktreePath: targetPath,
  };
  try {
    recordWorktree(record);
  } catch (err) {
    // The checkout exists and is the user's now; without a record wmux will
    // simply never remove it. Say so rather than undo the add.
    console.warn(`[worktree] registry write failed: ${(err as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`);
  }
  return { ok: true, worktree: record };
}

// ─── Inspect / remove ────────────────────────────────────────────────────────

type Vetted =
  | { ok: true; record: WorktreeRecord; path: string; present: boolean }
  | { ok: false; result: WorktreeRemoveResult };

/**
 * Every precondition for touching `p`, in the order that costs least:
 * two-level layout, not a link, recorded by main, and listed by git for the
 * recorded repository (and not that repository's primary checkout).
 */
/** A real directory, nothing at all, or something else (a link, a junction, a file). */
function entryKind(target: string): 'dir' | 'absent' | 'other' {
  try {
    const st = fs.lstatSync(target);
    return st.isDirectory() && !st.isSymbolicLink() ? 'dir' : 'other';
  } catch {
    return 'absent';
  }
}

async function vetManagedWorktree(p: unknown): Promise<Vetted> {
  if (typeof p !== 'string' || !isManagedWorktreePath(worktreeRoot(), p)) {
    return { ok: false, result: { outcome: 'not-ours' } };
  }
  const target = path.resolve(p);
  const entry = entryKind(target);
  if (entry === 'other') return { ok: false, result: { outcome: 'not-ours' } };
  const present = entry === 'dir';

  const record = lookupWorktree(target);
  if (!record) return { ok: false, result: { outcome: 'not-ours' } };
  if (!isDirectory(record.repoRoot)) {
    return { ok: false, result: { outcome: 'error', message: 'The repository this worktree belongs to was not found' } };
  }

  const list = await runGit(record.repoRoot, ['worktree', 'list', '--porcelain']);
  if (list.code !== 0) {
    return { ok: false, result: { outcome: 'error', message: firstLine(list.stderr) } };
  }
  const key = worktreeKey(target);
  const listed = parseWorktreePorcelain(list.stdout).find((wt) => worktreeKey(wt.path) === key);
  if (!listed || listed.primary) return { ok: false, result: { outcome: 'not-ours' } };
  return { ok: true, record, path: target, present };
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim()) ?? 'git failed').replace(/^(fatal|error): /, '').trim();
}

async function countWork(worktreePath: string): Promise<{ count: number } | { error: string }> {
  const status = await runGit(worktreePath, STATUS_ARGS, 64 * 1024 * 1024);
  if (status.code !== 0) return { error: firstLine(status.stderr) };
  return { count: countStatusEntries(status.stdout) };
}

/**
 * Read-only pre-flight for the close dialog: is this a worktree wmux may
 * remove, and does it hold anything Keep would refuse to lose? Runs while the
 * workspace is still open, so a refusal costs the user nothing.
 */
export async function inspectWorktree(p: unknown): Promise<WorktreeInspectResult> {
  const vetted = await vetManagedWorktree(p);
  if (!vetted.ok) return vetted.result.outcome === 'error'
    ? { outcome: 'error', message: vetted.result.message }
    : { outcome: 'not-ours' };
  if (!vetted.present) return { outcome: 'absent' };
  const work = await countWork(vetted.path);
  if ('error' in work) return { outcome: 'error', message: work.error };
  return work.count > 0 ? { outcome: 'has-work', count: work.count } : { outcome: 'clean' };
}

async function removeEmptyLeftover(dir: string, discard: boolean): Promise<boolean> {
  if (!fs.existsSync(dir)) return true;
  try {
    if (discard) {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } else {
      await fs.promises.rmdir(dir);
    }
  } catch {
    // left behind: reported below
  }
  return !fs.existsSync(dir);
}

/**
 * Removes a worktree wmux created.
 *
 * - `keep`: refuses with `has-work` if `status --ignored --untracked-files=all`
 *   lists anything, then an UNFORCED `git worktree remove`. The branch stays.
 * - `discard`: `git worktree remove --force`, then `git branch -D` of the
 *   branch main recorded — only after the removal succeeded.
 *
 * Never a recursive delete after a git failure: any non-zero exit is
 * `left-behind` with the directory as git left it.
 */
export async function removeWorktree(
  p: unknown,
  o: { mode: WorktreeCloseMode; drainMs?: number },
): Promise<WorktreeRemoveResult> {
  const mode = o?.mode;
  if (mode !== 'keep' && mode !== 'discard') return { outcome: 'error', message: 'invalid mode' };

  const vetted = await vetManagedWorktree(p);
  if (!vetted.ok) return vetted.result;
  if (!vetted.present) return { outcome: 'absent' };
  const { record, path: target } = vetted;

  await drain(o.drainMs ?? WORKTREE_CLOSE_DRAIN_MS);

  const removal = mode === 'discard' ? await forceRemove(record, target) : await keepRemove(record, target);
  if (removal) return removal;
  forgetWorktree(target);
  return mode === 'discard' ? deleteRecordedBranch(record) : { outcome: 'removed', branchDeleted: false };
}

function drain(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Discard's second half: the branch MAIN recorded, never one the renderer named
 *  — there is no IPC that names a branch to delete. */
async function deleteRecordedBranch(record: WorktreeRecord): Promise<WorktreeRemoveResult> {
  const branch = await runGit(record.repoRoot, ['branch', '-D', record.branch]);
  return branch.code === 0
    ? { outcome: 'removed', branchDeleted: true }
    : { outcome: 'removed', branchDeleted: false, message: firstLine(branch.stderr) };
}

/** Keep: re-check for work now that the shells are gone, then an unforced
 *  remove. Null when the directory is gone; otherwise why it stays. */
async function keepRemove(record: WorktreeRecord, target: string): Promise<WorktreeRemoveResult | null> {
  const work = await countWork(target);
  if ('error' in work) return { outcome: 'error', message: work.error };
  if (work.count > 0) return { outcome: 'has-work', count: work.count };

  const removed = await runGit(record.repoRoot, removeArgs(target, false));
  if (removed.code !== 0) {
    return /modified or untracked files/i.test(removed.stderr)
      ? { outcome: 'has-work' }
      : { outcome: 'left-behind', message: firstLine(removed.stderr) };
  }
  // git exited 0 for this exact path: only an EMPTY leftover may go.
  return (await removeEmptyLeftover(target, false)) ? null : { outcome: 'left-behind' };
}

/** Discard: the user confirmed destroying everything in the checkout. */
async function forceRemove(record: WorktreeRecord, target: string): Promise<WorktreeRemoveResult | null> {
  const removed = await runGit(record.repoRoot, removeArgs(target, true));
  if (removed.code !== 0) return { outcome: 'left-behind', message: firstLine(removed.stderr) };
  // git exited 0 for this exact path: only now may a leftover directory go.
  return (await removeEmptyLeftover(target, true)) ? null : { outcome: 'left-behind' };
}

// ─── Restore ─────────────────────────────────────────────────────────────────

function findSplitLeaves(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (node.type === 'leaf') return [node];
  if (Array.isArray(node.children)) return node.children.flatMap(findSplitLeaves);
  return [];
}

const isTerminalSurface = (s: any): boolean =>
  !!s && (s.type === 'terminal' || !s.type) && typeof s.id === 'string';

function activeSurfaceOf(leaf: any): any {
  if (!Array.isArray(leaf.surfaces) || leaf.surfaces.length === 0) return undefined;
  const idx = typeof leaf.activeSurfaceIndex === 'number' ? leaf.activeSurfaceIndex : 0;
  return leaf.surfaces[idx] ?? leaf.surfaces[0];
}

/** The surface a restore notice should be written to: an active terminal,
 *  else any terminal, else any active surface. */
export function findNoticeSurfaceId(tree: any): string | undefined {
  const leaves = findSplitLeaves(tree);
  const activeTerminal = leaves.map(activeSurfaceOf).find(isTerminalSurface);
  if (activeTerminal) return activeTerminal.id;
  for (const leaf of leaves) {
    const terminal = Array.isArray(leaf.surfaces) ? leaf.surfaces.find(isTerminalSurface) : undefined;
    if (terminal) return terminal.id;
  }
  const anyActive = leaves.map(activeSurfaceOf).find((s) => s && typeof s.id === 'string');
  return anyActive?.id;
}

/** The i18n key of the restore notice; translated by the renderer. */
export const WORKTREE_MISSING_NOTICE_KEY = 'worktree.restoreMissing';

/**
 * A restored workspace whose worktree directory is gone loses its binding and
 * says so in a pane. Logs counts only, never paths (#174). Never removes
 * anything: a directory that is merely unreachable right now is not touched.
 */
export function verifyRestoredWorktrees(
  windows: Array<{ workspaces?: Array<{ worktree?: WorktreeMetadata; splitTree?: any; [key: string]: any }> }>,
  deps?: {
    existsSync?: (p: string) => boolean;
    showNotice?: (surfaceId: string, key: string) => void;
  },
): { verified: number; cleared: number } {
  const exists = deps?.existsSync ?? fs.existsSync;
  let verified = 0;
  let cleared = 0;
  for (const win of windows || []) {
    for (const ws of win.workspaces || []) {
      if (!ws.worktree?.worktreePath) continue;
      if (exists(ws.worktree.worktreePath)) {
        verified++;
        continue;
      }
      delete ws.worktree;
      cleared++;
      const surfaceId = findNoticeSurfaceId(ws.splitTree);
      if (surfaceId) deps?.showNotice?.(surfaceId, WORKTREE_MISSING_NOTICE_KEY);
    }
  }
  if (cleared > 0) {
    console.log(`[worktree-verify] cleared ${cleared} missing worktree(s), verified ${verified}`);
  }
  return { verified, cleared };
}
