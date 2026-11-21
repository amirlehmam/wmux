import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';

// The WSL route's executable is a fake that runs the call in the local file system: a directory of it
// stands for the distro's (`\\wsl.localhost\Ubuntu\tmp\x` is `/tmp/x`), `sh` is `sh`, `git` is `git`.
const fakeState = vi.hoisted(() => ({ exe: '', cwd: '' }));
vi.mock('../../src/main/system32', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/system32')>()),
  wslExecutable: () => fakeState.exe,
  wslSystemRoot: () => fakeState.cwd,
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const standsFor = (p: unknown): unknown => {
    const m = typeof p === 'string' ? /^\\\\wsl\.localhost\\[^\\]+(.*)$/.exec(p) : null;
    return m ? m[1].replace(/\\/g, '/') : p;
  };
  const statSync = ((p: unknown, ...rest: unknown[]) => (actual.statSync as (...a: unknown[]) => unknown)(standsFor(p), ...rest)) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

import {
  configureExecWorker,
  liveExecWorkerCount,
  resetExecWorkersForTests,
} from '../../src/main/exec-worker';
import {
  LOCAL_GIT_SCRIPT,
  parseWorkerInvocation,
  parseWslLocalInvocation,
  WORKER_REMOTE_COMMAND,
} from '../../src/main/exec-worker-script';
import {
  execFileRouted,
  isWorkerRoute,
  runSshRouted,
} from '../../src/main/exec-worker-routed';
import { gitCommand, handleGitView, wslPathToWindows } from '../../src/main/git-view';
import { getChangedFiles, getChangedFilesWithBaseline, getFileDiff, resetDiffCaches } from '../../src/main/diff-provider';
import { resetBatchBackoff, runGitBatch, type BatchGroup } from '../../src/main/exec-git-batch';
import { resetSnapshots } from '../../src/main/exec-snapshot';
import { configureExecTrace } from '../../src/main/exec-trace';
import { resetExecWarmForTests, warmWorkspace } from '../../src/main/exec-warm';
import { remoteInvocation } from '../../src/main/ssh-command';
import { parseSshTarget } from '../../src/main/ssh-targets';
import type { GitViewRequest } from '../../src/shared/git-view';
import { onPlatform } from '../helpers/platform';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

interface LogEntry { kind: 'worker' | 'spawn' | 'nonce'; pid: number; argv: string[]; value?: string }

describe.skipIf(!hasPosixTools(['git', 'base64', 'mktemp', 'wc', 'sed']))('the persistent worker of a WSL distro, over a local sh', () => {
  let tmp: string;
  let repo: string;
  let logFile: string;
  let controlFile: string;
  let hash: string;

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
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const unc = (posix: string, distro = 'Ubuntu'): string => wslPathToWindows(distro, posix);
  const cwd = (): string => unc(repo);

  interface Result { err: (Error & { code?: unknown; killed?: boolean }) | null; stdout: string; stderr: string; via?: string; cold?: boolean }
  /** One git call as git-view.ts makes it: through `gitCommand` and the routed `execFile`. */
  const gitCall = (
    folder: string,
    gitArgs: string[],
    options: { idempotent?: boolean; timeout?: number; extraEnv?: Record<string, string> } = {},
  ): Promise<Result> => new Promise((resolve) => {
    const cmd = gitCommand(folder, gitArgs, options.extraEnv ?? { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
    execFileRouted(cmd.file, cmd.args, {
      cwd: cmd.cwd, env: cmd.env, windowsHide: true, timeout: options.timeout ?? 10_000, maxBuffer: 5 * 1024 * 1024,
      idempotent: options.idempotent ?? true, wslEnv: cmd.route?.kind === 'wsl' ? cmd.route.env : undefined,
    }, (err, stdout, stderr, via, cold) => resolve({ err: err as Result['err'], stdout, stderr, via, cold }));
  });
  const norm = (r: Result): unknown => ({ code: r.err?.code ?? 0, stdout: r.stdout, stderr: r.stderr });

  beforeAll(() => {
    tmp = makeTmpDir('wmux-wsl-worker-');
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
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(repo, 'with space.txt'), 's\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    hash = git(repo, 'rev-parse', 'HEAD').trim();
    fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(repo, "it's $(x) `y` %s.txt"), 'x\ny\n');
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
    resetExecWarmForTests();
    resetBatchBackoff();
    resetSnapshots();
    resetDiffCaches();
    configureExecTrace(false);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    configureExecTrace(false);
    resetExecWorkersForTests();
    delete process.env.WMUX_SSH_WORKER;
    configureExecWorker();
  });

  // ─── What is recognised, and what the bootstrap holds ─────────────────────

  describe('the argv it recognises and the one it starts with', () => {
    it('takes a script run with `sh -c <wsl command>` and a single git call that names its environment, and nothing else', () => {
      const script = ['-d', 'Ubuntu', '--exec', 'sh', '-c', `set -f;IFS=;eval $(echo ${Buffer.from("sh -c 'true' sh").toString('base64')}|base64 -d)`];
      const parsed = parseWslLocalInvocation(script);
      expect(parsed).toMatchObject({ loc: 'wsl', distro: 'Ubuntu', destination: '', prefix: script.slice(0, 5) });
      expect(Buffer.from(parsed!.payload, 'base64').toString()).toBe("sh -c 'true' sh");
      expect(parsed!.perCallOn125).toBeUndefined();

      const gitArgv = ['-d', 'Ubuntu', '--cd', '/home/me/repo', '--exec', 'git', 'status', '--porcelain'];
      expect(parseWslLocalInvocation(gitArgv)).toBeUndefined(); // the caller has not said what its environment is
      const single = parseWslLocalInvocation(gitArgv, { GIT_OPTIONAL_LOCKS: '0' });
      expect(single).toMatchObject({ loc: 'wsl', distro: 'Ubuntu', destination: '', prefix: ['-d', 'Ubuntu', '--exec', 'sh', '-c'], perCallOn125: true });
      expect(Buffer.from(single!.payload, 'base64').toString())
        .toBe(`sh -c '${LOCAL_GIT_SCRIPT}' sh '/home/me/repo' 'GIT_OPTIONAL_LOCKS=0' 'git' 'status' '--porcelain'`);

      const refused: Array<[string[], Record<string, string>?]> = [
        [['-d', '-x', '--exec', 'sh', '-c', script[5]]],
        [['-d', 'U b', '--exec', 'sh', '-c', script[5]]],
        [['-d', 'Ubuntu', '--exec', 'sh', '-c', 'echo hi']],
        [['-d', 'Ubuntu', '--exec', 'sh', '-c', script[5], 'extra']],
        [['-d', 'Ubuntu', '--exec', 'bash', '-c', script[5]]],
        [['-d', 'Ubuntu', '--cd', 'relative', '--exec', 'git', 'status'], {}],
        [['-d', 'Ubuntu', '--cd', '/a\0b', '--exec', 'git', 'status'], {}],
        [['-d', 'Ubuntu', '--cd', '/a', '--exec', 'git', 'sta\0tus'], {}],
        [['-d', 'Ubuntu', '--cd', '/a', '--exec', 'rm', '-rf', '/'], {}],
        [['-d', 'Ubuntu', '--cd', '/a', '--exec', 'git', 'status'], { 'BAD NAME': '1' }],
        [['-d', 'Ubuntu', '--cd', '/a', '--exec', 'git', 'status'], { GOOD: 'a\0b' }],
        [['status'], {}],
      ];
      for (const [argv, env] of refused) expect(parseWslLocalInvocation(argv, env), argv.join(' ')).toBeUndefined();
      // Both places through one entry point, told apart.
      const sshTarget = parseSshTarget(['ssh', 'dev@h'], '/w', 'Ubuntu');
      if ('error' in sshTarget) throw new Error(sshTarget.error);
      const sshArgv = remoteInvocation(sshTarget, 'true', [], () => 'ssh').args;
      expect(parseWorkerInvocation(sshArgv)?.loc).toBe('ssh');
      expect(parseWorkerInvocation(script)?.loc).toBe('wsl');
    });

    it('starts with a constant argv that holds no user-controlled byte, whatever it is asked', async () => {
      const marker = 'ZZ-HOSTILE-MARKER-ZZ';
      const hostile = `x'; touch ${path.join(tmp, 'pwned')}; echo \\$(id) %PATH% "q" \n\r é${marker}`;
      const ok = await gitCall(cwd(), ['log', `--format=${hostile}`, '-n', '1']);
      expect(ok.via).toBe('worker');
      expect(ok.stdout).toContain(marker);
      const groups: BatchGroup[] = [{ dir: 'c', args: ['log', `--format=${hostile}`, '-n', '1'] }];
      expect((await runGitBatch({ wsl: { distro: 'Ubuntu', posix: repo } }, repo, groups))?.[0].stdout).toContain(marker);
      const { workers } = starts();
      expect(workers).toHaveLength(1);
      const argv = workers[0].argv;
      // The distro name (a word wsl.exe needs, held to a strict pattern) and constants: nothing of either request.
      expect(argv).toEqual(['-d', 'Ubuntu', '--exec', 'sh', '-c', WORKER_REMOTE_COMMAND]);
      for (const word of argv) {
        expect(word).not.toContain(marker);
        expect(word).not.toContain('pwned');
        expect(word).not.toContain(repo);
      }
      expect(fs.existsSync(path.join(tmp, 'pwned'))).toBe(false);
    });
  });

  // ─── Serving ──────────────────────────────────────────────────────────────

  describe('serving the calls of a WSL folder', () => {
    it('serves single git calls and batches from one worker, and answers them as a spawn does', async () => {
      const calls: string[][] = [
        ['status', '--porcelain=v2', '--branch', '-z', '-unormal'],
        ['rev-parse', '--show-toplevel'],
        ['log', '--format=%H%x1f%an%x1f%s', '-n', '5'],
        ['diff', '--numstat'],
        ['rev-parse', '--verify', '--quiet', '--end-of-options', 'no-such-ref^{commit}'], // exit 1
        ['show', 'not-a-hash'], // exit 128 with a message
        ['diff', '--no-index', '--', '/dev/null', "it's $(x) `y` %s.txt"], // exit 1 with output
      ];
      const run = async (enabled: boolean): Promise<unknown[]> => {
        configureExecWorker({ enabled });
        resetExecWorkersForTests();
        const out: unknown[] = [];
        for (const args of calls) out.push(norm(await gitCall(cwd(), args)));
        return out;
      };
      const viaSpawn = await run(false);
      expect(starts().workers).toHaveLength(0);
      fs.writeFileSync(logFile, '');
      const viaWorker = await run(true);
      expect(starts().workers).toHaveLength(1);
      expect(starts().spawns).toHaveLength(0);
      expect(viaWorker).toEqual(viaSpawn);
      expect((viaWorker[5] as { code: number }).code).toBe(128);
      expect((viaWorker[4] as { code: number }).code).toBe(1);
    });

    it('gives every Git view and Diff tab answer the same with the worker as without it', async () => {
      const views = (): GitViewRequest[] => [
        { op: 'repo', cwd: cwd() },
        { op: 'working', cwd: cwd(), worktree: cwd() },
        { op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: 'a.txt', section: 'unstaged' },
        { op: 'branch', cwd: cwd(), worktree: cwd(), base: 'main' },
        { op: 'graph', cwd: cwd(), worktree: cwd(), scope: 'all', limit: 20 },
        { op: 'commit', cwd: cwd(), hash },
        { op: 'rangeDiff', cwd: cwd(), from: '', to: hash, file: 'a.txt' },
      ];
      const session = async (enabled: boolean): Promise<unknown> => {
        configureExecWorker({ enabled });
        resetExecWorkersForTests();
        resetDiffCaches();
        resetBatchBackoff();
        const out: unknown[] = [];
        for (const req of views()) out.push(await handleGitView(req));
        out.push(await getChangedFiles(cwd()), await getChangedFilesWithBaseline(cwd()), await getFileDiff(cwd(), 'a.txt'));
        return out;
      };
      const viaSpawn = await session(false);
      fs.writeFileSync(logFile, '');
      const viaWorker = await session(true);
      expect(viaWorker).toEqual(viaSpawn);
      expect((viaWorker as Array<{ ok?: boolean }>).slice(0, 7).every((r) => r.ok)).toBe(true);
      // One process for all of it: a worker, no spawn.
      expect(starts().workers).toHaveLength(1);
      expect(starts().spawns).toHaveLength(0);
    });

    it('keeps a worker per distro, and one for all the folders of a distro', async () => {
      await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
      await gitCall(unc(path.join(tmp, 'repo', '.git')), ['rev-parse', '--git-dir']);
      expect(starts().workers).toHaveLength(1);
      expect(liveExecWorkerCount()).toBe(1);
      await gitCall(unc(repo, 'Debian'), ['rev-parse', '--show-toplevel']);
      expect(starts().workers).toHaveLength(2);
      expect(starts().workers.map((w) => w.argv[1]).sort()).toEqual(['Debian', 'Ubuntu']);
      expect(liveExecWorkerCount()).toBe(2);
    });

    it('runs a call that may write per call, never in the worker: only reads go there', async () => {
      const ran = await gitCall(cwd(), ['rev-parse', '--show-toplevel'], { idempotent: false });
      expect(ran.via).toBe('spawn');
      expect(ran.stdout.trim()).toBe(repo);
      expect(starts().workers).toHaveLength(0);
      expect(starts().spawns).toHaveLength(1);
      // And a git call that does not say what its environment is.
      await new Promise<void>((resolve) => {
        execFileRouted(fakeState.exe, ['-d', 'Ubuntu', '--cd', repo, '--exec', 'git', 'rev-parse', '--show-toplevel'],
          { idempotent: true, timeout: 5000 }, () => resolve());
      });
      expect(starts().workers).toHaveLength(0);
    });

    it('runs a call per call, in its own words, when the directory cannot be entered, and keeps the worker', async () => {
      await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
      fs.writeFileSync(logFile, '');
      const gone = await gitCall(unc(path.join(tmp, 'no-such-dir')), ['status']);
      expect(gone.via).toBe('spawn');
      expect(gone.err).not.toBeNull();
      expect(starts().workers).toHaveLength(0);
      expect(starts().spawns).toHaveLength(1);
      const after = await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
      expect(after.via).toBe('worker');
    });

    it('sets exactly the variables the call forwards: none for the Diff tab, two for the Git view', async () => {
      const probe = async (extraEnv: Record<string, string>): Promise<string> => {
        // `env` in front of git is what carries them: ask git for its environment through an alias.
        const r = await gitCall(cwd(), ['-c', 'alias.e=!env', 'e'], { extraEnv });
        return r.stdout;
      };
      const none = await probe({});
      const some = await probe({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
      expect(none).not.toContain('GIT_TERMINAL_PROMPT=0');
      expect(some).toContain('GIT_OPTIONAL_LOCKS=0');
      expect(some).toContain('GIT_TERMINAL_PROMPT=0');
    });
  });

  // ─── Failure: always the per-call route ───────────────────────────────────

  describe('when the worker fails', () => {
    it.each(['crashAfterRun', 'dropOutput', 'badBase64', 'noise'])(
      'a read that meets %s is answered per call, correctly',
      async (mode) => {
        await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
        control({ mode });
        // A worker that answers nothing is only noticed by the call's own timeout: keep it short.
        const ran = await gitCall(cwd(), ['rev-parse', '--show-toplevel'], mode === 'dropOutput' ? { timeout: 500 } : {});
        if (mode === 'noise') {
          expect(ran.via).toBe('worker'); // noise before our BEGIN is dropped, not a failure
        } else {
          expect(ran.via).toBe('spawn');
        }
        expect(ran.err).toBeNull();
        expect(ran.stdout.trim()).toBe(repo);
      },
    );

    it('answers a hung read per call after its timeout, then stays on spawns while backed off, then recovers', async () => {
      await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
      control({ mode: 'hang' });
      const ran = await gitCall(cwd(), ['rev-parse', '--show-toplevel'], { timeout: 400 });
      expect(ran.via).toBe('spawn');
      expect(ran.stdout.trim()).toBe(repo);
      const backedOff = await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
      expect(backedOff.via).toBe('spawn');
      expect(starts().workers).toHaveLength(1);
    });

    it('is never in the way of a batch: a worker that cannot start leaves the one-spawn batch', async () => {
      control({ startFail: true });
      const out = await runGitBatch({ wsl: { distro: 'Ubuntu', posix: repo } }, repo, [{ dir: 'c', args: ['rev-parse', '--show-toplevel'] }]);
      expect(out?.[0].stdout.trim()).toBe(repo);
      expect(starts().spawns.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('closes an idle worker (its sh ends with its stdin), and the next call starts another', async () => {
      const lines: string[] = [];
      configureExecTrace(true, (l) => lines.push(l));
      configureExecWorker({ enabled: true, idleMs: 120, lingerKillMs: 300 });
      await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
      const pid = starts().workers[0].pid;
      expect(alive(pid)).toBe(true);
      await settled(() => !alive(pid));
      expect(lines.some((l) => /^ssh-trace op=worker:stop loc=wsl reason=idle age_s=\d+$/.test(l))).toBe(true);
      const again = await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
      expect(again.via).toBe('worker');
      expect(again.cold).toBe(true);
      expect(starts().workers).toHaveLength(2);
      expect(lines.filter((l) => l.includes('op=worker:start')).map((l) => /reason=(\w+)/.exec(l)?.[1])).toEqual(['first', 'click']);
    });
  });

  // ─── Switches ─────────────────────────────────────────────────────────────

  describe('switches', () => {
    const sshArgv = (): string[] => {
      const t = parseSshTarget(['ssh', 'dev@h'], '/w', 'Ubuntu');
      if ('error' in t) throw new Error(t.error);
      return remoteInvocation(t, 'true', [], () => 'ssh').args;
    };
    const localArgv = ['-d', 'Ubuntu', '--cd', '/r', '--exec', 'git', 'status'];

    it('WMUX_SSH_WORKER=0 switches both places off', () => {
      configureExecWorker();
      onPlatform('win32', () => {
        expect(isWorkerRoute(sshArgv())).toBe(true);
        expect(isWorkerRoute(localArgv, {})).toBe(true);
        process.env.WMUX_SSH_WORKER = '0';
        expect(isWorkerRoute(sshArgv())).toBe(false);
        expect(isWorkerRoute(localArgv, {})).toBe(false);
      });
    });

    it('with it off, a WSL folder is spawns, no `via` anywhere, and the same answers', async () => {
      configureExecWorker({ enabled: false });
      const lines: string[] = [];
      configureExecTrace(true, (l) => lines.push(l));
      const ran = await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
      expect(ran.via).toBeUndefined();
      expect(ran.stdout.trim()).toBe(repo);
      expect(starts().workers).toHaveLength(0);
      // The per-call spawn is traced only through git(); here it is a direct call, so nothing is asserted about lines.
      expect(lines.every((l) => !l.includes('via='))).toBe(true);
      const ssh = await runSshRouted(fakeState.exe, sshArgv(), 5000, { idempotent: true });
      expect(ssh.via).toBeUndefined();
    });
  });

  // ─── Warm-up ──────────────────────────────────────────────────────────────

  describe('warm-up of the visible WSL workspace', () => {
    it('starts the distro worker ahead of the first call, which is then not cold', async () => {
      const lines: string[] = [];
      configureExecTrace(true, (l) => lines.push(l));
      await warmWorkspace('ws-wsl', cwd(), () => true);
      await settled(() => liveExecWorkerCount() === 1 && lines.some((l) => l.includes('op=worker:start')));
      expect(lines.find((l) => l.includes('op=worker:start'))).toMatch(/^ssh-trace op=worker:start loc=wsl ms=\d+ workers=1 reason=warm$/);
      expect(starts().workers).toHaveLength(1);
      expect(starts().workers[0].argv).toEqual(['-d', 'Ubuntu', '--exec', 'sh', '-c', WORKER_REMOTE_COMMAND]);
      const first = await gitCall(cwd(), ['rev-parse', '--show-toplevel']);
      expect(first.via).toBe('worker');
      expect(first.cold).toBeUndefined();
      expect(starts().workers).toHaveLength(1); // the request used the warm one
    });

    it('does nothing for a workspace that is not on screen, a folder that is not on a WSL share, or a switched-off worker', async () => {
      await warmWorkspace('ws-wsl', cwd(), () => false);
      await warmWorkspace('ws-wsl', cwd(), () => { throw new Error('gone'); });
      await warmWorkspace('ws-wsl', cwd(), async () => { throw new Error('gone'); });
      await warmWorkspace('ws-wsl', 'C:\\Users\\me\\repo', () => true);
      await warmWorkspace('ws-wsl', '\\\\server\\share\\repo', () => true);
      await warmWorkspace('ws-wsl', '', () => true);
      configureExecWorker({ enabled: false });
      await warmWorkspace('ws-wsl', cwd(), () => true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(starts().workers).toHaveLength(0);
      expect(liveExecWorkerCount()).toBe(0);
    });

    it('is asked once while it runs, and leaves a distro that has a worker alone', async () => {
      await warmWorkspace('ws-wsl', cwd(), () => true);
      await warmWorkspace('ws-wsl', cwd(), () => true);
      await warmWorkspace('ws-wsl', unc(path.join(repo, '.git')), () => true);
      await settled(() => liveExecWorkerCount() === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await warmWorkspace('ws-wsl', cwd(), () => true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(starts().workers).toHaveLength(1);
    });
  });

  // ─── Trace ────────────────────────────────────────────────────────────────

  describe('trace', () => {
    it('writes loc=wsl with via and cold on a call, and nothing about the folder, the distro or the call', async () => {
      const lines: string[] = [];
      configureExecTrace(true, (l) => lines.push(l));
      const { handleGitView: view } = await import('../../src/main/git-view');
      await view({ op: 'working', cwd: cwd(), worktree: cwd() });
      await view({ op: 'rangeDiff', cwd: cwd(), from: '', to: hash, file: 'a.txt' });
      await view({ op: 'working', cwd: cwd(), worktree: cwd() });
      const calls = lines.filter((l) => !l.startsWith('ssh-trace op=worker:'));
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const line of calls) {
        expect(line).toMatch(/^ssh-trace op=[a-z:-]+ loc=wsl prio=(fg|bg) wait=\d+ ms=\d+ exit=\d+ out=\d+ via=(worker|spawn)( cold=1)?$/);
      }
      expect(calls[0]).toMatch(/ via=worker cold=1$/);
      expect(calls.slice(1).every((l) => !l.includes('cold=1'))).toBe(true);
      expect(calls.some((l) => l.includes('op=git:batch'))).toBe(true);
      expect(calls.some((l) => l.includes('op=git:diff'))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain(tmp);
        expect(line).not.toContain('Ubuntu');
        expect(line).not.toContain('a.txt');
      }
      expect(lines.filter((l) => l.startsWith('ssh-trace op=worker:start')))
        .toEqual([expect.stringMatching(/^ssh-trace op=worker:start loc=wsl ms=\d+ workers=1 reason=first$/)]);
    });
  });
});
