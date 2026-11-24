import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { isSafeRev, spawnGit, wslGitContextFor } from './git-view';
import { canonicalRemoteRelPath } from './ssh-path';
import { type GitContext, isWslContext } from './exec-location';
import { currentSpawnPriority } from './exec-gate';
import { endStdin } from './exec-worker-routed';
import { cachedForPoll } from './exec-snapshot';
import { BatchSetupError, runGitBatch as runBatchRaw, type BatchGroup, type BatchOutcome } from './exec-git-batch';
import {
  currentSshGit,
  isSshUnreachable,
  markSshUnreachable,
  SSH_UNREACHABLE_MESSAGE,
  sshLocationKey,
} from './ssh-git';

const execFilePromise = promisify(execFile);
/** `promisify(execFile)` with the child's stdin closed: see `endStdin` (a direct-route ssh hangs on an open one). */
const execFileAsync: typeof execFilePromise = ((...callArgs: Parameters<typeof execFilePromise>) => {
  const running = execFilePromise(...callArgs);
  endStdin((running as { child?: Parameters<typeof endStdin>[0] }).child);
  return running;
}) as typeof execFilePromise;

export interface ChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

// ─── Git helpers ───────────────────────────────────────────────────────────

// Absolute git, never a bare `git`: libuv searches the child's cwd before
// PATH, and cwd here is whatever repo the pane is in — a committed git.exe
// there would run on every diff poll. Same resolver as git-view.ts.
async function git(cwd: string, args: string[]): Promise<string> {
  let ran: Awaited<ReturnType<typeof spawnGit>>;
  try {
    ran = await spawnGit(cwd, args, { timeout: 10_000, maxBuffer: 5 * 1024 * 1024, plain: execFileAsync });
  } catch (err) {
    // No ssh executable to run: the remote host cannot be reached, and the
    // inner `.catch(() => '')` below would read that as "no changes".
    if (currentSshGit()) {
      markSshUnreachable();
      throw new Error(SSH_UNREACHABLE_MESSAGE, { cause: err });
    }
    throw err;
  }
  const { err, stdout } = ran;
  if (!err) return stdout;
  // Over ssh, exit 255 is the connection, not git. Many callers below
  // turn a failed git into '' with `.catch(() => '')`, which would read as "no
  // changes", so the context is marked and the public entry points throw.
  const remote = currentSshGit();
  if (remote && isSshUnreachable(err, remote.target.wslDistro !== undefined)) {
    markSshUnreachable();
    throw new Error(SSH_UNREACHABLE_MESSAGE, { cause: err });
  }
  if (err.stdout) return String(err.stdout);
  throw err;
}

/**
 * Run a public entry point's work. On a remote host, an unreachable host is an
 * error however many inner `.catch(() => '')` swallowed it on the way.
 */
async function checkedForSsh<T>(work: () => Promise<T>): Promise<T> {
  const context = currentSshGit();
  if (!context) return work();
  context.unreachable = false;
  const result = await work();
  if (context.unreachable) throw new Error(SSH_UNREACHABLE_MESSAGE);
  return result;
}

// Whether a directory is a repo changes about as often as someone runs
// `git init`, but the probe used to spawn a `git rev-parse` on EVERY call to
// both public entry points — a third of the git processes in issue #141 were
// this check. Cache it with a TTL so `git init` is still picked up eventually.
const REPO_PROBE_TTL_MS = 30_000;
const repoProbes = new Map<string, { isRepo: boolean; at: number }>();

async function isGitRepo(cwd: string): Promise<boolean> {
  // The remote host is part of the key: a remote path and a local one can be spelled alike.
  const probeKey = `${sshLocationKey()}${cwd}`;
  const cached = repoProbes.get(probeKey);
  if (cached && Date.now() - cached.at < REPO_PROBE_TTL_MS) return cached.isRepo;
  let isRepo: boolean;
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    isRepo = true;
  } catch {
    // An unreachable host says nothing about the repository: not cached.
    if (currentSshGit()?.unreachable) return false;
    isRepo = false;
  }
  repoProbes.set(probeKey, { isRepo, at: Date.now() });
  return isRepo;
}

// ─── Non-git snapshot system ───────────────────────────────────────────────
// When there's no git repo, we take a snapshot of file contents on first load
// and diff against it on subsequent polls.

interface SnapshotEntry {
  content: string;
  mtimeMs: number;
  size: number;
}

