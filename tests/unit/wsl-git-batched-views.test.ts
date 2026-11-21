import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import { makeWslSpawnCounter, type WslSpawnCounter } from '../helpers/wsl-spawn-counter';

const fakeState = vi.hoisted(() => ({ exe: '', cwd: '' }));
vi.mock('../../src/main/system32', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/system32')>()),
  wslExecutable: () => fakeState.exe,
  wslSystemRoot: () => fakeState.cwd,
}));
// A UNC path means nothing to this (Linux) test's file system: `statSync` of one answers for the directory it stands for.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const standsFor = (p: unknown): unknown => {
    const m = typeof p === 'string' ? /^\\\\wsl\.localhost\\[^\\]+(.*)$/.exec(p) : null;
    return m ? m[1].replace(/\\/g, '/') : p;
  };
  const statSync = ((p: unknown, ...rest: unknown[]) => (actual.statSync as (...a: unknown[]) => unknown)(standsFor(p), ...rest)) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

import { resetBatchBackoff } from '../../src/main/exec-git-batch';
import { handleGitView, parseWslUnc, wslGitContextFor, wslPathToWindows } from '../../src/main/git-view';
import { getChangedFiles, getChangedFilesWithBaseline, getFileDiff, resetDiffCaches } from '../../src/main/diff-provider';
import type { GitViewRequest } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * Batching a WSL folder's git calls must change the NUMBER of wsl.exe starts and nothing
 * else: every answer is the one the one-git-per-spawn code gives, and a batch wsl.exe
 * does not answer is that code, after one wasted start.
 */
