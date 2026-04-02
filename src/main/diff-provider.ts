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

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch { return false; }
}

// ─── Non-git snapshot system ───────────────────────────────────────────────
// When there's no git repo, we take a snapshot of file contents on first load
// and diff against it on subsequent polls.

const snapshots = new Map<string, Map<string, string>>(); // cwd → (relPath → content)
const SNAPSHOT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.md', '.txt', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.proto', '.xml', '.svg',
]);
const SNAPSHOT_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
const MAX_SNAPSHOT_FILE = 500_000; // 500KB per file
const MAX_SNAPSHOT_FILES = 2000;

function shouldSnapshotFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SNAPSHOT_EXTENSIONS.has(ext);
}

function walkDir(dir: string, base: string, files: string[], depth = 0): void {
  if (depth > 5 || files.length >= MAX_SNAPSHOT_FILES) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (files.length >= MAX_SNAPSHOT_FILES) return;
    if (entry.isDirectory()) {
      if (!SNAPSHOT_IGNORE.has(entry.name) && !entry.name.startsWith('.')) {
        walkDir(path.join(dir, entry.name), base, files, depth + 1);
      }
    } else if (entry.isFile() && shouldSnapshotFile(entry.name)) {
      const rel = path.relative(base, path.join(dir, entry.name)).replace(/\\/g, '/');
      files.push(rel);
    }
  }
}

function takeSnapshot(cwd: string): Map<string, string> {
  const snap = new Map<string, string>();
  const files: string[] = [];
  walkDir(cwd, cwd, files);
  for (const rel of files) {
    try {
      const abs = path.join(cwd, rel);
      const stat = fs.statSync(abs);
      if (stat.size > MAX_SNAPSHOT_FILE) continue;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue; // skip binary
      snap.set(rel, buf.toString('utf-8'));
    } catch { /* skip unreadable */ }
  }
  return snap;
}

function readCurrentFile(cwd: string, rel: string): string | null {
  try {
    const abs = path.join(cwd, rel);
    const resolved = path.resolve(abs);
    if (!resolved.startsWith(path.resolve(cwd))) return null;
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_SNAPSHOT_FILE) return null;
    const buf = fs.readFileSync(resolved);
    if (buf.includes(0)) return null;
    return buf.toString('utf-8');
  } catch { return null; }
}

function generateUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Simple line-by-line diff using LCS-like approach
  const hunks: string[] = [];
  hunks.push(`diff --git a/${filePath} b/${filePath}`);
  hunks.push(`--- a/${filePath}`);
  hunks.push(`+++ b/${filePath}`);

  // Find changed regions
  const maxLen = Math.max(oldLines.length, newLines.length);
  let i = 0;
  while (i < maxLen) {
    // Skip matching lines
    if (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
      i++;
      continue;
    }
    // Found a difference — collect the hunk
    const hunkStart = i;
    const contextBefore = Math.max(0, hunkStart - 3);
    // Find end of differing region
    let oldEnd = i;
    let newEnd = i;
    // Simple: advance until lines match again (or end)
    let matchRun = 0;
    while (oldEnd < oldLines.length || newEnd < newLines.length) {
      if (oldEnd < oldLines.length && newEnd < newLines.length && oldLines[oldEnd] === newLines[newEnd]) {
        matchRun++;
        oldEnd++;
        newEnd++;
        if (matchRun >= 3) break;
      } else {
        matchRun = 0;
        if (oldEnd < oldLines.length) oldEnd++;
        if (newEnd < newLines.length) newEnd++;
      }
    }
    // Back up by the match run to not include trailing context in the diff lines
    oldEnd -= matchRun;
    newEnd -= matchRun;
    const contextAfter = Math.min(maxLen, Math.max(oldEnd, newEnd) + 3);

    const hunkOldStart = contextBefore + 1;
    const hunkNewStart = contextBefore + 1;
    const hunkOldLen = Math.min(oldLines.length, contextAfter) - contextBefore;
    const hunkNewLen = Math.min(newLines.length, contextAfter) - contextBefore;

    hunks.push(`@@ -${hunkOldStart},${hunkOldLen} +${hunkNewStart},${hunkNewLen} @@`);

    // Context before
    for (let c = contextBefore; c < hunkStart; c++) {
      if (c < oldLines.length) hunks.push(' ' + oldLines[c]);
    }
    // Removed lines
    for (let r = hunkStart; r < oldEnd; r++) {
      if (r < oldLines.length) hunks.push('-' + oldLines[r]);
    }
    // Added lines
    for (let a = hunkStart; a < newEnd; a++) {
      if (a < newLines.length) hunks.push('+' + newLines[a]);
    }
    // Context after
    for (let c = Math.max(oldEnd, newEnd); c < contextAfter && c < maxLen; c++) {
      const line = c < newLines.length ? newLines[c] : (c < oldLines.length ? oldLines[c] : '');
      hunks.push(' ' + line);
    }

    i = contextAfter;
  }

  return hunks.join('\n');
}

