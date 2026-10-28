/**
 * The project Git view (#362) — the main-process half of the `git` surface:
 * worktrees, working changes, branch changes and the commit graph, all over ONE
 * IPC channel (`git:view`, carrying a tagged `GitViewRequest` from
 * `shared/git-view.ts`).
 *
 * Read-only by construction: every git sub-command this module runs is one
 * that reads (`worktree list`, `status`, `log`, `diff`, `show`, `for-each-ref`,
 * `merge-base`, `rev-parse`, `symbolic-ref --quiet`). Nothing here stages,
 * checks out or writes a ref, so the view can sit beside agents committing in
 * the same repository without ever being a party to their work.
 *
 * Three rules shape the runner, each against a concrete failure:
 *
 * - **No shell, and no renderer string in an option slot.** Arguments go
 *   through `execFile` as an array. A ref arrives from the renderer and lands
 *   in argv, so `isSafeRev` refuses anything that could read as an option
 *   (`--output=…`), a range or an object path; paths only ever follow
 *   `--`, under `--literal-pathspecs` so a `:(top)` file name is a name and
 *   not magic. git itself is an ABSOLUTE path (`gitCandidates`: PATH dirs,
 *   then Git for Windows' install roots), never a bare `git` resolved per
 *   spawn.
 * - **`GIT_OPTIONAL_LOCKS=0`.** `git status` refreshes the index and takes
 *   `.git/index.lock` to write the refresh back; a poll doing that beside an
 *   agent that is committing makes the agent's `git commit` fail with
 *   "index.lock exists". The shell integration's prompt worker passes
 *   `--no-optional-locks` for the same reason; the env form covers every
 *   sub-command here at once.
 * - **`--no-ext-diff --no-textconv`.** A diff driver is a program. The view
 *   shows what git stores, and never runs a filter a `.gitattributes` names.
 *
 * Worktree-scoped requests name the worktree by PATH, and that path must be
 * one `git worktree list` reports for the repository the request was opened
 * on — the view can only point git at directories git itself vouched for.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  GitBranchChanges, GitCommit, GitCommitDetails, GitFileChange, GitFileStatus,
  GitGraphScope, GitRefs, GitRepoInfo, GitViewRequest, GitViewResult,
  GitWorkingChanges, GitWorkingSection, GitWorktree, GitWorktreeEntry, GitWorktreeSummary,
} from '../shared/git-view';
import { untrackedFileDiff } from './diff-provider';

// ─── Validation ──────────────────────────────────────────────────────────────

const HASH_RE = /^[0-9a-f]{7,64}$/i;
const REV_RE = /^[\w./@{}^~+-]+$/;

/**
 * A single revision the renderer may put in argv: a branch, a tag, a remote
 * branch, a hash, `HEAD~2`. Never an option (leading `-`), never a range
 * (`a..b` — every request already says which two ends it means), never an
 * object path (`HEAD:file`, refused by the character set).
 */
export function isSafeRev(rev: unknown): rev is string {
  return typeof rev === 'string'
    && rev.length > 0 && rev.length <= 250
    && !rev.startsWith('-')
    && !rev.includes('..')
    && REV_RE.test(rev);
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

/** A repo-relative path. It only ever follows `--`, under literal pathspecs. */
export function isSafeRepoPath(file: unknown): file is string {
  return typeof file === 'string'
    && file.length > 0 && file.length <= 4096
    && !file.includes('\0')
    && !path.isAbsolute(file);
}

/**
 * One spelling per directory, for comparison only.
 *
 * Through `realpathSync.native` first: git prints a worktree's LONG path,
 * while a path that reached us any other way can be an 8.3 short name
 * (`C:\Users\RUNNER~1\…` — the GitHub runner's temp dir, and any user whose
 * profile name is long or has a space) or go through a junction. The JS
 * `realpathSync` expands neither; the native one asks Windows for the final
 * path. A path that cannot be resolved (gone, no access) keeps its spelling.
 */
export function worktreeKey(p: string): string {
  let resolved = path.resolve(p);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* keep the spelling we were given */ }
  let key = resolved.replace(/\//g, '\\');
  if (process.platform === 'win32') key = key.toLowerCase();
  while (key.length > 3 && key.endsWith('\\')) key = key.slice(0, -1);
  return key;
}

// ─── Pure parsers ────────────────────────────────────────────────────────────

/** `git worktree list --porcelain`: blank-line separated blocks. */
export function parseWorktreePorcelain(out: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = {
        path: line.slice('worktree '.length), head: '', branch: null,
        primary: worktrees.length === 0, bare: false, locked: false, prunable: false,
      };
      worktrees.push(current);
    } else if (current) {
      applyWorktreeAttribute(current, line);
    }
  }
  return worktrees;
}

