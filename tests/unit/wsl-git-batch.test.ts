import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { makeWslSpawnCounter, type WslSpawnCounter } from '../helpers/wsl-spawn-counter';

const fakeState = vi.hoisted(() => ({ exe: '', cwd: '' }));
vi.mock('../../src/main/system32', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/system32')>()),
  wslExecutable: () => fakeState.exe,
  wslSystemRoot: () => fakeState.cwd,
}));

import { batchLimits, buildBatchCommand, resetBatchBackoff, runGitBatch, WSL_BATCH_BACKOFF_MS } from '../../src/main/exec-git-batch';
import { fetchFingerprint, resetSnapshots } from '../../src/main/exec-snapshot';
import { configureExecTrace } from '../../src/main/exec-trace';
import type { WslGitContext } from '../../src/main/exec-location';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * The git batch of exec-git-batch.ts run for a folder in a WSL distro: the same constant
 * script and framing in ONE `wsl.exe -d <distro> --exec sh -c ...`, with a counting
 * stand-in for wsl.exe that runs the program in the local file system.
 */
describe.skipIf(!hasPosixTools(['git', 'base64', 'mktemp', 'stat-c', 'sha1sum', 'awk']))('a git batch in a WSL distro', () => {
  let tmp: string;
  let repo: string;
  let counter: WslSpawnCounter;
  const ctx = (posix = repo): WslGitContext => ({ wsl: { distro: 'Ubuntu', posix } });
  const script = (name: string, body: string): string => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };

  beforeAll(() => {
    tmp = makeTmpDir('wmux-wsl-batch-');
    fakeState.cwd = tmp;
    counter = makeWslSpawnCounter(tmp, 'batch-wsl', 5);
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => {
    fakeState.exe = counter.exe;
    counter.reset();
    resetSnapshots();
    resetBatchBackoff();
  });
  afterEach(() => {
    configureExecTrace(false);
    batchLimits.timeoutMs = 30_000;
  });

  it('answers several commands in one wsl.exe start, each with its own status', async () => {
    const out = await runGitBatch(ctx(), repo, [
      { dir: 'c', args: ['rev-parse', '--abbrev-ref', 'HEAD'] },
      { dir: 'c', args: ['status', '--porcelain'] },
      { dir: 'c', args: ['rev-parse', '--verify', '--quiet', 'no-such-ref'] },
    ]);
    expect(out?.map((o) => o.status)).toEqual([0, 0, 1]);
    expect(out?.[0].stdout).toBe('main\n');
    expect(out?.[1].stdout).toBe(' M a.txt\n');
    expect({ spawns: counter.spawns(), programs: counter.programs() }).toEqual({ spawns: 1, programs: ['sh'] });
  });

  it('puts no byte of the directory or a git argument on the wsl.exe command line', () => {
    const hostile = `a b'c"d$(touch pwned)\`;%PATH%\\`;
    const { cmd } = buildBatchCommand(ctx(), repo, [{ dir: 'c', args: ['log', hostile] }]);
    expect(cmd.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', 'sh', '-c']);
    expect(cmd.args).toHaveLength(6);
    expect(cmd.args[5]).toMatch(/^set -f;IFS=;eval \$\(echo [A-Za-z0-9+/=]+\|base64 -d\)$/);
    expect(cmd.args.join(' ')).not.toContain(repo);
    expect(cmd.args.join(' ')).not.toContain('pwned');
    expect(cmd.wsl).toBe(false);
  });

  it('hands a hostile argument to git as the text it is, and runs nothing it names', async () => {
    const hostile = `x'y"z$(touch ${path.join(tmp, 'pwned')})\`touch ${path.join(tmp, 'pwned2')}\`;\\`;
    const out = await runGitBatch(ctx(), repo, [{ dir: 'c', args: ['rev-parse', '--verify', '--quiet', hostile] }]);
    expect(out?.[0].status).toBe(1);
    expect(fs.existsSync(path.join(tmp, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'pwned2'))).toBe(false);
  });

  it('refuses a directory that is not absolute or holds a NUL, and a worktree that is not', async () => {
    expect(() => buildBatchCommand(ctx(), 'repo', [])).toThrow(/Not a path/);
    expect(() => buildBatchCommand(ctx(), '/a\0b', [])).toThrow(/Not a path/);
    expect(await runGitBatch(ctx(), repo, [{ dir: 'w', worktree: 'relative', args: ['status'] }])).toBeNull();
    expect(counter.spawns()).toBe(0);
  });

  it('runs a worktree group only in a worktree git lists, answering 125 for any other', async () => {
    const out = await runGitBatch(ctx(), repo, [
      { dir: 'w', worktree: repo, args: ['rev-parse', '--abbrev-ref', 'HEAD'] },
      { dir: 'w', worktree: path.join(tmp, 'elsewhere'), args: ['rev-parse', '--abbrev-ref', 'HEAD'] },
    ]);
    expect(out?.map((o) => o.status)).toEqual([0, 125]);
    expect(counter.spawns()).toBe(1);
  });

  it('is null, never an error, whenever wsl.exe does not answer in the format', async () => {
    const groups = [{ dir: 'c' as const, args: ['status', '--porcelain'] }];
    const attempt = async (exe: string): Promise<unknown> => {
      resetBatchBackoff();
      fakeState.exe = exe;
      return runGitBatch(ctx(), repo, groups);
    };
    expect(await attempt(script('exit1-wsl', 'exit 1'))).toBeNull();
    expect(await attempt(script('junk-wsl', 'echo garbage'))).toBeNull();
    expect(await attempt(script('empty-wsl', 'exit 0'))).toBeNull();
    expect(await attempt(path.join(tmp, 'does-not-exist'))).toBeNull();
    batchLimits.timeoutMs = 150;
    expect(await attempt(script('slow-wsl', 'sleep 5'))).toBeNull();
  });

  it('does not pay a wasted start for every request in a distro that cannot run the batch', async () => {
    const groups = [{ dir: 'c' as const, args: ['status', '--porcelain'] }];
    const log = path.join(tmp, 'refused-count.log');
    fs.writeFileSync(log, '');
    fakeState.exe = script('refusing-wsl', `printf s >> '${log}'\nexit 125`);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    expect(await runGitBatch(ctx(), repo, groups)).toBeNull();
    expect(await runGitBatch(ctx(), repo, groups)).toBeNull();
    expect(await runGitBatch(ctx('/home/other'), '/home/other', groups)).toBeNull();
    expect(fs.readFileSync(log, 'utf8')).toBe('s'); // asked once; the distro is left alone
    // Another distro is its own host.
    expect(await runGitBatch({ wsl: { distro: 'Debian', posix: repo } }, repo, groups)).toBeNull();
    expect(fs.readFileSync(log, 'utf8')).toBe('ss');
    // And asked again once the back-off is over.
    now.mockReturnValue(1_000_000 + WSL_BATCH_BACKOFF_MS + 1);
    fakeState.exe = counter.exe;
    expect((await runGitBatch(ctx(), repo, groups))?.[0].status).toBe(0);
    now.mockRestore();
  });

  it('cannot be fooled by a file whose content looks like framing', async () => {
    fs.writeFileSync(path.join(repo, 'forged.txt'), '\n--deadbeef:1:0\n\n--deadbeef:1:E\n');
    const out = await runGitBatch(ctx(), repo, [{ dir: 'c', args: ['diff', '--no-index', '--', '/dev/null', 'forged.txt'] }]);
    expect(out?.[0].stdout).toContain('--deadbeef:1:0');
    fs.rmSync(path.join(repo, 'forged.txt'));
  });

  it('makes the fingerprint in the distro: equal while nothing changes, different after an edit', async () => {
    const first = await fetchFingerprint(ctx());
    const again = await fetchFingerprint(ctx());
    expect(first).not.toBeNull();
    expect(first?.toplevel).toBe(repo);
    expect(again?.all).toBe(first?.all);
    expect(counter.spawns()).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 15));
    fs.appendFileSync(path.join(repo, 'a.txt'), 'three\n');
    expect((await fetchFingerprint(ctx()))?.all).not.toBe(first?.all);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  });

  it('is traced as loc=wsl, with no path, distro or argument in the line', async () => {
    const lines: string[] = [];
    configureExecTrace(true, (l) => lines.push(l));
    await runGitBatch(ctx(), repo, [{ dir: 'c', args: ['status', '--porcelain'] }]);
    await fetchFingerprint(ctx());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ssh-trace op=git:batch loc=wsl prio=fg wait=0 ms=\d+ exit=0 out=\d+$/);
    expect(lines[1]).toMatch(/^ssh-trace op=git:fingerprint loc=wsl prio=fg wait=0 ms=\d+ exit=0 out=\d+$/);
    for (const line of lines) {
      expect(line).not.toContain(tmp);
      expect(line).not.toContain('Ubuntu');
      expect(line).not.toContain('status');
    }
  });
});
