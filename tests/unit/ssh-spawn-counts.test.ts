import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { makeSpawnCounter, type SpawnCounter } from '../helpers/ssh-spawn-counter';
import {
  remoteCreateEntry,
  remoteListDir,
  remoteReadCodeFile,
  remoteWriteCodeFile,
  type RemoteDeps,
} from '../../src/main/ssh-explorer';
import { runSsh } from '../../src/main/ssh-exec';
import { runWithSshGit, type SshGitContext } from '../../src/main/ssh-git';
import { remoteBranchStatus } from '../../src/main/ssh-branch';
import { remoteChangedFiles, remoteFileDiff } from '../../src/main/ssh-diff';
import { handleGitView } from '../../src/main/git-view';
import { getChangedFilesWithBaseline, resetDiffCaches } from '../../src/main/diff-provider';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import type { GitViewRequest } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * How many remote spawns each user action costs, and how many of them overlap.
 *
 * On the WSL route every spawn is a `wsl.exe` start plus the remote work, so the wall
 * clock of an action is roughly the number of sequential spawns times that start. These
 * numbers are the budget: a change that raises one is a latency regression, and a change
 * that lowers one should lower it here.
 * The ssh is a fake that runs the command string in a local `sh -c` and counts its
 * own starts (tests/helpers/ssh-spawn-counter.ts), so the scripts are the real ones.
 */