function applyWorktreeAttribute(wt: GitWorktree, line: string): void {
  if (line.startsWith('HEAD ')) wt.head = line.slice(5).trim();
  else if (line.startsWith('branch ')) wt.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
  else if (line === 'bare') wt.bare = true;
  else if (line === 'locked' || line.startsWith('locked ')) wt.locked = true;
  else if (line === 'prunable' || line.startsWith('prunable ')) wt.prunable = true;
}

interface StatusEntry {
  x: string;
  y: string;
  path: string;
  oldPath?: string;
  kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked';
}

interface ParsedStatus {
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
}

/** Everything after the `n`th space of `record` — a path may contain spaces. */
function afterFields(record: string, n: number): string {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = record.indexOf(' ', idx + 1);
    if (idx < 0) return '';
  }
  return record.slice(idx + 1);
}

/** `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string): ParsedStatus {
  const result: ParsedStatus = { upstream: null, ahead: 0, behind: 0, entries: [] };
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) { applyStatusHeader(result, rec); continue; }
    const type = rec[0];
    const x = rec[2] ?? '.';
    const y = rec[3] ?? '.';
    if (type === '1') result.entries.push({ x, y, path: afterFields(rec, 8), kind: 'ordinary' });
    else if (type === '2') result.entries.push({ x, y, path: afterFields(rec, 9), oldPath: records[++i], kind: 'renamed' });
    else if (type === 'u') result.entries.push({ x, y, path: afterFields(rec, 10), kind: 'unmerged' });
    else if (type === '?') result.entries.push({ x: '?', y: '?', path: rec.slice(2), kind: 'untracked' });
  }
  return result;
}

function applyStatusHeader(result: ParsedStatus, rec: string): void {
  if (rec.startsWith('# branch.upstream ')) result.upstream = rec.slice('# branch.upstream '.length);
  const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(rec);
  if (ab) { result.ahead = Number(ab[1]); result.behind = Number(ab[2]); }
}

export function summarizeStatus(status: ParsedStatus): GitWorktreeSummary {
  const summary: GitWorktreeSummary = {
    staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
    upstream: status.upstream, ahead: status.ahead, behind: status.behind,
  };
  for (const e of status.entries) {
    if (e.kind === 'untracked') summary.untracked++;
    else if (e.kind === 'unmerged') summary.conflicted++;
    else {
      if (e.x !== '.') summary.staged++;
      if (e.y !== '.') summary.unstaged++;
    }
  }
  return summary;
}

const STATUS_LETTERS: Record<string, GitFileStatus> = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'conflicted',
};

function statusFromLetter(letter: string): GitFileStatus {
  return STATUS_LETTERS[letter] ?? 'modified';
}

interface LineStat { additions: number; deletions: number; binary: boolean }

/**
 * `git diff --numstat -z`. A plain row is `add\tdel\tpath\0`; a rename leaves
 * the path field empty and follows with `old\0new\0`. Binary files print `-`.
 */
export function parseNumstatZ(out: string): Map<string, LineStat> {
  const stats = new Map<string, LineStat>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    let file = m[3];
    if (file === '') { i += 2; file = parts[i] ?? ''; }
    const binary = m[1] === '-';
    stats.set(file, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return stats;
}

/** `git diff --name-status -z`: `X\0path\0`, or `R100\0old\0new\0`. */
export function parseNameStatusZ(out: string): Array<{ status: GitFileStatus; path: string; oldPath?: string }> {
  const parts = out.split('\0');
  const files: Array<{ status: GitFileStatus; path: string; oldPath?: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      files.push({ status: statusFromLetter(letter), oldPath: parts[i + 1], path: parts[i + 2] ?? '' });
      i += 2;
    } else {
      files.push({ status: statusFromLetter(letter), path: parts[i + 1] ?? '' });
      i += 1;
    }
  }
  return files.filter((f) => f.path);
}

