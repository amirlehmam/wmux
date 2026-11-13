import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  gitCandidates, gitCommand, parseWslUnc, wslPathToWindows, fromGitPath, handleGitView, isHash, isSafeRepoPath, isSafeRev, joinFileStats,
  parseLog, parseNameStatusZ, parseNumstatZ, parseRefs, parseStatusV2, parseWorktreePorcelain,
  pickDefaultBase, summarizeStatus, LOG_FORMAT,
} from '../../src/main/git-view';
import type {
  GitBranchChanges, GitCommit, GitCommitDetails, GitFileChange, GitRepoInfo, GitViewResult, GitWorkingChanges,
} from '../../src/shared/git-view';

// The project Git view (#362). Parsers are pinned on the shapes git prints;
// the end-to-end block runs the real git against a throwaway repository with
// a linked worktree, because "does `--all` show a detached worktree's commit"
// is a question about git, not about this module.

describe('git-view: argument validation', () => {
  it('accepts the revisions a review names', () => {
    for (const rev of ['main', 'origin/main', 'feature/x-1', 'v1.2.3', 'HEAD~2', 'HEAD^', 'a1b2c3d', 'release@{1}']) {
      expect(isSafeRev(rev)).toBe(true);
    }
  });

  it('refuses anything that could read as an option, a range or an object path', () => {
    for (const rev of ['', '-n', '--output=x', 'a..b', 'main...dev', 'HEAD:secret.txt', 'a b', 'x;rm', 42, null]) {
      expect(isSafeRev(rev)).toBe(false);
    }
  });

  it('only takes hex hashes as commits', () => {
    expect(isHash('a1b2c3d')).toBe(true);
    expect(isHash('A1B2C3D4E5F6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')).toBe(true);
    expect(isHash('HEAD')).toBe(false);
    expect(isHash('abc')).toBe(false);
  });

  it('only takes repo-relative paths', () => {
    expect(isSafeRepoPath('src/a.ts')).toBe(true);
    expect(isSafeRepoPath(':(top)a.ts')).toBe(true); // literal under --literal-pathspecs
    expect(isSafeRepoPath(path.resolve('/etc/passwd'))).toBe(false);
    expect(isSafeRepoPath('a\0b')).toBe(false);
    expect(isSafeRepoPath('')).toBe(false);
  });
});

describe('git-view: git executable resolution', () => {
  it('searches PATH first, then the Git for Windows install roots, all absolute', () => {
    const c = gitCandidates({
      PATH: 'C:\\Tools;relative\\dir;"C:\\Quoted Dir"',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    }, 'win32');
    expect(c).toEqual([
      'C:\\Tools\\git.exe',
      'C:\\Quoted Dir\\git.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
    ]);
  });
});

