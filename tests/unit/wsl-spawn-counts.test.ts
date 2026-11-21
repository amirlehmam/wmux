import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import { makeWslSpawnCounter, type WslSpawnCounter } from '../helpers/wsl-spawn-counter';

// The wsl.exe of these tests is a counting stand-in that runs the program in the
// local file system (tests/helpers/wsl-spawn-counter.ts).
const fakeState = vi.hoisted(() => ({ exe: '', cwd: '' }));
vi.mock('../../src/main/system32', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/system32')>()),
  wslExecutable: () => fakeState.exe,
  wslSystemRoot: () => fakeState.cwd,
}));

// A UNC path means nothing to this (Linux) test's file system: `statSync` of one answers for the
// directory it stands for, so that the Git view's "does this folder exist" check passes.
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
import { handleGitView, wslPathToWindows } from '../../src/main/git-view';
import { getChangedFiles, getChangedFilesWithBaseline, getFileDiff, resetDiffCaches } from '../../src/main/diff-provider';
import type { GitViewRequest } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * How many `wsl.exe` starts each action costs for a folder that lives on a WSL
 * share (`\\wsl.localhost\<distro>\…`), where a git command is a
 * `wsl.exe -d <distro> --cd <dir> --exec git …` unless the batch carries it. The
 * explorer's file listing and reading go through the Windows file system over the
 * share and start no process, so they are not here.
 *
 * These are the budget for that path, as tests/unit/ssh-spawn-counts.test.ts is for
 * ssh: a change that raises one is a latency regression, and one that lowers one
 * should lower it here.
 */
describe.skipIf(!hasPosixTools(['git']))('local-WSL spawns per user action', () => {
  let tmp: string;
  let repo: string;
  let counter: WslSpawnCounter;
  let hash: string;
  /** The Windows spelling of a directory the fake wsl.exe sees as the same path. */
  const unc = (posix: string): string => wslPathToWindows('Ubuntu', posix);

  beforeAll(() => {
    tmp = makeTmpDir('wmux-wsl-count-');
    fakeState.cwd = tmp;
    counter = makeWslSpawnCounter(tmp);
    fakeState.exe = counter.exe;
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export {};\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    hash = git(repo, 'rev-parse', 'HEAD').trim();
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 's\n');
    git(repo, 'add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'new one.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(repo, 'new two.txt'), 'x\n');
    git(repo, 'worktree', 'add', '-q', '-b', 'agent/work', path.join(tmp, 'agent-wt'), 'HEAD');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    resetBatchBackoff();
    resetDiffCaches();
    counter.reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => vi.restoreAllMocks();
  });

  const cwd = (): string => unc(repo);
  const view = async (req: GitViewRequest): Promise<void> => {
    const res = await handleGitView(req);
    if (!res.ok) throw new Error(res.error);
  };
  /** Spawns and peak concurrency of `action`, from a clean counter. */
  const measure = async (action: () => Promise<unknown>): Promise<{ spawns: number; peak: number }> => {
    counter.reset();
    await action();
    return { spawns: counter.spawns(), peak: counter.peak() };
  };

  const req = (r: () => GitViewRequest): (() => Promise<void>) => () => view(r());
  // A change that raises a count is a latency regression; one that lowers it lowers it here.
  const cases: Array<{ name: string; action: () => Promise<unknown>; spawns: number }> = [
    { name: '(g) Git pane repo, one linked worktree', action: req(() => ({ op: 'repo', cwd: cwd() })), spawns: 2 },
    { name: '(g) Git pane working', action: req(() => ({ op: 'working', cwd: cwd(), worktree: cwd() })), spawns: 1 },
    { name: '(g) Git pane workingDiff, unstaged', action: req(() => ({ op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: 'a.txt', section: 'unstaged' })), spawns: 1 },
    // An untracked file is read through the share, not through git: only the worktree check is a spawn.
    { name: '(g) Git pane workingDiff, untracked', action: req(() => ({ op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: 'new one.txt', section: 'untracked' })), spawns: 1 },
    { name: '(g) Git pane branch', action: req(() => ({ op: 'branch', cwd: cwd(), worktree: cwd(), base: 'main' })), spawns: 2 },
    { name: '(g) Git pane graph, all worktrees', action: req(() => ({ op: 'graph', cwd: cwd(), worktree: cwd(), scope: 'all', limit: 50 })), spawns: 2 },
    { name: '(g) Git pane graph, one worktree', action: req(() => ({ op: 'graph', cwd: cwd(), worktree: cwd(), scope: 'worktree', limit: 50 })), spawns: 1 },
    { name: '(g) Git pane commit', action: req(() => ({ op: 'commit', cwd: cwd(), hash })), spawns: 2 },
    { name: '(g) Git pane compare, from a commit', action: req(() => ({ op: 'compare', cwd: cwd(), from: hash, to: hash })), spawns: 1 },
    { name: '(g) Git pane compare, from the empty tree', action: req(() => ({ op: 'compare', cwd: cwd(), from: '', to: hash })), spawns: 2 },
    { name: '(f) Diff tab file list', action: () => getChangedFiles(cwd()), spawns: 1 },
    { name: '(f) Diff tab file list, against a base', action: () => getChangedFiles(cwd(), hash), spawns: 1 },
    { name: '(f) explorer +N/-N column', action: () => getChangedFilesWithBaseline(cwd()), spawns: 1 },
    { name: '(f) Diff tab one tracked file diff', action: () => getFileDiff(cwd(), 'a.txt'), spawns: 1 },
    { name: '(f) Diff tab one untracked file diff', action: () => getFileDiff(cwd(), 'new one.txt'), spawns: 1 },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.spawns} wsl.exe start${c.spawns === 1 ? '' : 's'}`, async () => {
      expect((await measure(c.action)).spawns).toBe(c.spawns);
    });
  }
});
