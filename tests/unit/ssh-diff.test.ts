import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { diffTargetFor, remoteChangedFiles, remoteFileDiff } from '../../src/main/ssh-diff';
import { resetDiffCaches } from '../../src/main/diff-provider';
import { handleGitView } from '../../src/main/git-view';
import { SSH_UNREACHABLE_MESSAGE, type SshGitContext } from '../../src/main/ssh-git';
import { parseSshTarget, resetSshTargets, setSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import type { GitWorkingChanges } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * The Diff tab for a remote workspace. `diffTargetFor` is pure over a fake
 * window; the rest runs real git in throwaway repositories behind a fake `ssh`
 * that hands the command string to a local `sh` (as ssh-git.test.ts does).
 */
function target(repoPath: string): SshTarget {
  const parsed = parseSshTarget(['ssh', 'dev@box'], repoPath);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

function fakeWindow(answer: unknown, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { executeJavaScript: vi.fn(async () => answer) },
  };
}

describe('diffTargetFor', () => {
  beforeEach(() => resetSshTargets());

  it('resolves the target of the workspace the SENDER window holds the surface in', async () => {
    const t = target('/w/repo');
    setSshTarget('ws-1', t);
    const win = fakeWindow('ws-1');
    expect(await diffTargetFor('surf-diff', win)).toBe(t);
    expect(win.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it('is undefined (the local path) for a surface the sender window does not hold', async () => {
    setSshTarget('ws-1', target('/w/repo'));
    expect(await diffTargetFor('surf-of-another-window', fakeWindow(null))).toBeUndefined();
  });

  it('is undefined for a workspace without a target, a missing window, or a bad surface id', async () => {
    setSshTarget('ws-1', target('/w/repo'));
    expect(await diffTargetFor('surf-x', fakeWindow('ws-2'))).toBeUndefined();
    expect(await diffTargetFor('surf-x', null)).toBeUndefined();
    expect(await diffTargetFor('surf-x', undefined)).toBeUndefined();
    for (const bad of [undefined, null, '', 7, {}]) expect(await diffTargetFor(bad, fakeWindow('ws-1'))).toBeUndefined();
  });

  it('does not ask the renderer while no target is registered at all (every local poll)', async () => {
    const win = fakeWindow('ws-1');
    expect(await diffTargetFor('surf-x', win)).toBeUndefined();
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasPosixTools(['git']))('diff of a remote checkout, git run through a local sh', () => {
  let tmp: string;
  let repo: string;
  let localOnly: string;
  let plain: string;
  let fakeSsh: string;
  let deadSsh: string;

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-diff-');
    fakeSsh = path.join(tmp, 'fake-ssh');
    fs.writeFileSync(fakeSsh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n', { mode: 0o755 });
    deadSsh = path.join(tmp, 'dead-ssh');
    fs.writeFileSync(deadSsh, '#!/bin/sh\nexit 255\n', { mode: 0o755 });

    repo = path.join(tmp, 'remote checkout');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'gone.txt'), 'bye\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'three\n');
    fs.rmSync(path.join(repo, 'gone.txt'));
    fs.writeFileSync(path.join(repo, 'new file.txt'), 'x\ny\n');
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, 'docs', 'n.md'), '# n\n');
    fs.writeFileSync(path.join(tmp, 'outside-secret.txt'), 'TOP SECRET\n');

    // A DIFFERENT repo with its own change: what the renderer's cwd would show if it were used.
    localOnly = path.join(tmp, 'local only');
    fs.mkdirSync(localOnly);
    git(localOnly, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(localOnly, 'l.txt'), 'l\n');
    git(localOnly, 'add', '.');
    git(localOnly, 'commit', '-q', '-m', 'local');
    fs.appendFileSync(path.join(localOnly, 'l.txt'), 'edited locally\n');

    plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    resetDiffCaches();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => vi.restoreAllMocks();
  });

  const tool = (exe: string): SshGitContext['tool'] => () => exe;

  it('lists the checkout\'s changes: modified, deleted, untracked (with counts) and untracked in a folder', async () => {
    const res = await remoteChangedFiles(target(repo), undefined, tool(fakeSsh));
    if (!('files' in res)) throw new Error(res.error);
    const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', additions: 1 });
    expect(byPath['gone.txt']).toMatchObject({ status: 'deleted' });
    expect(byPath['new file.txt']).toMatchObject({ status: 'added', additions: 2 });
    // `status -unormal` folds an untracked folder into one entry, as it does locally.
    expect(Object.keys(byPath)).toContain('docs/');
    // The other repository (what a renderer cwd would have shown) is never read.
    expect(Object.keys(byPath)).not.toContain('l.txt');
  });

  it('diffs a tracked, a deleted and an untracked file, read on the remote host', async () => {
    const t = target(repo);
    expect(await remoteFileDiff(t, 'a.txt', undefined, tool(fakeSsh))).toEqual({ diff: expect.stringContaining('+three') });
    expect(await remoteFileDiff(t, 'gone.txt', undefined, tool(fakeSsh))).toEqual({ diff: expect.stringContaining('-bye') });
    const added = await remoteFileDiff(t, 'new file.txt', undefined, tool(fakeSsh));
    expect(added).toEqual({ diff: expect.stringContaining('+++ b/new file.txt') });
    expect(await remoteFileDiff(t, 'docs/n.md', undefined, tool(fakeSsh))).toEqual({ diff: expect.stringContaining('+# n') });
  });

  it('refuses a file that is not a relative path below the checkout, so no remote file can be read through it', async () => {
    const t = target(repo);
    for (const bad of ['', '/etc/passwd', `${tmp}/outside-secret.txt`, '../outside-secret.txt', 'docs/../../outside-secret.txt', 'a\0b', undefined, 5]) {
      const res = await remoteFileDiff(t, bad, undefined, tool(fakeSsh));
      expect(res, String(bad)).toMatchObject({ error: expect.any(String), code: expect.stringMatching(/invalid_path|outside_root/) });
      expect(JSON.stringify(res)).not.toContain('TOP SECRET');
    }
  });

  it('answers an empty diff for a path git has no change for', async () => {
    expect(await remoteFileDiff(target(repo), 'nope.txt', undefined, tool(fakeSsh))).toEqual({ diff: '' });
  });

  it('an unreachable remote host is an error with the fixed sentence, never an empty list or diff', async () => {
    const fixed = { error: SSH_UNREACHABLE_MESSAGE, code: 'ssh-unreachable' };
    expect(await remoteChangedFiles(target(repo), undefined, tool(deadSsh))).toEqual(fixed);
    expect(await remoteFileDiff(target(repo), 'a.txt', undefined, tool(deadSsh))).toEqual(fixed);
  });

  it('a host with no ssh executable cannot reach the remote host either: an error, never "no changes"', async () => {
    const none: SshGitContext['tool'] = () => { throw new Error('matching ssh executable not found'); };
    const fixed = { error: SSH_UNREACHABLE_MESSAGE, code: 'ssh-unreachable' };
    expect(await remoteChangedFiles(target(repo), undefined, none)).toEqual(fixed);
    expect(await remoteFileDiff(target(repo), 'a.txt', undefined, none)).toEqual(fixed);
  });

  it('a remote path that is not a repository has no changes, and the local disk is not walked', async () => {
    expect(await remoteChangedFiles(target(plain), undefined, tool(fakeSsh))).toEqual({ files: [] });
    expect(await remoteFileDiff(target(plain), 'x.txt', undefined, tool(fakeSsh))).toEqual({ diff: '' });
  });

  it('the Git pane\'s working-tree view agrees with the Diff tab for the same target', async () => {
    const t = target(repo);
    const diff = await remoteChangedFiles(t, undefined, tool(fakeSsh));
    if (!('files' in diff)) throw new Error(diff.error);
    const res = await handleGitView(
      { op: 'working', cwd: '/nonexistent/local/folder', worktree: repo },
      { target: t, tool: tool(fakeSsh) },
    );
    if (!res.ok) throw new Error(res.error);
    const working = res.data as GitWorkingChanges;
    const shown = [...working.staged, ...working.unstaged, ...working.untracked].map((f) => f.path).sort();
    expect(shown).toEqual(diff.files.map((f) => f.path).sort());
    expect(shown.length).toBeGreaterThan(0);
  });
});