describe('git-view: parsers', () => {
  it('reads worktree list --porcelain, primary first', () => {
    const out = [
      'worktree C:/repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
      'worktree C:/repo/.worktrees/agent-1', 'HEAD 2222222222222222222222222222222222222222', 'detached', '',
      'worktree C:/gone', 'HEAD 3333333333333333333333333333333333333333', 'branch refs/heads/feature/x', 'locked', 'prunable gitdir file points to non-existent location', '',
    ].join('\n');
    const wts = parseWorktreePorcelain(out);
    expect(wts.map((w) => [w.path, w.branch, w.primary, w.locked, w.prunable])).toEqual([
      ['C:/repo', 'main', true, false, false],
      ['C:/repo/.worktrees/agent-1', null, false, false, false],
      ['C:/gone', 'feature/x', false, true, true],
    ]);
    expect(wts[1].head).toBe('2222222222222222222222222222222222222222');
  });

  it('reads status v2 -z, keeping spaces in paths and the rename source', () => {
    const out = [
      '# branch.oid 2b6f0d3', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 78981922 78981922 dir/a file.txt',
      '1 M. N... 100644 100644 100644 78981922 78981922 staged.txt',
      '2 R. N... 100644 100644 100644 78981922 78981922 R100 new name.txt', 'old name.txt',
      'u UU N... 100644 100644 100644 100644 1 2 3 conflict.txt',
      '? untracked one.txt',
      '',
    ].join('\0');
    const status = parseStatusV2(out);
    expect(status.entries.map((e) => [e.kind, e.x, e.y, e.path, e.oldPath])).toEqual([
      ['ordinary', '.', 'M', 'dir/a file.txt', undefined],
      ['ordinary', 'M', '.', 'staged.txt', undefined],
      ['renamed', 'R', '.', 'new name.txt', 'old name.txt'],
      ['unmerged', 'U', 'U', 'conflict.txt', undefined],
      ['untracked', '?', '?', 'untracked one.txt', undefined],
    ]);
    expect(summarizeStatus(status)).toEqual({
      staged: 2, unstaged: 1, untracked: 1, conflicted: 1, upstream: 'origin/main', ahead: 2, behind: 1,
    });
  });

  it('reads numstat -z, including renames and binaries', () => {
    const out = ['3\t1\ta.txt', '-\t-\timg.png', '5\t0\t', 'old.txt', 'new.txt', ''].join('\0');
    const stats = parseNumstatZ(out);
    expect(stats.get('a.txt')).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(stats.get('img.png')).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(stats.get('new.txt')).toEqual({ additions: 5, deletions: 0, binary: false });
  });

  it('reads name-status -z and joins the counts', () => {
    const names = parseNameStatusZ(['M', 'a.txt', 'R087', 'old.txt', 'new.txt', 'D', 'gone.txt', ''].join('\0'));
    expect(names).toEqual([
      { status: 'modified', path: 'a.txt' },
      { status: 'renamed', oldPath: 'old.txt', path: 'new.txt' },
      { status: 'deleted', path: 'gone.txt' },
    ]);
    const joined = joinFileStats(names, parseNumstatZ('1\t2\ta.txt\0'));
    expect(joined[0]).toEqual({ status: 'modified', path: 'a.txt', additions: 1, deletions: 2 });
    expect(joined[2].additions).toBe(0);
  });

  it('reads log records, decorations and a subject containing separators', () => {
    const rec = (h: string, p: string, d: string, s: string) => [h, p, 'Ann', 'a@x', '1700000000', d, s].join('\x1f') + '\x1e';
    const out = rec('a'.repeat(40), `${'b'.repeat(40)} ${'c'.repeat(40)}`, 'HEAD -> main, tag: v1, origin/main', 'Merge: a, b')
      + '\n' + rec('b'.repeat(40), '', '', 'root');
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0].parents).toHaveLength(2);
    expect(commits[0].refs).toEqual(['HEAD -> main', 'tag: v1', 'origin/main']);
    expect(commits[0].subject).toBe('Merge: a, b');
    expect(commits[1].parents).toEqual([]);
    expect(LOG_FORMAT).toContain('%x1e');
  });

  it('sorts refs and drops the remote HEAD pointer', () => {
    expect(parseRefs('refs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/tags/v1\n')).toEqual({
      local: ['main'], remote: ['origin/main'], tags: ['v1'],
    });
  });

  it('picks the remote default branch, as a local branch when there is one', () => {
    const refs = { local: ['main', 'develop', 'feature'], remote: ['origin/main', 'origin/develop'], tags: [] };
    expect(pickDefaultBase(refs, 'refs/remotes/origin/develop')).toBe('develop');
    expect(pickDefaultBase({ ...refs, local: ['feature'] }, 'refs/remotes/origin/main')).toBe('origin/main');
    expect(pickDefaultBase(refs, null)).toBe('develop');
    expect(pickDefaultBase({ local: ['trunk'], remote: [], tags: [] }, null)).toBe('trunk');
  });
});

// ─── End to end, against the real git ────────────────────────────────────────

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

// Absolute, resolved the same way the module resolves it.
const GIT = gitCandidates(process.env).find((c) => fs.existsSync(c)) ?? 'git-not-found';

function run(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, env: ENV, encoding: 'utf8' });
}

/** The 8.3 spelling of an existing path, as cmd.exe reports it. */
function shortPath(p: string): string | null {
  try {
    const cmd = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'cmd.exe');
    // Verbatim: Node's per-argument quoting would wrap the loop in quotes cmd
    // then reads as part of the path.
    const line = `"for %A in ("${p}") do @echo %~sA"`;
    return execFileSync(cmd, ['/d', '/s', '/c', line], { encoding: 'utf8', windowsVerbatimArguments: true }).trim() || null;
  } catch {
    return null;
  }
}

