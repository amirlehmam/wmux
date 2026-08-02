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

  it('detects modified and deleted files on the very next poll', async () => {
    write('a.ts', 'one\n');
    write('b.ts', 'keep\n');
    await getChangedFiles(TEST_DIR); // baseline

    write('a.ts', 'one\ntwo\n');
    fs.rmSync(path.join(TEST_DIR, 'b.ts'));

    const changed = await getChangedFiles(TEST_DIR);
    const byPath = new Map(changed.map(c => [c.path, c]));
    expect(byPath.get('a.ts')?.status).toBe('modified');
    expect(byPath.get('b.ts')?.status).toBe('deleted');
  });

  it('detects added files once the periodic re-walk runs', async () => {
    write('a.ts', 'one\n');
    await getChangedFiles(TEST_DIR); // baseline
    write('c.ts', 'new\n');

    // Discovery is deliberately on a slower cadence than the content check,
    // so an added file appears within REWALK_EVERY_N_POLLS polls, not instantly.
    let added;
    for (let i = 0; i < 5 && !added; i++) {
      added = (await getChangedFiles(TEST_DIR)).find(c => c.path === 'c.ts');
    }
    expect(added?.status).toBe('added');
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

  it('keeps reporting a newly added file on the polls between re-walks', async () => {
    write('a.ts', 'one\n');
    await getChangedFiles(TEST_DIR); // baseline

    write('new.ts', 'hello\n');
    // Discovery runs every 5th poll; run enough polls to pass one, then keep
    // polling and assert the added file does not flicker out of the list.
    let seen = 0;
    for (let i = 0; i < 12; i++) {
      const changed = await getChangedFiles(TEST_DIR);
      const added = changed.find(c => c.path === 'new.ts');
      if (added) seen++;
      // Once discovered, it must appear on every subsequent poll
      if (seen > 0) expect(added?.status).toBe('added');
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('drops a discovered file from the list once it is deleted again', async () => {
    write('a.ts', 'one\n');
    await getChangedFiles(TEST_DIR); // baseline
    write('temp.ts', 'x\n');
    for (let i = 0; i < 6; i++) await getChangedFiles(TEST_DIR); // let discovery run

    fs.rmSync(path.join(TEST_DIR, 'temp.ts'));
    const changed = await getChangedFiles(TEST_DIR);
    expect(changed.find(c => c.path === 'temp.ts')).toBeUndefined();
  });

  it('ignores platform directories such as AppData', async () => {
    write('AppData/Local/thing/deep.ts', 'should not be seen\n');
    write('real.ts', 'baseline\n');
    await getChangedFiles(TEST_DIR); // baseline

    write('AppData/Local/thing/deep.ts', 'changed\n');
    write('real.ts', 'changed\n');
    for (let i = 0; i < 6; i++) {
      const changed = await getChangedFiles(TEST_DIR);
      expect(changed.some(c => c.path.startsWith('AppData/'))).toBe(false);
    }
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