function targetAt(root: string): SshTarget {
  const parsed = parseSshTarget(['ssh', 'dev@box'], root);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

describe.skipIf(!hasPosixTools(['git', 'gnu-find', 'stat-c', 'mktemp']))('remote spawns per user action', () => {
  let tmp: string;
  let repo: string;
  let counter: SpawnCounter;
  let hash: string;

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-count-');
    counter = makeSpawnCounter(tmp);
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(repo, 'notes.md'), '# notes\n');
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export {};\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    hash = git(repo, 'rev-parse', 'HEAD').trim();
    // Uncommitted work: an unstaged edit, a staged file and two untracked files.
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 's\n');
    git(repo, 'add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'new one.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(repo, 'new two.txt'), 'x\n');
    git(repo, 'worktree', 'add', '-q', '-b', 'agent/work', path.join(tmp, 'agent-wt'), 'HEAD');
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    resetDiffCaches();
    counter.reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => vi.restoreAllMocks();
  });

  const deps = (): RemoteDeps => ({ run: runSsh, tool: () => counter.tool });
  const ctx = (): SshGitContext => ({ target: targetAt(repo), tool: () => counter.tool });
  const view = async (req: GitViewRequest): Promise<void> => {
    const res = await handleGitView(req, ctx());
    if (!res.ok) throw new Error(res.error);
  };
  /** Spawns and peak concurrency of `action`, from a clean counter. */
  const measure = async (action: () => Promise<unknown>): Promise<{ spawns: number; peak: number }> => {
    counter.reset();
    await action();
    return { spawns: counter.spawns(), peak: counter.peak() };
  };

  describe('the explorer', () => {
    it('(a) first root listing, (b) expanding a directory: one spawn', async () => {
      expect(await measure(() => remoteListDir(targetAt(repo), '', {}, deps()))).toEqual({ spawns: 1, peak: 1 });
      expect(await measure(() => remoteListDir(targetAt(repo), 'src', {}, deps()))).toEqual({ spawns: 1, peak: 1 });
    });

    it('(c) opening a code file and (d) a markdown file: one spawn each', async () => {
      expect(await measure(() => remoteReadCodeFile(targetAt(repo), 'src/index.ts', deps()))).toEqual({ spawns: 1, peak: 1 });
      expect(await measure(() => remoteReadCodeFile(targetAt(repo), 'notes.md', deps()))).toEqual({ spawns: 1, peak: 1 });
    });

    it('(e) saving a file reads it first, then writes: two sequential spawns', async () => {
      const read = await remoteReadCodeFile(targetAt(repo), 'src/index.ts', deps());
      if ('error' in read) throw new Error(read.error);
      const result = await measure(() => remoteWriteCodeFile(targetAt(repo), 'src/index.ts', 'export {};\n', read.mtimeMs, deps()));
      expect(result).toEqual({ spawns: 2, peak: 1 });
    });

    it('(i) identical listings in flight at once share one spawn', async () => {
      const result = await measure(() => Promise.all([
        remoteListDir(targetAt(repo), '', {}, deps()),
        remoteListDir(targetAt(repo), '', {}, deps()),
        remoteListDir(targetAt(repo), '', {}, deps()),
      ]));
      expect(result).toEqual({ spawns: 1, peak: 1 });
    });

    it('(i) a listing does not join one that began before a write to the same host', async () => {
      const name = `made-${Date.now()}.txt`;
      const before = remoteListDir(targetAt(repo), '', {}, deps());
      const created = await remoteCreateEntry(targetAt(repo), '', name, 'file', deps());
      expect(created).toEqual({ ok: true });
      const after = await remoteListDir(targetAt(repo), '', {}, deps());
      await before;
      expect('entries' in after && after.entries.map((e) => e.name)).toContain(name);
      fs.rmSync(path.join(repo, name));
    });

    it('(i) a burst of different folders is capped at three spawns at once', async () => {
      const dirs = ['', 'src', 'src', 'a', 'b', 'c', 'd', 'e'];
      const result = await measure(() => Promise.all(dirs.map((rel) => remoteListDir(targetAt(repo), rel, {}, deps()))));
      expect(result.spawns).toBe(7);
      expect(result.peak).toBe(3);
    });
  });

  describe('changed files: the +N/-N column (f) and the Diff tab (f)', () => {
    it('the column: one spawn for probe, status and numstat, one for every untracked file together', async () => {
      const result = await measure(() => runWithSshGit(ctx(), () => getChangedFilesWithBaseline(repo)));
      expect(result).toEqual({ spawns: 2, peak: 1 });
      expect(await measure(() => runWithSshGit(ctx(), () => getChangedFilesWithBaseline(repo)))).toEqual({ spawns: 2, peak: 1 });
    });

    it('the Diff tab file list costs the same as the column, with or without a base ref', async () => {
      expect(await measure(() => remoteChangedFiles(targetAt(repo), undefined, () => counter.tool))).toEqual({ spawns: 2, peak: 1 });
      expect(await measure(() => remoteChangedFiles(targetAt(repo), hash, () => counter.tool))).toEqual({ spawns: 2, peak: 1 });
    });

    it('a clean repository is one spawn', async () => {
      const clean = path.join(tmp, 'clean');
      fs.mkdirSync(clean);
      git(clean, 'init', '-q', '-b', 'main');
      const result = await measure(() => remoteChangedFiles(targetAt(clean), undefined, () => counter.tool));
      expect(result).toEqual({ spawns: 1, peak: 1 });
    });

    it('the column and the Diff tab asking at the same moment share one pass', async () => {
      const result = await measure(() => Promise.all([
        runWithSshGit(ctx(), () => getChangedFilesWithBaseline(repo)),
        remoteChangedFiles(targetAt(repo), undefined, () => counter.tool),
      ]));
      expect(result).toEqual({ spawns: 2, peak: 1 });
    });

    it('one tracked file diff is one spawn; an untracked one is two', async () => {
      expect(await measure(() => remoteFileDiff(targetAt(repo), 'a.txt', undefined, () => counter.tool))).toEqual({ spawns: 1, peak: 1 });
      expect(await measure(() => remoteFileDiff(targetAt(repo), 'new one.txt', undefined, () => counter.tool))).toEqual({ spawns: 2, peak: 1 });
    });
  });

  describe('(g) the Git pane, a batch per request', () => {
    const wt = (): string => repo;
    it('repo: one spawn, two when the repository has linked worktrees', async () => {
      expect(await measure(() => view({ op: 'repo', cwd: '', surfaceId: 's' }))).toEqual({ spawns: 2, peak: 1 });
      const single = path.join(tmp, 'single');
      fs.mkdirSync(single);
      git(single, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(single, 'f.txt'), 'f\n');
      git(single, 'add', '.');
      git(single, 'commit', '-q', '-m', 'only');
      counter.reset();
      const res = await handleGitView({ op: 'repo', cwd: '' }, { target: targetAt(single), tool: () => counter.tool });
      expect(res.ok).toBe(true);
      expect({ spawns: counter.spawns(), peak: counter.peak() }).toEqual({ spawns: 1, peak: 1 });
    });

    it('working: one spawn', async () => {
      expect(await measure(() => view({ op: 'working', cwd: '', worktree: wt() }))).toEqual({ spawns: 1, peak: 1 });
    });

    it('workingDiff: one spawn', async () => {
      const req = (section: 'unstaged' | 'untracked', file: string): GitViewRequest => ({ op: 'workingDiff', cwd: '', worktree: wt(), file, section });
      expect(await measure(() => view(req('unstaged', 'a.txt')))).toEqual({ spawns: 1, peak: 1 });
      expect(await measure(() => view(req('untracked', 'new one.txt')))).toEqual({ spawns: 1, peak: 1 });
    });

    it('branch: two spawns (revisions and merge base, then log and file changes)', async () => {
      expect(await measure(() => view({ op: 'branch', cwd: '', worktree: wt(), base: 'main' }))).toEqual({ spawns: 2, peak: 1 });
    });

    it('graph: one spawn for one worktree, two for the others (they need every worktree HEAD first)', async () => {
      expect(await measure(() => view({ op: 'graph', cwd: '', worktree: wt(), scope: 'all', limit: 50 }))).toEqual({ spawns: 2, peak: 1 });
      expect(await measure(() => view({ op: 'graph', cwd: '', worktree: wt(), scope: 'worktree', limit: 50 }))).toEqual({ spawns: 1, peak: 1 });
    });

    it('commit: show with the file changes after it; compare: one spawn, two from the empty tree', async () => {
      expect(await measure(() => view({ op: 'commit', cwd: '', hash }))).toEqual({ spawns: 2, peak: 1 });
      expect(await measure(() => view({ op: 'compare', cwd: '', from: hash, to: hash }))).toEqual({ spawns: 1, peak: 1 });
      expect(await measure(() => view({ op: 'compare', cwd: '', from: '', to: hash }))).toEqual({ spawns: 2, peak: 1 });
    });

    it('two identical requests in flight share one run', async () => {
      const result = await measure(() => Promise.all([
        view({ op: 'working', cwd: '', worktree: wt() }),
        view({ op: 'working', cwd: '', worktree: wt() }),
      ]));
      expect(result).toEqual({ spawns: 1, peak: 1 });
    });
  });

  describe('(h) the sidebar branch and dirty marker', () => {
    it('is one spawn when a target is set (status and worktree list in one batch); a Git view refresh reuses its own repo answer', async () => {
      expect(await measure(() => remoteBranchStatus(targetAt(repo), runSsh, () => counter.tool))).toEqual({ spawns: 1, peak: 1 });
    });

    it('reads the same marker a Git view would, including for a linked worktree', async () => {
      expect(await remoteBranchStatus(targetAt(repo), runSsh, () => counter.tool)).toEqual({ branch: 'main', dirty: true });
      expect(await remoteBranchStatus(targetAt(path.join(tmp, 'agent-wt')), runSsh, () => counter.tool)).toEqual({ branch: 'agent/work', dirty: false });
    });

    it('reads a detached worktree as no branch, and a subfolder of the checkout as the checkout', async () => {
      git(repo, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'detached-wt'), 'HEAD');
      expect(await remoteBranchStatus(targetAt(path.join(tmp, 'detached-wt')), runSsh, () => counter.tool)).toEqual({ branch: null, dirty: false });
      expect(await remoteBranchStatus(targetAt(path.join(repo, 'src')), runSsh, () => counter.tool)).toEqual({ branch: 'main', dirty: true });
    });

    it('gives up after one spawn when the host cannot be reached, with no second try', async () => {
      const log = path.join(tmp, 'dead-count.log');
      const dead = path.join(tmp, 'dead-count-ssh');
      fs.writeFileSync(log, '');
      fs.writeFileSync(dead, `#!/bin/sh\nprintf 's\\n' >> '${log}'\nexit 255\n`, { mode: 0o755 });
      expect(await remoteBranchStatus(targetAt(repo), runSsh, () => dead)).toBeNull();
      expect(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('is null for a folder that is not a repository, and when no ssh can be run', async () => {
      const plain = path.join(tmp, 'plain-folder');
      fs.mkdirSync(plain);
      expect(await remoteBranchStatus(targetAt(plain), runSsh, () => counter.tool)).toBeNull();
      expect(await remoteBranchStatus(targetAt(repo), runSsh, () => { throw new Error('no ssh'); })).toBeNull();
    });

    it('falls back to one status spawn when the host does not answer the batch', async () => {
      const refusing = makeSpawnCounter(tmp, 'refusing-ssh', 0, true);
      const result = await remoteBranchStatus(targetAt(repo), runSsh, () => refusing.tool);
      expect(result).toEqual({ branch: 'main', dirty: true });
      expect(refusing.spawns()).toBe(2); // the refused batch, then `git status`
    });
  });
});
