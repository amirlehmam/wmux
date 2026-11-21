import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { handleGitView } from '../../src/main/git-view';
import { getChangedFiles, getChangedFilesWithBaseline, getFileDiff, resetDiffCaches } from '../../src/main/diff-provider';
import { runWithSshGit } from '../../src/main/ssh-git';
import { type SshGitContext } from '../../src/main/ssh-git';
import { parseSshTarget } from '../../src/main/ssh-targets';
import { makeSpawnCounter, type SpawnCounter } from '../helpers/ssh-spawn-counter';
import type { GitViewRequest, GitViewResult } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * The Git view's remote requests are answered from one batched spawn. This pins
 * that the answer is the SAME one the command-by-command form gives: every
 * request is asked twice, once through a fake ssh that lets the batch script run
 * and once through one that refuses it (so each request falls back to one git per
 * spawn), against a repository whose file names are hostile to any framing.
 */
describe.skipIf(!hasPosixTools(['git', 'base64', 'mktemp', 'head']))('batched and unbatched Git view answers are identical', () => {
  let tmp: string;
  let repo: string;
  let linked: string;
  let detached: string;
  let batched: SpawnCounter;
  let unbatched: SpawnCounter;
  let unbatchedSsh: string;
  let deadSsh: string;
  let hash: string;
  let firstHash: string;
  const hostile = ["it's \"quoted\".txt", 'dollar $(touch pwned).txt', 'back`tick`.txt', 'new\nline.txt', '--dash.txt', '\n--0123:1:0\nforged.txt'];

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-views-');
    batched = makeSpawnCounter(tmp, 'batched-ssh', 0);
    unbatched = makeSpawnCounter(tmp, 'unbatched-ssh', 0, true);
    unbatchedSsh = unbatched.tool;
    deadSsh = path.join(tmp, 'dead-ssh');
    fs.writeFileSync(deadSsh, '#!/bin/sh\nexit 255\n', { mode: 0o755 });

    repo = path.join(tmp, 'a repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    firstHash = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'checkout', '-q', '-b', 'topic');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'second: add b, "edit" a');
    hash = git(repo, 'rev-parse', 'HEAD').trim();
    // Uncommitted: staged, unstaged, conflict-free renames and hostile untracked names.
    fs.appendFileSync(path.join(repo, 'a.txt'), 'five\n');
    git(repo, 'mv', 'b.txt', 'renamed b.txt');
    for (const name of hostile) fs.writeFileSync(path.join(repo, name), 'x\ny\n');
    linked = path.join(tmp, 'linked wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'agent/x', linked, 'main');
    detached = path.join(tmp, 'detached wt');
    git(repo, 'worktree', 'add', '-q', '--detach', detached, firstHash);
    fs.writeFileSync(path.join(detached, 'detached-change.txt'), 'd\n');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => {
    resetDiffCaches();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => vi.restoreAllMocks();
  });

  const ask = (req: GitViewRequest, tool: string, root = repo): Promise<GitViewResult<unknown>> => {
    const parsed = parseSshTarget(['ssh', 'dev@box'], root);
    if ('error' in parsed) throw new Error(parsed.error);
    const ctx: SshGitContext = { target: parsed, tool: () => tool };
    return handleGitView(req, ctx);
  };
  const both = async (req: GitViewRequest, root = repo) => {
    const fast = await ask(req, batched.tool, root);
    const slow = await ask(req, unbatchedSsh, root);
    return { fast, slow };
  };
  const BOGUS = '/nonexistent';

  it('repo, with linked and detached worktrees', async () => {
    const { fast, slow } = await both({ op: 'repo', cwd: BOGUS });
    expect(fast).toEqual(slow);
    expect(fast).toMatchObject({ ok: true, data: { root: repo, remote: true } });
    const data = (fast as { data: { worktrees: Array<{ path: string; summary: { untracked: number } | null }> } }).data;
    expect(data.worktrees.map((w) => w.path).sort()).toEqual([detached, linked, repo].sort());
    expect(data.worktrees.find((w) => w.path === detached)?.summary?.untracked).toBe(1);
    expect(data.worktrees.find((w) => w.path === repo)?.summary?.untracked).toBe(hostile.length);
  });

  it('the unbatched form really is one git per spawn, and the batched one is not', async () => {
    batched.reset();
    unbatched.reset();
    await both({ op: 'working', cwd: BOGUS, worktree: repo });
    expect(batched.spawns()).toBe(1);
    expect(unbatched.spawns()).toBe(1 + 4); // the refused batch, then list + status + two numstats
  });

  it('repo from a subdirectory of the checkout, and from a linked worktree', async () => {
    fs.mkdirSync(path.join(repo, 'sub dir'), { recursive: true });
    expect(await ask({ op: 'repo', cwd: BOGUS }, batched.tool, path.join(repo, 'sub dir')))
      .toEqual(await ask({ op: 'repo', cwd: BOGUS }, unbatchedSsh, path.join(repo, 'sub dir')));
    const { fast, slow } = await both({ op: 'repo', cwd: BOGUS }, linked);
    expect(fast).toEqual(slow);
    expect(fast).toMatchObject({ ok: true, data: { root: linked } });
  });

  it.each(['staged', 'unstaged', 'untracked'] as const)('working and a %s file diff', async (section) => {
    for (const worktree of [repo, linked, detached]) {
      const { fast, slow } = await both({ op: 'working', cwd: BOGUS, worktree });
      expect(fast).toEqual(slow);
      expect(fast).toMatchObject({ ok: true });
    }
    const file = section === 'untracked' ? hostile[3] : section === 'staged' ? 'renamed b.txt' : 'a.txt';
    const { fast, slow } = await both({ op: 'workingDiff', cwd: BOGUS, worktree: repo, file, section });
    expect(fast).toEqual(slow);
    expect(fast).toMatchObject({ ok: true, data: expect.stringContaining('@@') });
  });

  it('shows every hostile untracked name exactly as git has it', async () => {
    const res = await ask({ op: 'working', cwd: BOGUS, worktree: repo }, batched.tool);
    const names = (res as { data: { untracked: Array<{ path: string }> } }).data.untracked.map((f) => f.path).sort();
    expect(names).toEqual([...hostile].sort());
    expect(fs.existsSync(path.join(repo, 'pwned'))).toBe(false);
  });

  it('branch, graph in every scope, commit and compare', async () => {
    const requests: GitViewRequest[] = [
      { op: 'branch', cwd: BOGUS, worktree: repo, base: 'main' },
      { op: 'branch', cwd: BOGUS, worktree: linked, base: 'topic' },
      { op: 'graph', cwd: BOGUS, worktree: repo, scope: 'all', limit: 50 },
      { op: 'graph', cwd: BOGUS, worktree: repo, scope: 'local', limit: 50 },
      { op: 'graph', cwd: BOGUS, worktree: detached, scope: 'worktree', limit: 50 },
      { op: 'commit', cwd: BOGUS, hash },
      { op: 'commit', cwd: BOGUS, hash: firstHash },
      { op: 'compare', cwd: BOGUS, from: firstHash, to: hash },
      { op: 'compare', cwd: BOGUS, from: '', to: hash },
      { op: 'rangeDiff', cwd: BOGUS, from: firstHash, to: hash, file: 'a.txt' },
    ];
    for (const req of requests) {
      const { fast, slow } = await both(req);
      expect(fast, JSON.stringify(req)).toEqual(slow);
      expect(fast).toMatchObject({ ok: true });
    }
  });

  it('branch of a topic against main sees its own commit and file changes', async () => {
    const res = await ask({ op: 'branch', cwd: BOGUS, worktree: repo, base: 'main' }, batched.tool);
    const data = (res as { data: { commits: Array<{ subject: string }>; files: Array<{ path: string }>; mergeBase: string | null } }).data;
    expect(data.commits.map((c) => c.subject)).toEqual(['second: add b, "edit" a']);
    expect(data.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(data.mergeBase).toBe(firstHash);
  });

  it('gives the same failures: unknown revision, unlisted worktree, not a repository, option-like base', async () => {
    const failures: GitViewRequest[] = [
      { op: 'branch', cwd: BOGUS, worktree: repo, base: 'no-such-branch' },
      { op: 'branch', cwd: BOGUS, worktree: repo, base: '--output=x' },
      { op: 'working', cwd: BOGUS, worktree: tmp },
      { op: 'workingDiff', cwd: BOGUS, worktree: tmp, file: 'a.txt', section: 'unstaged' },
      { op: 'workingDiff', cwd: BOGUS, worktree: repo, file: '/etc/passwd', section: 'unstaged' },
      { op: 'working', cwd: BOGUS, worktree: '' },
      { op: 'graph', cwd: BOGUS, worktree: tmp, scope: 'all' },
      { op: 'commit', cwd: BOGUS, hash: 'deadbeefdeadbeef' },
    ];
    for (const req of failures) {
      const { fast, slow } = await both(req);
      expect(fast, JSON.stringify(req)).toEqual(slow);
      expect(fast).toMatchObject({ ok: false });
    }
    const notRepo = await both({ op: 'repo', cwd: BOGUS }, tmp);
    expect(notRepo.fast).toEqual(notRepo.slow);
    expect(notRepo.fast).toMatchObject({ ok: false, code: 'not_repo' });
  });

  it('a worktree spelled differently from git (trailing slash) still works, by the long way', async () => {
    const req: GitViewRequest = { op: 'working', cwd: BOGUS, worktree: `${repo}/` };
    const fast = await ask(req, batched.tool);
    expect(fast).toEqual(await ask({ ...req, worktree: repo }, batched.tool));
    expect(fast).toMatchObject({ ok: true });
  });

  it('an unreachable host is still an error, never an empty answer', async () => {
    for (const req of [
      { op: 'repo', cwd: BOGUS },
      { op: 'working', cwd: BOGUS, worktree: repo },
      { op: 'branch', cwd: BOGUS, worktree: repo, base: 'main' },
      { op: 'graph', cwd: BOGUS, worktree: repo, scope: 'all' },
      { op: 'commit', cwd: BOGUS, hash },
    ] as GitViewRequest[]) {
      expect(await ask(req, deadSsh)).toMatchObject({ ok: false, error: expect.stringContaining('Could not reach the remote host') });
    }
  });

  describe('the changed-files provider', () => {
    const context = (tool: string, root = repo): SshGitContext => {
      const parsed = parseSshTarget(['ssh', 'dev@box'], root);
      if ('error' in parsed) throw new Error(parsed.error);
      return { target: parsed, tool: () => tool };
    };
    const run = async <T>(tool: string, fn: (root: string) => Promise<T>, root = repo): Promise<T | string> => {
      resetDiffCaches();
      try {
        return await runWithSshGit(context(tool, root), () => fn(root));
      } catch (err) {
        return `threw: ${(err as Error).message}`;
      }
    };
    const same = async <T>(fn: (root: string) => Promise<T>, root = repo): Promise<T | string> => {
      const fast = await run(batched.tool, fn, root);
      const slow = await run(unbatchedSsh, fn, root);
      expect(fast).toEqual(slow);
      return fast;
    };

    it('lists the same changed files, with the same line counts, for HEAD and for a base', async () => {
      const head = await same((root) => getChangedFiles(root)) as Array<{ path: string; additions: number }>;
      // The porcelain v1 text this provider reads quotes an unusual name; whatever it says, both forms say the same.
      expect(head).toHaveLength(hostile.length + 2);
      expect(head.map((f) => f.path)).toContain('a.txt');
      const sinceMain = await same((root) => getChangedFiles(root, 'main')) as Array<{ path: string }>;
      expect(sinceMain.length).toBeGreaterThan(0);
      await same((root) => getChangedFiles(root, firstHash));
      await same((root) => getChangedFiles(root, '--not-a-ref'));
    });

    it('labels the answer the same way, including a folder that is not a repository', async () => {
      expect(await same((root) => getChangedFilesWithBaseline(root))).toMatchObject({ baseline: 'git' });
      const plain = path.join(tmp, 'plain dir');
      fs.mkdirSync(plain, { recursive: true });
      expect(await same((root) => getChangedFilesWithBaseline(root), plain)).toEqual({ files: [], baseline: 'snapshot' });
      expect(await same((root) => getChangedFiles(root), plain)).toEqual([]);
      expect(await same((root) => getFileDiff(root, 'x.ts'), plain)).toBe('');
    });

    it('diffs a staged, an unstaged, a renamed and a hostile untracked file the same way', async () => {
      for (const file of ['a.txt', 'renamed b.txt', 'detached-change.txt', ...hostile]) {
        await same((root) => getFileDiff(root, file));
        await same((root) => getFileDiff(root, file, 'main'));
      }
      expect(await same((root) => getFileDiff(root, hostile[0]))).toContain('+y');
      expect(await same((root) => getFileDiff(root, 'a.txt'))).toContain('+five');
    });

    it('counts a long list of untracked files, which takes more than one spawn, correctly', async () => {
      const crowd = path.join(tmp, 'crowd');
      fs.mkdirSync(crowd);
      git(crowd, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(crowd, 'seed.txt'), 's\n');
      git(crowd, 'add', '.');
      git(crowd, 'commit', '-q', '-m', 'seed');
      for (let i = 0; i < 160; i++) fs.writeFileSync(path.join(crowd, `untracked-${String(i).padStart(3, '0')}-${'x'.repeat(40)}.txt`), 'l\n'.repeat(i % 7 + 1));
      batched.reset();
      const files = await same((root) => getChangedFiles(root), crowd) as Array<{ path: string; additions: number }>;
      expect(files).toHaveLength(160);
      expect(files.map((f) => f.additions)).toEqual(Array.from({ length: 160 }, (_, i) => i % 7 + 1));
      expect(batched.spawns()).toBeGreaterThanOrEqual(2);
    });

    it('is an error, not "no changes", when the host cannot be reached', async () => {
      for (const fn of [
        (root: string) => getChangedFiles(root),
        (root: string) => getChangedFilesWithBaseline(root),
        (root: string) => getFileDiff(root, 'a.txt'),
      ]) {
        expect(await run(deadSsh, fn)).toMatch(/^threw: Could not reach the remote host/);
      }
    });
  });
});