const snapshots = new Map<string, Map<string, SnapshotEntry>>(); // cwd → (relPath → entry)
// One scan per directory at a time: a slow scan coalesces concurrent callers
// instead of piling up (a home-dir scan can outlast the renderer's poll interval).
const scansInFlight = new Map<string, Promise<ChangedFile[]>>();
const SNAPSHOT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.md', '.txt', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.proto', '.xml', '.svg',
]);
const SNAPSHOT_IGNORE = new Set([
  // Build/dependency output
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv',
  // Platform directories. A home directory is never a git repo, so it lands on
  // the snapshot path; without these the walk descends into caches and installed
  // applications, burning the directory budget on files nobody is editing.
  'AppData', 'Library', 'Application Data', '$RECYCLE.BIN', 'System Volume Information',
  'OneDrive', 'Recovery', 'ntuser.dat',
]);
const MAX_SNAPSHOT_FILE = 500_000; // 500KB per file
const MAX_SNAPSHOT_FILES = 2000;
// The file cap bounds how much we READ, not how much we WALK: on a home
// directory ~3,500 directories get enumerated before the file cap bites, and
// which files you end up with is then an accident of traversal order. Budget
// directories too, so the walk itself is bounded.
const MAX_SNAPSHOT_DIRS = 500;
// Re-walking to discover new files is far more expensive than stat-ing the
// files already known, and new files appear far less often than they change.
// Run discovery on a multiple of the content check instead of every poll.
const REWALK_EVERY_N_POLLS = 5;
const pollCounts = new Map<string, number>(); // cwd → polls since last re-walk
const addedPaths = new Map<string, Set<string>>(); // cwd → files discovered since the baseline

function shouldSnapshotFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SNAPSHOT_EXTENSIONS.has(ext);
}

interface WalkBudget { dirs: number }

async function walkDir(
  dir: string, base: string, files: string[], depth = 0,
  budget: WalkBudget = { dirs: MAX_SNAPSHOT_DIRS },
): Promise<void> {
  if (depth > 5 || files.length >= MAX_SNAPSHOT_FILES || budget.dirs <= 0) return;
  budget.dirs--;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (files.length >= MAX_SNAPSHOT_FILES || budget.dirs <= 0) return;
    if (entry.isDirectory()) {
      if (!SNAPSHOT_IGNORE.has(entry.name) && !entry.name.startsWith('.')) {
        await walkDir(path.join(dir, entry.name), base, files, depth + 1, budget);
      }
    } else if (entry.isFile() && shouldSnapshotFile(entry.name)) {
      const rel = path.relative(base, path.join(dir, entry.name)).replace(/\\/g, '/');
      files.push(rel);
    }
  }
}

/**
 * True if `resolved` is `root` or sits underneath it.
 * Uses path.relative rather than a string prefix test, so a sibling whose name
 * merely starts with root (C:\foobar vs C:\foo) is not treated as contained.
 */
