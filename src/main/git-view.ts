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
import type { ExecFileException } from 'child_process';
import { execFilePlain, execFileRoutedAsync, type PlainExecAsync } from './exec-worker-routed';
import * as fs from 'fs';
import * as path from 'path';
import type {
  GitBranchChanges, GitCommit, GitCommitDetails, GitFileChange, GitFileStatus,
  GitGraphScope, GitRefs, GitRepoInfo, GitViewRequest, GitViewResult,
  GitWorkingChanges, GitWorkingSection, GitWorktree, GitWorktreeEntry, GitWorktreeSummary,
} from '../shared/git-view';
import { wslExecutable, wslSystemRoot } from './system32';
import { isWslDistroName } from '../shared/wsl-distro';
import { contextLaneKey, contextLocationKey, type GitContext, isWslContext, type WslGitContext } from './exec-location';
import { untrackedDiffArgs, untrackedFileDiffAny } from './diff-provider';
import { canonicalRemoteRelPath } from './ssh-path';
import { gitTraceOp, traceExitStatus, traceSpawn, type SpawnVia } from './exec-trace';
import { currentSpawnPriority, sshLaneKey, withSpawnSlot, type SpawnSlot } from './exec-gate';
import { cachedForPoll, invalidateSnapshots } from './exec-snapshot';
import type { RemoteFingerprint } from './exec-snapshot-fingerprint';
import { runGitBatch, type BatchGroup } from './exec-git-batch';
import {
  currentSshGit,
  isSshUnreachable,
  runWithSshGit,
  sshGitCommand,
  sshLocationKey,
  SSH_UNREACHABLE_MESSAGE,
  type SshGitContext,
} from './ssh-git';

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
/** `p` without the `/` characters at its end. A loop, not a regex: the path comes from a remote host. */
function stripTrailingSlashes(p: string): string {
  let end = p.length;
  while (end > 0 && p[end - 1] === '/') end--;
  return p.slice(0, end);
}

export function worktreeKey(p: string): string {
  // A remote host path is compared as the text git printed: resolving it here would
  // ask the LOCAL disk about a path that is not on it.
  if (currentSshGit()) return stripTrailingSlashes(p) || '/';
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

// Both slash spellings: git run inside WSL prints POSIX paths, and a UNC path
// can reach us as `\\wsl.localhost\<distro>\…` or `//wsl.localhost/<distro>/…`.
const WSL_UNC = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)((?:[\\/].*)?)$/i;

/** The distro and POSIX path a WSL UNC folder names, or null for anything else. */
export function parseWslUnc(p: string): { distro: string; posix: string } | null {
  const m = WSL_UNC.exec(p);
  if (!m || !isWslDistroName(m[1])) return null;
  const posix = m[2].replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return { distro: m[1], posix: posix === '' ? '/' : posix };
}

/**
 * The ONE switch for the fast route of a folder on a WSL share: `WMUX_WSL_FAST=1`. Off by
 * default, and then such a folder behaves exactly as it did before ssh workspaces existed:
 * every git call is its own `wsl.exe -d <distro> --cd <dir> --exec git`, re-run on every
 * poll, with no batch, no spawn gate, no poll cache, no persistent worker and no warm-up.
 *
 * It is opt-in because the fast route changes what a person sees without their having asked
 * for anything (no `set-ssh-target` is involved): a poll is answered from the cache while the
 * checkout's fingerprint is unchanged, with a back-off of up to 30 s, so a commit made from
 * the workspace's own pane can show late; and a `wsl.exe` worker per distro is started when
 * the workspace comes on screen. Every one of those hangs off `wslGitContextFor` answering
 * null, plus the `wslEnv` of `spawnGit`, so there is nothing else to switch.
 *
 * Read on every call rather than once, so a test can flip it.
 */
export function wslFastRouteEnabled(): boolean {
  return process.env.WMUX_WSL_FAST === '1';
}

/**
 * The context a git call on `folder` runs in when the folder is on a WSL share, or
 * null for anything else. Only a UNC path with a distro and a directory in it
 * qualifies: a `C:\\` path, or the Windows spelling of a worktree under `/mnt/c`, runs on
 * Windows git.
 */
export function wslGitContextFor(folder: unknown): WslGitContext | null {
  if (!wslFastRouteEnabled()) return null;
  if (typeof folder !== 'string' || folder.includes('\0')) return null;
  const wsl = parseWslUnc(folder);
  return wsl ? { wsl } : null;
}

