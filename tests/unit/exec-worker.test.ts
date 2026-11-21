import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

// The WSL route's executable is a fake that runs the command in a local `sh`,
// the way tests/unit/ssh-wsl.test.ts's fakes do for the explorer. Nothing here
// starts a real wsl.exe or ssh.
const fakeState = vi.hoisted(() => ({ exe: '', cwd: '' }));
vi.mock('../../src/main/system32', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/system32')>()),
  wslExecutable: () => fakeState.exe,
  wslSystemRoot: () => fakeState.cwd,
}));

import {
  configureExecWorker,
  liveExecWorkerCount,
  releaseExecWorkers,
  noteExecWorkersProcessExitForTests,
  resetExecWorkersForTests,
  shutdownExecWorkers,
  workerEnabled,
} from '../../src/main/exec-worker';
import {
  LOOP_SCRIPT,
  parseWslSshInvocation,
  WORKER_REMOTE_COMMAND,
} from '../../src/main/exec-worker-script';
import {
  execFileRouted,
  execFileRoutedAsync,
  type PlainExecAsync,
  runSshRouted,
} from '../../src/main/exec-worker-routed';
import {
  remoteCreateEntry,
  remoteDeleteEntry,
  remoteListDir,
  remoteReadCodeFile,
  remoteRenameEntry,
  remoteWriteCodeFile,
} from '../../src/main/ssh-explorer';
import { remoteInvocation } from '../../src/main/ssh-command';
import { SSH_CONNECTION_PERSIST_S, wslRemoteCommand, wslSshArgs } from '../../src/main/ssh-exec';
import { runGitBatch, type BatchGroup } from '../../src/main/exec-git-batch';
import { remoteBranchStatus } from '../../src/main/ssh-branch';
import { runWithSpawnPriority, sshLaneKey, withSpawnSlot } from '../../src/main/exec-gate';
import { resetExecWarmForTests, warmSshTarget, warmWorkspace } from '../../src/main/exec-warm';
import { configureExecTrace } from '../../src/main/exec-trace';
import { clearSshTarget, parseSshTarget, resetSshTargets, setSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import { onPlatform } from '../helpers/platform';
import { hasPosixTools } from '../helpers/posix-tools';
import { makeTmpDir } from '../helpers/git-repo';

interface LogEntry { kind: 'worker' | 'spawn' | 'nonce'; pid: number; argv: string[]; value?: string }

// The real timer, taken before a test installs fake ones: waiting for a process must not depend on the fake clock.
const realSetTimeout = globalThis.setTimeout;

describe.skipIf(!hasPosixTools(['git', 'base64', 'mktemp', 'wc', 'sed']))('the persistent ssh worker, over a local sh', () => {
  let tmp: string;
  let logFile: string;
  let controlFile: string;
  let seq = 0;

  const entries = (): LogEntry[] =>
    fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry);
  const starts = () => ({
    workers: entries().filter((e) => e.kind === 'worker'),
    spawns: entries().filter((e) => e.kind === 'spawn'),
  });
  const control = (c: Record<string, unknown>): void => fs.writeFileSync(controlFile, JSON.stringify(c));
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const settled = async (cond: () => boolean, ms = 5000): Promise<void> => {
    const until = performance.now() + ms;
    while (!cond()) {
      if (performance.now() > until) throw new Error('condition not reached');
      await new Promise((resolve) => realSetTimeout(resolve, 5));
    }
  };
  const gone = (pid: number): Promise<void> => settled(() => !alive(pid));

  const target = (root: string, destination = 'dev@h1', distro = 'Ubuntu-24.04'): SshTarget => {
    const parsed = parseSshTarget(['ssh', '-o', 'UserKnownHostsFile=/home/u/.ssh/kh', destination], root, distro);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };

  /** One call through the same argv the views build, run by the routed runner. */
  const call = (
    script: string,
    args: string[] = [],
    options: { timeout?: number; input?: Buffer | string; maxBuffer?: number; idempotent?: boolean } = {},
    to: SshTarget = target(tmp),
  ) => {
    const invocation = remoteInvocation(to, script, args, () => 'ssh');
    return runSshRouted(invocation.file, invocation.args, options.timeout ?? 10_000, {
      cwd: invocation.cwd,
      input: options.input,
      maxBuffer: options.maxBuffer,
      idempotent: options.idempotent,
    });
  };

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-worker-');
    logFile = path.join(tmp, 'fake.log');
    controlFile = path.join(tmp, 'control.json');
    const exe = path.join(tmp, 'fake-wsl');
    fs.writeFileSync(
      exe,
      `#!/bin/sh\nexec '${process.execPath}' '${path.resolve(__dirname, '../helpers/fake-wsl.cjs')}' "$@"\n`,
      { mode: 0o755 },
    );
    fakeState.exe = exe;
    fakeState.cwd = tmp;
    process.env.FAKE_WSL_LOG = logFile;
    process.env.FAKE_WSL_CONTROL = controlFile;
  });

  afterAll(() => {
    resetExecWorkersForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.FAKE_WSL_LOG;
    delete process.env.FAKE_WSL_CONTROL;
  });

  beforeEach(() => {
    fs.writeFileSync(logFile, '');
    control({});
    configureExecWorker({ enabled: true });
    resetExecWorkersForTests();
    resetSshTargets();
    configureExecTrace(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    configureExecTrace(false);
    resetExecWorkersForTests();
    delete process.env.WMUX_SSH_WORKER;
    configureExecWorker();
  });

  // ─── The bootstrap and the recognised argv ────────────────────────────────

  describe('the worker command line', () => {
    it('is base64 and eval only, with nothing a wsl.exe command line could mangle', () => {
      expect(WORKER_REMOTE_COMMAND).toMatch(/^set -f;IFS=;eval \$\(echo [A-Za-z0-9+/=]+\|base64 -d\)$/);
      expect(WORKER_REMOTE_COMMAND).not.toMatch(/['"\\%]/);
      // Both layers decode to the constant script.
      const outer = Buffer.from(/echo ([A-Za-z0-9+/=]+)\|/.exec(WORKER_REMOTE_COMMAND)![1], 'base64').toString();
      expect(outer.startsWith('exec sh -c "$(echo ')).toBe(true);
      const loop = Buffer.from(/echo ([A-Za-z0-9+/=]+)\|/.exec(outer.slice('exec sh -c "$('.length))![1], 'base64').toString();
      expect(loop).toBe(LOOP_SCRIPT);
    });

    it('recognises exactly the argv wslSshArgs builds, and hands back its command untouched', () => {
      const session = target('/w').session;
      const command = wslRemoteCommand("sh -c 'echo hi' sh");
      const argv = wslSshArgs(session, 'Ubuntu-24.04', command);
      const parsed = parseWslSshInvocation(argv);
      expect(parsed?.distro).toBe('Ubuntu-24.04');
      expect(parsed?.destination).toBe('dev@h1');
      expect(parsed?.prefix).toEqual(argv.slice(0, -1));
      expect(Buffer.from(parsed!.payload, 'base64').toString()).toBe("sh -c 'echo hi' sh");
      expect(parseWslSshInvocation(['-T', 'dev@h1', "sh -c 'x'"])).toBeUndefined();
      expect(parseWslSshInvocation([...argv.slice(0, -1), 'echo hi'])).toBeUndefined();
      expect(parseWslSshInvocation(['-d', 'D', '--exec', 'git', 'a', 'b', 'c'])).toBeUndefined();
    });

    it('never carries a user-controlled byte: the worker starts with a constant argv, whatever it is asked', async () => {
      const hostile = "x'; touch /tmp/pwned; echo \\$(id) %PATH% \"q\" \n\r é";
      const marker = 'ZZ-HOSTILE-MARKER-ZZ';
      const ok = await call('printf %s "$1"', [hostile + marker], { input: hostile + marker, idempotent: true });
      expect(ok.via).toBe('worker');
      expect(ok.stdout).toBe(hostile + marker);
      await call('cat', [], { input: marker + marker, idempotent: true });
      const { workers } = starts();
      expect(workers).toHaveLength(1);
      const argv = workers[0].argv;
      expect(argv[argv.length - 1]).toBe(WORKER_REMOTE_COMMAND);
      // Nothing of either request is in any word of the argv.
      for (const word of argv) {
        expect(word).not.toContain(marker);
        expect(word).not.toContain('pwned');
      }
      // And the words before the command are the target's own options, as the per-call route builds them.
      expect(argv.slice(0, -1)).toEqual(remoteInvocation(target(tmp), 'true', [], () => 'ssh').args.slice(0, -1));
    });
  });

  // ─── Equivalence with the per-call route ──────────────────────────────────

  describe('the same answers as a spawn', () => {
    const HOSTILE = [
      'plain.txt', 'with space.txt', "it's.txt", 'dollar $(echo pwned).txt', 'back\\slash.txt', 'new\nline.txt',
      '--dash.txt', 'ünï€ode.txt', '`tick`.txt', 'percent %s %n.txt', '.hidden', 'CRLF\r.txt',
    ];

    function fixtureDir(name: string): string {
      const dir = path.join(tmp, name);
      fs.mkdirSync(path.join(dir, 'sub dir'), { recursive: true });
      for (const [i, file] of HOSTILE.entries()) fs.writeFileSync(path.join(dir, file), `content ${i}\nline two\r\n`);
      fs.writeFileSync(path.join(dir, 'sub dir', 'inner.txt'), 'inner\n');
      return dir;
    }

    async function session(root: string, off: boolean): Promise<unknown[]> {
      configureExecWorker({ enabled: !off });
      resetExecWorkersForTests();
      const t = target(root);
      const out: unknown[] = [];
      const norm = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'number' && v > 1e9 ? 'T' : v)));
      out.push(norm(await remoteListDir(t, '', { showHidden: true })));
      out.push(norm(await remoteListDir(t, 'sub dir', {})));
      for (const file of HOSTILE) out.push(norm(await remoteReadCodeFile(t, file)));
      out.push(norm(await remoteReadCodeFile(t, 'missing.txt')));
      out.push(norm(await remoteListDir(t, 'nope', {})));
      out.push(norm(await remoteListDir(t, '../x', {})));
      // Writes: a save keeps its CRLF, a create / rename / delete take hostile names.
      out.push(norm(await remoteWriteCodeFile(t, 'plain.txt', 'new\ncontent\n', undefined)));
      out.push(norm(await remoteWriteCodeFile(t, 'CRLF\r.txt', 'a\nb\n', undefined)));
      out.push(norm(await remoteWriteCodeFile(t, 'with space.txt', 'x', 1)));
      out.push(norm(await remoteCreateEntry(t, '', "new'dir $(x)", 'dir')));
      out.push(norm(await remoteCreateEntry(t, "new'dir $(x)", 'f\nile.txt', 'file')));
      out.push(norm(await remoteCreateEntry(t, '', 'plain.txt', 'file')));
      out.push(norm(await remoteRenameEntry(t, 'dollar $(echo pwned).txt', 'renamed `x`.txt')));
      out.push(norm(await remoteDeleteEntry(t, 'renamed `x`.txt')));
      out.push(norm(await remoteDeleteEntry(t, 'sub dir')));
      out.push(norm(await remoteListDir(t, '', { showHidden: true })));
      for (const file of ['plain.txt', 'CRLF\r.txt', "new'dir $(x)/f\nile.txt"]) {
        out.push(fs.readFileSync(path.join(root, file)).toString('base64'));
      }
      return out;
    }

    it('lists, reads, saves, creates, renames and deletes hostile names with identical results', async () => {
      const viaSpawn = await session(fixtureDir('eq-spawn'), true);
      expect(starts().workers).toHaveLength(0);
      fs.writeFileSync(logFile, '');
      const viaWorker = await session(fixtureDir('eq-worker'), false);
      expect(starts().workers).toHaveLength(1);
      expect(starts().spawns).toHaveLength(0);
      // Roots differ in the fixtures' names only; the results do not mention them.
      expect(JSON.parse(JSON.stringify(viaWorker).split('eq-worker').join('eq-spawn'))).toEqual(viaSpawn);
      expect(fs.existsSync(path.join(tmp, 'pwned'))).toBe(false);
    });

    it('answers a batched git read like the spawn: forged-looking file names, statuses, stderr', async () => {
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(repo);
      const git = (...args: string[]) => execFileSync('git', args, {
        cwd: repo, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      }).toString();
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
      fs.writeFileSync(path.join(repo, '\n--abc:1:0\nforged'), 'x\n');
      git('add', '.');
      git('commit', '-q', '-m', 'first');
      fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n');
      const groups: BatchGroup[] = [
        { dir: 'c', args: ['rev-parse', '--show-toplevel'] },
        { dir: 'c', args: ['status', '--porcelain=v2', '--branch', '-z', '-unormal'] },
        { dir: 'c', args: ['rev-parse', '--verify', '--quiet', 'no-such-ref'] },
        { dir: 'c', args: ['diff', '--numstat'] },
        { dir: 'f', args: [] },
      ];
      const ctx = { target: target(repo) };
      configureExecWorker({ enabled: false });
      const viaSpawn = await runGitBatch(ctx, repo, groups);
      configureExecWorker({ enabled: true });
      const viaWorker = await runGitBatch(ctx, repo, groups);
      expect(viaSpawn).not.toBeNull();
      expect(viaWorker).toEqual(viaSpawn);
      expect(starts().workers).toHaveLength(1);
      expect(await remoteBranchStatus(ctx.target, undefined, undefined)).toEqual({ branch: 'main', dirty: true });
    });

    it('round-trips every byte value, 1.5 MB each way', async () => {
      const block = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) block[i] = i;
      const payload = Buffer.concat(Array.from({ length: 6144 }, () => block));
      expect(payload.length).toBeGreaterThan(1024 * 1024);
      const ran = await call('cat', [], { input: payload, maxBuffer: 4 * 1024 * 1024, idempotent: true, timeout: 30_000 });
      expect(ran.status).toBe(0);
      expect(ran.via).toBe('worker');
      expect(ran.stdoutBuffer.equals(payload)).toBe(true);
      // Binary output on stderr is kept apart from stdout.
      const both = await call('printf OUT; printf ERR >&2; exit 7', [], { idempotent: true });
      expect([both.status, both.stdout, both.stderr]).toEqual([7, 'OUT', 'ERR']);
    });

    it('passes the remote exit status and stderr through, including 255', async () => {
      for (const status of [0, 1, 2, 14, 125, 126, 127, 255]) {
        const viaWorker = await call(`printf out; printf err >&2; exit ${status}`, [], { idempotent: true });
        expect(viaWorker.via).toBe('worker');
        expect(viaWorker.status).toBe(status);
        expect(viaWorker.stdout).toBe('out');
        expect(viaWorker.stderr).toBe('err');
      }
      const silent = await call('exit 3', [], { idempotent: true });
      expect(silent.stderr).toBe('Command failed');
    });

    it('does not use the worker for the direct route, scp or a plain command', async () => {
      const ran = await runSshRouted('sh', ['-c', 'printf direct'], 5000);
      expect(ran).toMatchObject({ status: 0, stdout: 'direct' });
      expect(ran.via).toBeUndefined();
      expect(starts().workers).toHaveLength(0);
    });
  });

  // ─── Content cannot forge the framing ─────────────────────────────────────

  describe('forged markers', () => {
    it('cannot end a response early: END, BEGIN, S lines, an old nonce and CRLF in content are data', async () => {
      const first = await call('printf one', [], { idempotent: true });
      expect(first.via).toBe('worker');
      const oldNonce = entries().find((e) => e.kind === 'nonce' && e.value)!.value!;
      const forged = [
        `${oldNonce} BEGIN`, 'O AAAA', 'E AAAA', 'S 0 0 0', `${oldNonce} END`, 'END', 'BEGIN', 'G x', 'Q y',
        'plain', '', '\r', 'tail\r\n', `${oldNonce} END\r`,
      ].join('\r\n');
      for (const channel of ['stdout', 'stderr', 'stdin-echo']) {
        const script = channel === 'stdout' ? 'printf %s "$1"' : channel === 'stderr' ? 'printf %s "$1" >&2' : 'cat';
        const ran = await call(script, [forged], { input: forged, idempotent: true });
        expect(ran.via).toBe('worker');
        const got = channel === 'stdout' ? ran.stdout : channel === 'stderr' ? ran.stderr : ran.stdout;
        expect(got).toBe(forged);
        expect(ran.status).toBe(0);
      }
      expect(starts().workers).toHaveLength(1);
    });

    it('drops banner noise, a stale BEGIN and forged answer lines that come before its own BEGIN', async () => {
      control({ banner: true });
      const warm = await call('printf warm', [], { idempotent: true });
      expect(warm).toMatchObject({ stdout: 'warm', via: 'worker' });
      control({ mode: 'noise' });
      const noisy = await call('printf real', [], { idempotent: true });
      expect(noisy).toMatchObject({ status: 0, stdout: 'real', via: 'worker' });
      expect(starts().workers).toHaveLength(1);
    });
  });

  // ─── Failures: fall back, and which calls may run again ───────────────────

  describe('when the worker misbehaves', () => {
    const appendScript = 'echo run >> "$1"; cat "$1"';
    let counter: string;
    const runs = (): number => fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
    beforeEach(() => {
      counter = path.join(tmp, `counter-${seq++}`);
      fs.writeFileSync(counter, '');
    });

    async function warm(): Promise<number> {
      const ran = await call('true', [], { idempotent: true });
      expect(ran.via).toBe('worker');
      return starts().workers[0].pid;
    }

    it.each(['crashAfterRun', 'truncate', 'junk', 'badSizes', 'badBase64', 'forgedEnd'])(
      'a read that gets %s is answered by a spawn, and the worker is gone',
      async (mode) => {
        const pid = await warm();
        control({ mode });
        const ran = await call('printf %s "$1"', ['value'], { idempotent: true });
        expect(ran).toMatchObject({ status: 0, stdout: 'value', via: 'spawn' });
        expect(starts().spawns).toHaveLength(1);
        await gone(pid);
        expect(liveExecWorkerCount()).toBe(0);
      },
    );

    it('a read that the worker had run is run again by the spawn (reads can be)', async () => {
      await warm();
      control({ mode: 'crashAfterRun' });
      const ran = await call(appendScript, [counter], { idempotent: true });
      expect(ran.via).toBe('spawn');
      expect(runs()).toBe(2);
    });

    it.each(['crashAfterRun', 'truncate', 'junk', 'badSizes', 'badBase64', 'forgedEnd'])(
      'a write that gets %s is NOT run again: it fails as unreachable',
      async (mode) => {
        await warm();
        control({ mode });
        const ran = await call(appendScript, [counter], { idempotent: false });
        expect(ran.status).toBe(255);
        expect(ran.stdout).toBe('');
        expect(ran.via).toBe('worker');
        expect(starts().spawns).toHaveLength(0);
        // The worker had run it once before the answer went wrong; nothing ran it a second time.
        expect(runs()).toBe(1);
      },
    );

    it('an unspecified call counts as a write', async () => {
      await warm();
      control({ mode: 'crashAfterRun' });
      const ran = await call(appendScript, [counter]);
      expect(ran.status).toBe(255);
      expect(runs()).toBe(1);
    });

    it('the explorer reports a write the worker lost as ssh-unreachable and never repeats it', async () => {
      const dir = path.join(tmp, `lost-${seq++}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'f.txt'), 'old\n');
      const t = target(dir);
      expect(await remoteReadCodeFile(t, 'f.txt')).toMatchObject({ content: 'old\n' });
      const saved = await remoteWriteCodeFile(t, 'f.txt', 'new\n', undefined, {
        run: (file, args, _timeout, options) => {
          // The save's read goes through; its write is answered by nothing.
          if (options?.idempotent === false) control({ mode: 'dropOutput' });
          return runSshRouted(file, args, 600, options);
        },
        tool: () => 'ssh',
      });
      // A timeout is reported as a timeout, as the per-call route would: not a retry.
      expect(saved).toMatchObject({ code: 'write_failed' });
      expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('new\n');
      expect(starts().spawns).toHaveLength(0);

      resetExecWorkersForTests(); // the timeout backed the host off
      await warm();
      control({ mode: 'crashAfterRun' });
      const created = await remoteCreateEntry(t, '', 'made.txt', 'file');
      expect(created).toMatchObject({ code: 'ssh-unreachable' });
      expect(fs.existsSync(path.join(dir, 'made.txt'))).toBe(true);
      expect(starts().spawns).toHaveLength(0);
    });

    it('a write that never reached the worker (it died while the request was still being sent) is run once, per call', async () => {
      await warm();
      control({ mode: 'dieOnData' });
      const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
      const ran = await call('cat >/dev/null; echo run >> "$1"; echo done', [counter], { input: big, idempotent: false });
      expect(ran).toMatchObject({ status: 0, stdout: 'done\n', via: 'spawn' });
      expect(runs()).toBe(1);
    });

    it('a hang kills the worker at the timeout, and a read is answered by a spawn', async () => {
      const pid = await warm();
      control({ mode: 'hang' });
      const started = performance.now();
      const ran = await call('printf %s "$1"', ['late'], { idempotent: true, timeout: 700 });
      expect(performance.now() - started).toBeGreaterThanOrEqual(600);
      expect(ran).toMatchObject({ status: 0, stdout: 'late', via: 'spawn' });
      await gone(pid);
      expect(liveExecWorkerCount()).toBe(0);
    });

    it('a hang on a write is a timeout, not a second run', async () => {
      const pid = await warm();
      control({ mode: 'dropOutput' });
      const ran = await call(appendScript, [counter], { idempotent: false, timeout: 700 });
      expect(ran.status).toBe(1);
      expect(ran.stderr).toMatch(/timed out/);
      expect(runs()).toBe(1);
      await gone(pid);
      expect(starts().spawns).toHaveLength(0);
    });

    it('after a failure the host is left to spawns for a while, then tried again', async () => {
      await warm();
      control({ mode: 'truncate' });
      await call('true', [], { idempotent: true });
      const failedAt = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(failedAt);
      const during = await call('printf x', [], { idempotent: true });
      expect(during.via).toBe('spawn');
      expect(starts().workers).toHaveLength(1);
      vi.setSystemTime(failedAt + 31_000);
      const after = await call('printf y', [], { idempotent: true });
      expect(after.via).toBe('worker');
      expect(starts().workers).toHaveLength(2);
    });

    it('a failed handshake marks the host unusable for five minutes', async () => {
      control({ startFail: true });
      const first = await call('printf one', [], { idempotent: true });
      expect(first).toMatchObject({ status: 0, stdout: 'one', via: 'spawn' });
      expect(starts().workers).toHaveLength(1);
      control({});
      const t0 = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(t0 + 4 * 60_000);
      expect((await call('printf two', [], { idempotent: true })).via).toBe('spawn');
      expect(starts().workers).toHaveLength(1);
      vi.setSystemTime(t0 + 5 * 60_000 + 1000);
      expect((await call('printf three', [], { idempotent: true })).via).toBe('worker');
      expect(starts().workers).toHaveLength(2);
    });

    it('a handshake with a wrong answer is a failed handshake too', async () => {
      control({ mode: 'badSizes' });
      const ran = await call('printf one', [], { idempotent: true });
      expect(ran).toMatchObject({ stdout: 'one', via: 'spawn' });
      expect(liveExecWorkerCount()).toBe(0);
      expect((await call('printf two', [], { idempotent: true })).via).toBe('spawn');
      expect(starts().workers).toHaveLength(1);
    });

    it('WMUX_SSH_WORKER=0 means a spawn for every call and no worker, with no via in the result', async () => {
      configureExecWorker({});
      process.env.WMUX_SSH_WORKER = '0';
      expect(workerEnabled()).toBe(false);
      const ran = await call('printf one', [], { idempotent: true });
      expect(ran).toMatchObject({ status: 0, stdout: 'one' });
      expect(ran.via).toBeUndefined();
      expect(starts().workers).toHaveLength(0);
      expect(starts().spawns).toHaveLength(1);
    });

    it('is on by default only where the WSL route exists (Windows), and "1" does not force it on elsewhere', () => {
      configureExecWorker({});
      onPlatform('win32', () => {
        expect(workerEnabled()).toBe(true);
        process.env.WMUX_SSH_WORKER = '0';
        expect(workerEnabled()).toBe(false);
        process.env.WMUX_SSH_WORKER = '1';
        expect(workerEnabled()).toBe(true);
      });
      onPlatform('linux', () => {
        delete process.env.WMUX_SSH_WORKER;
        expect(workerEnabled()).toBe(false);
        process.env.WMUX_SSH_WORKER = '1';
        expect(workerEnabled()).toBe(false);
      });
      configureExecWorker({ enabled: true });
      process.env.WMUX_SSH_WORKER = '0';
      expect(workerEnabled()).toBe(true); // a test's override wins over the environment
    });

    it('a response bigger than maxBuffer is the per-call overflow error, and the worker stays usable', async () => {
      const ran = await call('head -c 2097152 /dev/zero', [], { idempotent: true, maxBuffer: 1024 * 1024 });
      expect(ran.status).toBe(1);
      expect(ran.stderr).toMatch(/maxBuffer/);
      expect(ran.stdout).toBe('');
      const next = await call('printf ok', [], { idempotent: true });
      expect(next).toMatchObject({ stdout: 'ok', via: 'worker' });
      expect(starts().workers).toHaveLength(1);
    });

    it('a request over the size cap is run per call', async () => {
      const ran = await call('wc -c', [], { input: Buffer.alloc(7 * 1024 * 1024, 0x62), idempotent: true, maxBuffer: 1024, timeout: 30_000 });
      expect(ran.via).toBe('spawn');
      expect(ran.stdout.trim()).toBe(String(7 * 1024 * 1024));
    });

    it('a call with an abort signal is a spawn', async () => {
      const controller = new AbortController();
      const invocation = remoteInvocation(target(tmp), 'printf s', [], () => 'ssh');
      const ran = await runSshRouted(invocation.file, invocation.args, 5000, { cwd: invocation.cwd, signal: controller.signal });
      expect(ran).toMatchObject({ stdout: 's', via: 'spawn' });
      expect(starts().workers).toHaveLength(0);
    });
  });

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('starts one worker, however many requests follow: N sequential calls are 1 process start, not N', async () => {
      control({ startDelayMs: 120 });
      const n = 12;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const ran = await call('printf %s "$1"', [String(i)], { idempotent: true });
        expect(ran).toMatchObject({ stdout: String(i), via: 'worker' });
      }
      const elapsed = performance.now() - t0;
      expect(starts().workers).toHaveLength(1);
      expect(starts().spawns).toHaveLength(0);
      // Per call, each would have paid the start; one worker pays it once.
      expect(elapsed).toBeLessThan(n * 120 * 0.6);
      const baseline = performance.now();
      configureExecWorker({ enabled: false });
      for (let i = 0; i < n; i++) await call('printf %s "$1"', [String(i)], { idempotent: true });
      const perCall = performance.now() - baseline;
      expect(starts().spawns).toHaveLength(n);
      expect(perCall).toBeGreaterThan(n * 120);
      expect(elapsed).toBeLessThan(perCall / 2);
    });

    it('closes an idle worker after 300 s, as long as the shared ssh connection persists, and a later request starts a new one', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      expect((await call('true', [], { idempotent: true })).via).toBe('worker');
      const pid = starts().workers[0].pid;
      // Still there a minute in, and at five minutes less one: the lifetime is the connection's.
      vi.advanceTimersByTime(61_000);
      expect(liveExecWorkerCount()).toBe(1);
      vi.advanceTimersByTime(238_000);
      expect(liveExecWorkerCount()).toBe(1);
      expect(alive(pid)).toBe(true);
      vi.advanceTimersByTime(2_000);
      expect(liveExecWorkerCount()).toBe(0);
      // Its stdin was closed, so the remote sh and the whole chain end by themselves.
      await gone(pid);
      expect((await call('true', [], { idempotent: true })).via).toBe('worker');
      expect(starts().workers).toHaveLength(2);
    });

    it('takes its default idle lifetime from the shared connection\'s ControlPersist, so they cannot drift', () => {
      expect(SSH_CONNECTION_PERSIST_S).toBe(300);
      const invocation = remoteInvocation(target(tmp), 'true', [], () => 'ssh');
      expect(invocation.args).toContain(`ControlPersist=${SSH_CONNECTION_PERSIST_S}`);
    });

    it('closes an idle worker after the default lifetime, and not before', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      expect((await call('true', [], { idempotent: true })).via).toBe('worker');
      vi.advanceTimersByTime(SSH_CONNECTION_PERSIST_S * 1000 - 1000);
      expect(liveExecWorkerCount()).toBe(1);
      vi.advanceTimersByTime(2_000);
      expect(liveExecWorkerCount()).toBe(0);
    });

    it('kills a worker that lingers after its stdin was closed', async () => {
      control({ ignoreEof: true });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      expect((await call('true', [], { idempotent: true })).via).toBe('worker');
      const pid = starts().workers[0].pid;
      vi.advanceTimersByTime(301_000);
      await new Promise((resolve) => setImmediate(resolve));
      expect(alive(pid)).toBe(true);
      vi.advanceTimersByTime(3_100);
      await gone(pid);
    });

    it('a busy worker is not closed for being idle', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      configureExecWorker({ enabled: true, idleMs: 1000 });
      const slow = call('sleep 0.4; printf done', [], { idempotent: true, timeout: 20_000 });
      await settled(() => liveExecWorkerCount() === 1);
      vi.advanceTimersByTime(900);
      expect(await slow).toMatchObject({ stdout: 'done', via: 'worker' });
      expect(starts().workers).toHaveLength(1);
    });

    it('is killed when its workspace target is cleared or changed, unless another workspace uses the host', async () => {
      const t1 = target(tmp, 'dev@h1');
      setSshTarget('ws-1', t1);
      expect((await call('true', [], { idempotent: true }, t1)).via).toBe('worker');
      const pid = starts().workers[0].pid;
      expect(clearSshTarget('ws-1')).toBe(true);
      await gone(pid);
      expect(liveExecWorkerCount()).toBe(0);

      setSshTarget('ws-1', t1);
      setSshTarget('ws-2', t1);
      expect((await call('true', [], { idempotent: true }, t1)).via).toBe('worker');
      clearSshTarget('ws-1');
      expect(liveExecWorkerCount()).toBe(1);
      const pid2 = starts().workers[1].pid;
      // Changing the target of the last workspace on a host ends that host's worker.
      setSshTarget('ws-2', target(tmp, 'dev@other'));
      await gone(pid2);
      expect(liveExecWorkerCount()).toBe(0);
      clearSshTarget('ws-2');
    });

    describe('a target cleared while a request is in flight', () => {
      const nonces = (): number => entries().filter((e) => e.kind === 'nonce').length;
      /** A request that is running on the worker when its workspace's target goes away. */
      const clearedMidRequest = async (idempotent: boolean, how: 'clear' | 'replace' = 'clear') => {
        const t1 = target(tmp, 'dev@h1');
        setSshTarget('ws-1', t1);
        expect((await call('true', [], { idempotent: true }, t1)).via).toBe('worker');
        const pid = starts().workers[0].pid;
        const before = nonces();
        const slow = call('sleep 0.4; printf done', [], { idempotent, timeout: 20_000 }, t1);
        await settled(() => nonces() > before);
        if (how === 'clear') clearSshTarget('ws-1');
        else setSshTarget('ws-1', target(tmp, 'dev@other'));
        return { slow, pid, t1 };
      };

      it('an idempotent read ends by being answered as a spawn, and the worker is gone', async () => {
        const { slow, pid } = await clearedMidRequest(true);
        expect(await slow).toMatchObject({ status: 0, stdout: 'done', via: 'spawn' });
        await gone(pid);
        expect(liveExecWorkerCount()).toBe(0);
        expect(starts().spawns).toHaveLength(1);
      });

      it('a write is not run a second time: it ends as the unreachable status, with no spawn', async () => {
        const { slow, pid } = await clearedMidRequest(false);
        expect(await slow).toMatchObject({ status: 255, via: 'worker' });
        await gone(pid);
        expect(liveExecWorkerCount()).toBe(0);
        expect(starts().spawns).toHaveLength(0);
      });

      it('the next request of that host starts a fresh worker, not the dead one', async () => {
        const { slow, pid, t1 } = await clearedMidRequest(true);
        await slow;
        await gone(pid);
        setSshTarget('ws-1', t1);
        expect((await call('true', [], { idempotent: true }, t1)).via).toBe('worker');
        expect(starts().workers).toHaveLength(2);
        expect(starts().workers[1].pid).not.toBe(pid);
        clearSshTarget('ws-1');
      });

      it('a target replaced by one on another host ends the old host\'s request the same way', async () => {
        const { slow, pid } = await clearedMidRequest(true, 'replace');
        expect(await slow).toMatchObject({ status: 0, stdout: 'done' });
        await gone(pid);
        expect(liveExecWorkerCount()).toBe(0);
        clearSshTarget('ws-1');
      });
    });

    it('releaseExecWorkers only touches the named host', async () => {
      const a = target(tmp, 'dev@ha');
      const b = target(tmp, 'dev@hb');
      await call('true', [], { idempotent: true }, a);
      await call('true', [], { idempotent: true }, b);
      expect(liveExecWorkerCount()).toBe(2);
      releaseExecWorkers('Ubuntu-24.04', 'dev@ha');
      expect(liveExecWorkerCount()).toBe(1);
      releaseExecWorkers('Other-Distro', 'dev@hb');
      expect(liveExecWorkerCount()).toBe(1);
    });

    it('is killed by the quit hook, and the hook runs before the quit is planned', async () => {
      await call('true', [], { idempotent: true });
      const pid = starts().workers[0].pid;
      shutdownExecWorkers();
      await gone(pid);
      expect(liveExecWorkerCount()).toBe(0);
      shutdownExecWorkers(); // twice is fine
      const index = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf8');
      const willQuit = index.slice(index.indexOf("app.on('will-quit'"));
      expect(willQuit.indexOf('shutdownExecWorkers()')).toBeGreaterThan(-1);
      expect(willQuit.indexOf('shutdownExecWorkers()')).toBeLessThan(willQuit.indexOf('planQuit('));
    });

    it('two hosts get two workers, each its own argv', async () => {
      const a = target(tmp, 'dev@ha');
      const b = target(tmp, 'dev@hb');
      await Promise.all([call('true', [], { idempotent: true }, a), call('true', [], { idempotent: true }, b)]);
      await call('true', [], { idempotent: true }, a);
      const { workers } = starts();
      expect(workers).toHaveLength(2);
      expect(workers.map((w) => w.argv[w.argv.length - 2]).sort()).toEqual(['dev@ha', 'dev@hb']);
    });

    it('a worker a remote host closed while idle is replaced quietly by the next request', async () => {
      await call('true', [], { idempotent: true });
      const pid = starts().workers[0].pid;
      process.kill(pid, 'SIGKILL');
      await settled(() => liveExecWorkerCount() === 0);
      const ran = await call('printf back', [], { idempotent: true });
      expect(ran).toMatchObject({ stdout: 'back', via: 'worker' });
      expect(starts().workers).toHaveLength(2);
    });
  });

  // ─── Concurrency ──────────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('answers many concurrent callers, each its own answer, on at most two workers', async () => {
      const results = await Promise.all(Array.from({ length: 60 }, (_v, i) =>
        call('printf %s-%s "$1" "$2"', [`n${i}`, 'x'.repeat(i)], { idempotent: true, input: `in${i}` })));
      results.forEach((ran, i) => expect(ran).toMatchObject({ status: 0, stdout: `n${i}-${'x'.repeat(i)}`, via: 'worker' }));
      expect(starts().workers.length).toBeLessThanOrEqual(2);
      expect(starts().spawns).toHaveLength(0);
    });

    it('keeps the gate: total in-flight stays within its slots', async () => {
      let inFlight = 0;
      let peak = 0;
      const lane = 'test-lane-worker';
      await Promise.all(Array.from({ length: 12 }, (_v, i) => withSpawnSlot(lane, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        const ran = await call('sleep 0.05; printf %s "$1"', [String(i)], { idempotent: true });
        inFlight--;
        return ran;
      })));
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThan(0);
    });

    it('serves in arrival order, and a foreground request before earlier background ones', async () => {
      configureExecWorker({ enabled: true, maxWorkers: 1 });
      await call('true', [], { idempotent: true });
      const order: string[] = [];
      const track = (label: string, p: ReturnType<typeof call>) => p.then((ran) => { order.push(label); return ran; });
      const blocker = track('blocker', call('sleep 0.3', [], { idempotent: true }));
      await new Promise((resolve) => setTimeout(resolve, 60)); // the blocker is on the worker now
      const bg = (label: string) => runWithSpawnPriority('bg', () => track(label, call('true', [], { idempotent: true })));
      const waiting = [bg('bg1'), bg('bg2'), track('fg1', call('true', [], { idempotent: true })), track('fg2', call('true', [], { idempotent: true })), bg('bg3')];
      await Promise.all([blocker, ...waiting]);
      expect(order).toEqual(['blocker', 'fg1', 'fg2', 'bg1', 'bg2', 'bg3']);
    });

    it('a second worker starts only when a request has to wait', async () => {
      await call('true', [], { idempotent: true });
      await call('true', [], { idempotent: true });
      expect(starts().workers).toHaveLength(1);
      await Promise.all([call('sleep 0.3', [], { idempotent: true }), call('sleep 0.3', [], { idempotent: true }), call('true', [], { idempotent: true })]);
      expect(starts().workers).toHaveLength(2);
    });
  });

  // ─── Warm-up ──────────────────────────────────────────────────────────────

  describe('warm-up', () => {
    // The log is appended to by another process: a read can land mid-line.
    const workerStarts = (): number => { try { return starts().workers.length; } catch { return -1; } };
    const quiet = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    beforeEach(() => resetExecWarmForTests());

    it('starts the worker in the background, once, and the first request is served by it', async () => {
      const t = target(tmp);
      expect(warmSshTarget(t)).toBeUndefined(); // returns at once, with nothing to wait on
      warmSshTarget(t);
      warmSshTarget(t);
      await settled(() => workerStarts() === 1);
      await quiet();
      expect(starts().workers).toHaveLength(1);
      expect(liveExecWorkerCount()).toBe(1);
      const first = await call('printf warm', [], { idempotent: true }, t);
      expect(first).toMatchObject({ stdout: 'warm', via: 'worker' });
      expect(starts().workers).toHaveLength(1);
      expect(starts().spawns).toHaveLength(0);
      // A worker that is there already is left alone.
      warmSshTarget(t);
      await quiet();
      expect(starts().workers).toHaveLength(1);
    });

    it('never blocks the caller: a request that arrives during the start waits for that start, not for a second one', async () => {
      control({ startDelayMs: 300 });
      const t = target(tmp);
      const began = performance.now();
      warmSshTarget(t);
      expect(performance.now() - began).toBeLessThan(100);
      const click = await call('printf click', [], { idempotent: true }, t);
      expect(click).toMatchObject({ stdout: 'click', via: 'worker' });
      expect(starts().workers).toHaveLength(1);
    });

    it('a failed warm-up backs the host off like any worker failure, and requests use spawns', async () => {
      control({ startFail: true });
      const t = target(tmp);
      warmSshTarget(t);
      await settled(() => workerStarts() === 1 && liveExecWorkerCount() === 0);
      control({});
      expect(await call('printf one', [], { idempotent: true }, t)).toMatchObject({ stdout: 'one', via: 'spawn' });
      expect(starts().workers).toHaveLength(1);
      // Nor does a later warm-up retry inside the back-off.
      warmSshTarget(t);
      await quiet();
      expect(starts().workers).toHaveLength(1);
      // After the five minutes it starts one again.
      const t0 = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(t0 + 5 * 60_000 + 1000);
      warmSshTarget(t);
      await settled(() => workerStarts() === 2);
    });

    it('does nothing with WMUX_SSH_WORKER=0, and nothing for a target that is not on the WSL route', async () => {
      configureExecWorker({});
      process.env.WMUX_SSH_WORKER = '0';
      warmSshTarget(target(tmp));
      await quiet();
      expect(starts().workers).toHaveLength(0);
      expect(liveExecWorkerCount()).toBe(0);
      configureExecWorker({ enabled: true });
      const direct = parseSshTarget(['ssh', 'dev@h1'], tmp);
      if ('error' in direct) throw new Error(direct.error);
      warmSshTarget(direct);
      await quiet();
      expect(starts().workers).toHaveLength(0);
    });

    it('warms a workspace only when it is visible and has a target on the WSL route', async () => {
      const t = target(tmp);
      setSshTarget('ws-1', t);
      await warmWorkspace('ws-unknown', undefined, () => true);
      await warmWorkspace('ws-1', undefined, () => false);
      await warmWorkspace('ws-1', undefined, () => { throw new Error('window gone'); });
      await warmWorkspace('ws-1', undefined, async () => { throw new Error('window gone'); });
      await quiet();
      expect(starts().workers).toHaveLength(0);
      const direct = parseSshTarget(['ssh', 'dev@h2'], tmp);
      if ('error' in direct) throw new Error(direct.error);
      setSshTarget('ws-direct', direct);
      await warmWorkspace('ws-direct', undefined, () => true);
      await quiet();
      expect(starts().workers).toHaveLength(0);
      await warmWorkspace('ws-1', undefined, async () => true);
      await settled(() => workerStarts() === 1);
      expect((await call('true', [], { idempotent: true }, t)).via).toBe('worker');
      expect(starts().workers).toHaveLength(1);
    });

    it('waits for a free background slot, never takes the last one, and starts nothing for a target cleared meanwhile', async () => {
      const t = target(tmp);
      setSshTarget('ws-1', t);
      const lane = sshLaneKey(t);
      const release: Array<() => void> = [];
      const hold = () => withSpawnSlot(lane, () => new Promise<void>((resolve) => release.push(resolve)), 'fg');
      const held = [hold(), hold()]; // a background call may use two of the three
      await warmWorkspace('ws-1', undefined, () => true);
      await quiet();
      expect(starts().workers).toHaveLength(0); // still queued behind the two
      clearSshTarget('ws-1');
      release.forEach((r) => r());
      await Promise.all(held);
      await quiet();
      expect(starts().workers).toHaveLength(0); // the target went away: nothing started
      // Slots free and the target still there: it starts.
      setSshTarget('ws-1', t);
      await warmWorkspace('ws-1', undefined, () => true);
      await settled(() => workerStarts() === 1);
    });
  });

  // ─── Trace and the execFile shape ─────────────────────────────────────────

  describe('trace', () => {
    it('names the way a call travelled, and still carries no path, host or content', async () => {
      const lines: string[] = [];
      configureExecTrace(true, (line) => lines.push(line));
      const dir = path.join(tmp, 'trace dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'secret-name.txt'), 'secret content');
      const t = target(dir, 'dev@secret-host');
      await remoteListDir(t, '', {});
      await remoteReadCodeFile(t, 'secret-name.txt');
      control({ mode: 'truncate' });
      await remoteReadCodeFile(t, 'secret-name.txt');
      const requests = lines.filter((l) => !l.startsWith('ssh-trace op=worker:'));
      expect(requests.map((l) => /via=(\w+)/.exec(l)?.[1])).toEqual(['worker', 'worker', 'spawn']);
      // Only the first call, the one that waited for the worker to start, is cold.
      expect(requests.map((l) => l.endsWith(' cold=1'))).toEqual([true, false, false]);
      for (const line of requests) {
        expect(line).toMatch(/^ssh-trace op=(list|read) loc=ssh prio=fg wait=\d+ ms=\d+ exit=0 out=\d+ via=(worker|spawn)( cold=1)?$/);
      }
      for (const line of lines) expect(line).not.toMatch(/secret|trace dir|dev@/);
      lines.length = 0;
      configureExecWorker({ enabled: false });
      await remoteListDir(t, '', {});
      expect(lines.every((l) => !l.includes('via='))).toBe(true);
    });

    describe('the worker lifecycle', () => {
      const START = /^ssh-trace op=worker:start loc=ssh ms=\d+ workers=\d+ reason=(first|click|warm|restart)$/;
      const STOP = /^ssh-trace op=worker:stop loc=ssh reason=(idle|timeout|protocol|clear|quit|exit|closed-by-peer) age_s=\d+$/;
      let lines: string[];
      const events = (): string[] => lines.filter((l) => l.startsWith('ssh-trace op=worker:'));
      const requests = (): string[] => lines.filter((l) => !l.startsWith('ssh-trace op=worker:'));
      const field = (line: string, name: string): string => new RegExp(`${name}=(\\S+)`).exec(line)![1];
      const reasons = (): string[] => events().map((l) => `${field(l, 'op').slice(7)}:${field(l, 'reason')}`);
      const idle = (t: SshTarget = target(tmp)) => call('true', [], { idempotent: true }, t);

      beforeEach(() => {
        lines = [];
        configureExecTrace(true, (line) => lines.push(line));
      });

      it('traces the first start with its handshake time and the host\'s worker count', async () => {
        await idle();
        await idle();
        expect(events()).toHaveLength(1);
        expect(events()[0]).toMatch(START);
        expect(field(events()[0], 'workers')).toBe('1');
        expect(field(events()[0], 'reason')).toBe('first');
        expect(Number(field(events()[0], 'ms'))).toBeGreaterThanOrEqual(0);
      });

      it('stops an idle worker at the default idle lifetime and starts the next one as a click, cold', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await idle();
        vi.advanceTimersByTime(299_000);
        expect(reasons()).toEqual(['start:first']);
        vi.advanceTimersByTime(2_000);
        expect(events()[1]).toMatch(STOP);
        expect(events()[1]).toBe('ssh-trace op=worker:stop loc=ssh reason=idle age_s=300');
        await idle();
        expect(reasons()).toEqual(['start:first', 'stop:idle', 'start:click']);
      });

      it('traces a timeout as a stop, and the start after its back-off as a restart', async () => {
        await idle();
        control({ mode: 'hang' });
        const hung = await call('printf x', [], { idempotent: true, timeout: 300 });
        expect(hung.via).toBe('spawn');
        expect(reasons()).toEqual(['start:first', 'stop:timeout']);
        expect(events()[1]).toMatch(STOP);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 31_000);
        await idle();
        expect(reasons()).toEqual(['start:first', 'stop:timeout', 'start:restart']);
      });

      it('traces clear and quit, and the start after a clear is a first again', async () => {
        const t1 = target(tmp);
        setSshTarget('ws-1', t1);
        await idle(t1);
        clearSshTarget('ws-1');
        expect(reasons()).toEqual(['start:first', 'stop:clear']);
        await idle(t1);
        expect(reasons()).toEqual(['start:first', 'stop:clear', 'start:first']);
        shutdownExecWorkers();
        expect(reasons()).toEqual(['start:first', 'stop:clear', 'start:first', 'stop:quit']);
        shutdownExecWorkers();
        expect(events()).toHaveLength(4);
      });

      it('says nothing when tracing is off or the worker is switched off, and never holds a host, path or content', async () => {
        configureExecTrace(false);
        await idle();
        shutdownExecWorkers();
        expect(lines).toHaveLength(0);
        configureExecTrace(true, (line) => lines.push(line));
        configureExecWorker({});
        process.env.WMUX_SSH_WORKER = '0';
        await idle();
        expect(events()).toHaveLength(0);
        delete process.env.WMUX_SSH_WORKER;
        configureExecWorker({ enabled: true });
        const secret = target(path.join(tmp, 'trace dir'), 'dev@secret-host');
        await idle(secret);
        shutdownExecWorkers();
        for (const line of events()) {
          expect(line).toMatch(new RegExp(`${START.source}|${STOP.source}`));
          expect(line).not.toMatch(/secret|trace dir|dev@|\/|wsl/i);
        }
      });
    });
  });

  describe('execFileRouted', () => {
    const run = (options: { timeout?: number; idempotent?: boolean } = {}, script = 'printf %s "$1"', args = ['v']) =>
      new Promise<{ err: (Error & Record<string, unknown>) | null; stdout: string; stderr: string; via?: string }>((resolve) => {
        const invocation = remoteInvocation(target(tmp), script, args, () => 'ssh');
        execFileRouted(invocation.file, invocation.args, { cwd: invocation.cwd, timeout: 700, maxBuffer: 1024, idempotent: true, ...options },
          (err, stdout, stderr, via) => resolve({ err: err as (Error & Record<string, unknown>) | null, stdout, stderr, via }));
      });

    it('has the callback shapes the git callers read: ok, exit code, 255, timeout and overflow', async () => {
      expect(await run()).toMatchObject({ err: null, stdout: 'v', via: 'worker' });
      const failed = await run({}, 'printf o; printf e >&2; exit 5', []);
      expect(failed.err).toMatchObject({ code: 5, stdout: 'o', stderr: 'e' });
      const overflow = await run({}, 'head -c 5000 /dev/zero', []);
      expect(overflow.err).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      control({ mode: 'dropOutput' });
      const timedOut = await run({ idempotent: false }, 'printf x', []);
      expect(timedOut.err).toMatchObject({ killed: true, code: null });
      resetExecWorkersForTests(); // the timeout backed the host off
      await call('true', [], { idempotent: true });
      control({ mode: 'crashAfterRun' });
      const lost = await run({ idempotent: false }, 'printf x', []);
      expect(lost.err).toMatchObject({ code: 255 });
    });

    it('is plain execFile, with no via, for a command that is not the WSL route', async () => {
      const ran = await new Promise<{ stdout: string; via?: string }>((resolve) => {
        execFileRouted('sh', ['-c', 'printf plain'], {}, (_e, stdout, _s, via) => resolve({ stdout, via }));
      });
      expect(ran).toEqual({ stdout: 'plain', via: undefined });
    });
  });

  describe('execFileRoutedAsync and the cold flag', () => {
    const plain = promisify(execFile) as unknown as PlainExecAsync;
    const via = (script: string, args: string[], options: { idempotent?: boolean; timeout?: number } = {}) => {
      const invocation = remoteInvocation(target(tmp), script, args, () => 'ssh');
      return execFileRoutedAsync(invocation.file, invocation.args,
        { cwd: invocation.cwd, timeout: 5000, maxBuffer: 1024, idempotent: true, ...options }, plain);
    };

    it('answers from the worker, cold only for the call that waited for the start', async () => {
      expect(await via('printf %s "$1"', ['a'])).toMatchObject({ stdout: 'a', via: 'worker', cold: true });
      const second = await via('printf %s "$1"', ['b']);
      expect(second).toMatchObject({ stdout: 'b', via: 'worker' });
      expect(second.cold).toBeUndefined();
    });

    it('puts via and cold on the error of a failed command too', async () => {
      await expect(via('exit 3', [])).rejects.toMatchObject({ code: 3, via: 'worker', cold: true });
      await expect(via('exit 4', [])).rejects.toMatchObject({ code: 4, via: 'worker', cold: undefined });
    });

    it('is cold and a spawn when the worker that was starting failed', async () => {
      control({ startFail: true });
      expect(await via('printf %s "$1"', ['c'])).toMatchObject({ stdout: 'c', via: 'spawn', cold: true });
      control({});
      await expect(via('exit 5', [])).rejects.toMatchObject({ code: 5, via: 'spawn', cold: undefined });
    });
  });
});