async function getSnapshotChangedFiles(cwd: string): Promise<ChangedFile[]> {
  if (!snapshots.has(cwd)) {
    snapshots.set(cwd, takeSnapshot(cwd));
    return []; // First call: snapshot taken, no changes yet
  }
  const snap = snapshots.get(cwd)!;
  const changed: ChangedFile[] = [];

  // Check existing files for modifications
  for (const [rel, oldContent] of snap) {
    const current = readCurrentFile(cwd, rel);
    if (current === null) {
      // File was deleted
      const lines = oldContent.split('\n').length;
      changed.push({ path: rel, status: 'deleted', additions: 0, deletions: lines });
    } else if (current !== oldContent) {
      // File was modified
      const oldLines = oldContent.split('\n');
      const newLines = current.split('\n');
      let additions = 0, deletions = 0;
      const max = Math.max(oldLines.length, newLines.length);
      for (let i = 0; i < max; i++) {
        const o = i < oldLines.length ? oldLines[i] : undefined;
        const n = i < newLines.length ? newLines[i] : undefined;
        if (o !== n) {
          if (o !== undefined) deletions++;
          if (n !== undefined) additions++;
        }
      }
      changed.push({ path: rel, status: 'modified', additions, deletions });
    }
  }

  // Check for new files
  const currentFiles: string[] = [];
  walkDir(cwd, cwd, currentFiles);
  for (const rel of currentFiles) {
    if (!snap.has(rel)) {
      const content = readCurrentFile(cwd, rel);
      if (content !== null) {
        changed.push({ path: rel, status: 'added', additions: content.split('\n').length, deletions: 0 });
      }
    }
  }

  return changed;
}

function getSnapshotFileDiff(cwd: string, file: string): string {
  const snap = snapshots.get(cwd);
  if (!snap) return '';

  const oldContent = snap.get(file);
  const current = readCurrentFile(cwd, file);

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

export async function getChangedFiles(cwd: string): Promise<ChangedFile[]> {
  if (!cwd) cwd = process.cwd();

  // Try git first
  if (await isGitRepo(cwd)) {
    const statusOut = await git(cwd, ['status', '--porcelain', '-unormal']).catch(() => '');
    if (!statusOut.trim()) return [];

    const entries = statusOut.trim().split('\n').map(line => {
      const xy = line.substring(0, 2);
      const filePath = line.substring(3).trim().replace(/^"(.*)"$/, '$1');
      let status: ChangedFile['status'] = 'modified';
      if (xy.includes('A') || xy === '??') status = 'added';
      else if (xy.includes('D')) status = 'deleted';
      else if (xy.includes('R')) status = 'renamed';
      return { path: filePath, status };
    });

    const numstat = await git(cwd, ['diff', 'HEAD', '--numstat']).catch(() => '');
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

    return entries.map(e => ({
      ...e,
      additions: stats.get(e.path)?.additions ?? 0,
      deletions: stats.get(e.path)?.deletions ?? 0,
    }));
  }

  // No git — use snapshot system
  return getSnapshotChangedFiles(cwd);
}

export async function getFileDiff(cwd: string, file: string): Promise<string> {
  if (!file) return '';
  if (!cwd) cwd = process.cwd();

  // Try git first
  if (await isGitRepo(cwd)) {
    const diff = await git(cwd, ['diff', 'HEAD', '--', file]).catch(() => '');
    if (diff.trim()) return diff;

    const diff2 = await git(cwd, ['diff', '--', file]).catch(() => '');
    if (diff2.trim()) return diff2;

    const diff3 = await git(cwd, ['diff', '--cached', '--', file]).catch(() => '');
    if (diff3.trim()) return diff3;

    // Untracked files
    const status = await git(cwd, ['status', '--porcelain', '--', file]).catch(() => '');
    if (status.includes('??')) {
      try {
        const absPath = path.isAbsolute(file) ? file : path.join(cwd, file);
        const resolved = path.resolve(absPath);
        if (!resolved.startsWith(path.resolve(cwd))) return '';
        const stat = fs.statSync(resolved);
        if (stat.size > MAX_UNTRACKED_SIZE) return '(File too large to display inline)';
        const buf = fs.readFileSync(resolved);
        if (buf.includes(0)) return '(Binary file)';
        const content = buf.toString('utf-8');
        const lines = content.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        const header = [
          `diff --git a/${file} b/${file}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${file}`,
          `@@ -0,0 +1,${lines.length} @@`,
        ].join('\n');
        return header + '\n' + lines.map(l => '+' + l).join('\n');
      } catch {
        return '';
      }
    }

    return '';
  }

  // No git — use snapshot system
  return getSnapshotFileDiff(cwd, file);
}

/** Reset the snapshot for a directory so next poll re-baselines. */
export function resetSnapshot(cwd: string): void {
  snapshots.delete(cwd);
}