function isWithin(root: string, resolved: string): boolean {
  if (resolved === root) return true;
  const rel = path.relative(root, resolved);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Resolve `rel` inside `cwd`, or null if it escapes the directory. */
function resolveWithin(cwd: string, rel: string): string | null {
  const root = path.resolve(cwd);
  const resolved = path.resolve(path.join(root, rel));
  return isWithin(root, resolved) ? resolved : null;
}

async function readSnapshotEntry(abs: string): Promise<SnapshotEntry | null> {
  try {
    const stat = await fs.promises.stat(abs);
    if (stat.size > MAX_SNAPSHOT_FILE) return null;
    const buf = await fs.promises.readFile(abs);
    if (buf.includes(0)) return null; // skip binary
    return { content: buf.toString('utf-8'), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch { return null; /* skip unreadable */ }
}

async function takeSnapshot(cwd: string): Promise<Map<string, SnapshotEntry>> {
  const snap = new Map<string, SnapshotEntry>();
  const files: string[] = [];
  await walkDir(cwd, cwd, files);
  for (const rel of files) {
    const entry = await readSnapshotEntry(path.join(cwd, rel));
    if (entry) snap.set(rel, entry);
  }
  return snap;
}

async function readCurrentFile(cwd: string, rel: string): Promise<string | null> {
  const resolved = resolveWithin(cwd, rel);
  if (!resolved) return null;
  const entry = await readSnapshotEntry(resolved);
  return entry ? entry.content : null;
}

const DIFF_CONTEXT = 3;

/**
 * Advance from `start` until DIFF_CONTEXT consecutive lines match again, then
 * back up over that matching run so it becomes trailing context rather than
 * part of the changed region.
 */
function findDivergenceEnd(
  oldLines: string[], newLines: string[], start: number,
): { oldEnd: number; newEnd: number } {
  let oldEnd = start;
  let newEnd = start;
  let matchRun = 0;
  while (oldEnd < oldLines.length || newEnd < newLines.length) {
    if (oldEnd < oldLines.length && newEnd < newLines.length && oldLines[oldEnd] === newLines[newEnd]) {
      matchRun++;
      oldEnd++;
      newEnd++;
      if (matchRun >= DIFF_CONTEXT) break;
    } else {
      matchRun = 0;
      if (oldEnd < oldLines.length) oldEnd++;
      if (newEnd < newLines.length) newEnd++;
    }
  }
  return { oldEnd: oldEnd - matchRun, newEnd: newEnd - matchRun };
}

/** Emit one `@@` hunk covering [contextBefore, contextAfter). */
function renderHunk(
  out: string[], oldLines: string[], newLines: string[],
  hunkStart: number, oldEnd: number, newEnd: number, contextAfter: number,
): void {
  const contextBefore = Math.max(0, hunkStart - DIFF_CONTEXT);
  const maxLen = Math.max(oldLines.length, newLines.length);
  const oldLen = Math.min(oldLines.length, contextAfter) - contextBefore;
  const newLen = Math.min(newLines.length, contextAfter) - contextBefore;
  out.push(`@@ -${contextBefore + 1},${oldLen} +${contextBefore + 1},${newLen} @@`);

  for (let c = contextBefore; c < hunkStart; c++) {
    if (c < oldLines.length) out.push(' ' + oldLines[c]);
  }
  for (let r = hunkStart; r < oldEnd; r++) {
    if (r < oldLines.length) out.push('-' + oldLines[r]);
  }
  for (let a = hunkStart; a < newEnd; a++) {
    if (a < newLines.length) out.push('+' + newLines[a]);
  }
  for (let c = Math.max(oldEnd, newEnd); c < contextAfter && c < maxLen; c++) {
    out.push(' ' + contextLineAt(oldLines, newLines, c));
  }
}

function contextLineAt(oldLines: string[], newLines: string[], index: number): string {
  if (index < newLines.length) return newLines[index];
  if (index < oldLines.length) return oldLines[index];
  return '';
}

function generateUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const out: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  const maxLen = Math.max(oldLines.length, newLines.length);
  let i = 0;
  while (i < maxLen) {
    if (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
      i++;
      continue;
    }
    const { oldEnd, newEnd } = findDivergenceEnd(oldLines, newLines, i);
    const contextAfter = Math.min(maxLen, Math.max(oldEnd, newEnd) + DIFF_CONTEXT);
    renderHunk(out, oldLines, newLines, i, oldEnd, newEnd, contextAfter);
    i = contextAfter;
  }

  return out.join('\n');
}

function deletedEntry(rel: string, entry: SnapshotEntry): ChangedFile {
  return { path: rel, status: 'deleted', additions: 0, deletions: entry.content.split('\n').length };
}

function countLineChanges(oldContent: string, newContent: string): { additions: number; deletions: number } {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  let additions = 0, deletions = 0;
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = i < oldLines.length ? oldLines[i] : undefined;
    const n = i < newLines.length ? newLines[i] : undefined;
    if (o === n) continue;
    if (o !== undefined) deletions++;
    if (n !== undefined) additions++;
  }
  return { additions, deletions };
}

/**
 * Compare one baselined file against disk. Stat first and only read content
 * when mtime/size moved — in the steady state this skips every read.
 */
async function diffSnapshotEntry(
  cwd: string, rel: string, entry: SnapshotEntry, snap: Map<string, SnapshotEntry>,
): Promise<ChangedFile | null> {
  const resolved = resolveWithin(cwd, rel);
  let stat: fs.Stats | null = null;
  if (resolved) {
    try { stat = await fs.promises.stat(resolved); } catch { /* deleted */ }
  }
  if (!stat) return deletedEntry(rel, entry);
  if (stat.mtimeMs === entry.mtimeMs && stat.size === entry.size) return null; // unchanged

  const current = await readCurrentFile(cwd, rel);
  // Grew past the size cap or turned binary — treat as gone, like before
  if (current === null) return deletedEntry(rel, entry);
  if (current !== entry.content) {
    return { path: rel, status: 'modified', ...countLineChanges(entry.content, current) };
  }
  // Content identical, only metadata moved (e.g. touch) — refresh the stored
  // stat so the next poll goes back to the cheap skip path.
  snap.set(rel, { content: entry.content, mtimeMs: stat.mtimeMs, size: stat.size });
  return null;
}

/**
 * Files present on disk but absent from the baseline. The re-walk is the
 * expensive half of a poll and new files appear far less often than existing
 * ones change, so discovery runs every Nth poll; a file added in the gap
 * surfaces on the next discovery pass rather than being missed. Discovered
 * paths are remembered so they keep being reported on the polls in between
 * instead of flickering out of the list and back in.
 */
async function collectAddedFiles(cwd: string, snap: Map<string, SnapshotEntry>): Promise<ChangedFile[]> {
  const polls = (pollCounts.get(cwd) ?? 0) + 1;
  const rewalk = polls >= REWALK_EVERY_N_POLLS;
  pollCounts.set(cwd, rewalk ? 0 : polls);

  let known = addedPaths.get(cwd);
  if (!known) { known = new Set<string>(); addedPaths.set(cwd, known); }

  if (rewalk) {
    const currentFiles: string[] = [];
    await walkDir(cwd, cwd, currentFiles);
    for (const rel of currentFiles) {
      if (!snap.has(rel)) known.add(rel);
    }
  }

  const added: ChangedFile[] = [];
  for (const rel of [...known]) {
    const content = await readCurrentFile(cwd, rel);
    if (content === null) { known.delete(rel); continue; } // gone again
    added.push({ path: rel, status: 'added', additions: content.split('\n').length, deletions: 0 });
  }
  return added;
}

async function getSnapshotChangedFiles(cwd: string): Promise<ChangedFile[]> {
  if (!snapshots.has(cwd)) {
    snapshots.set(cwd, await takeSnapshot(cwd));
    return []; // First call: snapshot taken, no changes yet
  }
  const snap = snapshots.get(cwd)!;
  const changed: ChangedFile[] = [];

  for (const [rel, entry] of snap) {
    const result = await diffSnapshotEntry(cwd, rel, entry, snap);
    if (result) changed.push(result);
  }
  changed.push(...await collectAddedFiles(cwd, snap));
  return changed;
}

/** Serialize/coalesce snapshot scans per directory. */
function getSnapshotChangedFilesCoalesced(cwd: string): Promise<ChangedFile[]> {
  const inFlight = scansInFlight.get(cwd);
  if (inFlight) return inFlight;
  const scan = getSnapshotChangedFiles(cwd).finally(() => scansInFlight.delete(cwd));
  scansInFlight.set(cwd, scan);
  return scan;
}

async function getSnapshotFileDiff(cwd: string, file: string): Promise<string> {
  const snap = snapshots.get(cwd);
  if (!snap) return '';

  const oldContent = snap.get(file)?.content;
  const current = await readCurrentFile(cwd, file);

  if (oldContent === undefined && current !== null) {
    // New file
    const lines = current.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return [
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map(l => '+' + l),
    ].join('\n');
  }

  if (oldContent !== undefined && current === null) {
    // Deleted file
    const lines = oldContent.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return [
      `diff --git a/${file} b/${file}`,
      'deleted file mode 100644',
      `--- a/${file}`,
      '+++ /dev/null',
      `@@ -1,${lines.length} +0,0 @@`,
      ...lines.map(l => '-' + l),
    ].join('\n');
  }

  if (oldContent !== undefined && current !== null && oldContent !== current) {
    return generateUnifiedDiff(file, oldContent, current);
  }

  return '';
}

// ─── Public API ────────────────────────────────────────────────────────────

const MAX_UNTRACKED_SIZE = 1_000_000;

function parseNumstat(numstat: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    stats.set(parts[2], {
      additions: parts[0] === '-' ? 0 : parseInt(parts[0]) || 0,
      deletions: parts[1] === '-' ? 0 : parseInt(parts[1]) || 0,
    });
  }
  return stats;
}

