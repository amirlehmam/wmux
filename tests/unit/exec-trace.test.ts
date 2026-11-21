import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configureExecTrace,
  gitTraceOp,
  execTraceEnabled,
  traceExitStatus,
  traceSpawn,
  traceWorkerStart,
  traceWorkerStop,
} from '../../src/main/exec-trace';
import { makeSpawnCounter, type SpawnCounter } from '../helpers/ssh-spawn-counter';
import { remoteListDir, remoteReadCodeFile, remoteWriteCodeFile, type RemoteDeps } from '../../src/main/ssh-explorer';
import { runSsh } from '../../src/main/ssh-exec';
import { getDiagnosticsPath } from '../../src/main/crash-diagnostics';
import { remoteBranchStatus } from '../../src/main/ssh-branch';
import { remoteChangedFiles, remoteFileDiff } from '../../src/main/ssh-diff';
import { handleGitView } from '../../src/main/git-view';
import { resetDiffCaches } from '../../src/main/diff-provider';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import { runWithSpawnPriority } from '../../src/main/exec-gate';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

afterEach(() => configureExecTrace(false));

describe('gitTraceOp', () => {
  it('names the sub-command after the global options', () => {
    expect(gitTraceOp(['-c', 'core.quotepath=off', '-c', 'color.ui=never', '--literal-pathspecs', 'status', '-z'])).toBe('git:status');
    expect(gitTraceOp(['diff', '--numstat'])).toBe('git:diff');
    expect(gitTraceOp(['worktree', 'list'])).toBe('git:worktree');
  });

  it('never repeats a word it does not know, so a path cannot reach the log', () => {
    expect(gitTraceOp(['/home/someone/secret'])).toBe('git:other');
    expect(gitTraceOp(['--no-such-flag'])).toBe('git:other');
    expect(gitTraceOp([])).toBe('git:other');
  });
});

