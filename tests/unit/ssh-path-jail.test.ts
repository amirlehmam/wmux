import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { handleGitView } from '../../src/main/git-view';
import { resetDiffCaches, untrackedFileDiffAny } from '../../src/main/diff-provider';
import { remoteFileDiff } from '../../src/main/ssh-diff';
import { canonicalRemoteRelPath, remoteRelSegments } from '../../src/main/ssh-path';
import { runWithSshGit, type SshGitContext } from '../../src/main/ssh-git';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import { makeSpawnCounter, type SpawnCounter } from '../helpers/ssh-spawn-counter';
import { git, makeTmpDir } from '../helpers/git-repo';
import { hasPosixTools } from '../helpers/posix-tools';

/**
 * A renderer-supplied file path that reaches a remote host's git. The untracked
 * branch runs `git diff --no-index -- /dev/null <file>`, which reads ANY file the
 * remote account can, so a path that climbs out of the checkout must be refused
 * before a process is started, whether the request is batched or not.
 *
 * The refusal tests start nothing: the ssh `tool` is a spy that must never be asked
 * for an executable, which is the step before every spawn.
 */
const target = (): SshTarget => {
  const parsed = parseSshTarget(['ssh', 'dev@box'], '/srv/checkout');
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
};

const HOSTILE_PATHS: Array<[string, string]> = [
  ['a parent segment', '../secret'],
  ['a climb to the account\'s home', '../../../../home/u/.ssh/id_rsa'],
  ['a climb in the middle', 'a/../../b'],
  ['a climb that comes back in', 'a/../a'],
  ['a leading ./', './a.txt'],
  ['a dot segment', 'a/./b.txt'],
  ['an empty segment', 'a//b.txt'],
  ['a backslash climb', '..\\..\\secret'],
  ['a backslash climb below a folder', 'a\\..\\..\\secret'],
  ['a NUL', 'a\0.txt'],
  ['an absolute path', '/etc/passwd'],
  ['an empty path', ''],
  ['only a slash', '/'],
  ['a path that is not a string', undefined as unknown as string],
];

describe('canonicalRemoteRelPath', () => {
  it.each(HOSTILE_PATHS)('refuses %s', (_name, file) => {
    expect(canonicalRemoteRelPath(file)).toBeNull();
  });

  it.each([
    'a.txt',
    'sub/dir/a b.txt',
    '--dash.txt',
    'new\nline.txt',
    "it's \"quoted\".txt",
    'back\\slash.txt',
    'folder/', // git's spelling of an untracked folder
    '.hidden/.also',
    '...',
  ])('keeps %j as it is', (file) => {
    expect(canonicalRemoteRelPath(file)).toBe(file);
  });

  it('refuses a path longer than a path can be', () => {
    expect(canonicalRemoteRelPath('a/'.repeat(2049))).toBeNull();
  });

  it('is the rule the explorer shares: its segments fold what this one refuses, but both refuse a climb', () => {
    expect(remoteRelSegments('../x')).toMatchObject({ code: 'outside_root' });
    expect(remoteRelSegments('./a//b')).toEqual(['a', 'b']);
  });
});

describe('a remote request with a path outside the checkout starts no process', () => {
  let asked: number;
  let context: SshGitContext;
  beforeEach(() => {
    asked = 0;
    resetDiffCaches();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    context = { target: target(), tool: () => { asked += 1; return '/nonexistent/ssh'; } };
    return () => vi.restoreAllMocks();
  });

  describe.each(HOSTILE_PATHS.filter(([, file]) => typeof file === 'string'))('%s', (_name, file) => {
    it.each(['untracked', 'staged', 'unstaged'] as const)('git view, %s section', async (section) => {
      const res = await handleGitView(
        { op: 'workingDiff', cwd: '/ignored', worktree: '/srv/checkout', file, section }, context);
      expect(res).toMatchObject({ ok: false, code: 'invalid' });
      expect(asked).toBe(0);
    });

    it('git view, a commit range', async () => {
      const hash = 'a'.repeat(40);
      const res = await handleGitView({ op: 'rangeDiff', cwd: '/ignored', from: '', to: hash, file }, context);
      expect(res).toMatchObject({ ok: false, code: 'invalid' });
      expect(asked).toBe(0);
    });

    it('the diff tab', async () => {
      const res = await remoteFileDiff(context.target, file, undefined, context.tool);
      expect(res).toMatchObject({ code: 'invalid_path' });
      expect(asked).toBe(0);
    });
  });

  it('a commit range refuses the old path of a rename the same way', async () => {
    const res = await handleGitView(
      { op: 'rangeDiff', cwd: '/ignored', from: '', to: 'b'.repeat(40), file: 'ok.txt', oldPath: '../../x' }, context);
    expect(res).toMatchObject({ ok: false, code: 'invalid' });
    expect(asked).toBe(0);
  });

  it('the diff provider itself does not hand an outside path to git on the remote host', async () => {
    const run = vi.fn(async () => 'SHOWN');
    await runWithSshGit(context, async () => {
      expect(await untrackedFileDiffAny('/srv/checkout', '../../etc/passwd', run)).toBe('');
      expect(run).not.toHaveBeenCalled();
      expect(await untrackedFileDiffAny('/srv/checkout', 'sub/new.txt', run)).toBe('SHOWN');
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});

describe.skipIf(!hasPosixTools(['git', 'base64', 'mktemp', 'head']))('a normal nested untracked file is still diffed', () => {
  let tmp: string;
  let repo: string;
  let batched: SpawnCounter;
  let unbatched: SpawnCounter;

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-jail-');
    batched = makeSpawnCounter(tmp, 'batched-ssh', 0);
    unbatched = makeSpawnCounter(tmp, 'unbatched-ssh', 0, true);
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    fs.mkdirSync(path.join(repo, 'sub dir'));
    fs.writeFileSync(path.join(repo, 'sub dir', 'new.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'top secret\n');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => {
    resetDiffCaches();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => vi.restoreAllMocks();
  });

  const ask = (tool: string, file: string) => {
    const parsed = parseSshTarget(['ssh', 'dev@box'], repo);
    if ('error' in parsed) throw new Error(parsed.error);
    return handleGitView(
      { op: 'workingDiff', cwd: '/ignored', worktree: repo, file, section: 'untracked' },
      { target: parsed, tool: () => tool });
  };

  it.each([['batched', () => batched.tool], ['unbatched', () => unbatched.tool]] as const)(
    'shows it (%s), and a climb to the sibling file shows nothing',
    async (_name, tool) => {
      const shown = await ask(tool(), 'sub dir/new.txt');
      expect(shown).toMatchObject({ ok: true });
      expect((shown as { data: string }).data).toContain('+x');
      const climbed = await ask(tool(), '../secret.txt');
      expect(climbed).toMatchObject({ ok: false, code: 'invalid' });
      expect(JSON.stringify(climbed)).not.toContain('top secret');
    },
  );
});