describe.skipIf(!hasPosixTools(['git']))('the Git view and the Diff tab on a WSL folder, batched', () => {
  let tmp: string;
  let repo: string;
  let plain: string;
  let batching: WslSpawnCounter;
  let refusing: WslSpawnCounter;
  let hash: string;
  const unc = (posix: string, distro = 'Ubuntu'): string => wslPathToWindows(distro, posix);

  beforeAll(() => {
    tmp = makeTmpDir('wmux-wsl-views-');
    fakeState.cwd = tmp;
    batching = makeWslSpawnCounter(tmp, 'batching-wsl', 2);
    refusing = makeWslSpawnCounter(tmp, 'refusing-wsl', 2, true);
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export {};\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    hash = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'second: it has a "quote", a \'tick\' and a $dollar');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 's\n');
    git(repo, 'add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'new one.txt'), 'x\ny\n');
    git(repo, 'worktree', 'add', '-q', '-b', 'agent/work', path.join(tmp, 'agent-wt'), 'HEAD');
    plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => {
    resetBatchBackoff();
    resetDiffCaches();
    batching.reset();
    refusing.reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => vi.restoreAllMocks();
  });

  const cwd = (): string => unc(repo);
  const requests = (): GitViewRequest[] => [
    { op: 'repo', cwd: cwd() },
    { op: 'working', cwd: cwd(), worktree: cwd() },
    { op: 'working', cwd: cwd(), worktree: unc(path.join(tmp, 'agent-wt')) },
    { op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: 'a.txt', section: 'unstaged' },
    { op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: 'staged.txt', section: 'staged' },
    { op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: 'new one.txt', section: 'untracked' },
    { op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: '../x', section: 'unstaged' },
    { op: 'branch', cwd: cwd(), worktree: cwd(), base: 'main' },
    { op: 'branch', cwd: cwd(), worktree: cwd(), base: 'no-such-branch' },
    { op: 'graph', cwd: cwd(), worktree: cwd(), scope: 'all', limit: 50 },
    { op: 'graph', cwd: cwd(), worktree: cwd(), scope: 'local', limit: 50 },
    { op: 'graph', cwd: cwd(), worktree: cwd(), scope: 'worktree', limit: 50 },
    { op: 'commit', cwd: cwd(), hash },
    { op: 'commit', cwd: cwd(), hash: git(repo, 'rev-parse', 'HEAD').trim() },
    { op: 'compare', cwd: cwd(), from: hash, to: git(repo, 'rev-parse', 'HEAD').trim() },
    { op: 'compare', cwd: cwd(), from: '', to: hash },
    { op: 'rangeDiff', cwd: cwd(), from: hash, to: git(repo, 'rev-parse', 'HEAD').trim(), file: 'b.txt' },
    // Refused or failing before any git runs: the same errors, batched or not.
    { op: 'working', cwd: cwd(), worktree: unc(path.join(tmp, 'not-a-worktree')) },
    { op: 'working', cwd: cwd(), worktree: unc(repo, 'Debian') },
    { op: 'working', cwd: cwd(), worktree: 'C:\\somewhere' },
    { op: 'commit', cwd: cwd(), hash: 'not-a-hash' },
  ];

  it('gives every Git view answer the one-git-per-spawn code gives, error or not', async () => {
    const answers = async (exe: string): Promise<unknown[]> => {
      resetBatchBackoff();
      fakeState.exe = exe;
      const out: unknown[] = [];
      for (const req of requests()) out.push(await handleGitView(req));
      return out;
    };
    const refused = await answers(refusing.exe);
    const batched = await answers(batching.exe);
    expect(batched).toEqual(refused);
    // The comparison is not between two failures.
    expect((batched as Array<{ ok: boolean }>).filter((a) => a.ok).length).toBeGreaterThan(12);
    expect((batched[0] as { data: { remote?: boolean } }).data.remote).toBeUndefined();
    expect(batching.spawns()).toBeLessThan(refusing.spawns() / 2);
  });

  it('gives the Diff tab and the column the same files and diffs, batched or not', async () => {
    const run = async (exe: string) => {
      resetBatchBackoff();
      fakeState.exe = exe;
      resetDiffCaches();
      return {
        files: await getChangedFiles(cwd()),
        against: await getChangedFiles(cwd(), hash),
        column: await getChangedFilesWithBaseline(cwd()),
        tracked: await getFileDiff(cwd(), 'a.txt'),
        staged: await getFileDiff(cwd(), 'staged.txt'),
        untracked: await getFileDiff(cwd(), 'new one.txt'),
        clean: await getFileDiff(cwd(), 'src/index.ts'),
        against2: await getFileDiff(cwd(), 'b.txt', hash),
      };
    };
    const refused = await run(refusing.exe);
    const batched = await run(batching.exe);
    expect(batched).toEqual(refused);
    expect(batched.files.map((f) => f.path).sort()).toEqual(['a.txt', 'new one.txt', 'staged.txt']);
    expect(batched.tracked).toContain('+four');
    expect(batched.column.baseline).toBe('git');
  });

  it('costs one wasted start, then one spawn per command, when wsl.exe does not run the batch', async () => {
    fakeState.exe = refusing.exe;
    await handleGitView({ op: 'working', cwd: cwd(), worktree: cwd() });
    expect(refusing.spawns()).toBe(1 + 4); // the refused batch, then list, status and two numstats
    refusing.reset();
    expect(await getChangedFiles(cwd())).toHaveLength(3);
    // The distro is then left alone for a while: no second wasted start, just one spawn per command (probe, status, numstat).
    expect(refusing.spawns()).toBe(3);
  });

  it('leaves a folder that is not on a WSL share alone: no wsl.exe, no batch', async () => {
    fakeState.exe = batching.exe;
    const res = await handleGitView({ op: 'working', cwd: repo, worktree: repo });
    expect(res.ok).toBe(true);
    expect((await getChangedFiles(repo)).length).toBe(3);
    expect(batching.spawns()).toBe(0);
    for (const p of [repo, 'C:\\repo', '\\\\server\\share\\repo', '/home/me', '', 'wsl.localhost', undefined, null, 5]) {
      expect(wslGitContextFor(p)).toBeNull();
    }
    expect(wslGitContextFor('\\\\wsl.localhost\\Ubuntu\\home\\me')).toEqual({ wsl: { distro: 'Ubuntu', posix: '/home/me' } });
    expect(wslGitContextFor('//wsl$/Debian/x/y/')).toEqual({ wsl: { distro: 'Debian', posix: '/x/y' } });
    expect(parseWslUnc('\\\\wsl.localhost\\Ubuntu\\a\\0b')).not.toBeNull();
    expect(wslGitContextFor('\\\\wsl.localhost\\Ubuntu\\a\0b')).toBeNull();
  });

  it('leaves a WSL folder that is not a repository to the non-git snapshot', async () => {
    fakeState.exe = batching.exe;
    const folder = unc(plain);
    expect(await getChangedFiles(folder)).toEqual([]);
    expect((await getChangedFilesWithBaseline(folder)).baseline).toBe('snapshot');
    expect(await getFileDiff(folder, 'x.txt')).toBe('');
  });
});