describe('traceExitStatus', () => {
  it('is the numeric code, 1 for a code that is not a number, 0 for no error', () => {
    expect(traceExitStatus(null)).toBe(0);
    expect(traceExitStatus(Object.assign(new Error('x'), { code: 255 }))).toBe(255);
    expect(traceExitStatus(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(1);
    expect(traceExitStatus(new Error('x'))).toBe(1);
  });
});

describe('worker lifecycle lines', () => {
  it('are off with tracing, and otherwise one line each with only a duration, a count, seconds and a fixed word', () => {
    const lines: string[] = [];
    const fields: Array<Record<string, string | number>> = [];
    traceWorkerStart(5, 1, 'first');
    traceWorkerStop('idle', 1000);
    configureExecTrace(true, (line, f) => { lines.push(line); fields.push(f); });
    traceWorkerStart(612.4, 2, 'warm');
    traceWorkerStop('closed-by-peer', 299_600);
    traceWorkerStop('quit', -5);
    traceWorkerStart(-1, 1, 'restart');
    expect(lines).toEqual([
      'ssh-trace op=worker:start loc=ssh ms=612 workers=2 reason=warm',
      'ssh-trace op=worker:stop loc=ssh reason=closed-by-peer age_s=300',
      'ssh-trace op=worker:stop loc=ssh reason=quit age_s=0',
      'ssh-trace op=worker:start loc=ssh ms=0 workers=1 reason=restart',
    ]);
    expect(fields[0]).toEqual({ op: 'worker:start', loc: 'ssh', ms: 612, workers: 2, reason: 'warm' });
    expect(fields[1]).toEqual({ op: 'worker:stop', loc: 'ssh', reason: 'closed-by-peer', age_s: 300 });
  });
});

describe('traceSpawn', () => {
  it('is off by default and does nothing, not even building the name', () => {
    expect(execTraceEnabled()).toBe(false);
    const name = vi.fn(() => 'list');
    expect(traceSpawn(name)).toBeUndefined();
    expect(name).not.toHaveBeenCalled();
  });

  it('writes one line with the operation, priority, queue wait (rounded), duration, exit status and bytes', () => {
    const lines: string[] = [];
    const fields: Array<Record<string, string | number>> = [];
    configureExecTrace(true, (line, f) => { lines.push(line); fields.push(f); });
    expect(execTraceEnabled()).toBe(true);
    traceSpawn('list')?.(0, 1234);
    traceSpawn(() => 'git:batch', { prio: 'bg', waitMs: 412.6 })?.(255, 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ssh-trace op=list loc=ssh prio=fg wait=0 ms=\d+ exit=0 out=1234$/);
    expect(lines[1]).toMatch(/^ssh-trace op=git:batch loc=ssh prio=bg wait=413 ms=\d+ exit=255 out=0$/);
    expect(fields[1]).toMatchObject({ op: 'git:batch', loc: 'ssh', prio: 'bg', wait: 413, exit: 255, out: 0 });
  });

  it('ends a line in via and cold only when it has them, cold only when set', () => {
    const lines: string[] = [];
    const fields: Array<Record<string, string | number>> = [];
    configureExecTrace(true, (line, f) => { lines.push(line); fields.push(f); });
    traceSpawn('read')?.(0, 5, 'worker', true);
    traceSpawn('read')?.(0, 5, 'spawn', true);
    traceSpawn('read')?.(0, 5, 'worker', false);
    traceSpawn('read')?.(0, 5, 'worker');
    traceSpawn('read')?.(0, 5, undefined, true);
    expect(lines.map((l) => l.replace(/ms=\d+/, 'ms=N'))).toEqual([
      'ssh-trace op=read loc=ssh prio=fg wait=0 ms=N exit=0 out=5 via=worker cold=1',
      'ssh-trace op=read loc=ssh prio=fg wait=0 ms=N exit=0 out=5 via=spawn cold=1',
      'ssh-trace op=read loc=ssh prio=fg wait=0 ms=N exit=0 out=5 via=worker',
      'ssh-trace op=read loc=ssh prio=fg wait=0 ms=N exit=0 out=5 via=worker',
      'ssh-trace op=read loc=ssh prio=fg wait=0 ms=N exit=0 out=5 cold=1',
    ]);
    expect(fields[0]).toMatchObject({ via: 'worker', cold: 1 });
    expect(fields[2]).not.toHaveProperty('cold');
  });

  it('goes to the console and the diagnostics log by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-trace-'));
    const saved = process.env.APPDATA;
    process.env.APPDATA = home;
    try {
      configureExecTrace(true);
      traceSpawn('read')?.(0, 5);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[ssh-trace op=read loc=ssh prio=fg wait=0 ms=\d+ exit=0 out=5\]$/));
      const written = fs.readFileSync(getDiagnosticsPath(), 'utf8');
      expect(written).toMatch(/ssh-trace op=read loc=ssh prio=fg wait=0 ms=\d+ exit=0 out=5\n$/);
    } finally {
      if (saved === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = saved;
      log.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasPosixTools(['git', 'gnu-find', 'stat-c', 'mktemp']))('a traced ssh workspace', () => {
  let tmp: string;
  let repo: string;
  let counter: SpawnCounter;
  const SECRET = 'secret-name-9f3c';
  const target = (): SshTarget => {
    const parsed = parseSshTarget(['ssh', 'someone@private-host.example'], repo);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };
  const deps = (): RemoteDeps => ({ run: runSsh, tool: () => counter.tool });

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-trace-');
    counter = makeSpawnCounter(tmp, 'trace-ssh', 0);
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, `${SECRET}.txt`), 'top secret content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    fs.appendFileSync(path.join(repo, `${SECRET}.txt`), 'more secret content\n');
    fs.writeFileSync(path.join(repo, `untracked-${SECRET}.txt`), 'x\n');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => resetDiffCaches());

  it('prints one line per spawn, and no path, name, content or host in any of them', async () => {
    const lines: string[] = [];
    configureExecTrace(true, (line) => lines.push(line));
    const tool = () => counter.tool;
    await remoteListDir(target(), '', {}, deps());
    const read = await remoteReadCodeFile(target(), `${SECRET}.txt`, deps());
    if ('error' in read) throw new Error(read.error);
    await remoteWriteCodeFile(target(), `${SECRET}.txt`, 'new secret content\n', read.mtimeMs, deps());
    await remoteChangedFiles(target(), undefined, tool);
    await remoteFileDiff(target(), `untracked-${SECRET}.txt`, undefined, tool);
    await handleGitView({ op: 'repo', cwd: '' }, { target: target(), tool });
    await remoteBranchStatus(target(), runSsh, tool);

    expect(lines.length).toBe(counter.spawns());
    for (const line of lines) expect(line).toMatch(/^ssh-trace op=[a-z:-]+ loc=ssh prio=(fg|bg) wait=\d+ ms=\d+ exit=\d+ out=\d+$/);
    const joined = lines.join('\n');
    for (const forbidden of [SECRET, 'secret content', tmp, 'private-host', 'someone', 'repo']) {
      expect(joined).not.toContain(forbidden);
    }
    const ops = new Set(lines.map((l) => /op=([^ ]+)/.exec(l)?.[1]));
    for (const op of ['list', 'read', 'write', 'git:batch']) {
      expect(ops.has(op)).toBe(true);
    }
  });

  it('marks the spawns of a poll bg and records the time one queued behind the cap', async () => {
    const lines: string[] = [];
    configureExecTrace(true, (line) => lines.push(line));
    const tool = () => counter.tool;
    await runWithSpawnPriority('bg', () => remoteChangedFiles(target(), undefined, tool));
    await remoteListDir(target(), '', {}, deps());
    expect(lines.some((l) => / prio=bg /.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/ op=list loc=ssh prio=fg /);
    // The sidebar's marker is nobody's click.
    await remoteBranchStatus(target(), runSsh, tool);
    expect(lines.at(-1)).toMatch(/ op=git:batch loc=ssh prio=bg /);
    // Eight calls at once against a cap of three: the later ones report a wait.
    lines.length = 0;
    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((d) => remoteListDir(target(), d, {}, deps())));
    const waits = lines.map((l) => Number(/ wait=(\d+) /.exec(l)?.[1]));
    expect(waits).toHaveLength(8);
    expect(waits.filter((w) => w === 0).length).toBeGreaterThanOrEqual(3);
  });

  it('writes nothing when off', async () => {
    const lines: string[] = [];
    configureExecTrace(false, (line) => lines.push(line));
    await remoteListDir(target(), '', {}, deps());
    await remoteBranchStatus(target(), runSsh, () => counter.tool);
    expect(lines).toEqual([]);
  });
});
