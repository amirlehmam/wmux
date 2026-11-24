import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  currentSshGit,
  isSshUnreachable,
  markSshUnreachable,
  runWithSshGit,
  sshGitCommand,
  sshLocationKey,
  SSH_UNREACHABLE_MESSAGE,
  type SshGitContext,
} from '../../src/main/ssh-git';
import {
  branchStatusFromRepo,
  parseBranchStatus,
  pushWorkspaceGit,
  setWorkspaceGitJs,
} from '../../src/main/ssh-branch';
import { handleGitView, worktreeKey } from '../../src/main/git-view';
import { getChangedFiles, getChangedFilesWithBaseline, getFileDiff, resetDiffCaches } from '../../src/main/diff-provider';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import type { GitRepoInfo, GitViewRequest, GitWorkingChanges, GitBranchChanges, GitCommit, GitCommitDetails } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * Remote git, run for real: the "ssh" is a two-line script that executes the
 * one command string ssh would have sent in a local `sh -c`, so the quoting,
 * the `env`/`git -C` script and every git sub-command of the Git view run
 * against throwaway repositories, with no network.
 */
function target(repoPath: string, host = 'dev@box'): SshTarget {
  const parsed = parseSshTarget(['ssh', host], repoPath);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

describe('pure helpers', () => {
  it('parseBranchStatus reads the branch and whether anything is dirty', () => {
    expect(parseBranchStatus('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n')).toEqual({ branch: 'main', dirty: false });
    expect(parseBranchStatus('# branch.head feat/x\n1 .M N... 100644 100644 100644 a b src/a.ts\n')).toEqual({ branch: 'feat/x', dirty: true });
    expect(parseBranchStatus('# branch.head (detached)\n? new.txt\n')).toEqual({ branch: null, dirty: true });
    expect(parseBranchStatus('')).toBeNull();
    expect(parseBranchStatus('fatal: not a git repository')).toBeNull();
  });

  const repoInfo = (summaries: Record<string, { staged: number; unstaged: number; untracked: number; conflicted: number } | null>): GitRepoInfo => ({
    root: '/w/repo',
    defaultBase: null,
    refs: { local: [], remote: [], tags: [] },
    worktrees: Object.entries(summaries).map(([p, s], i) => ({
      path: p, head: 'abc', branch: i === 0 ? 'main' : `b${i}`, primary: i === 0, bare: false, locked: false, prunable: false,
      summary: s && { ...s, upstream: null, ahead: 0, behind: 0 },
    })),
  });
  const clean = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };

  it('branchStatusFromRepo takes the worktree at the checkout path, else the primary', () => {
    const repo = repoInfo({ '/w/repo': clean, '/w/repo/.wt/agent': { ...clean, unstaged: 2 } });
    expect(branchStatusFromRepo(repo, '/w/repo/.wt/agent/')).toEqual({ branch: 'b1', dirty: true });
    expect(branchStatusFromRepo(repo, '/w/repo')).toEqual({ branch: 'main', dirty: false });
    expect(branchStatusFromRepo(repo, '/elsewhere')).toEqual({ branch: 'main', dirty: false });
    expect(branchStatusFromRepo(repoInfo({ '/w/repo': { ...clean, untracked: 1 } }), '/w/repo')).toEqual({ branch: 'main', dirty: true });
  });

  it('branchStatusFromRepo has no answer without a summary or worktrees', () => {
    expect(branchStatusFromRepo(repoInfo({ '/w/repo': null }), '/w/repo')).toBeNull();
    expect(branchStatusFromRepo({ ...repoInfo({}), worktrees: [] }, '/w/repo')).toBeNull();
    const bare = repoInfo({ '/w/repo': clean });
    bare.worktrees[0].bare = true;
    expect(branchStatusFromRepo(bare, '/w/repo')).toBeNull();
  });

  it('setWorkspaceGitJs encodes every value', () => {
    const js = setWorkspaceGitJs(`ws'"); alert(1); //`, { branch: null, dirty: true });
    expect(js).toContain(JSON.stringify(`ws'"); alert(1); //`));
    expect(js).toContain('null, true');
    expect(js.startsWith('window.__wmux_setWorkspaceGit?.(')).toBe(true);
  });

  it('isSshUnreachable is exit status 255 only', () => {
    expect(isSshUnreachable(Object.assign(new Error('x'), { code: 255 }))).toBe(true);
    expect(isSshUnreachable(Object.assign(new Error('x'), { code: 1 }))).toBe(false);
    expect(isSshUnreachable(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isSshUnreachable(null)).toBe(false);
  });

  it('the context is only visible inside runWithSshGit, and marks propagate to it', async () => {
    expect(currentSshGit()).toBeUndefined();
    expect(sshLocationKey()).toBe('');
    const ctx: SshGitContext = { target: target('/w/repo') };
    await runWithSshGit(ctx, async () => {
      await Promise.resolve();
      expect(currentSshGit()).toBe(ctx);
      expect(sshLocationKey()).toBe('ssh://dev@box/w/repo');
      markSshUnreachable();
    });
    expect(ctx.unreachable).toBe(true);
    markSshUnreachable(); // outside a context: nothing to mark, no throw
    expect(currentSshGit()).toBeUndefined();
  });

  it('sshGitCommand: one quoted command, the git args as arguments, never in the script', () => {
    const ctx: SshGitContext = { target: target('/w/repo'), tool: () => 'ssh' };
    const hostile = `x'; touch pwned; '`;
    const cmd = sshGitCommand(ctx, '/w/repo', ['status', '--', hostile]);
    expect(cmd.ssh).toBe(true);
    expect(cmd.file).toBe('ssh');
    expect(cmd.args).toContain('BatchMode=yes');
    expect(cmd.args[cmd.args.length - 2]).toBe('dev@box');
    const command = cmd.args[cmd.args.length - 1];
    expect(command).toContain('GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git -C');
    expect(command).toContain(`'x'"'"'; touch pwned; '"'"''`);
    expect(command.split(' sh ')[0]).not.toContain('pwned');
  });

  it('sshGitCommand refuses a cwd that is not a remote absolute path', () => {
    const ctx: SshGitContext = { target: target('/w/repo'), tool: () => 'ssh' };
    for (const bad of ['relative', '', 'C:\\x', '/a\0b']) expect(() => sshGitCommand(ctx, bad, ['status'])).toThrow(/remote host/);
  });

  it('worktreeKey compares a remote host path as text, not through the local disk', () => {
    runWithSshGit({ target: target('/w/repo') }, () => {
      expect(worktreeKey('/definitely/not/local/')).toBe('/definitely/not/local');
      expect(worktreeKey('/')).toBe('/');
    });
  });
});

describe('pushWorkspaceGit', () => {
  const win = (answer: unknown, destroyed = false) => ({
    isDestroyed: () => destroyed,
    webContents: { executeJavaScript: vi.fn(async () => { if (answer instanceof Error) throw answer; return answer; }) },
  });

  it('writes into the first window that holds the workspace, skipping dead and failing ones', async () => {
    const dead = win({ x: 1 }, true);
    const failing = win(new Error('reloading'));
    const other = win(null);
    const owner = win({ workspaceId: 'ws-1' });
    const after = win({ workspaceId: 'ws-1' });
    await pushWorkspaceGit([dead, failing, other, owner, after], 'ws-1', { branch: 'main', dirty: false });
    expect(dead.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(owner.webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('"ws-1", "main", false'));
    expect(after.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('does nothing without a status', async () => {
    const w = win({ workspaceId: 'ws-1' });
    await pushWorkspaceGit([w], 'ws-1', null);
    expect(w.webContents.executeJavaScript).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasPosixTools(['git']))('git on a remote host, executed by a local sh', () => {
  let tmp: string;
  let repoA: string;
  let repoB: string;
  let plain: string;
  let fakeSsh: string;
  let deadSsh: string;

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-git-');
    fakeSsh = path.join(tmp, 'fake-ssh');
    fs.writeFileSync(fakeSsh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n', { mode: 0o755 });
    deadSsh = path.join(tmp, 'dead-ssh');
    fs.writeFileSync(deadSsh, '#!/bin/sh\nexit 255\n', { mode: 0o755 });

    repoA = path.join(tmp, 'repo with space');
    fs.mkdirSync(repoA);
    git(repoA, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repoA, 'a.txt'), 'one\ntwo\nthree\n');
    git(repoA, 'add', '.');
    git(repoA, 'commit', '-q', '-m', 'first');
    // Uncommitted: unstaged edit, a staged file, an untracked file and a binary one.
    fs.appendFileSync(path.join(repoA, 'a.txt'), 'four\n');
    fs.writeFileSync(path.join(repoA, 'staged.txt'), 's\n');
    git(repoA, 'add', 'staged.txt');
    fs.writeFileSync(path.join(repoA, 'new file.txt'), 'x\ny\nz\n');
    fs.writeFileSync(path.join(repoA, 'blob.bin'), Buffer.from([0, 1, 2, 0]));
    // A linked worktree outside the checkout, the shape an agent's worktree has.
    git(repoA, 'worktree', 'add', '-q', '-b', 'agent/work', path.join(tmp, 'agent-wt'), 'HEAD');

    repoB = path.join(tmp, 'repoB');
    fs.mkdirSync(repoB);
    git(repoB, 'init', '-q', '-b', 'other');
    fs.writeFileSync(path.join(repoB, 'b.txt'), 'b\n');
    git(repoB, 'add', '.');
    git(repoB, 'commit', '-q', '-m', 'only in B');

    plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'x.ts'), 'x\n');
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    resetDiffCaches();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => vi.restoreAllMocks();
  });

  const via = (repoPath: string, tool = fakeSsh): SshGitContext => ({ target: target(repoPath), tool: () => tool });
  const ask = async <T>(req: GitViewRequest, ctx: SshGitContext): Promise<T> => {
    const res = await handleGitView(req, ctx);
    if (!res.ok) throw new Error(res.error);
    return res.data as T;
  };
  const BOGUS = '/nonexistent/local/folder';

  describe('handleGitView', () => {
    it('answers from the target path and ignores the request cwd, marking the answer remote', async () => {
      const repo = await ask<GitRepoInfo>({ op: 'repo', cwd: BOGUS }, via(repoA));
      expect(repo.remote).toBe(true);
      expect(repo.root).toBe(repoA);
      expect(repo.worktrees.map((w) => w.branch).sort()).toEqual(['agent/work', 'main']);
      expect(repo.worktrees[0].summary).toMatchObject({ staged: 1, unstaged: 1, untracked: 2 });
      expect(repo.refs.local.sort()).toEqual(['agent/work', 'main']);
    });

    it('never falls back to the request cwd: a local repository named there is not read', async () => {
      const repo = await ask<GitRepoInfo>({ op: 'repo', cwd: repoB }, via(repoA));
      expect(repo.root).toBe(repoA);
      expect(repo.worktrees.map((w) => w.branch)).not.toContain('other');
    });

    it('without a target the same request is the local one, unchanged', async () => {
      const res = await handleGitView({ op: 'repo', cwd: repoB });
      expect(res).toMatchObject({ ok: true, data: { root: repoB } });
      expect((res as { data: GitRepoInfo }).data.remote).toBeUndefined();
    });

    it('does not mix two remote hosts that receive an identical request at once', async () => {
      const [a, b] = await Promise.all([
        handleGitView({ op: 'repo', cwd: BOGUS }, via(repoA)),
        handleGitView({ op: 'repo', cwd: BOGUS }, via(repoB)),
      ]);
      expect(a).toMatchObject({ ok: true, data: { root: repoA } });
      expect(b).toMatchObject({ ok: true, data: { root: repoB } });
    });

    it('splits working changes and shows an untracked file as an all-additions diff, read on the remote host', async () => {
      const ctx = via(repoA);
      const changes = await ask<GitWorkingChanges>({ op: 'working', cwd: BOGUS, worktree: repoA }, ctx);
      expect(changes.staged.map((f) => f.path)).toEqual(['staged.txt']);
      expect(changes.unstaged.map((f) => [f.path, f.additions])).toEqual([['a.txt', 1]]);
      expect(changes.untracked.map((f) => f.path).sort()).toEqual(['blob.bin', 'new file.txt']);
      const diff = await ask<string>({ op: 'workingDiff', cwd: BOGUS, worktree: repoA, file: 'new file.txt', section: 'untracked' }, ctx);
      expect(diff).toContain('--- /dev/null');
      expect(diff).toContain('+++ b/new file.txt');
      expect(diff).toContain('+y');
      const staged = await ask<string>({ op: 'workingDiff', cwd: BOGUS, worktree: repoA, file: 'staged.txt', section: 'staged' }, ctx);
      expect(staged).toContain('+s');
      const unstaged = await ask<string>({ op: 'workingDiff', cwd: BOGUS, worktree: repoA, file: 'a.txt', section: 'unstaged' }, ctx);
      expect(unstaged).toContain('+four');
    });

    it('serves a linked worktree git itself lists, wherever it is on the remote host, and refuses any other path', async () => {
      const ctx = via(repoA);
      const wt = path.join(tmp, 'agent-wt');
      const changes = await ask<GitWorkingChanges>({ op: 'working', cwd: BOGUS, worktree: wt }, ctx);
      expect(changes.staged).toEqual([]);
      const refused = await handleGitView({ op: 'working', cwd: BOGUS, worktree: tmp }, ctx);
      expect(refused).toMatchObject({ ok: false, code: 'invalid' });
    });

    it('answers branch, graph and commit queries', async () => {
      const ctx = via(repoA);
      const branch = await ask<GitBranchChanges>({ op: 'branch', cwd: BOGUS, worktree: repoA, base: 'main' }, ctx);
      expect(branch.base).toBe('main');
      const { commits } = await ask<{ commits: GitCommit[] }>({ op: 'graph', cwd: BOGUS, worktree: repoA, scope: 'all', limit: 50 }, ctx);
      expect(commits.map((c) => c.subject)).toEqual(['first']);
      const details = await ask<GitCommitDetails>({ op: 'commit', cwd: BOGUS, hash: commits[0].hash }, ctx);
      expect(details.files.map((f) => f.path)).toEqual(['a.txt']);
    });

    it('keeps the argument validation: an option smuggled in as a base is refused before any ssh', async () => {
      const res = await handleGitView({ op: 'branch', cwd: BOGUS, worktree: repoA, base: '--output=pwned' }, via(repoA));
      expect(res).toMatchObject({ ok: false, code: 'invalid' });
      expect(fs.existsSync(path.join(repoA, 'pwned'))).toBe(false);
    });

    it('answers not_repo for a remote host path that is not a repository', async () => {
      expect(await handleGitView({ op: 'repo', cwd: BOGUS }, via(plain))).toMatchObject({ ok: false, code: 'not_repo' });
    });

    it('names the cause when the remote host cannot be reached, and reads nothing local', async () => {
      const res = await handleGitView({ op: 'repo', cwd: repoB }, via(repoA, deadSsh));
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining(SSH_UNREACHABLE_MESSAGE) });
      const working = await handleGitView({ op: 'working', cwd: repoB, worktree: repoA }, via(repoA, deadSsh));
      expect(working).toMatchObject({ ok: false });
    });

    it('reports a missing ssh executable as a failure, not a crash', async () => {
      const ctx: SshGitContext = { target: target(repoA), tool: () => { throw new Error('matching ssh executable not found'); } };
      expect(await handleGitView({ op: 'repo', cwd: BOGUS }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining('ssh executable') });
    });
  });

  describe('diff-provider', () => {
    it('lists changed files with untracked line counts, counted on the remote host', async () => {
      const files = await runWithSshGit(via(repoA), () => getChangedFiles(repoA));
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
      expect(byPath['a.txt']).toMatchObject({ status: 'modified', additions: 1 });
      expect(byPath['staged.txt']).toMatchObject({ status: 'added' });
      expect(byPath['new file.txt']).toMatchObject({ status: 'added', additions: 3, deletions: 0 });
      expect(byPath['blob.bin']).toMatchObject({ status: 'added', additions: 0 });
    });

    it('labels a git answer with the git baseline', async () => {
      const res = await runWithSshGit(via(repoA), () => getChangedFilesWithBaseline(repoA));
      expect(res.baseline).toBe('git');
      expect(res.files.length).toBeGreaterThan(0);
    });

    it('diffs a tracked and an untracked file', async () => {
      const ctx = via(repoA);
      expect(await runWithSshGit(ctx, () => getFileDiff(repoA, 'a.txt'))).toContain('+four');
      const untracked = await runWithSshGit(ctx, () => getFileDiff(repoA, 'new file.txt'));
      expect(untracked).toContain('+++ b/new file.txt');
      expect(untracked).toContain('+z');
    });

    it('for a remote host path that is not a repository answers nothing, and never walks the local disk', async () => {
      const ctx = via(plain);
      const res = await runWithSshGit(ctx, () => getChangedFilesWithBaseline(plain));
      expect(res).toEqual({ files: [], baseline: 'snapshot' });
      expect(await runWithSshGit(ctx, () => getFileDiff(plain, 'x.ts'))).toBe('');
      // The local snapshot machinery would have baselined the directory that exists here.
      expect(await getChangedFiles(plain)).toEqual([]); // first local call only takes the snapshot
    });

    it('throws, rather than reporting "no changes", when the remote host cannot be reached', async () => {
      const ctx = via(repoA, deadSsh);
      await expect(runWithSshGit(ctx, () => getChangedFiles(repoA))).rejects.toThrow(SSH_UNREACHABLE_MESSAGE);
      await expect(runWithSshGit(ctx, () => getChangedFilesWithBaseline(repoA))).rejects.toThrow(SSH_UNREACHABLE_MESSAGE);
      await expect(runWithSshGit(ctx, () => getFileDiff(repoA, 'a.txt'))).rejects.toThrow(SSH_UNREACHABLE_MESSAGE);
    });

    it('does not cache an unreachable host as "not a repository"', async () => {
      await expect(runWithSshGit(via(repoA, deadSsh), () => getChangedFiles(repoA))).rejects.toThrow();
      const files = await runWithSshGit(via(repoA), () => getChangedFiles(repoA));
      expect(files.length).toBeGreaterThan(0);
    });

    it('keeps a remote host path and a local path with the same spelling apart in its caches', async () => {
      const remote = await runWithSshGit(via(repoA), () => getChangedFiles(repoA));
      const local = await getChangedFiles(repoA);
      expect(local.map((f) => f.path).sort()).toEqual(remote.map((f) => f.path).sort()); // same repo here, so same answer
      resetDiffCaches();
      const localFirst = await getChangedFiles(plain); // non-repo: snapshot, nothing yet
      const remoteAfter = await runWithSshGit(via(plain), () => getChangedFiles(plain));
      expect(localFirst).toEqual([]);
      expect(remoteAfter).toEqual([]);
    });
  });
});