/**
 * `XY PATH`, where X is the INDEX column and Y the WORKTREE one.
 *
 * The leading character is DATA, not padding: for the most common state there
 * is — modified but not staged — X is a space, and git emits ` M README.md`.
 * So the output may only be split, never trimmed. A `statusOut.trim()` here
 * shifted the FIRST line one character left (and only the first, since trim
 * touches the ends of a string while every interior row keeps its space),
 * yielding `EADME.md`. That path then failed to match the same file's key in
 * `git diff HEAD --numstat`, and since that join falls back to `?? 0`, a
 * mangled name surfaced as a file with no changes rather than as an error.
 * Live since v0.5.2 and invisible until 2.7 rendered the counts per row.
 */
function parsePorcelainStatus(statusOut: string): Array<{ path: string; status: ChangedFile['status'] }> {
  return statusOut.split('\n').filter(line => line.trim() !== '').map(line => {
    const xy = line.substring(0, 2);
    const filePath = line.substring(3).trim().replace(/^"(.*)"$/, '$1');
    let status: ChangedFile['status'] = 'modified';
    if (xy.includes('A') || xy === '??') status = 'added';
    else if (xy.includes('D')) status = 'deleted';
    else if (xy.includes('R')) status = 'renamed';
    return { path: filePath, status };
  });
}

/**
 * Lines in an untracked file, counted the way `git diff --numstat` counts them.
 *
 * A trailing newline TERMINATES the last line rather than starting a new one,
 * so `'a\nb\nc\n'` is three lines and not four. `untrackedFileDiff` below pops
 * the same empty tail for the same reason. The snapshot backend's `added` path
 * does not, but nothing there sits beside a numstat number in one column —
 * here they do, and a new file reading one line longer than the diff that
 * opens underneath it is a number the user cannot trust.
 *
 * Everything that can go wrong returns 0 rather than throwing, because every
 * one of them is ordinary: `readCurrentFile` answers null for a path outside
 * the repo, a file over the size cap, a binary, an unreadable file, and for
 * the EISDIR that a collapsed `vendor/` entry produces.
 */