export function joinFileStats(
  names: Array<{ status: GitFileStatus; path: string; oldPath?: string }>,
  stats: Map<string, LineStat>,
): GitFileChange[] {
  return names.map((n) => {
    const s = stats.get(n.path);
    return {
      ...n,
      additions: s?.additions ?? 0,
      deletions: s?.deletions ?? 0,
      ...(s?.binary ? { binary: true } : {}),
    };
  });
}

const FIELD = '\x1f';
const RECORD = '\x1e';
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f') + '%x1e';

/** Records produced by `--format=LOG_FORMAT`. */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const raw of out.split(RECORD)) {
    const rec = raw.replace(/^\s+/, '');
    if (!rec) continue;
    const [hash, parents, author, email, date, refs, ...subject] = rec.split(FIELD);
    if (!isHash(hash)) continue;
    commits.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author: author ?? '',
      email: email ?? '',
      date: Number(date) || 0,
      refs: refs ? refs.split(', ').map((r) => r.trim()).filter(Boolean) : [],
      subject: subject.join(FIELD),
    });
  }
  return commits;
}

/** `for-each-ref --format=%(refname)` → the three ref families, short names. */
export function parseRefs(out: string): GitRefs {
  const refs: GitRefs = { local: [], remote: [], tags: [] };
  for (const line of out.split(/\r?\n/)) {
    const ref = line.trim();
    if (ref.startsWith('refs/heads/')) refs.local.push(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/')) {
      const short = ref.slice('refs/remotes/'.length);
      if (!short.endsWith('/HEAD')) refs.remote.push(short);
    } else if (ref.startsWith('refs/tags/')) refs.tags.push(ref.slice('refs/tags/'.length));
  }
  return refs;
}

/**
 * Which base a branch review opens on. The remote's own idea of its default
 * branch wins (as a LOCAL branch when one exists, since that is what the user
 * merges into), then the usual names.
 */
export function pickDefaultBase(refs: GitRefs, originHead: string | null): string | null {
  const has = (r: string) => refs.local.includes(r) || refs.remote.includes(r);
  const candidates: string[] = [];
  if (originHead) {
    const short = originHead.replace(/^refs\/remotes\//, '');
    const branch = short.split('/').slice(1).join('/');
    if (branch) candidates.push(branch);
    candidates.push(short);
  }
  candidates.push('develop', 'main', 'master', 'origin/develop', 'origin/main', 'origin/master');
  return candidates.find(has) ?? refs.local[0] ?? null;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

class GitError extends Error {
  constructor(message: string, readonly code: 'not_repo' | 'invalid' | 'failed' = 'failed') {
    super(message);
  }
}

/**
 * Candidate git executables, most specific first: every PATH directory (the
 * git the user runs), then Git for Windows' default install roots — an
 * Explorer-launched wmux inherits the registry PATH, which can lack the
 * per-user install entirely. Pure, so the order is testable without Git.
 */
export function gitCandidates(env: Record<string, string | undefined>, platform = process.platform): string[] {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exe = win ? 'git.exe' : 'git';
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const out = dirs.filter((d) => p.isAbsolute(d)).map((d) => p.join(d, exe));
  if (win) {
    for (const base of [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (base) out.push(p.join(base, 'Git', 'cmd', exe));
    }
    if (env.LOCALAPPDATA) out.push(p.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', exe));
  } else {
    out.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git');
  }
  return out;
}

let gitExeMemo: string | null = null;

/**
 * An ABSOLUTE git, resolved once. A bare `git` would be looked up by the OS at
 * every spawn, so a writeable directory early on PATH — the current folder
 * included, on Windows — decides what runs. Re-validated on use so an
 * uninstall or a Git update that moves it re-resolves. Exported because
 * `git-worktree.ts` runs git in a folder the user picked and needs the same
 * guarantee: a `git.exe` committed to that repo must never be what runs.
 */
export function gitExecutable(): string {
  if (gitExeMemo && fs.existsSync(gitExeMemo)) return gitExeMemo;
  gitExeMemo = gitCandidates(process.env).find((c) => {
    try { return fs.statSync(c).isFile(); } catch { return false; }
  }) ?? null;
  if (!gitExeMemo) throw new GitError('Git was not found on this machine');
  return gitExeMemo;
}

function git(cwd: string, args: string[], maxBuffer = 20 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let exe: string;
    try { exe = gitExecutable(); } catch (err) { reject(err); return; }
    execFile(exe, ['-c', 'core.quotepath=off', '-c', 'color.ui=never', '--literal-pathspecs', ...args], {
      cwd,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err) {
        const first = String(stderr || err.message).split(/\r?\n/).find((l) => l.trim()) ?? 'git failed';
        reject(new GitError(first.replace(/^(fatal|error): /, '')));
        return;
      }
      resolve(stdout);
    });
  });
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

async function emptyTree(cwd: string): Promise<string> {
  const format = (await git(cwd, ['rev-parse', '--show-object-format']).catch(() => 'sha1')).trim();
  return format === 'sha256'
    ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
    : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

function assertDir(cwd: unknown): string {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) throw new GitError('No folder to inspect', 'invalid');
  let stat: fs.Stats;
  try { stat = fs.statSync(cwd); } catch { throw new GitError(`Folder not found: ${cwd}`, 'invalid'); }
  if (!stat.isDirectory()) throw new GitError(`Not a folder: ${cwd}`, 'invalid');
  return cwd;
}

async function toplevel(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new GitError('Not a Git repository', 'not_repo');
  }
}

async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
  return parseWorktreePorcelain(await git(cwd, ['worktree', 'list', '--porcelain']));
}