async function ok<T>(req: Parameters<typeof handleGitView>[0]): Promise<T> {
  const res = await handleGitView(req) as GitViewResult<T>;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

describe('git-view: a repository with a linked worktree', () => {
  let tmp: string;
  let repo: string;
  let wtPath: string;

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gitview-')));
    // A long name with a space, so Windows gives it a different 8.3 short
    // name — the spelling the GitHub runner's own temp dir arrives in.
    repo = path.join(tmp, 'repository with a long name');
    fs.mkdirSync(repo);
    run(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'second on main');

    // An agent's worktree INSIDE the main tree, branched at "first".
    wtPath = path.join(repo, '.worktrees', 'agent');
    run(repo, 'worktree', 'add', '-q', '-b', 'agent/work', wtPath, 'HEAD~1');
    fs.writeFileSync(path.join(wtPath, 'a.txt'), 'one\nTWO\nthree\n');
    run(wtPath, 'commit', '-q', '-am', 'agent edit');

    // A commit on main AFTER the fork: must not show up as the agent's work.
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    run(repo, 'add', 'c.txt');
    run(repo, 'commit', '-q', '-m', 'third on main');

    // Uncommitted work in the agent's tree: staged, unstaged and untracked.
    fs.writeFileSync(path.join(wtPath, 'staged.txt'), 's\n');
    run(wtPath, 'add', 'staged.txt');
    fs.appendFileSync(path.join(wtPath, 'a.txt'), 'four\n');
    fs.writeFileSync(path.join(wtPath, 'new file.txt'), 'x\ny\n');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const agentPath = async () => {
    const info = await ok<GitRepoInfo>({ op: 'repo', cwd: repo });
    return info.worktrees.find((w) => w.branch === 'agent/work')!.path;
  };

  it('lists both worktrees with their summaries, from inside either one', async () => {
    const fromWt = await ok<GitRepoInfo>({ op: 'repo', cwd: wtPath });
    expect(fromWt.worktrees).toHaveLength(2);
    const [main, agent] = fromWt.worktrees;
    expect(main.primary).toBe(true);
    expect(main.branch).toBe('main');
    expect(main.summary).toMatchObject({ staged: 0, unstaged: 0 });
    expect(agent.branch).toBe('agent/work');
    expect(agent.summary).toMatchObject({ staged: 1, unstaged: 1, untracked: 1 });
    expect(fromWt.refs.local.sort()).toEqual(['agent/work', 'main']);
    expect(fromWt.defaultBase).toBe('main');
  });

  it('splits working changes into staged / unstaged / untracked', async () => {
    const changes = await ok<GitWorkingChanges>({ op: 'working', cwd: repo, worktree: await agentPath() });
    expect(changes.staged.map((f) => [f.path, f.status])).toEqual([['staged.txt', 'added']]);
    expect(changes.unstaged.map((f) => [f.path, f.additions])).toEqual([['a.txt', 1]]);
    expect(changes.untracked.map((f) => f.path)).toEqual(['new file.txt']);
    const diff = await ok<string>({ op: 'workingDiff', cwd: repo, worktree: await agentPath(), file: 'new file.txt', section: 'untracked' });
    expect(diff).toContain('+y');
  });

  it('measures branch changes from the merge base, so main’s later commits are not the agent’s', async () => {
    const branch = await ok<GitBranchChanges>({ op: 'branch', cwd: repo, worktree: await agentPath(), base: 'main' });
    expect(branch.commits.map((c) => c.subject)).toEqual(['agent edit']);
    expect(branch.files.map((f) => [f.path, f.additions, f.deletions])).toEqual([['a.txt', 1, 1]]);
    const diff = await ok<string>({ op: 'rangeDiff', cwd: repo, from: branch.mergeBase!, to: branch.head, file: 'a.txt' });
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
    expect(diff).not.toContain('four'); // uncommitted stays out of the branch review
  });

  it('draws one graph across worktrees and opens a commit', async () => {
    const { commits } = await ok<{ commits: GitCommit[] }>({ op: 'graph', cwd: repo, worktree: repo, scope: 'all', limit: 100 });
    expect(commits.map((c) => c.subject).sort()).toEqual(['agent edit', 'first', 'second on main', 'third on main']);
    const own = await ok<{ commits: GitCommit[] }>({ op: 'graph', cwd: repo, worktree: await agentPath(), scope: 'worktree', limit: 100 });
    expect(own.commits.map((c) => c.subject)).toEqual(['agent edit', 'first']);

    const root = commits.find((c) => c.subject === 'first')!;
    const details = await ok<GitCommitDetails>({ op: 'commit', cwd: repo, hash: root.hash });
    expect(details.files.map((f) => f.path)).toEqual(['a.txt']); // root commit diffs against the empty tree
    const cmp = await ok<GitFileChange[]>({ op: 'compare', cwd: repo, from: root.hash, to: commits[0].hash });
    expect(cmp.length).toBeGreaterThan(0);
  });

  it('refuses a worktree git does not list, and an option smuggled in as a base', async () => {
    const outside = await handleGitView({ op: 'working', cwd: repo, worktree: tmp });
    expect(outside).toMatchObject({ ok: false, code: 'invalid' });
    const option = await handleGitView({ op: 'branch', cwd: repo, worktree: repo, base: '--output=pwned' });
    expect(option).toMatchObject({ ok: false, code: 'invalid' });
    expect(fs.existsSync(path.join(repo, 'pwned'))).toBe(false);
  });

  it('recognises a worktree named by its 8.3 short path (CI runners, long profile names)', async () => {
    if (process.platform !== 'win32') return;
    const short = shortPath(repo);
    if (!short || short.toLowerCase() === repo.toLowerCase()) return; // 8.3 names disabled on this volume
    const changes = await ok<GitWorkingChanges>({ op: 'working', cwd: short, worktree: short });
    expect(changes.untracked.map((f) => f.path)).toContain('.worktrees/');
  });

  it('answers not_repo outside a repository, never throws', async () => {
    const res = await handleGitView({ op: 'repo', cwd: tmp });
    expect(res).toMatchObject({ ok: false, code: 'not_repo' });
  });
});

describe('git-view: git for folders on a WSL share', () => {
  const REPO = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo';
  const WIN_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
  const winGit = () => WIN_GIT;

  it('parses both slash spellings and rejects lookalikes', () => {
    const want = { distro: 'Ubuntu-24.04', posix: '/home/me/repo' };
    expect(parseWslUnc(REPO)).toEqual(want);
    expect(parseWslUnc('//wsl.localhost/Ubuntu-24.04/home/me/repo/')).toEqual(want);
    expect(parseWslUnc('\\\\WSL$\\Ubuntu\\home\\me')).toEqual({ distro: 'Ubuntu', posix: '/home/me' });
    expect(parseWslUnc('\\\\wsl.localhost\\Ubuntu')).toEqual({ distro: 'Ubuntu', posix: '/' });
    for (const p of ['C:\\repo', '\\\\server\\share\\repo', '\\\\wsl.localhost\\', '\\\\wsl.localhostx\\d\\r', '/home/me', '']) {
      expect(parseWslUnc(p)).toBeNull();
    }
  });

  it('turns a POSIX path git printed back into a Windows path', () => {
    expect(wslPathToWindows('Ubuntu-24.04', '/home/me/repo')).toBe(REPO);
    expect(wslPathToWindows('Ubuntu', '/mnt/c/Users/me')).toBe('C:\\Users\\me');
    expect(wslPathToWindows('Ubuntu', '/mnt/d')).toBe('D:\\');
    expect(fromGitPath(REPO, '/home/me/repo/wt')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo\\wt');
    expect(fromGitPath(REPO, 'relative/path')).toBe('relative/path');
    expect(fromGitPath('C:\\repo', '/home/me')).toBe('/home/me');
  });

  it('runs Windows git unchanged outside a WSL share', () => {
    const cmd = gitCommand('C:\\repo', ['status'], { GIT_OPTIONAL_LOCKS: '0' }, winGit);
    expect(cmd.file).toBe(WIN_GIT);
    expect(cmd.args).toEqual(['status']);
    expect(cmd.cwd).toBe('C:\\repo');
    expect(cmd.env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(cmd.env.WSLENV).toBe(process.env.WSLENV);
  });

  it('runs git inside the distro with no config flags and no shell', () => {
    const cmd = gitCommand(`${REPO}\\src`, ['status', '--porcelain'], {}, () => { throw new Error('must not look up Windows git'); });
    expect(cmd.file.toLowerCase()).toMatch(/system32[\\/]wsl\.exe$/);
    expect(cmd.args).toEqual(['-d', 'Ubuntu-24.04', '--cd', '/home/me/repo/src', '--exec', 'git', 'status', '--porcelain']);
    expect(cmd.args.join(' ')).not.toMatch(/safe\.directory|core\.filemode|core\.symlinks/);
    expect(cmd.cwd).not.toBe(REPO);
  });

  it('forwards extra variables through WSLENV without duplicating', () => {
    const saved = process.env.WSLENV;
    try {
      process.env.WSLENV = 'FOO/p:GIT_TERMINAL_PROMPT';
      const { env } = gitCommand(REPO, ['log'], { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
      expect(env.WSLENV).toBe('FOO/p:GIT_TERMINAL_PROMPT:GIT_OPTIONAL_LOCKS');
    } finally {
      if (saved === undefined) delete process.env.WSLENV; else process.env.WSLENV = saved;
    }
  });
});