async function countUntrackedAdditions(cwd: string, rel: string): Promise<number> {
  if (currentSshGit()) {
    // `--no-index` against /dev/null counts lines the way numstat does, on the
    // remote host. It exits 1 when the files differ, which `git()` here accepts when
    // it has output; a binary file counts `-` and so 0, as the local read does.
    return additionsFromNumstat(await git(cwd, untrackedNumstatArgs(rel)).catch(() => ''));
  }
  const content = await readCurrentFile(cwd, rel);
  if (content === null) return 0;
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// A worktree workspace's base commit (#366) lands in argv: one safe revision
// (git-view.ts's rule — never an option, never a range) or nothing.
function isValidBaseRef(ref: string): boolean {
  return isSafeRev(ref);
}

const NAME_STATUS: Record<string, ChangedFile['status']> = { A: 'added', D: 'deleted', R: 'renamed' };

/** `git diff <base> --name-status` joined with its `--numstat`. */
function parseNameStatus(
  nameStatusOut: string,
  stats: Map<string, { additions: number; deletions: number }>,
): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const line of nameStatusOut.trim().split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const filePath = parts[parts.length >= 3 ? 2 : 1].trim().replace(/^"(.*)"$/, '$1');
    const stat = stats.get(filePath);
    out.push({
      path: filePath,
      status: NAME_STATUS[parts[0].trim()[0]] ?? 'modified',
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
    });
  }
  return out;
}

/** Everything a worktree workspace changed since its base commit (#366):
 *  committed and uncommitted work against `base`, plus untracked files. */
async function getGitChangedFilesSinceBase(cwd: string, base: string): Promise<ChangedFile[]> {
  const [nameStatusOut, numstatOut, statusOut] = await Promise.all([
    git(cwd, ['diff', base, '--name-status']).catch(() => ''),
    git(cwd, ['diff', base, '--numstat']).catch(() => ''),
    git(cwd, ['status', '--porcelain', '-unormal']).catch(() => ''),
  ]);
  const out = parseNameStatus(nameStatusOut, parseNumstat(numstatOut));
  const seen = new Set(out.map((f) => f.path));
  // Sequential for the same reason as the HEAD path below (#141).
  for (const e of parsePorcelainStatus(statusOut)) {
    if (seen.has(e.path) || e.status !== 'added') continue;
    out.push({ ...e, additions: await countUntrackedAdditions(cwd, e.path), deletions: 0 });
    seen.add(e.path);
  }
  return out;
}

async function getGitChangedFiles(cwd: string, baseRef?: string): Promise<ChangedFile[]> {
  if (baseRef && isValidBaseRef(baseRef)) return getGitChangedFilesSinceBase(cwd, baseRef);

  const statusOut = await git(cwd, ['status', '--porcelain', '-unormal']).catch(() => '');
  if (!statusOut.trim()) return [];

  const entries = parsePorcelainStatus(statusOut);
  const stats = parseNumstat(await git(cwd, ['diff', 'HEAD', '--numstat']).catch(() => ''));

  // `git diff HEAD --numstat` covers TRACKED files only, so an untracked file
  // falls through the join and lands on +0/-0 — which the explorer's column
  // renders identically to a file that did not change. Read those and count
  // them, matching what the snapshot backend has always reported for an added
  // file, so the same column means the same thing in a repo and outside one.
  //
  // Sequential on purpose. This runs on the poll path in the process that also
  // relays every keystroke (issue #141), and a Promise.all over a repo with a
  // few thousand loose untracked files is an EMFILE waiting to happen. The
  // loop is short in practice because `-unormal` collapses an untracked
  // DIRECTORY into one `name/` entry: an unignored node_modules arrives here
  // as a single row that costs one failed read, not as 30 000 rows.
  const out: ChangedFile[] = [];
  for (const e of entries) {
    const stat = stats.get(e.path);
    if (stat) { out.push({ ...e, ...stat }); continue; }
    const additions = e.status === 'added' ? await countUntrackedAdditions(cwd, e.path) : 0;
    out.push({ ...e, additions, deletions: 0 });
  }
  return out;
}

/**
 * `untrackedFileDiff` for a request that may be running on a remote host,
 * where the file is read by git there (`diff --no-index`, which prints the same
 * new-file diff) instead of from the local disk. `run` is git-view's own runner,
 * passed in because that module owns the git spawn and imports this one.
 */
export async function untrackedFileDiffAny(
  cwd: string,
  file: string,
  run: (cwd: string, args: string[]) => Promise<string>,
): Promise<string> {
  if (!currentSshGit()) return untrackedFileDiff(cwd, file);
  // `diff --no-index` reads any file the remote account can: only a path below the checkout goes to it.
  if (canonicalRemoteRelPath(file) === null) return '';
  return run(cwd, untrackedDiffArgs(file)).catch(() => '');
}

/** Render an untracked file as an all-additions diff. Shared with git-view.ts (#362). */
export function untrackedFileDiff(cwd: string, file: string): string {
  try {
    const absPath = path.isAbsolute(file) ? file : path.join(cwd, file);
    const resolved = path.resolve(absPath);
    if (!isWithin(path.resolve(cwd), resolved)) return '';
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_UNTRACKED_SIZE) return '(File too large to display inline)';
    const buf = fs.readFileSync(resolved);
    if (buf.includes(0)) return '(Binary file)';
    const lines = buf.toString('utf-8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return [
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map(l => '+' + l),
    ].join('\n');
  } catch {
    return '';
  }
}