/** The worktree path the renderer named, as long as git lists it for `cwd`. */
async function resolveWorktree(cwd: string, worktree: unknown): Promise<string> {
  if (typeof worktree !== 'string' || !worktree) throw new GitError('No worktree selected', 'invalid');
  const want = worktreeKey(worktree);
  const match = (await listWorktrees(cwd)).find((w) => !w.bare && !w.prunable && worktreeKey(w.path) === want);
  if (!match) throw new GitError(`Not a worktree of this repository: ${worktree}`, 'invalid');
  return match.path;
}

async function worktreeSummary(wt: GitWorktree): Promise<GitWorktreeSummary | null> {
  if (wt.bare || wt.prunable) return null;
  try {
    return summarizeStatus(parseStatusV2(await git(wt.path, ['status', '--porcelain=v2', '--branch', '-z', '-unormal'])));
  } catch {
    return null;
  }
}

async function repoInfo(cwd: string): Promise<GitRepoInfo> {
  const root = await toplevel(cwd);
  const worktrees = await listWorktrees(root);
  // Sequential on purpose — same reasoning as diff-provider's untracked loop:
  // this runs in the process that relays every keystroke (#141).
  const entries: GitWorktreeEntry[] = [];
  for (const wt of worktrees) entries.push({ ...wt, summary: await worktreeSummary(wt) });
  const refs = parseRefs(await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']));
  const originHead = (await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '')).trim() || null;
  return { root, worktrees: entries, refs, defaultBase: pickDefaultBase(refs, originHead) };
}

async function workingChanges(cwd: string, worktree: unknown): Promise<GitWorkingChanges> {
  const wt = await resolveWorktree(cwd, worktree);
  const status = parseStatusV2(await git(wt, ['status', '--porcelain=v2', '-z', '-unormal']));
  const stagedStats = parseNumstatZ(await git(wt, ['diff', ...DIFF_FLAGS, '--cached', '--numstat', '-z', '-M']).catch(() => ''));
  const unstagedStats = parseNumstatZ(await git(wt, ['diff', ...DIFF_FLAGS, '--numstat', '-z']).catch(() => ''));
  const changes: GitWorkingChanges = { staged: [], unstaged: [], untracked: [], conflicted: [] };
  for (const e of status.entries) addWorkingEntry(changes, e, stagedStats, unstagedStats);
  return changes;
}

