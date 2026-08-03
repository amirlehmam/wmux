import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface ChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

// ─── Git helpers ───────────────────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    if (err.stdout) return err.stdout;
    throw err;
  }
}

// Whether a directory is a repo changes about as often as someone runs
// `git init`, but the probe used to spawn a `git rev-parse` on EVERY call to
// both public entry points — a third of the git processes in issue #141 were
// this check. Cache it with a TTL so `git init` is still picked up eventually.
const REPO_PROBE_TTL_MS = 30_000;
const repoProbes = new Map<string, { isRepo: boolean; at: number }>();

async function isGitRepo(cwd: string): Promise<boolean> {
  const cached = repoProbes.get(cwd);
  if (cached && Date.now() - cached.at < REPO_PROBE_TTL_MS) return cached.isRepo;
  let isRepo: boolean;
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    isRepo = true;
  } catch { isRepo = false; }
  repoProbes.set(cwd, { isRepo, at: Date.now() });
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

function parsePorcelainStatus(statusOut: string): Array<{ path: string; status: ChangedFile['status'] }> {
  return statusOut.trim().split('\n').map(line => {
    const xy = line.substring(0, 2);
    const filePath = line.substring(3).trim().replace(/^"(.*)"$/, '$1');
    let status: ChangedFile['status'] = 'modified';
    if (xy.includes('A') || xy === '??') status = 'added';
    else if (xy.includes('D')) status = 'deleted';
    else if (xy.includes('R')) status = 'renamed';
    return { path: filePath, status };
  });
}

async function getGitChangedFiles(cwd: string): Promise<ChangedFile[]> {
  const statusOut = await git(cwd, ['status', '--porcelain', '-unormal']).catch(() => '');
  if (!statusOut.trim()) return [];

  const entries = parsePorcelainStatus(statusOut);
  const stats = parseNumstat(await git(cwd, ['diff', 'HEAD', '--numstat']).catch(() => ''));

  return entries.map(e => ({
    ...e,
    additions: stats.get(e.path)?.additions ?? 0,
    deletions: stats.get(e.path)?.deletions ?? 0,
  }));
}

/** Render an untracked file as an all-additions diff. */
function untrackedFileDiff(cwd: string, file: string): string {
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

async function getGitFileDiff(cwd: string, file: string): Promise<string> {
  for (const args of [['diff', 'HEAD'], ['diff'], ['diff', '--cached']]) {
    const out = await git(cwd, [...args, '--', file]).catch(() => '');
    if (out.trim()) return out;
  }
  const status = await git(cwd, ['status', '--porcelain', '--', file]).catch(() => '');
  return status.includes('??') ? untrackedFileDiff(cwd, file) : '';
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

const changedFilesInFlight = new Map<string, Promise<ChangedFile[]>>();
const fileDiffsInFlight = new Map<string, Promise<string>>();

export async function getChangedFiles(cwd: string): Promise<ChangedFile[]> {
  if (!cwd) cwd = process.cwd();
  return coalesce(changedFilesInFlight, cwd, async () => (
    await isGitRepo(cwd)
      ? getGitChangedFiles(cwd)
      // No git — use snapshot system, which coalesces on its own key too so a
      // scan shared with a direct caller is still only walked once.
      : getSnapshotChangedFilesCoalesced(cwd)
  ));
}

export async function getFileDiff(cwd: string, file: string): Promise<string> {
  if (!file) return '';
  if (!cwd) cwd = process.cwd();
  return coalesce(fileDiffsInFlight, `${cwd} ${file}`, async () => (
    await isGitRepo(cwd) ? getGitFileDiff(cwd, file) : getSnapshotFileDiff(cwd, file)
  ));
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
