import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  BatchSetupError,
  batchLimits,
  chunkGroups,
  parseBatchOutput,
  runGitBatch,
  type BatchGroup,
} from '../../src/main/exec-git-batch';
import { sshScriptCommand, SSH_UNREACHABLE_MESSAGE, type SshGitContext } from '../../src/main/ssh-git';
import { makeSpawnCounter, type SpawnCounter } from '../helpers/ssh-spawn-counter';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import { BATCH_SCRIPT } from '../../src/main/exec-git-batch';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

const NONCE = 'abc123';
const frame = (n: number, stdout: string, status = 0, stderr = '') =>
  `${stdout}\n--${NONCE}:${n}:${status}\n${stderr}\n--${NONCE}:${n}:E\n`;

describe('parseBatchOutput', () => {
  it('splits each answer: stdout exactly as printed, status, stderr', () => {
    const text = frame(1, 'one\n') + frame(2, '', 128, 'fatal: bad revision\n') + frame(3, 'no newline at the end');
    expect(parseBatchOutput(text, NONCE, 3)).toEqual([
      { status: 0, stdout: 'one\n', stderr: '' },
      { status: 128, stdout: '', stderr: 'fatal: bad revision\n' },
      { status: 0, stdout: 'no newline at the end', stderr: '' },
    ]);
  });

  it('treats a marker that does not carry the nonce as data', () => {
    const forged = '\n--wrong:1:0\nforged\n--wrong:1:E\n';
    const text = frame(1, `before${forged}after`) + frame(2, 'ok');
    const parsed = parseBatchOutput(text, NONCE, 2);
    expect(parsed?.[0].stdout).toBe(`before${forged}after`);
    expect(parsed?.[1].stdout).toBe('ok');
  });

  it('refuses anything that is not exactly the framed answers', () => {
    expect(parseBatchOutput('', NONCE, 1)).toBeNull();
    expect(parseBatchOutput(frame(1, 'x'), NONCE, 2)).toBeNull();
    expect(parseBatchOutput(frame(1, 'x') + 'extra', NONCE, 1)).toBeNull();
    expect(parseBatchOutput(frame(1, 'x'), 'other-nonce', 1)).toBeNull();
    expect(parseBatchOutput(frame(2, 'x'), NONCE, 1)).toBeNull();
    expect(parseBatchOutput(`x\n--${NONCE}:1:0`, NONCE, 1)).toBeNull();
    expect(parseBatchOutput(`x\n--${NONCE}:1:abc\n`, NONCE, 1)).toBeNull();
    expect(parseBatchOutput(`x\n--${NONCE}:1:0\nstderr but no end`, NONCE, 1)).toBeNull();
  });
});