function addWorkingEntry(
  changes: GitWorkingChanges, e: StatusEntry,
  stagedStats: Map<string, LineStat>, unstagedStats: Map<string, LineStat>,
): void {
  const withStats = (status: GitFileStatus, s: LineStat | undefined): GitFileChange => ({
    path: e.path,
    ...(e.oldPath ? { oldPath: e.oldPath } : {}),
    status,
    additions: s?.additions ?? 0,
    deletions: s?.deletions ?? 0,
    ...(s?.binary ? { binary: true } : {}),
  });
  if (e.kind === 'untracked') { changes.untracked.push(withStats('added', undefined)); return; }
  if (e.kind === 'unmerged') { changes.conflicted.push(withStats('conflicted', unstagedStats.get(e.path))); return; }
  if (e.x !== '.') changes.staged.push(withStats(statusFromLetter(e.x), stagedStats.get(e.path)));
  if (e.y !== '.') changes.unstaged.push(withStats(statusFromLetter(e.y), unstagedStats.get(e.path)));
}

async function workingDiff(cwd: string, worktree: unknown, file: unknown, section: GitWorkingSection): Promise<string> {
  const wt = await resolveWorktree(cwd, worktree);
  if (!isSafeRepoPath(file)) throw new GitError('Invalid file path', 'invalid');
  if (section === 'untracked') return untrackedFileDiff(wt, file);
  const args = section === 'staged' ? ['diff', ...DIFF_FLAGS, '--cached', '-M'] : ['diff', ...DIFF_FLAGS];
  return git(wt, [...args, '--', file]);
}

async function fileChanges(cwd: string, from: string, to: string): Promise<GitFileChange[]> {
  const names = parseNameStatusZ(await git(cwd, ['diff', ...DIFF_FLAGS, '--name-status', '-z', '-M', from, to]));
  const stats = parseNumstatZ(await git(cwd, ['diff', ...DIFF_FLAGS, '--numstat', '-z', '-M', from, to]));
  return joinFileStats(names, stats);
}

async function resolveCommit(cwd: string, rev: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])).trim();
  } catch {
    throw new GitError(`Unknown revision: ${rev}`, 'invalid');
  }
}

/**
 * What a branch did since it forked from `base`. THREE-dot, i.e.
 * `merge-base(base, HEAD)..HEAD`, so commits that landed on the base after the
 * fork never read as the agent's work. Uncommitted changes stay out of it (they
 * are the working-changes view).
 */
async function branchChanges(cwd: string, worktree: unknown, base: unknown): Promise<GitBranchChanges> {
  const wt = await resolveWorktree(cwd, worktree);
  if (!isSafeRev(base)) throw new GitError('Invalid base branch', 'invalid');
  const head = await resolveCommit(wt, 'HEAD');
  const baseHash = await resolveCommit(wt, base);
  const mergeBase = (await git(wt, ['merge-base', baseHash, head]).catch(() => '')).trim() || null;
  const from = mergeBase ?? baseHash;
  const commits = parseLog(await git(wt, ['log', `--format=${LOG_FORMAT}`, '-n', '500', `${from}..${head}`]));
  const files = await fileChanges(wt, from, head);
  return { base, mergeBase, head, commits, files };
}

const GRAPH_MAX = 5000;

async function graph(cwd: string, worktree: unknown, scope: GitGraphScope, limit: unknown): Promise<{ commits: GitCommit[]; more: boolean }> {
  const wt = await resolveWorktree(cwd, worktree);
  const n = Math.min(GRAPH_MAX, Math.max(50, Number(limit) || 400));
  const revs = await graphRevs(cwd, scope);
  const out = await git(wt, ['log', '--date-order', `--format=${LOG_FORMAT}`, '-n', String(n + 1), ...revs]);
  const commits = parseLog(out);
  return { commits: commits.slice(0, n), more: commits.length > n };
}

/**
 * `--all` misses the other worktrees' HEADs — a detached worktree's commits
 * live on no ref, and those are exactly the commits an agent made — so every
 * worktree HEAD is named explicitly too. Stashes are left out: they are
 * commits, but not history anyone is reviewing.
 */