/** The path Windows uses for a POSIX path git printed inside `distro`. */
export function wslPathToWindows(distro: string, posix: string): string {
  const drive = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(posix);
  if (drive) return `${drive[1].toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`;
  return `\\\\wsl.localhost\\${distro}${posix.replace(/\//g, '\\')}`;
}

/** A path git printed for a command run in `cwd`, as the Windows path wmux uses. */
export function fromGitPath(cwd: string, p: string): string {
  const wsl = parseWslUnc(cwd);
  return wsl && p.startsWith('/') ? wslPathToWindows(wsl.distro, p) : p;
}

/** Where a command runs when it is not the Windows git: for the gate, the trace and the error mapping (exec-location.ts). */
export type GitRoute =
  /** Over ssh on a remote host; its exit 255 means "unreachable". `wsl`: the ssh runs inside WSL, so wsl.exe's own failures also mean "unreachable". */
  | { kind: 'ssh'; wsl: boolean }
  /** In the distro of a folder on a WSL share. `env`: the variables forwarded through WSLENV, which a persistent worker sets for the call. */
  | { kind: 'wsl'; env: Record<string, string> };

export interface GitCommand {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Unsaid for the local Windows git. */
  route?: GitRoute;
}

/**
 * How to run `git <gitArgs>` for `cwd`.
 *
 * While a request runs inside `runWithSshGit` (ssh-git.ts) it is a git on the
 * remote host instead, whatever `cwd` is: see that module for why the switch lives
 * here and not at each call site.
 *
 * A folder on a WSL share (`\\wsl.localhost\<distro>\…`) is read by git inside
 * that distro: `wsl.exe -d <distro> --cd <path> --exec git …`. Linux git sees the
 * real executable bits and symlinks, owns the repository (no "dubious ownership"
 * refusal) and does no CRLF conversion, so nothing has to be configured or
 * trusted. Windows git over the share gets all of those wrong. `--exec` runs git
 * without a shell, so arguments are never re-parsed. `wsl.exe` is the absolute
 * System32 one for the same reason `gitExecutable` is absolute.
 *
 * Every other folder runs the absolute Windows git as before. `extraEnv` is
 * forwarded into WSL through `WSLENV`.
 */