async function getGitFileDiff(cwd: string, file: string, baseRef?: string): Promise<string> {
  const validBase = baseRef && isValidBaseRef(baseRef) ? baseRef : undefined;
  if (validBase) {
    const out = await git(cwd, ['diff', validBase, '--', file]).catch(() => '');
    if (out.trim()) return out;
    const status = await git(cwd, ['status', '--porcelain', '--', file]).catch(() => '');
    return status.includes('??') ? untrackedDiffHere(cwd, file) : '';
  }

  for (const args of [['diff', 'HEAD'], ['diff'], ['diff', '--cached']]) {
    const out = await git(cwd, [...args, '--', file]).catch(() => '');
    if (out.trim()) return out;
  }
  const status = await git(cwd, ['status', '--porcelain', '--', file]).catch(() => '');
  return status.includes('??') ? untrackedDiffHere(cwd, file) : '';
}

/** An untracked file's diff, from wherever this request's repository is. */
function untrackedDiffHere(cwd: string, file: string): Promise<string> {
  return untrackedFileDiffAny(cwd, file, git);
}

/**
 * Run `work` for `key`, or join the pass already running for it.
 *
 * Every git invocation below costs a process spawn, and on a large working
 * tree `git diff HEAD --numstat` takes ~1s. A caller polling faster than that
 * used to stack one process per call — 10-40 `git.exe`/s, saturating the main
 * process that also relays every keystroke (issue #141). Callers that arrive
 * mid-pass get that pass's result: at most one poll stale, which is well
 * inside the pane's own refresh interval.
 */