async function graphRevs(cwd: string, scope: GitGraphScope): Promise<string[]> {
  if (scope === 'worktree') return ['HEAD'];
  const heads = (await listWorktrees(cwd)).map((w) => w.head).filter(isHash);
  if (scope === 'local') return ['--branches', 'HEAD', ...heads];
  return ['--exclude=refs/stash', '--all', 'HEAD', ...heads];
}

async function commitDetails(cwd: string, hash: unknown): Promise<GitCommitDetails> {
  if (!isHash(hash)) throw new GitError('Invalid commit', 'invalid');
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s', '%cn', '%ct', '%b'].join('%x1f');
  const out = await git(cwd, ['show', '-s', `--format=${fmt}`, hash]);
  const [h, parents, author, email, date, refs, subject, committer, committerDate, ...body] = out.split(FIELD);
  const parentList = parents ? parents.split(' ').filter(Boolean) : [];
  const from = parentList[0] ?? await emptyTree(cwd);
  return {
    hash: h.trim(),
    parents: parentList,
    author, email,
    date: Number(date) || 0,
    refs: refs ? refs.split(', ').filter(Boolean) : [],
    subject,
    committer,
    committerDate: Number(committerDate) || 0,
    body: body.join(FIELD).trim(),
    files: await fileChanges(cwd, from, h.trim()),
  };
}

async function compare(cwd: string, from: unknown, to: unknown): Promise<GitFileChange[]> {
  if (!isHash(to) || (from !== '' && !isHash(from))) throw new GitError('Invalid commit', 'invalid');
  const base = from || await emptyTree(cwd);
  return fileChanges(cwd, base, to);
}

async function rangeDiff(cwd: string, from: unknown, to: unknown, file: unknown, oldPath?: unknown): Promise<string> {
  if (!isHash(to) || (from !== '' && !isHash(from))) throw new GitError('Invalid commit', 'invalid');
  if (!isSafeRepoPath(file)) throw new GitError('Invalid file path', 'invalid');
  const paths = isSafeRepoPath(oldPath) && oldPath !== file ? [oldPath, file] : [file];
  const base = from || await emptyTree(cwd);
  return git(cwd, ['diff', ...DIFF_FLAGS, '-M', base, to, '--', ...paths]);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<GitViewResult<unknown>>>();

/**
 * Answer one request. Never throws: a failure is `{ok:false}` with git's own
 * first line, because "fatal: bad revision" is more useful in the pane than a
 * generic error. Identical requests that arrive while one is running share it
 * (a polling view and a click on the same file, #141).
 */
export function handleGitView(req: GitViewRequest): Promise<GitViewResult<unknown>> {
  const key = JSON.stringify(req);
  const running = inFlight.get(key);
  if (running) return running;
  const started = dispatch(req)
    .then((data): GitViewResult<unknown> => ({ ok: true, data }))
    .catch((err: unknown): GitViewResult<unknown> => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof GitError ? err.code : 'failed',
    }))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

async function dispatch(req: GitViewRequest): Promise<unknown> {
  if (!req || typeof req !== 'object') throw new GitError('Invalid request', 'invalid');
  const cwd = assertDir(req.cwd);
  switch (req.op) {
    case 'repo': return repoInfo(cwd);
    case 'working': return workingChanges(cwd, req.worktree);
    case 'workingDiff': return workingDiff(cwd, req.worktree, req.file, validSection(req.section));
    case 'branch': return branchChanges(cwd, req.worktree, req.base);
    case 'graph': return graph(cwd, req.worktree, validScope(req.scope), req.limit);
    case 'commit': return commitDetails(cwd, req.hash);
    case 'compare': return compare(cwd, req.from, req.to);
    case 'rangeDiff': return rangeDiff(cwd, req.from, req.to, req.file, req.oldPath);
    default: throw new GitError('Unknown request', 'invalid');
  }
}

function validSection(section: unknown): GitWorkingSection {
  if (section === 'staged' || section === 'unstaged' || section === 'untracked' || section === 'conflicted') return section;
  throw new GitError('Invalid section', 'invalid');
}

function validScope(scope: unknown): GitGraphScope {
  return scope === 'local' || scope === 'worktree' ? scope : 'all';
}