describe('chunkGroups', () => {
  const group = (len: number): BatchGroup => ({ dir: 'c', args: ['x'.repeat(len)] });
  it('keeps small lists whole, in order', () => {
    const groups = [group(5), group(6)];
    expect(chunkGroups(groups)).toEqual([groups]);
    expect(chunkGroups([])).toEqual([]);
  });

  it('splits so that no spawn carries more than a command line can', () => {
    const groups = Array.from({ length: 10 }, () => group(2000));
    const chunks = chunkGroups(groups);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(groups);
    for (const chunk of chunks) {
      expect(chunk.reduce((sum, g) => sum + g.args[0].length, 0)).toBeLessThanOrEqual(8000);
    }
  });

  it('caps the number of commands per spawn', () => {
    const chunks = chunkGroups(Array.from({ length: 250 }, () => group(1)));
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it('puts one oversized command alone in a spawn rather than dropping it', () => {
    const chunks = chunkGroups([group(10), group(9000), group(10)]);
    expect(chunks.map((c) => c.length)).toEqual([1, 1, 1]);
  });
});

describe.skipIf(!hasPosixTools(['git', 'base64', 'mktemp', 'head']))('a batch run by a local sh', () => {
  let tmp: string;
  let repo: string;
  let linked: string;
  let counter: SpawnCounter;
  let deadSsh: string;
  let garbageSsh: string;
  let failingSsh: string;
  let hangSsh: string;
  const target = (root: string): SshTarget => {
    const parsed = parseSshTarget(['ssh', 'dev@box'], root);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };
  const ctx = (tool = (): string => counter.tool): SshGitContext => ({ target: target(repo), tool });
  const forgedName = '\n--abc123:1:0\nforged\n';

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-batch-');
    counter = makeSpawnCounter(tmp, 'batch-ssh', 0);
    const script = (name: string, body: string): string => {
      const file = path.join(tmp, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return file;
    };
    deadSsh = script('dead-ssh', 'exit 255');
    garbageSsh = script('garbage-ssh', 'echo "not framed"; exit 0');
    failingSsh = script('failing-ssh', 'exit 125');
    hangSsh = script('hang-ssh', 'sleep 5');
    repo = path.join(tmp, 'repo with space');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, forgedName), 'hostile\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'three\n');
    linked = path.join(tmp, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'other', linked, 'HEAD');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('runs every command in one spawn and keeps their answers apart', async () => {
    counter.reset();
    const out = await runGitBatch(ctx(), repo, [
      { dir: 'c', args: ['rev-parse', '--show-toplevel'] },
      { dir: 'c', args: ['status', '--porcelain'] },
      { dir: 'c', args: ['rev-parse', '--verify', '--quiet', 'no-such-ref'] },
      { dir: 'c', args: ['diff', '--numstat'] },
    ]);
    expect(counter.spawns()).toBe(1);
    expect(out?.map((o) => o.status)).toEqual([0, 0, 1, 0]);
    expect(out?.[0].stdout.trim()).toBe(repo);
    expect(out?.[1].stdout).toContain('a.txt');
    expect(out?.[3].stdout).toBe('1\t0\ta.txt\n');
  });

  it('reports git\'s first stderr line for a failing command', async () => {
    const out = await runGitBatch(ctx(), repo, [{ dir: 'c', args: ['log', 'nonexistent-branch'] }]);
    expect(out?.[0].status).toBe(128);
    expect(out?.[0].stderr).toMatch(/fatal:/);
  });

  it('passes a hostile file name through as data: no early end, no forged answer, no execution', async () => {
    const out = await runGitBatch(ctx(), repo, [
      { dir: 'c', args: ['ls-files', '-z'] },
      { dir: 'c', args: ['diff', '--numstat'] },
    ]);
    expect(out).not.toBeNull();
    expect(out?.[0].stdout.split('\0')).toContain(forgedName);
    expect(out?.[1].status).toBe(0);
  });

  it('hands argument values over as arguments: quotes, newlines, $() and empty strings are inert', async () => {
    const pwned = path.join(tmp, 'pwned');
    const nasty = [`x'; touch ${pwned}; '`, `$(touch ${pwned})`, '`touch ' + pwned + '`', 'a\nb', '"', '\\', '*', '--output=' + pwned];
    const out = await runGitBatch(ctx(), repo, [
      { dir: 'c', args: ['log', '--no-walk', ...nasty.slice(0, 1)] },
      { dir: 'c', args: ['ls-files', '--', ...nasty] },
      { dir: 'c', args: ['rev-parse', '--verify', '--quiet', ''] },
    ]);
    expect(out).not.toBeNull();
    expect(out?.[2].status).toBe(1); // the empty string arrived as an argument of its own
    expect(fs.existsSync(pwned)).toBe(false);
    expect(out?.[1].status).toBe(0);
  });

  it('carries a large answer whole', async () => {
    const big = path.join(repo, 'big.txt');
    fs.writeFileSync(big, 'line of text to make the diff large\n'.repeat(80_000));
    try {
      const out = await runGitBatch(ctx(), repo, [
        { dir: 'c', args: ['diff', '--no-index', '--', '/dev/null', 'big.txt'] },
        { dir: 'c', args: ['rev-parse', 'HEAD'] },
      ]);
      expect(out?.[0].stdout.length).toBeGreaterThan(2_800_000);
      expect(out?.[0].status).toBe(1);
      expect(out?.[1].stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      fs.rmSync(big);
    }
  });

  it('runs a worktree group only in a worktree git lists, and answers 125 otherwise', async () => {
    const wt = (worktree: string): BatchGroup => ({ dir: 'w', worktree, args: ['rev-parse', '--abbrev-ref', 'HEAD'] });
    const out = await runGitBatch(ctx(), repo, [
      { dir: 'c', args: ['worktree', 'list', '--porcelain'] },
      wt(linked),
      wt(repo),
      wt(tmp),
      wt(`${linked}/`),
      wt(linked.slice(0, -1)),
    ]);
    expect(out?.[0].status).toBe(0);
    expect(out?.[1]).toMatchObject({ status: 0, stdout: 'other\n' });
    expect(out?.[2]).toMatchObject({ status: 0, stdout: 'main\n' });
    // Not listed, a spelling git did not print, a prefix of a listed path: never run.
    for (const refused of out!.slice(3)) expect(refused).toEqual({ status: 125, stdout: '', stderr: '' });
  });

  it('refuses a worktree that is not a remote absolute path, without spawning', async () => {
    counter.reset();
    expect(await runGitBatch(ctx(), repo, [{ dir: 'w', worktree: 'relative', args: ['status'] }])).toBeNull();
    expect(await runGitBatch(ctx(), repo, [{ dir: 'w', worktree: '/a\0b', args: ['status'] }])).toBeNull();
    expect(counter.spawns()).toBe(0);
  });

  it('splits an over-long list into several spawns and returns all the answers in order', async () => {
    counter.reset();
    const groups: BatchGroup[] = Array.from({ length: 150 }, (_, i) => ({ dir: 'c', args: ['rev-parse', '--verify', '--quiet', i % 2 ? 'HEAD' : 'nope'] }));
    const out = await runGitBatch(ctx(), repo, groups);
    expect(counter.spawns()).toBe(2);
    expect(out).toHaveLength(150);
    expect(out?.map((o) => o.status === 0)).toEqual(groups.map((_, i) => i % 2 === 1));
  });

  it('is the same through the base64 + eval command line the WSL route sends', async () => {
    const wslTarget = parseSshTarget(['ssh', 'dev@box'], repo, 'Ubuntu');
    if ('error' in wslTarget) throw new Error(wslTarget.error);
    const cmd = sshScriptCommand({ target: wslTarget }, BATCH_SCRIPT, repo, [
      repo, 'n0nce', 'c', '2', 'rev-parse', '--show-toplevel', 'w', '4', repo, 'rev-parse', '--abbrev-ref', 'HEAD',
    ]);
    expect(cmd.wsl).toBe(true);
    const remoteCommand = cmd.args[cmd.args.length - 1];
    expect(remoteCommand).toMatch(/^set -f;IFS=;eval \$\(echo [A-Za-z0-9+/=]+\|base64 -d\)$/);
    const ran = spawnSync('sh', ['-c', remoteCommand], { encoding: 'utf8' });
    const out = parseBatchOutput(ran.stdout, 'n0nce', 2);
    expect(out?.[0].stdout.trim()).toBe(repo);
    // The worktree gate (a here-document in the script) works through eval too.
    expect(out?.[1]).toMatchObject({ status: 0, stdout: 'main\n' });
  });

  it('an unreachable host is an error and marks the context', async () => {
    const context = ctx(() => deadSsh);
    await expect(runGitBatch(context, repo, [{ dir: 'c', args: ['status'] }])).rejects.toThrow(SSH_UNREACHABLE_MESSAGE);
    expect(context.unreachable).toBe(true);
  });

  it('answers null, to be done the long way, when the reply is not framed or the script fails', async () => {
    expect(await runGitBatch(ctx(() => garbageSsh), repo, [{ dir: 'c', args: ['status'] }])).toBeNull();
    expect(await runGitBatch(ctx(() => failingSsh), repo, [{ dir: 'c', args: ['status'] }])).toBeNull();
  });

  it('no ssh executable to run is a setup error, with its own message, not a fallback', async () => {
    const none: SshGitContext = { target: target(repo), tool: () => { throw new Error('matching ssh executable not found'); } };
    await expect(runGitBatch(none, repo, [{ dir: 'c', args: ['status'] }])).rejects.toBeInstanceOf(BatchSetupError);
    await expect(runGitBatch(none, repo, [{ dir: 'c', args: ['status'] }])).rejects.toThrow('ssh executable');
  });

  it('a batch that hangs is an error, not a retry', async () => {
    const saved = batchLimits.timeoutMs;
    batchLimits.timeoutMs = 150;
    try {
      await expect(runGitBatch(ctx(() => hangSsh), repo, [{ dir: 'c', args: ['status'] }])).rejects.toThrow(/timed out/);
    } finally {
      batchLimits.timeoutMs = saved;
    }
  });
});
