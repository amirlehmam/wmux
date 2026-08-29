/**
 * Untracked files must carry their line count as additions.
 *
 * `git diff HEAD --numstat` reports TRACKED files only, so an untracked file
 * comes back from the numstat join with `+0/-0` — indistinguishable, in the
 * explorer's column, from a file that genuinely did not change. The panel
 * labels those numbers "everything uncommitted", and a brand new file is as
 * uncommitted as a file gets.
 *
 * The snapshot backend has always counted an added file's lines this way
 * (`status: 'added', additions: content.split('\n').length`), so this is the
 * git backend catching up with its sibling rather than a new rule: the two
 * back the same column, and a number that means one thing in a repo and
 * another outside it is worse than no number.
 *
 * git is mocked; the filesystem is REAL. The counting path runs through
 * `readCurrentFile`, whose guards (path jail, size cap, binary skip,
 * unreadable → null) are the whole safety argument, and mocking fs would
 * assert against a fake version of exactly the thing being relied on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let statusOut = '';
let numstatOut = '';

const execFileImpl: any = async (_cmd: string, args: string[]) => {
  if (args[0] === 'rev-parse') return { stdout: 'true\n', stderr: '' };
  if (args[0] === 'status') return { stdout: statusOut, stderr: '' };
  if (args[0] === 'diff' && args.includes('--numstat')) return { stdout: numstatOut, stderr: '' };
  return { stdout: '', stderr: '' };
};
execFileImpl[promisify.custom] = execFileImpl;

vi.mock('child_process', () => ({ execFile: execFileImpl }));

interface Changed { path: string; status: string; additions: number; deletions: number }
let getChangedFiles: (cwd: string) => Promise<Changed[]>;
let repo = '';

/** The entry for `rel`, or undefined — asserted on rather than an index, so a
 *  change in provider ordering fails as a missing file and not as a wrong one. */
const find = (files: Changed[], rel: string): Changed | undefined =>
  files.find((f) => f.path === rel);

beforeEach(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wmux-untracked-'));
  vi.resetModules();
  const mod = await import('../../src/main/diff-provider');
  getChangedFiles = mod.getChangedFiles as typeof getChangedFiles;
  mod.resetDiffCaches();
});

afterEach(async () => {
  await fs.promises.rm(repo, { recursive: true, force: true });
});

describe('getChangedFiles — untracked files', () => {
  it('counts an untracked file as all-additions', async () => {
    await fs.promises.writeFile(path.join(repo, 'new.ts'), 'a\nb\nc\n');
    statusOut = '?? new.ts\n';
    numstatOut = '';

    const file = find(await getChangedFiles(repo), 'new.ts');
    expect(file).toMatchObject({ status: 'added', additions: 3, deletions: 0 });
  });

  it('counts lines the way git does, ignoring the trailing newline', async () => {
    // `'a\nb\nc\n'.split('\n')` is FOUR entries — the last one empty. numstat
    // would call this file 3 lines, and these numbers sit in the same column as
    // real numstat output, so they have to be counted the same way or a new
    // file reads one line longer than the diff that follows it.
    await fs.promises.writeFile(path.join(repo, 'trailing.ts'), 'a\nb\nc\n');
    await fs.promises.writeFile(path.join(repo, 'bare.ts'), 'a\nb\nc');
    statusOut = '?? trailing.ts\n?? bare.ts\n';
    numstatOut = '';

    const files = await getChangedFiles(repo);
    expect(find(files, 'trailing.ts')?.additions).toBe(3);
    expect(find(files, 'bare.ts')?.additions).toBe(3);
  });

  it('leaves a binary file at zero rather than counting its bytes', async () => {
    await fs.promises.writeFile(path.join(repo, 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]));
    statusOut = '?? blob.bin\n';
    numstatOut = '';

    const file = find(await getChangedFiles(repo), 'blob.bin');
    expect(file).toMatchObject({ additions: 0, deletions: 0 });
  });

  it('leaves a collapsed directory at zero instead of throwing', async () => {
    // `-unormal` reports an untracked directory (or a nested repo, which git
    // never descends into) as a single `name/` entry. Counting it would need a
    // walk; reading it is EISDIR, which must degrade to no number.
    await fs.promises.mkdir(path.join(repo, 'vendor'));
    await fs.promises.writeFile(path.join(repo, 'vendor', 'x.ts'), 'a\n');
    statusOut = '?? vendor/\n';
    numstatOut = '';

    const file = find(await getChangedFiles(repo), 'vendor/');
    expect(file).toMatchObject({ additions: 0, deletions: 0 });
  });

  it('leaves a name it cannot resolve at zero', async () => {
    // git quotes non-ASCII paths (`core.quotePath`), so the provider can be
    // handed an octal-escaped name that does not exist on disk under that
    // spelling. It must read as no number, never as a throw.
    statusOut = '?? Sign\\303\\251.pdf\n';
    numstatOut = '';

    const files = await getChangedFiles(repo);
    expect(files[0]).toMatchObject({ additions: 0, deletions: 0 });
  });

  it('still prefers numstat for tracked files', async () => {
    await fs.promises.writeFile(path.join(repo, 'new.ts'), 'a\nb\n');
    statusOut = ' M tracked.ts\n?? new.ts\n';
    numstatOut = '5\t2\ttracked.ts\n';

    const files = await getChangedFiles(repo);
    expect(find(files, 'tracked.ts')).toMatchObject({ additions: 5, deletions: 2 });
    expect(find(files, 'new.ts')?.additions).toBe(2);
  });
});