export function gitCommand(
  cwd: string,
  gitArgs: string[],
  extraEnv: Record<string, string> = {},
  windowsGit: () => string = gitExecutable,
): GitCommand {
  const remote = currentSshGit();
  if (remote) {
    const { file, args, cwd: sshCwd, env, wsl } = sshGitCommand(remote, cwd, gitArgs);
    return { file, args, cwd: sshCwd, env, route: { kind: 'ssh', wsl } };
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const wsl = parseWslUnc(cwd);
  if (!wsl) return { file: windowsGit(), args: gitArgs, cwd, env };

  const forwarded = (env.WSLENV ?? '').split(':').filter(Boolean);
  for (const name of Object.keys(extraEnv)) {
    if (!forwarded.some((f) => f.split('/')[0] === name)) forwarded.push(name);
  }
  if (forwarded.length) env.WSLENV = forwarded.join(':');
  const systemRoot = wslSystemRoot(env);
  return {
    file: wslExecutable(env),
    args: ['-d', wsl.distro, '--cd', wsl.posix, '--exec', 'git', ...gitArgs],
    cwd: systemRoot,
    env,
    route: { kind: 'wsl', env: extraEnv },
  };
}

/** What `spawnGit` needs beyond the command: the options a caller's own limits and environment add. */
export interface GitSpawnOptions {
  timeout: number;
  maxBuffer: number;
  /** Put before the arguments (`git -c …`), and left out of the trace line. */
  prefix?: string[];
  /** Added to the environment, and forwarded into a WSL distro. */
  env?: Record<string, string>;
  /** The spawn itself, when the caller has its own `promisify(execFile)`. */
  plain?: PlainExecAsync;
}

/**
 * ONE git process for `cwd`, wherever that is (`gitCommand`): through a persistent worker when the
 * route has one (`execFileRoutedAsync`), in the lane's slot (on a remote host, and in a WSL distro, at most a
 * few spawns run at once, and a click's goes first: exec-gate.ts), and traced. It settles with the
 * command and what the process answered; a failure of the process is `err`, never a rejection. It rejects
 * only when no command can be built (no ssh executable, no git), which each caller reports as its own.
 */
export function spawnGit(
  cwd: string,
  args: string[],
  { timeout, maxBuffer, prefix = [], env = {}, plain = execFilePlain }: GitSpawnOptions,
): Promise<{ cmd: GitCommand; err: ExecFileException | null; stdout: string; stderr: string }> {
  const remote = currentSshGit();
  const wslFolder = remote ? null : wslGitContextFor(cwd);
  const run = async (slot?: SpawnSlot): Promise<Awaited<ReturnType<typeof spawnGit>>> => {
    const cmd = gitCommand(cwd, [...prefix, ...args], env);
    const done = cmd.route ? traceSpawn(() => gitTraceOp(args), slot, cmd.route.kind) : undefined;
    try {
      const { stdout, stderr, via, cold } = await execFileRoutedAsync(cmd.file, cmd.args, {
        cwd: cmd.cwd,
        windowsHide: true,
        timeout,
        maxBuffer,
        env: cmd.env,
        idempotent: true, // every git call here reads: repeating one after a worker failure is safe
        // Without `wslEnv` a WSL call is never served by a worker: that is how the switch reaches it.
        wslEnv: wslFolder && cmd.route?.kind === 'wsl' ? cmd.route.env : undefined,
      }, plain);
      done?.(0, stdout.length, via, cold);
      return { cmd, err: null, stdout, stderr };
    } catch (failure) {
      const err = failure as ExecFileException & { via?: SpawnVia; cold?: boolean };
      const stdout = String(err.stdout ?? '');
      done?.(traceExitStatus(err), stdout.length, err.via, err.cold);
      return { cmd, err, stdout, stderr: String(err.stderr ?? '') };
    }
  };
  if (remote) return withSpawnSlot(sshLaneKey(remote.target), run);
  return wslFolder ? withSpawnSlot(contextLaneKey(wslFolder), run) : run();
}

async function git(
  cwd: string,
  args: string[],
  maxBuffer = 20 * 1024 * 1024,
  /** Exit statuses that still carry the answer (`diff --no-index` exits 1 when the files differ). */
  okStatuses: readonly number[] = [],
): Promise<string> {
  const { cmd, err, stdout, stderr } = await spawnGit(cwd, args, {
    timeout: 15_000, maxBuffer, prefix: GIT_PREFIX, env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (!err) return stdout;
  if (typeof err.code === 'number' && okStatuses.includes(err.code)) return stdout;
  // ssh's own failure, not git's. Its stderr (and `-q` silences it anyway)
  // can carry local paths, so the answer is a fixed sentence.
  if (cmd.route?.kind === 'ssh' && isSshUnreachable(err, cmd.route.wsl)) throw new GitError(SSH_UNREACHABLE_MESSAGE);
  const first = String(stderr || err.message).split(/\r?\n/).find((l) => l.trim()) ?? 'git failed';
  throw new GitError(first.replace(/^(fatal|error): /, ''));
}

// ─── One spawn per request on a remote host or a WSL folder ──────────────────
// Every spawn on the WSL route pays a `wsl.exe` start, so the queries below run their
// independent git commands in one script (`runGitCmds`, exec-git-batch.ts): on the remote
// host, or in the distro of a folder on a WSL share. Without a context to batch in (a
// Windows folder) or when a batch is not answered in the expected format, the same
// commands run one spawn each (`runOneByOne`).

/** The options every `git()` call adds, so a batched command reads the same way. */
const GIT_PREFIX = ['-c', 'core.quotepath=off', '-c', 'color.ui=never', '--literal-pathspecs'];

interface BatchCmd {
  args: string[];
  /** Exit statuses that still carry the answer, as `git()`'s own parameter. */
  okStatuses?: readonly number[];
  /** A failure is an empty answer (`.catch(() => '')`) instead of an error. */
  soft?: boolean;
  /** Run in this worktree instead of `cwd`; only a batch can, and `inWorktreeBatched` sets it. */
  worktree?: string;
}

interface Answer {
  ok: boolean;
  status: number;
  stdout: string;
  error: GitError;
}

/** The text of a command that has to succeed. */
function must(answer: Answer): string {
  if (!answer.ok) throw answer.error;
  return answer.stdout;
}

/** The text of each command: a failure throws, unless the command is `soft`, where it is ''. */
function settle(cmds: readonly BatchCmd[], answers: readonly Answer[]): string[] {
  return answers.map((a, i) => (cmds[i].soft && !a.ok ? '' : must(a)));
}

const answerOf = (cmd: BatchCmd, outcome: { status: number; stdout: string; stderr: string }): Answer => {
  const first = outcome.stderr.split(/\r?\n/).find((l) => l.trim()) ?? 'git failed';
  return {
    ok: outcome.status === 0 || (cmd.okStatuses?.includes(outcome.status) ?? false),
    status: outcome.status,
    stdout: outcome.stdout,
    error: new GitError(first.replace(/^(fatal|error): /, '')),
  };
};

/**
 * Several commands, ONE spawn, on the remote host of the running request or, for
 * a folder on a WSL share, in its distro; null when there is neither (a Windows
 * folder) or the batch was not answered in its format. An unreachable remote host
 * throws, as `git()` does; a WSL folder has no such error, and any failure of its
 * batch is null.
 */
async function batch(cwd: string, groups: readonly BatchCmd[]): Promise<Answer[] | null> {
  const context: GitContext | null = currentSshGit() ?? wslGitContextFor(cwd);
  if (!context) return null;
  // A WSL folder is named by its UNC path here and by a POSIX one in its distro; a worktree that
  // is not in the same distro (a drive path, say) is not batched, and runs the long way.
  const place = (w: string): string | null => {
    if (!isWslContext(context)) return w;
    const wsl = parseWslUnc(w);
    return wsl && wsl.distro === context.wsl.distro ? wsl.posix : null;
  };
  const sent: BatchGroup[] = [];
  for (const g of groups) {
    const prefixed = [...GIT_PREFIX, ...g.args];
    if (g.worktree === undefined) { sent.push({ dir: 'c', args: prefixed }); continue; }
    const worktree = place(g.worktree);
    if (worktree === null) return null;
    sent.push({ dir: 'w', worktree, args: prefixed });
  }
  const outcomes = await runGitBatch(context, isWslContext(context) ? context.wsl.posix : cwd, sent);
  return outcomes ? outcomes.map((o, i) => answerOf(groups[i], o)) : null;
}

/** The same commands, one `git()` spawn each: what runs when there is nothing to batch them into. */
async function runOneByOne(cwd: string, cmds: readonly BatchCmd[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) {
    const run = git(cwd, c.args, undefined, c.okStatuses);
    out.push(c.soft ? await run.catch(() => '') : await run);
  }
  return out;
}

/**
 * The text of each command, in `cwd`: all in ONE spawn when there is somewhere to batch
 * them (see `batch`), else one `git()` each. A caller states its commands once, and a
 * batch that was not understood costs only its own spawn.
 */
async function runGitCmds(cwd: string, cmds: readonly BatchCmd[]): Promise<string[]> {
  const answers = await batch(cwd, cmds);
  return answers ? settle(cmds, answers) : runOneByOne(cwd, cmds);
}

const LIST_WORKTREES: BatchCmd = { args: ['worktree', 'list', '--porcelain'] };

/** `worktree list` as `listWorktrees` reads it, from the text a batch returned. */
function worktreesFrom(cwd: string, text: string): GitWorktree[] {
  return parseWorktreePorcelain(text).map((w) => ({ ...w, path: fromGitPath(cwd, w.path) }));
}

/**
 * The worktree the renderer named, validated against git's own list (as
 * `resolveWorktree`), AND `cmds` run in it, in the same spawn as that list.
 * The script runs them only in a worktree whose path it finds listed verbatim.
 * Null: not batched (local, an odd spelling of the path, a batch that failed),
 * and the caller does it the long way (`inWorktree` does, for the callers that
 * can use the text of their commands as it comes).
 */
async function inWorktreeBatched(
  cwd: string,
  worktree: unknown,
  cmds: readonly BatchCmd[],
): Promise<{ wt: string; worktrees: GitWorktree[]; out: Answer[] } | null> {
  if (typeof worktree !== 'string' || !worktree) return null;
  const answers = await batch(cwd, [LIST_WORKTREES, ...cmds.map((c) => ({ ...c, worktree }))]);
  if (!answers) return null;
  const [list, ...out] = answers;
  const worktrees = worktreesFrom(cwd, must(list));
  const want = worktreeKey(worktree);
  const match = worktrees.find((w) => !w.bare && !w.prunable && worktreeKey(w.path) === want);
  if (!match) throw new GitError(`Not a worktree of this repository: ${worktree}`, 'invalid');
  // 125 is the script declining to run in a path it did not find listed verbatim
  // (a spelling difference): not an answer, so do it the long way.
  if (out.some((a) => a.status === 125)) return null;
  return { wt: match.path, worktrees, out };
}

/**
 * `inWorktreeBatched`, and where it is null the worktree is resolved and each command runs on
 * its own. `worktrees` is the list the batch carried, and undefined when there was none.
 */
async function inWorktree(
  cwd: string,
  worktree: unknown,
  cmds: readonly BatchCmd[],
): Promise<{ wt: string; worktrees?: GitWorktree[]; out: string[] }> {
  const batched = await inWorktreeBatched(cwd, worktree, cmds);
  if (batched) return { ...batched, out: settle(cmds, batched.out) };
  const wt = await resolveWorktree(cwd, worktree);
  return { wt, out: await runOneByOne(wt, cmds) };
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

function emptyTreeFor(format: string): string {
  return format.trim() === 'sha256'
    ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
    : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

async function emptyTree(cwd: string): Promise<string> {
  return emptyTreeFor(await git(cwd, ['rev-parse', '--show-object-format']).catch(() => 'sha1'));
}

const OBJECT_FORMAT: BatchCmd = { args: ['rev-parse', '--show-object-format'] };

function assertDir(cwd: unknown): string {
  // A UNC path on a WSL share is absolute on Windows, where this runs. The second test only keeps
  // the same answer on the other platforms the unit tests run on.
  if (typeof cwd !== 'string' || !cwd || !(path.isAbsolute(cwd) || parseWslUnc(cwd))) throw new GitError('No folder to inspect', 'invalid');
  let stat: fs.Stats;
  try { stat = fs.statSync(cwd); } catch { throw new GitError(`Folder not found: ${cwd}`, 'invalid'); }
  if (!stat.isDirectory()) throw new GitError(`Not a folder: ${cwd}`, 'invalid');
  return cwd;
}

async function toplevel(cwd: string): Promise<string> {
  try {
    return fromGitPath(cwd, (await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  } catch (err) {
    // On a remote host, "could not reach it" (or no ssh to run) must not read as
    // "not a repository": only git's own refusal is that.
    if (currentSshGit() && (!(err instanceof GitError) || err.message === SSH_UNREACHABLE_MESSAGE)) throw err;
    throw new GitError('Not a Git repository', 'not_repo');
  }
}

async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
  return parseWorktreePorcelain(await git(cwd, ['worktree', 'list', '--porcelain']))
    .map((w) => ({ ...w, path: fromGitPath(cwd, w.path) }));
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

const WORKTREE_STATUS = ['status', '--porcelain=v2', '--branch', '-z', '-unormal'];
const REFS_CMD: BatchCmd = { args: ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'] };
const ORIGIN_HEAD_CMD: BatchCmd = { args: ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'] };

/**
 * `repoInfo` for a remote host in one spawn (two when the repository has linked
 * worktrees): the toplevel, the worktree list, the refs, origin's HEAD and the
 * checkout's own status together, then the other worktrees' statuses together.
 * Null: do it the long way.
 */
async function repoInfoBatched(cwd: string): Promise<GitRepoInfo | null> {
  const first = await batch(cwd, [
    { args: ['rev-parse', '--show-toplevel'] },
    LIST_WORKTREES,
    REFS_CMD,
    ORIGIN_HEAD_CMD,
    { args: WORKTREE_STATUS },
  ]);
  if (!first) return null;
  const [top, list, refsOut, origin, own] = first;
  // Only git's own refusal is "not a repository"; an unreachable host threw above.
  if (!top.ok) throw new GitError('Not a Git repository', 'not_repo');
  const root = fromGitPath(cwd, top.stdout.trim());
  const rootKey = worktreeKey(root);
  const worktrees = worktreesFrom(cwd, must(list));
  const usable = (w: GitWorktree) => !w.bare && !w.prunable;
  const others = worktrees.filter((w) => usable(w) && worktreeKey(w.path) !== rootKey);
  const elsewhere = others.length > 0
    ? await batch(cwd, others.map((w) => ({ args: WORKTREE_STATUS, worktree: w.path })))
    : [];
  const summaries = new Map<string, GitWorktreeSummary | null>();
  for (const [i, w] of others.entries()) {
    if (elsewhere) summaries.set(w.path, elsewhere[i].ok ? summarizeStatus(parseStatusV2(elsewhere[i].stdout)) : null);
    else summaries.set(w.path, await worktreeSummary(w));
  }
  const summaryOf = (w: (typeof worktrees)[number]): GitWorktreeEntry['summary'] => {
    if (!usable(w)) return null;
    if (worktreeKey(w.path) !== rootKey) return summaries.get(w.path) ?? null;
    return own.ok ? summarizeStatus(parseStatusV2(own.stdout)) : null;
  };
  const entries: GitWorktreeEntry[] = worktrees.map((w) => ({ ...w, summary: summaryOf(w) }));
  const refs = parseRefs(must(refsOut));
  const originHead = (origin.ok ? origin.stdout.trim() : '') || null;
  return {
    root, worktrees: entries, refs, defaultBase: pickDefaultBase(refs, originHead),
    // Only a remote host's paths must not be pinned as this tab's local folder; a WSL folder's are local ones.
    ...(currentSshGit() ? { remote: true as const } : {}),
  };
}

async function repoInfo(cwd: string): Promise<GitRepoInfo> {
  const batched = await repoInfoBatched(cwd);
  if (batched) return batched;
  const root = await toplevel(cwd);
  const worktrees = await listWorktrees(root);
  // Sequential on purpose — same reasoning as diff-provider's untracked loop:
  // this runs in the process that relays every keystroke (#141).
  const entries: GitWorktreeEntry[] = [];
  for (const wt of worktrees) entries.push({ ...wt, summary: await worktreeSummary(wt) });
  const refs = parseRefs(await git(root, REFS_CMD.args));
  const originHead = (await git(root, ORIGIN_HEAD_CMD.args).catch(() => '')).trim() || null;
  return {
    root, worktrees: entries, refs, defaultBase: pickDefaultBase(refs, originHead),
    // The renderer must not pin a remote host path as this tab's local folder.
    ...(currentSshGit() ? { remote: true as const } : {}),
  };
}

async function workingChanges(cwd: string, worktree: unknown): Promise<GitWorkingChanges> {
  const { out: [statusOut, stagedOut, unstagedOut] } = await inWorktree(cwd, worktree, [
    { args: ['status', '--porcelain=v2', '-z', '-unormal'] },
    { args: ['diff', ...DIFF_FLAGS, '--cached', '--numstat', '-z', '-M'], soft: true },
    { args: ['diff', ...DIFF_FLAGS, '--numstat', '-z'], soft: true },
  ]);
  const status = parseStatusV2(statusOut);
  const stagedStats = parseNumstatZ(stagedOut);
  const unstagedStats = parseNumstatZ(unstagedOut);
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
  // On a remote host the untracked branch runs `diff --no-index`, which reads any file the account can,
  // so a path there must be one git printed (below the checkout, canonical). Refused before anything is
  // spawned, batched or not; the other sections get the same rule because it costs a real path nothing.
  if (currentSshGit() && canonicalRemoteRelPath(file) === null) throw new GitError('Invalid file path', 'invalid');
  const args = section === 'staged' ? ['diff', ...DIFF_FLAGS, '--cached', '-M'] : ['diff', ...DIFF_FLAGS];
  // A file that is not a safe path is refused below, after the worktree is.
  // A WSL folder reads an untracked file through its share, not through git: nothing to batch there.
  if (isSafeRepoPath(file) && (currentSshGit() || (section !== 'untracked' && wslGitContextFor(cwd)))) {
    const cmd: BatchCmd = section === 'untracked'
      ? { args: untrackedDiffArgs(file), okStatuses: [1], soft: true }
      : { args: [...args, '--', file] };
    const batched = await inWorktreeBatched(cwd, worktree, [cmd]);
    if (batched) return settle([cmd], batched.out)[0];
  }
  const wt = await resolveWorktree(cwd, worktree);
  if (!isSafeRepoPath(file)) throw new GitError('Invalid file path', 'invalid');
  if (section === 'untracked') return untrackedFileDiffAny(wt, file, (cwdArg, gitArgs) => git(cwdArg, gitArgs, undefined, [1]));
  return git(wt, [...args, '--', file]);
}

const nameStatusCmd = (from: string, to: string): BatchCmd => ({ args: ['diff', ...DIFF_FLAGS, '--name-status', '-z', '-M', from, to] });
const numstatCmd = (from: string, to: string): BatchCmd => ({ args: ['diff', ...DIFF_FLAGS, '--numstat', '-z', '-M', from, to] });

async function fileChanges(cwd: string, from: string, to: string): Promise<GitFileChange[]> {
  const [names, stats] = await runGitCmds(cwd, [nameStatusCmd(from, to), numstatCmd(from, to)]);
  return joinFileStats(parseNameStatusZ(names), parseNumstatZ(stats));
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
  // On a remote host the worktree check, both revisions and the merge base are
  // one spawn. `merge-base <base> HEAD` names what the long form passes as the
  // two hashes it has just resolved: the same commits.
  const first = isSafeRev(base)
    ? await inWorktreeBatched(cwd, worktree, [
      { args: ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'] },
      { args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`] },
      { args: ['merge-base', base, 'HEAD'] },
    ])
    : null;
  let wt: string;
  let head: string;
  let baseHash: string;
  let mergeBase: string | null;
  if (first) {
    if (!first.out[0].ok) throw new GitError('Unknown revision: HEAD', 'invalid');
    if (!first.out[1].ok) throw new GitError(`Unknown revision: ${String(base)}`, 'invalid');
    wt = first.wt;
    head = first.out[0].stdout.trim();
    baseHash = first.out[1].stdout.trim();
    mergeBase = (first.out[2].ok ? first.out[2].stdout.trim() : '') || null;
  } else {
    wt = await resolveWorktree(cwd, worktree);
    if (!isSafeRev(base)) throw new GitError('Invalid base branch', 'invalid');
    head = await resolveCommit(wt, 'HEAD');
    baseHash = await resolveCommit(wt, base);
    mergeBase = (await git(wt, ['merge-base', baseHash, head]).catch(() => '')).trim() || null;
  }
  const from = mergeBase ?? baseHash;
  const logCmd: BatchCmd = { args: ['log', `--format=${LOG_FORMAT}`, '-n', '500', `${from}..${head}`] };
  const [log, names, stats] = await runGitCmds(wt, [logCmd, nameStatusCmd(from, head), numstatCmd(from, head)]);
  return { base: base as string, mergeBase, head, commits: parseLog(log), files: joinFileStats(parseNameStatusZ(names), parseNumstatZ(stats)) };
}

const GRAPH_MAX = 5000;

async function graph(cwd: string, worktree: unknown, scope: GitGraphScope, limit: unknown): Promise<{ commits: GitCommit[]; more: boolean }> {
  const n = Math.min(GRAPH_MAX, Math.max(50, Number(limit) || 400));
  const logArgs = (revs: string[]): string[] => ['log', '--date-order', `--format=${LOG_FORMAT}`, '-n', String(n + 1), ...revs];
  // On a remote host: the worktree check and, for the one-worktree scope, the log
  // itself are one spawn; the other scopes need the worktrees' HEADs first,
  // so they are two (the list, then the log) instead of three.
  const first = await inWorktree(cwd, worktree, scope === 'worktree' ? [{ args: logArgs(['HEAD']) }] : []);
  const [out] = scope === 'worktree'
    ? first.out
    : await runGitCmds(first.wt, [{ args: logArgs(graphRevsFrom(scope, first.worktrees ?? await listWorktrees(cwd))) }]);
  return graphPage(out, n);
}

function graphPage(out: string, n: number): { commits: GitCommit[]; more: boolean } {
  const commits = parseLog(out);
  return { commits: commits.slice(0, n), more: commits.length > n };
}

/**
 * `--all` misses the other worktrees' HEADs — a detached worktree's commits
 * live on no ref, and those are exactly the commits an agent made — so every
 * worktree HEAD is named explicitly too. Stashes are left out: they are
 * commits, but not history anyone is reviewing.
 */
function graphRevsFrom(scope: GitGraphScope, worktrees: GitWorktree[]): string[] {
  if (scope === 'worktree') return ['HEAD'];
  const heads = worktrees.map((w) => w.head).filter(isHash);
  if (scope === 'local') return ['--branches', 'HEAD', ...heads];
  return ['--exclude=refs/stash', '--all', 'HEAD', ...heads];
}

async function commitDetails(cwd: string, hash: unknown): Promise<GitCommitDetails> {
  if (!isHash(hash)) throw new GitError('Invalid commit', 'invalid');
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s', '%cn', '%ct', '%b'].join('%x1f');
  // On a remote host the object format (for a root commit's empty tree) rides along with `show`.
  const showCmd: BatchCmd = { args: ['show', '-s', `--format=${fmt}`, hash] };
  const shown = await batch(cwd, [showCmd, OBJECT_FORMAT]);
  const out = shown ? must(shown[0]) : await git(cwd, ['show', '-s', `--format=${fmt}`, hash]);
  const [h, parents, author, email, date, refs, subject, committer, committerDate, ...body] = out.split(FIELD);
  const parentList = parents ? parents.split(' ').filter(Boolean) : [];
  const shownFormat = shown?.[1].ok ? shown[1].stdout : '';
  const from = parentList[0] ?? (shown ? emptyTreeFor(shownFormat || 'sha1') : await emptyTree(cwd));
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
  if (currentSshGit() && paths.some((p) => canonicalRemoteRelPath(p) === null)) {
    throw new GitError('Invalid file path', 'invalid');
  }
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
export function handleGitView(req: GitViewRequest, remote?: SshGitContext): Promise<GitViewResult<unknown>> {
  // The remote host is part of the key: with a target the request's own `cwd` is
  // ignored, so two workspaces on different hosts can send identical requests.
  // So is who asked, there: a click must not be answered by a poll's run, which
  // may come from the snapshot cache (exec-snapshot.ts).
  // The same goes for a folder on a WSL share (its own key, and who asked, for the same reason).
  const wslFolder = remote ? null : wslGitContextFor((req as { cwd?: unknown } | null)?.cwd);
  let place = '';
  if (remote) place = sshLocationKey(remote);
  else if (wslFolder) place = contextLocationKey(wslFolder);
  const key = `${place}\n${remote || wslFolder ? currentSpawnPriority() : ''}\n${JSON.stringify(req)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const dispatched = (): Promise<unknown> => {
    if (remote) return runWithSshGit(remote, () => dispatchOn(req, remote, remote.target.path));
    return wslFolder ? dispatchOn(req, wslFolder) : dispatch(req);
  };
  const started = dispatched()
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

/**
 * What a remote request's answer is valid under, for the three requests a
 * pane re-asks on a timer. Anything else is not cached.
 */
function snapshotToken(req: GitViewRequest, wsl?: WslGitContext): ((fp: RemoteFingerprint) => string | null) | undefined {
  if (!req || typeof req !== 'object') return undefined;
  // A repository's fingerprint says "no repository here" with an empty top level: then there is nothing it can vouch for.
  if (req.op === 'repo' || req.op === 'working') return (fp) => (wsl && !fp.toplevel ? null : fp.all);
  if (req.op === 'workingDiff' && typeof req.worktree === 'string' && typeof req.file === 'string') {
    const { file } = req;
    // The fingerprint names a worktree by the path git prints in its distro; the request, by the Windows one.
    const worktree = wsl ? parseWslUnc(req.worktree) : { distro: '', posix: req.worktree };
    if (!worktree || (wsl && worktree.distro !== wsl.wsl.distro)) return undefined;
    return (fp) => fp.fileKey(worktree.posix, file);
  }
  return undefined;
}

/**
 * A request on a remote host (`remoteCwd`: the target's path, never the renderer's `cwd`) or
 * on a folder that lives on a WSL share. A poll's `repo`, `working` and `workingDiff` are
 * answered from the last result while the fingerprint of the host's or the distro's checkout
 * says nothing changed (exec-snapshot.ts); everything else, and every request a person made, runs.
 */
function dispatchOn(req: GitViewRequest, context: GitContext, remoteCwd?: string): Promise<unknown> {
  const token = snapshotToken(req, isWslContext(context) ? context : undefined);
  if (!token) return dispatch(req, remoteCwd);
  return cachedForPoll({
    context,
    key: `view\0${JSON.stringify(req)}`,
    token,
    compute: () => dispatch(req, remoteCwd),
  });
}

/**
 * wmux wrote `file` itself (a save from the code or markdown editor): if it is in a WSL
 * distro, what the polls of that distro cached is out of date and their back-off starts over.
 */
export function noteWslWrite(file: unknown): void {
  const wsl = wslGitContextFor(file);
  if (wsl) invalidateSnapshots(contextLaneKey(wsl));
}

async function dispatch(req: GitViewRequest, remoteCwd?: string): Promise<unknown> {
  if (!req || typeof req !== 'object') throw new GitError('Invalid request', 'invalid');
  // On a remote host the checkout is the workspace's target path, never the
  // renderer's `cwd`, and there is no local folder to stat.
  const cwd = remoteCwd ?? assertDir(req.cwd);
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