function coalesce<T>(inFlight: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running;
  const started = work().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

// ─── One spawn per refresh on a remote host ──────────────────────────────────
// The explorer's +N/-N column polls every few seconds and the Diff tab every two,
// and each pass is a probe, a status, a numstat and one spawn per untracked file.
// On a remote host (or a WSL folder) those commands run in one batched script
// (exec-git-batch.ts), the untracked files' line counts in a second one. A batch that
// is not answered in the expected format returns null and the one-spawn-per-command
// code below it runs.

const git0 = (args: string[]): BatchGroup => ({ dir: 'c', args });

/**
 * Where a batch for `cwd` can run: the remote host of the request or, for a folder on a
 * WSL share, its distro; undefined for a Windows folder, which runs Windows git.
 */
function batchContext(cwd: string): GitContext | undefined {
  return currentSshGit() ?? wslGitContextFor(cwd) ?? undefined;
}

/**
 * `runGitBatch`, with what `git()` above does for the same failure: no ssh
 * executable to run is "could not reach the host" (marked, so an inner swallow
 * cannot turn it into "no changes"), never an empty answer.
 */
async function runGitBatch(context: GitContext, cwd: string, groups: readonly BatchGroup[]): Promise<BatchOutcome[] | null> {
  try {
    return await runBatchRaw(context, isWslContext(context) ? context.wsl.posix : cwd, groups);
  } catch (err) {
    // A WSL folder has no "unreachable": it is run command by command.
    if (err instanceof BatchSetupError && isWslContext(context)) return null;
    if (err instanceof BatchSetupError) {
      markSshUnreachable();
      throw new Error(SSH_UNREACHABLE_MESSAGE, { cause: err });
    }
    throw err;
  }
}

const untrackedNumstatArgs = (rel: string): string[] => ['diff', '--no-index', '--numstat', '--', '/dev/null', rel];

/** The line count `countUntrackedAdditions` reads off a `--no-index --numstat` answer. */
function additionsFromNumstat(out: string): number {
  const added = Number.parseInt(out.split('\t')[0], 10);
  return Number.isFinite(added) ? added : 0;
}

interface RemoteChanged {
  files: ChangedFile[];
  /** False for a folder that is not a git repository: no files, and the "snapshot" label. */
  isRepo: boolean;
}

/** Added files whose line count `git diff HEAD --numstat` does not carry, counted in one more spawn. */
async function countUntracked(cwd: string, rels: string[]): Promise<number[] | null> {
  if (rels.length === 0) return [];
  const remote = currentSshGit();
  if (!remote) return null;
  const counted = await runGitBatch(remote, cwd, rels.map((rel) => git0(untrackedNumstatArgs(rel))));
  // `diff --no-index` exits 1 when the files differ; the text is the answer whatever the status.
  return counted ? counted.map((c) => additionsFromNumstat(c.stdout)) : null;
}

async function batchedChangedFiles(cwd: string, baseRef?: string): Promise<RemoteChanged | null> {
  const remote = batchContext(cwd);
  if (!remote) return null;
  const base = baseRef && isValidBaseRef(baseRef) ? baseRef : undefined;
  const probe = git0(['rev-parse', '--is-inside-work-tree']);
  const status = git0(['status', '--porcelain', '-unormal']);
  const answers = await runGitBatch(remote, cwd, base
    ? [probe, git0(['diff', base, '--name-status']), git0(['diff', base, '--numstat']), status]
    : [probe, status, git0(['diff', 'HEAD', '--numstat'])]);
  if (!answers) return null;
  // Not a repository: a remote host says so; for a WSL folder the long way decides (it may be the non-git snapshot).
  if (answers[0].status !== 0) return isWslContext(remote) ? null : { files: [], isRepo: false };

  const statusOut = base ? answers[3].stdout : answers[1].stdout;
  if (!base && !statusOut.trim()) return { files: [], isRepo: true };
  const entries = parsePorcelainStatus(statusOut);
  const listed = base
    ? changedAgainstBase(entries, answers[1].stdout, answers[2].stdout)
    : changedAgainstHead(entries, answers[2].stdout);
  await fillUntrackedCounts(cwd, listed);
  return { files: listed.out, isRepo: true };
}

type StatusEntries = ReturnType<typeof parsePorcelainStatus>;

/** The files of a pass, and which of them are added files still waiting for a line count. */
interface ListedChanges {
  out: ChangedFile[];
  pending: Array<{ index: number; rel: string }>;
}

/** Against a base ref: the diff's own files, plus the added files the status names and the diff does not. */
function changedAgainstBase(entries: StatusEntries, nameStatusOut: string, numstatOut: string): ListedChanges {
  const out: ChangedFile[] = [...parseNameStatus(nameStatusOut, parseNumstat(numstatOut))];
  const pending: ListedChanges['pending'] = [];
  const seen = new Set(out.map((f) => f.path));
  for (const e of entries) {
    if (seen.has(e.path) || e.status !== 'added') continue;
    pending.push({ index: out.length, rel: e.path });
    out.push({ ...e, additions: 0, deletions: 0 });
    seen.add(e.path);
  }
  return { out, pending };
}

/** Against HEAD: every status entry, with the numstat line it has; an added file without one is counted later. */
function changedAgainstHead(entries: StatusEntries, numstatOut: string): ListedChanges {
  const stats = parseNumstat(numstatOut);
  const out: ChangedFile[] = [];
  const pending: ListedChanges['pending'] = [];
  for (const e of entries) {
    const stat = stats.get(e.path);
    if (stat) { out.push({ ...e, ...stat }); continue; }
    if (e.status === 'added') pending.push({ index: out.length, rel: e.path });
    out.push({ ...e, additions: 0, deletions: 0 });
  }
  return { out, pending };
}

/** Line counts for the pending added files: one batch when there is one, else one spawn each. */
async function fillUntrackedCounts(cwd: string, { out, pending }: ListedChanges): Promise<void> {
  const counts = await countUntracked(cwd, pending.map((p) => p.rel));
  for (const [i, p] of pending.entries()) {
    const additions = counts ? counts[i] : await countUntrackedAdditions(cwd, p.rel);
    out[p.index] = { ...out[p.index], additions };
  }
}

const remoteChangedInFlight = new Map<string, Promise<RemoteChanged | null>>();

/**
 * `batchedChangedFiles`, shared by the callers that arrive while one pass runs (the
 * column and the Diff tab both poll), and, for a poll, by every caller until the
 * host's fingerprint changes (exec-snapshot.ts): the column and the Diff tab are
 * one consumer of one answer. A null (the batch was not understood) is never kept.
 * The caller's priority is part of the key, so a click is not answered by a
 * poll's run.
 */
function remoteChangedCoalesced(cwd: string, baseRef?: string): Promise<RemoteChanged | null> {
  const remote = batchContext(cwd);
  const key = `${sshLocationKey()}\0${currentSpawnPriority()}\0${cwd}\0${baseRef || ''}`;
  const compute = () => checkedForSsh(() => batchedChangedFiles(cwd, baseRef));
  return coalesce(remoteChangedInFlight, key, () => (remote
    ? cachedForPoll({
      context: remote,
      key: `changed\0${cwd}\0${baseRef || ''}`,
      token: (fp) => fp.all,
      compute,
      cacheable: (value) => value !== null,
    })
    : compute()));
}

/** One file's diff on a remote host: the probe, the candidate diffs and the status in one spawn, the untracked file's diff in a second. */
async function remoteFileDiffBatched(cwd: string, file: string, baseRef?: string): Promise<string | null> {
  const remote = batchContext(cwd);
  if (!remote) return null;
  const base = baseRef && isValidBaseRef(baseRef) ? baseRef : undefined;
  const candidates = base
    ? [git0(['diff', base, '--', file])]
    : [git0(['diff', 'HEAD', '--', file]), git0(['diff', '--', file]), git0(['diff', '--cached', '--', file])];
  const answers = await runGitBatch(remote, cwd, [
    git0(['rev-parse', '--is-inside-work-tree']),
    ...candidates,
    git0(['status', '--porcelain', '--', file]),
  ]);
  if (!answers) return null;
  if (answers[0].status !== 0) return isWslContext(remote) ? null : '';
  for (const answer of answers.slice(1, 1 + candidates.length)) {
    if (answer.stdout.trim()) return answer.stdout;
  }
  if (!answers[answers.length - 1].stdout.includes('??')) return '';
  // A WSL folder's untracked file is read through its share, as `untrackedFileDiffAny` does there.
  if (isWslContext(remote)) return untrackedFileDiff(cwd, file);
  if (canonicalRemoteRelPath(file) === null) return '';
  const untracked = await runGitBatch(remote, cwd, [git0(untrackedDiffArgs(file))]);
  return untracked ? untracked[0].stdout : null;
}

/** The command that prints an untracked file's diff against nothing, run by git where the file is (git-view.ts runs it too). */
export const untrackedDiffArgs = (file: string): string[] =>
  ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', file];

const changedFilesInFlight = new Map<string, Promise<ChangedFile[]>>();
const fileDiffsInFlight = new Map<string, Promise<string>>();

export async function getChangedFiles(cwd: string, baseRef?: string): Promise<ChangedFile[]> {
  if (!cwd) cwd = process.cwd();
  if (batchContext(cwd)) {
    const batched = await remoteChangedCoalesced(cwd, baseRef);
    if (batched) return batched.files;
  }
  const key = `${sshLocationKey()}\0${cwd}\0${baseRef || ''}`;
  return coalesce(changedFilesInFlight, key, () => checkedForSsh(async () => {
    if (await isGitRepo(cwd)) return getGitChangedFiles(cwd, baseRef);
    // The snapshot system walks the LOCAL disk: never for a remote host path.
    if (currentSshGit()) return [];
    // No git — use snapshot system, which coalesces on its own key too so a
    // scan shared with a direct caller is still only walked once.
    return getSnapshotChangedFilesCoalesced(cwd);
  }));
}

/**
 * The same answer, plus WHICH backend produced it.
 *
 * The explorer's +N/-N column needs this because the two backends answer
 * genuinely different questions — git compares against HEAD ("everything
 * uncommitted"), the snapshot against a baseline taken when the session started
 * ("changed since you opened wmux") — and a column of numbers that silently
 * means one or the other is a column the user cannot interpret. The panel
 * labels itself from this.
 *
 * Deliberately a separate export rather than a widened `getChangedFiles`:
 * DiffPane does not need the label, and changing a shared return shape to serve
 * one caller is how the DiffPane and the explorer would start to drift.
 * `isGitRepo` is TTL-cached and `getChangedFiles` coalesces, so the extra probe
 * costs nothing on the poll path.
 */
export async function getChangedFilesWithBaseline(
  cwd: string,
): Promise<{ files: ChangedFile[]; baseline: 'git' | 'snapshot' }> {
  if (!cwd) cwd = process.cwd();
  if (batchContext(cwd)) {
    const batched = await remoteChangedCoalesced(cwd);
    if (batched) return { files: batched.files, baseline: batched.isRepo ? 'git' : 'snapshot' };
  }
  const baseline = await isGitRepo(cwd) ? 'git' as const : 'snapshot' as const;
  // After the probe, so an unreachable remote host is thrown rather than labelled.
  const files = await getChangedFiles(cwd);
  return { files, baseline };
}

export async function getFileDiff(cwd: string, file: string, baseRef?: string): Promise<string> {
  if (!file) return '';
  if (!cwd) cwd = process.cwd();
  const remote = batchContext(cwd);
  const key = `${sshLocationKey()}\0${remote ? currentSpawnPriority() : ''}\0${cwd}\0${file}\0${baseRef || ''}`;
  const compute = () => checkedForSsh(async () => {
    if (batchContext(cwd)) {
      const batched = await remoteFileDiffBatched(cwd, file, baseRef);
      if (batched !== null) return batched;
    }
    if (await isGitRepo(cwd)) return getGitFileDiff(cwd, file, baseRef);
    return currentSshGit() ? '' : getSnapshotFileDiff(cwd, file);
  });
  // On a remote host a poll re-fetches a file's diff only when that file's own
  // fingerprint changed (exec-snapshot.ts); a named base adds where the refs point.
  return coalesce(fileDiffsInFlight, key, () => (remote
    ? cachedForPoll({
      context: remote,
      key: `diff\0${cwd}\0${file}\0${baseRef || ''}`,
      token: (fp) => {
        const fileKey = fp.fileKey(fp.toplevel, file);
        if (fileKey === null) return null;
        return baseRef ? `${fileKey}\0${fp.refs}` : fileKey;
      },
      compute,
    })
    : compute()));
}

/** Reset the snapshot for a directory so next poll re-baselines. */
export function resetSnapshot(cwd: string): void {
  snapshots.delete(cwd);
  pollCounts.delete(cwd);
  addedPaths.delete(cwd);
  repoProbes.delete(cwd);
}

/** Drop every cached probe/snapshot. Test seam. */
export function resetDiffCaches(): void {
  snapshots.clear();
  pollCounts.clear();
  addedPaths.clear();
  repoProbes.clear();
  scansInFlight.clear();
  changedFilesInFlight.clear();
  fileDiffsInFlight.clear();
}
