import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getChangedFiles, getFileDiff, resetSnapshot } from '../../src/main/diff-provider';

// Non-git directory so getChangedFiles falls through to the snapshot system.
const TEST_DIR = path.join(os.tmpdir(), 'wmux-test-diff-' + process.pid);

function write(rel: string, content: string) {
  const abs = path.join(TEST_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('diff-provider snapshot system (non-git cwd)', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    resetSnapshot(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('first call takes the baseline and reports no changes', async () => {
    write('a.ts', 'one\n');
    expect(await getChangedFiles(TEST_DIR)).toEqual([]);
  });

  it('detects modified, added, and deleted files against the baseline', async () => {
    write('a.ts', 'one\n');
    write('b.ts', 'keep\n');
    await getChangedFiles(TEST_DIR); // baseline

    write('a.ts', 'one\ntwo\n');
    write('c.ts', 'new\n');
    fs.rmSync(path.join(TEST_DIR, 'b.ts'));

    const changed = await getChangedFiles(TEST_DIR);
    const byPath = new Map(changed.map(c => [c.path, c]));
    expect(byPath.get('a.ts')?.status).toBe('modified');
    expect(byPath.get('c.ts')?.status).toBe('added');
    expect(byPath.get('b.ts')?.status).toBe('deleted');
  });

  it('does not report a file whose mtime moved but whose content is unchanged', async () => {
    write('a.ts', 'same\n');
    await getChangedFiles(TEST_DIR); // baseline

    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(TEST_DIR, 'a.ts'), later, later); // touch

    expect(await getChangedFiles(TEST_DIR)).toEqual([]);
    // And the refreshed stat keeps the skip path on the following poll too
    expect(await getChangedFiles(TEST_DIR)).toEqual([]);
  });

  it('renders a unified diff for a modified file', async () => {
    write('a.ts', 'line1\nline2\n');
    await getChangedFiles(TEST_DIR); // baseline
    write('a.ts', 'line1\nchanged\n');
    await getChangedFiles(TEST_DIR);

    const diff = await getFileDiff(TEST_DIR, 'a.ts');
    expect(diff).toContain('-line2');
    expect(diff).toContain('+changed');
  });

  it('coalesces concurrent scans of the same directory', async () => {
    write('a.ts', 'one\n');
    await getChangedFiles(TEST_DIR); // baseline
    write('a.ts', 'two\n');

    const [first, second] = await Promise.all([
      getChangedFiles(TEST_DIR),
      getChangedFiles(TEST_DIR),
    ]);
    // Both callers resolve with the same scan's result
    expect(first).toEqual(second);
    expect(first[0]?.status).toBe('modified');
  });
});
