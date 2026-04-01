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
    // git diff --no-index exits with 1 when there are differences
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

export async function getChangedFiles(cwd: string): Promise<ChangedFile[]> {
  if (!cwd) return [];
  if (!await isGitRepo(cwd)) return [];

  // -unormal (not -uall) to avoid OOM on repos with large untracked dirs
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

  // Get numstat for +/- counts (tracked files only)
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

const MAX_UNTRACKED_SIZE = 1_000_000; // 1MB

export async function getFileDiff(cwd: string, file: string): Promise<string> {
  if (!cwd || !file) return '';
  if (!await isGitRepo(cwd)) return '';

  // Try diff against HEAD (staged + unstaged)
  const diff = await git(cwd, ['diff', 'HEAD', '--', file]).catch(() => '');
  if (diff.trim()) return diff;

  // Try unstaged only
  const diff2 = await git(cwd, ['diff', '--', file]).catch(() => '');
  if (diff2.trim()) return diff2;

  // Try staged only
  const diff3 = await git(cwd, ['diff', '--cached', '--', file]).catch(() => '');
  if (diff3.trim()) return diff3;

  // For untracked files, synthesize a diff from file content
  const status = await git(cwd, ['status', '--porcelain', '--', file]).catch(() => '');
  if (status.includes('??')) {
    try {
      const absPath = path.isAbsolute(file) ? file : path.join(cwd, file);
      // Path traversal guard: ensure resolved path stays within cwd
      const resolved = path.resolve(absPath);
      if (!resolved.startsWith(path.resolve(cwd))) return '';
      // Size guard: skip large files
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_UNTRACKED_SIZE) return '(File too large to display inline)';
      // Binary guard: check for null bytes
      const buf = fs.readFileSync(resolved);
      if (buf.includes(0)) return '(Binary file)';
      const content = buf.toString('utf-8');
      const lines = content.split('\n');
      // Remove trailing empty line from final newline
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
