import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { AgentBrowserControl, type NativeCommandRunner } from '../../src/main/agent-browser-control';
import type { RunResult } from '../../src/main/agent-browser-cli';
import { sessionNameFor, type AgentSession } from '../../src/main/agent-browser-session';
import type { SurfaceId } from '../../src/shared/types';

function result(data: unknown, success = true): RunResult {
  const value = success ? { success, data } : { success, data: null, error: data };
  return { ok: true, spawnFailed: false, data: value, stdout: JSON.stringify(value), stderr: '' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(id = 'surf-one') {
  const surfaceId = id as SurfaceId;
  const session: AgentSession = { surfaceId, sessionName: sessionNameFor(surfaceId), streamPort: 9300, dashboardUrl: '' };
  const state = {
    pid: 123, version: '0.41.2', localVersion: '0.41.2', active: true, browserLaunched: true,
    socketDir: path.resolve('test-native-state'), port: 41234, streamPort: 9300,
    cdpUrl: 'ws://127.0.0.1:40000/devtools/browser/original', live: true,
    fingerprint: { path: path.resolve('agent-browser.exe'), identity: 'original-file' },
    coherent: true,
  };
  let hook: ((argv: string[], timeoutMs: number) => Promise<RunResult> | RunResult | undefined) | undefined;
  const calls: string[][] = [];
  const run = vi.fn(async (_binary: string, raw: string[], timeoutMs = 60_000): Promise<RunResult> => {
    const argv = raw[0] === '--session' ? raw.slice(2).filter((arg) => arg !== '--json') : raw;
    calls.push(argv);
    const overridden = hook?.(argv, timeoutMs);
    if (overridden !== undefined) return overridden;
    if (argv[0] === '--version') return { ...result(null), stdout: `agent-browser ${state.localVersion}\n`, data: null };
    if (argv.join(' ') === 'session info') return result({
      session: session.sessionName, namespace: null, socketDir: state.socketDir,
      active: state.active, pid: state.active ? state.pid : null, version: state.active ? state.version : null,
      runtimeError: null,
      runtime: state.active ? { session: session.sessionName, namespace: null, socketDir: state.socketDir,
        backgroundPid: state.coherent ? state.pid : state.pid + 1, browserLaunched: state.browserLaunched,
        launchHash: 'not-an-identity' } : null,
    });
    if (argv.join(' ') === 'get cdp-url') return result({ cdpUrl: state.cdpUrl });
    if (argv[0] === 'close') { state.active = false; state.browserLaunched = false; return result({ message: 'Browser closed' }); }
    return result({ value: argv.join(' ') });
  });
  const fingerprint = vi.fn(async () => ({ ...state.fingerprint }));
  const readPort = vi.fn(async (file: string) => file.endsWith('.stream') ? state.streamPort : state.port);
  const probeBrowser = vi.fn(async (url: string) => state.live && url === state.cdpUrl);
  const onPause = vi.fn();
  const control = new AgentBrowserControl(session, state.fingerprint.path, { run, fingerprint, readPort, probeBrowser, onPause });
  const actions = () => calls.filter((argv) => argv[0] !== '--version' && argv.join(' ') !== 'session info' && argv.join(' ') !== 'get cdp-url');
  return { control, state, session, run, calls, actions, fingerprint, readPort, probeBrowser, onPause,
    setHook: (next: typeof hook) => { hook = next; } };
}

async function paused(h: ReturnType<typeof harness>): Promise<void> {
  const unknown = result({ code: 'outcome_unknown' }, false);
  h.setHook((argv) => argv[0] === 'click' ? unknown : undefined);
  await expect(h.control.enqueue((run) => run(['click', '@e1']))).rejects.toThrow(/unknown/);
  h.setHook(undefined);
  expect(h.control.pauseMessage).toBeDefined();
}

afterEach(() => { vi.useRealTimers(); });

describe('AgentBrowserControl', () => {
  it('captures executable/version, coherent daemon, separate port files and exact browser endpoint after startup', async () => {
    const h = harness();
    await expect(h.control.enqueue((run) => run(['get', 'url']))).rejects.toThrow(/not initialized/);
    await h.control.initialize();
    expect(h.calls).toEqual([['--version'], ['session', 'info'], ['get', 'cdp-url'], ['session', 'info']]);
    expect(h.readPort.mock.calls.map(([file]) => path.basename(file))).toEqual([
      `${h.session.sessionName}.port`, `${h.session.sessionName}.stream`,
      `${h.session.sessionName}.port`, `${h.session.sessionName}.stream`,
    ]);
    expect(h.probeBrowser).toHaveBeenCalledWith(h.state.cdpUrl, expect.any(Number));
    expect(h.fingerprint).toHaveBeenCalledTimes(3);
    expect(h.control.pauseMessage).toBeUndefined();
    const output = await h.control.enqueue((run) => run(['get', 'url']));
    expect(output.data).toEqual({ success: true, data: { value: 'get url' } });
    expect(h.run.mock.calls.at(-2)?.[1]).toEqual(['--session', h.session.sessionName, '--json', 'get', 'url']);
  });

  it('keeps multi-step work atomic across callers, but not across independent sessions', async () => {
    const h = harness();
    const other = harness('surf-two');
    await Promise.all([h.control.initialize(), other.control.initialize()]);
    const entered = deferred<void>();
    const release = deferred<void>();
    h.setHook((argv) => argv[0] === 'first' ? (async () => {
      entered.resolve(); await release.promise; return result({});
    })() : undefined);
    const a = h.control.enqueue(async (run) => { await run(['first']); await run(['second']); });
    await entered.promise;
    const b = h.control.enqueue((run) => run(['third']));
    await other.control.enqueue((run) => run(['independent']));
    expect(h.actions()).toEqual([['first']]);
    release.resolve();
    await Promise.all([a, b]);
    expect(h.actions()).toEqual([['first'], ['second'], ['third']]);
  });

  it('bounds the shared FIFO to 256 work items', async () => {
    const h = harness();
    await h.control.initialize();
    const entered = deferred<void>();
    const release = deferred<void>();
    const active = h.control.enqueue(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const pending = Array.from({ length: 255 }, () => h.control.enqueue(() => undefined));
    await expect(h.control.enqueue(() => undefined)).rejects.toThrow(/queue is full/);
    release.resolve();
    await Promise.all([active, ...pending]);
  });

  it('rejects escaped runner capabilities, including a run not awaited by its owning work', async () => {
    const h = harness();
    await h.control.initialize();
    let escaped!: NativeCommandRunner;
    await h.control.enqueue((run) => { escaped = run; });
    await expect(escaped(['late'])).rejects.toThrow(/stale/);
    const gate = deferred<void>();
    let late!: Promise<RunResult>;
    await h.control.enqueue((run) => { late = run(['unawaited'], undefined, () => gate.promise); });
    const rejected = expect(late).rejects.toThrow(/stale/);
    gate.resolve();
    await rejected;
    expect(h.actions()).toEqual([]);
  });

  it.each(['pid', 'port', 'streamPort', 'version', 'socketDir', 'coherent', 'browser', 'binary'] as const)(
    'blocks a changed %s before ordinary dispatch', async (changed) => {
      const h = harness();
      await h.control.initialize();
      switch (changed) {
        case 'pid': h.state.pid++; break;
        case 'port': h.state.port++; break;
        case 'streamPort': h.state.streamPort++; break;
        case 'version': h.state.version = '0.42.0'; break;
        case 'socketDir': h.state.socketDir = path.resolve('other-state'); break;
        case 'coherent': h.state.coherent = false; break;
        case 'browser': h.state.cdpUrl = 'ws://127.0.0.1:40000/devtools/browser/replacement'; break;
        case 'binary': h.state.fingerprint.identity = 'upgraded-file'; break;
      }
      await expect(h.control.enqueue((run) => run(['click', '@e1']))).rejects.toThrow();
      expect(h.control.pauseMessage).toBeDefined();
      expect(h.actions()).toEqual([]);
      expect(h.calls.filter((argv) => argv.join(' ') === 'get cdp-url')).toHaveLength(1);
    },
  );

  it('checks identity and browser again before returning native effects', async () => {
    const h = harness();
    await h.control.initialize();
    h.setHook((argv) => {
      if (argv[0] === 'copy') { h.state.pid++; return result({ text: 'must not escape' }); }
      return undefined;
    });
    const effect = vi.fn();
    await expect(h.control.enqueue(async (run) => { const value = await run(['copy']); effect(value); })).rejects.toThrow(/identity changed/);
    expect(effect).not.toHaveBeenCalled();
  });

  it('fails a timed-out read alone, whether native or wmux gives up first', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.control.initialize();
    h.setHook((argv) => argv[0] === 'wait' ? { ...result({}), ok: false, timedOut: true }
      : argv[0] === 'snapshot' ? new Promise<RunResult>(() => {}) : undefined);
    await expect(h.control.enqueue((run) => run(['wait', '@e3']))).rejects.toThrow(/timed out/);
    const hung = h.control.enqueue((run) => run(['snapshot']), 20);
    const rejected = expect(hung).rejects.toThrow(/deadline expired/);
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(h.control.pauseMessage).toBeUndefined();
    expect(h.onPause).not.toHaveBeenCalled();
    await h.control.enqueue((run) => run(['click', '@e3']));
    expect(h.actions()).toEqual([['wait', '@e3'], ['snapshot'], ['click', '@e3']]);
  });

  it.each(['timeout', 'malformed', 'unknown', 'replacement'] as const)(
    'pauses immediately on %s without postflight native calls or replay', async (kind) => {
      const h = harness();
      await h.control.initialize();
      const entered = deferred<void>();
      const release = deferred<RunResult>();
      h.setHook((argv) => {
        if (argv[0] !== 'click') return undefined;
        entered.resolve();
        return release.promise;
      });
      const action = h.control.enqueue((run) => run(['click', '@e1']));
      const actionRejected = expect(action).rejects.toThrow();
      await entered.promise;
      const queued = h.control.enqueue((run) => run(['must-not-run']));
      const queuedRejected = expect(queued).rejects.toThrow(/stale/);
      const count = h.calls.length;
      const outcomes: Record<typeof kind, RunResult> = {
        timeout: { ...result({}), ok: false, timedOut: true },
        malformed: { ...result({}), data: null },
        unknown: result({ code: 'outcome_unknown' }, false),
        replacement: result({ lifecycle: { relaunchedBrowser: true } }),
      };
      release.resolve(outcomes[kind]);
      await Promise.all([actionRejected, queuedRejected]);
      expect(h.calls).toHaveLength(count);
      expect(h.onPause).toHaveBeenCalledTimes(1);
      h.setHook(undefined);
      await h.control.resume();
      await h.control.enqueue((run) => run(['fresh']));
      expect(h.actions()).toEqual([['click', '@e1'], ['fresh']]);
    },
  );

  it('normalizes exit-zero native errors and confirmation envelopes without auto-confirming or pausing', async () => {
    const h = harness();
    await h.control.initialize();
    const failure = result('Unknown ref: e1', false);
    const confirmation = result({ confirmation_required: true, token: 'not-for-auto-confirm' });
    h.setHook((argv) => argv[0] === 'fail' ? failure : argv[0] === 'confirm' ? confirmation : undefined);
    const failed = await h.control.enqueue((run) => run(['fail']));
    expect(failed).toEqual({ ...failure, ok: false, stderr: 'Unknown ref: e1' });
    expect(failed.data).toBe(failure.data);
    const unconfirmed = await h.control.enqueue((run) => run(['confirm']));
    expect(unconfirmed).toEqual({ ...confirmation, ok: false, stderr: 'Native command requires confirmation; no action was confirmed.' });
    expect(unconfirmed.data).toBe(confirmation.data);
    expect(failure.ok).toBe(true);
    expect(confirmation.ok).toBe(true);
    expect(h.control.pauseMessage).toBeUndefined();
    expect(h.actions()).toEqual([['fail'], ['confirm']]);
  });

  it('only interprets lifecycle flags on successes', async () => {
    const h = harness();
    await h.control.initialize();
    const failure = { ...result('known error', false), ok: false, stderr: 'known error',
      data: { success: false, error: 'known', data: { lifecycle: { launched: true } } } };
    h.setHook((argv) => argv[0] === 'fail' ? failure : undefined);
    expect(await h.control.enqueue((run) => run(['fail']))).toBe(failure);
    expect(h.control.pauseMessage).toBeUndefined();
  });

  it('preserves opaque payload text that resembles a session flag while rejecting a leading routing override', async () => {
    const h = harness();
    await h.control.initialize();
    for (const verb of ['fill', 'type']) {
      for (const text of ['--session', '--session=other']) {
        const argv = [verb, '@e1', text];
        expect((await h.control.enqueue((run) => run(argv))).ok).toBe(true);
        expect(h.run.mock.calls.at(-2)?.[1]).toEqual(['--session', h.session.sessionName, '--json', ...argv]);
      }
    }
    for (const argv of [['--session', 'other', 'get', 'url'], ['--session=other', 'get', 'url']]) {
      await expect(h.control.enqueue((run) => run(argv))).rejects.toThrow(/session is owned/);
    }
    expect(h.actions()).toHaveLength(4);
    expect(h.control.pauseMessage).toBeUndefined();
  });

  it('normalizes refused and unconfirmed URL handoffs even after ordinary work is cancelled', async () => {
    const h = harness();
    await h.control.initialize();
    h.control.cancelPending();
    for (const refusal of [result({ message: 'URL unavailable' }, false), result({ confirmation_required: true })]) {
      h.setHook((argv) => argv.join(' ') === 'get url' ? refusal : undefined);
      const output = await h.control.readback(1000);
      expect(output.ok).toBe(false);
      expect(output.stderr).toMatch(/URL unavailable|requires confirmation/);
      expect(output.data).toBe(refusal.data);
      expect(output.stdout).toBe(refusal.stdout);
    }
    expect(h.control.pauseMessage).toBeUndefined();
    expect(h.actions()).toEqual([['get', 'url'], ['get', 'url']]);
  });

  it('uses the read-only cdp-url barrier only on explicit paused recovery and never adopts a changed URL', async () => {
    const h = harness();
    await h.control.initialize();
    await paused(h);
    const count = h.calls.length;
    h.setHook((argv) => argv.join(' ') === 'get cdp-url'
      ? result({ cdpUrl: 'ws://127.0.0.1:40000/devtools/browser/replacement' }) : undefined);
    await expect(h.control.resume()).rejects.toThrow(/endpoint changed/);
    expect(h.control.pauseMessage).toBeDefined();
    expect(h.calls.slice(count)).toEqual([['session', 'info'], ['get', 'cdp-url']]);
    h.setHook(undefined);
    await h.control.resume();
    expect(h.control.pauseMessage).toBeUndefined();
    expect(h.actions()).toEqual([['click', '@e1']]);
  });

  it('refuses recovery before launch-capable reads when binary or daemon identity changes', async () => {
    const h = harness();
    await h.control.initialize();
    await paused(h);
    h.state.fingerprint.identity = 'changed';
    const count = h.calls.length;
    await expect(h.control.resume()).rejects.toThrow(/executable changed/);
    expect(h.calls).toHaveLength(count);
    h.state.fingerprint.identity = 'original-file';
    h.state.pid++;
    await expect(h.control.resume()).rejects.toThrow(/identity changed/);
    expect(h.calls.slice(count)).toEqual([['session', 'info']]);
    expect(h.control.pauseMessage).toBeDefined();
  });

  it('checks a recovery caller before dispatch and after async checks, limits concurrent recovery, and keeps a stale recovery paused', async () => {
    const h = harness();
    await h.control.initialize();
    await paused(h);
    const count = h.calls.length;
    await expect(h.control.resume(() => { throw new Error('wrong owner'); })).rejects.toThrow(/wrong owner/);
    expect(h.calls).toHaveLength(count);
    const entered = deferred<void>();
    const release = deferred<void>();
    let valid = true;
    h.probeBrowser.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return true; });
    const check = () => { if (!valid) throw new Error('stale owner'); };
    const recovery = h.control.resume(check);
    const rejected = expect(recovery).rejects.toThrow(/stale owner/);
    await entered.promise;
    await expect(h.control.resume()).rejects.toThrow(/already pending/);
    valid = false;
    release.resolve();
    await rejected;
    expect(h.control.pauseMessage).toBeDefined();
    expect(h.calls.slice(count)).toEqual([['session', 'info']]);
    await h.control.resume();
    expect(h.control.pauseMessage).toBeUndefined();
  });

  it('does not clear pause when the caller becomes stale after the recovery barrier', async () => {
    const h = harness();
    await h.control.initialize();
    await paused(h);
    let valid = true;
    h.setHook((argv) => {
      if (argv.join(' ') === 'get cdp-url') { valid = false; return result({ cdpUrl: h.state.cdpUrl }); }
      return undefined;
    });
    await expect(h.control.resume(() => { if (!valid) throw new Error('stale owner'); })).rejects.toThrow(/stale owner/);
    expect(h.control.pauseMessage).toBeDefined();
  });

  it('does not issue any native call for a healthy stream-only reconnect', async () => {
    const h = harness();
    await h.control.initialize();
    h.run.mockClear();
    const check = vi.fn();
    await h.control.resume(check);
    expect(h.run).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('checks an ordinary caller after preflight and before returning effects', async () => {
    const h = harness();
    await h.control.initialize();
    let valid = true;
    const check = () => { if (!valid) throw new Error('stale tab'); };
    h.probeBrowser.mockImplementationOnce(async () => { valid = false; return true; });
    await expect(h.control.enqueue((run) => run(['click'], undefined, check))).rejects.toThrow(/stale tab/);
    expect(h.actions()).toEqual([]);
    expect(h.control.pauseMessage).toBeUndefined();
    valid = true;
    h.setHook((argv) => { if (argv[0] === 'click') { valid = false; return result({}); } return undefined; });
    await expect(h.control.enqueue((run) => run(['click'], undefined, check))).rejects.toThrow(/stale tab/);
    expect(h.control.pauseMessage).toBeUndefined();
  });

  it('retains a partial daemon baseline for safe close if Chrome capture fails', async () => {
    const h = harness();
    h.state.live = false;
    await expect(h.control.initialize()).rejects.toThrow(/endpoint/);
    expect(h.control.pauseMessage).toBeDefined();
    await expect(h.control.resume()).rejects.toThrow(/incomplete/);
    const closed = await h.control.close(1000);
    expect(closed.ok).toBe(true);
    expect(h.actions()).toEqual([['close']]);
    expect(h.control.pauseMessage).toBeUndefined();
  });

  it('rejects mismatched startup versions and a binary changed during capture', async () => {
    const h = harness();
    h.state.localVersion = '0.42.0';
    await expect(h.control.initialize()).rejects.toThrow(/versions differ/);
    expect(h.calls).toEqual([['--version'], ['session', 'info']]);
    const changed = harness('surf-changed');
    changed.fingerprint.mockResolvedValueOnce({ ...changed.state.fingerprint });
    changed.state.fingerprint.identity = 'changed-during-capture';
    await expect(changed.control.initialize()).rejects.toThrow(/executable changed/);
    expect(changed.control.pauseMessage).toBeDefined();
  });

  it('serializes close behind active work, cancels queued work and permits an upgraded executable at the same recorded path', async () => {
    const h = harness();
    await h.control.initialize();
    const entered = deferred<void>();
    const release = deferred<RunResult>();
    h.setHook((argv) => { if (argv[0] === 'click') { entered.resolve(); return release.promise; } return undefined; });
    const active = h.control.enqueue((run) => run(['click']));
    const activeRejected = expect(active).rejects.toThrow(/stale/);
    await entered.promise;
    const queued = h.control.enqueue((run) => run(['queued']));
    const queuedRejected = expect(queued).rejects.toThrow(/stale/);
    h.state.fingerprint.identity = 'upgraded';
    const closing = h.control.close(1000);
    expect(h.actions()).toEqual([['click']]);
    release.resolve(result({}));
    await Promise.all([activeRejected, queuedRejected]);
    const closed = await closing;
    expect(closed.ok).toBe(true);
    expect(h.actions()).toEqual([['click'], ['close']]);
    expect(await h.control.close(1000)).toBe(closed);
    expect(h.actions()).toHaveLength(2);
  });

  it('preserves close intent behind a healthy command that outlasts the close budget', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.control.initialize();
    const entered = deferred<void>();
    h.setHook((argv) => {
      if (argv[0] !== 'click') return undefined;
      entered.resolve();
      return new Promise((resolve) => setTimeout(() => resolve(result({})), 8000));
    });
    const active = h.control.enqueue((run) => run(['click']));
    const activeRejected = expect(active).rejects.toThrow(/stale/);
    await entered.promise;
    const closing = h.control.close(3000);
    const completed = vi.fn();
    void closing.then(completed);
    expect(h.control.close(3000)).toBe(closing);
    await vi.advanceTimersByTimeAsync(3001);
    expect(completed).not.toHaveBeenCalled();
    expect(h.actions()).toEqual([['click']]);
    await vi.advanceTimersByTimeAsync(4999);
    await activeRejected;
    const closed = await closing;
    expect(closed.ok).toBe(true);
    expect(h.actions()).toEqual([['click'], ['close']]);
    const dispatched = h.run.mock.calls.find(([, argv]) => argv.includes('close'));
    expect(dispatched?.[2]).toBe(3000);
    expect(await h.control.close(3000)).toBe(closed);
    expect(h.actions()).toHaveLength(2);
  });

  it('still bounds executing cleanup and permits a failed close to be retried', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.control.initialize();
    const entered = deferred<void>();
    h.setHook((argv) => {
      if (argv[0] !== 'close') return undefined;
      entered.resolve();
      return new Promise(() => {});
    });
    const closing = h.control.close(3000);
    const rejected = expect(closing).rejects.toThrow(/deadline expired/);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(3001);
    await rejected;
    expect(h.control.pauseMessage).toBeDefined();
    h.setHook(undefined);
    expect((await h.control.close(3000)).ok).toBe(true);
    expect(h.actions()).toEqual([['close'], ['close']]);
  });

  it('refuses close for a replacement daemon, with no fallback spawning', async () => {
    const h = harness();
    await h.control.initialize();
    await paused(h);
    h.state.pid++;
    await expect(h.control.close(1000)).rejects.toThrow(/identity changed/);
    expect(h.actions()).toEqual([['click', '@e1']]);
  });

  it('proves an absent daemon closed without dispatching native close', async () => {
    const h = harness();
    await h.control.initialize();
    await paused(h);
    h.state.active = false;
    const closed = await h.control.close(1000);
    expect(closed.ok).toBe(true);
    expect(await h.control.close(1000)).toBe(closed);
    expect(h.actions()).toEqual([['click', '@e1']]);
    expect(h.control.pauseMessage).toBeUndefined();
    await expect(h.control.enqueue((run) => run(['reload']))).rejects.toThrow();
  });

  it('refuses a moved executable even on deliberate close', async () => {
    const h = harness();
    await h.control.initialize();
    h.state.fingerprint.path = path.resolve('replacement.exe');
    await expect(h.control.close(1000)).rejects.toThrow(/executable changed/);
    expect(h.actions()).toEqual([]);
  });

  it('keeps failed and confirmation-required closes retryable and does not retire a replacement discovered after close', async () => {
    const h = harness();
    await h.control.initialize();
    const failure = result('known close error', false);
    const confirmation = result({ confirmation_required: true });
    h.setHook((argv) => argv[0] === 'close' ? failure : undefined);
    const failed = await h.control.close(1000);
    expect(failed).toEqual({ ...failure, ok: false, stderr: 'known close error' });
    expect(failed.data).toBe(failure.data);
    h.setHook((argv) => argv[0] === 'close' ? confirmation : undefined);
    const unconfirmed = await h.control.close(1000);
    expect(unconfirmed).toEqual({ ...confirmation, ok: false, stderr: 'Native command requires confirmation; no action was confirmed.' });
    expect(unconfirmed.data).toBe(confirmation.data);
    expect(h.control.pauseMessage).toBeUndefined();
    expect(h.state.active).toBe(true);
    h.setHook((argv) => { if (argv[0] === 'close') { h.state.pid++; return result({}); } return undefined; });
    await expect(h.control.close(1000)).rejects.toThrow(/identity changed/);
    h.state.pid--;
    h.setHook(undefined);
    expect((await h.control.close(1000)).ok).toBe(true);
    expect(h.actions()).toEqual([['close'], ['close'], ['close'], ['close']]);
  });

  it('expires queued work before it can ever dispatch, even after the queue later drains', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.control.initialize();
    const entered = deferred<void>();
    const release = deferred<void>();
    const active = h.control.enqueue(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const expired = h.control.enqueue((run) => run(['expired']), 20);
    const rejected = expect(expired).rejects.toThrow(/deadline expired/);
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    release.resolve();
    await active;
    await h.control.enqueue((run) => run(['fresh']));
    expect(h.actions()).toEqual([['fresh']]);
    expect(h.control.pauseMessage).toBeUndefined();
  });

  it('includes async preflight and caller checks in the native command budget', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.control.initialize();
    h.probeBrowser.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(true), 12)));
    const check = () => new Promise<void>((resolve) => setTimeout(resolve, 3));
    const operation = h.control.enqueue((run) => run(['click'], 30, check), 100);
    await vi.advanceTimersByTimeAsync(25);
    await operation;
    const dispatched = h.run.mock.calls.find(([, argv]) => argv.includes('click'));
    expect(dispatched?.[2]).toBeLessThanOrEqual(12);
    expect(dispatched?.[2]).toBeGreaterThan(0);
    h.probeBrowser.mockImplementationOnce(() => new Promise(() => {}));
    const expired = h.control.enqueue((run) => run(['never'], 10));
    const rejected = expect(expired).rejects.toThrow(/deadline expired/);
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(h.actions()).toEqual([['click']]);
  });

  it('uses a bounded recovery barrier behind timed-out native work and discards the late result', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.control.initialize();
    const entered = deferred<void>();
    const late = deferred<RunResult>();
    h.setHook((argv) => { if (argv[0] === 'click') { entered.resolve(); return late.promise; } return undefined; });
    const action = h.control.enqueue((run) => run(['click'], 20));
    const rejected = expect(action).rejects.toThrow(/deadline expired/);
    await entered.promise;
    const count = h.calls.length;
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(h.calls).toHaveLength(count);
    expect(h.control.pauseMessage).toBeDefined();
    await h.control.resume();
    late.resolve(result({ lifecycle: { launched: true } }));
    await Promise.resolve();
    expect(h.control.pauseMessage).toBeUndefined();
    expect(h.actions()).toEqual([['click']]);
    expect(h.calls.slice(count)).toEqual([['session', 'info'], ['get', 'cdp-url'], ['session', 'info']]);
  });

  it('never clears pause when cancellation arrives during recovery checks', async () => {
    const h = harness();
    await h.control.initialize();
    await paused(h);
    const entered = deferred<void>();
    const release = deferred<boolean>();
    h.probeBrowser.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const recovery = h.control.resume();
    const rejected = expect(recovery).rejects.toThrow(/stale/);
    await entered.promise;
    const count = h.calls.length;
    h.control.cancelPending();
    release.resolve(true);
    await rejected;
    expect(h.control.pauseMessage).toBeDefined();
    expect(h.calls).toHaveLength(count);
    expect((await h.control.close(1000)).ok).toBe(true);
  });

  it('bounds recovery and keeps cancellation fenced, while still allowing explicit close', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.control.initialize();
    await paused(h);
    h.probeBrowser.mockImplementationOnce(() => new Promise(() => {}));
    const recovery = h.control.resume();
    const rejected = expect(recovery).rejects.toThrow(/deadline expired/);
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    expect(h.control.pauseMessage).toBeDefined();
    h.control.cancelPending();
    await expect(h.control.resume()).rejects.toThrow(/unavailable/);
    await expect(h.control.enqueue((run) => run(['late']))).rejects.toThrow();
    expect((await h.control.close(1000)).ok).toBe(true);
  });

  it('allows only guarded final URL readback after cancellation without reopening ordinary work', async () => {
    const h = harness();
    await h.control.initialize();
    const entered = deferred<void>();
    const release = deferred<RunResult>();
    h.setHook((argv) => { if (argv[0] === 'click') { entered.resolve(); return release.promise; } return undefined; });
    const active = h.control.enqueue((run) => run(['click']));
    const rejected = expect(active).rejects.toThrow(/stale/);
    await entered.promise;
    h.control.cancelPending();
    const handoff = h.control.readback(1000);
    release.resolve(result({}));
    await rejected;
    expect((await handoff).data).toEqual({ success: true, data: { value: 'get url' } });
    expect(h.control.pauseMessage).toBeUndefined();
    await expect(h.control.enqueue((run) => run(['late']))).rejects.toThrow(/unavailable/);
    await expect(h.control.resume()).rejects.toThrow(/unavailable/);
    expect(h.actions()).toEqual([['click'], ['get', 'url']]);
    await h.control.close(1000);
    await expect(h.control.readback(1000)).rejects.toThrow();
  });

  it('never performs readback after an uncertain outcome, even if it was queued while retiring', async () => {
    const h = harness();
    await h.control.initialize();
    const entered = deferred<void>();
    const release = deferred<RunResult>();
    h.setHook((argv) => { if (argv[0] === 'click') { entered.resolve(); return release.promise; } return undefined; });
    const active = h.control.enqueue((run) => run(['click']));
    const rejected = expect(active).rejects.toThrow(/unknown/);
    await entered.promise;
    h.control.cancelPending();
    const handoff = h.control.readback(1000);
    const handoffRejected = expect(handoff).rejects.toThrow(/paused/);
    release.resolve(result({ code: 'outcome_unknown' }, false));
    await Promise.all([rejected, handoffRejected]);
    await expect(h.control.readback(1000)).rejects.toThrow(/paused/);
    expect(h.actions()).toEqual([['click']]);
  });

  it('still guards retiring readback against daemon or executable changes', async () => {
    const h = harness();
    await h.control.initialize();
    h.control.cancelPending();
    h.state.pid++;
    await expect(h.control.readback(1000)).rejects.toThrow(/identity changed/);
    expect(h.actions()).toEqual([]);
  });

  it('fences cancellation during startup inspection before cdp discovery and retains safe close ownership', async () => {
    const h = harness();
    const entered = deferred<void>();
    const release = deferred<number>();
    h.readPort.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const startup = h.control.initialize();
    const rejected = expect(startup).rejects.toThrow(/stale/);
    await entered.promise;
    h.control.cancelPending();
    release.resolve(h.state.port);
    await rejected;
    expect(h.calls).toEqual([['--version'], ['session', 'info']]);
    expect(h.control.pauseMessage).toBeDefined();
    expect(h.control.initialize()).toBe(startup);
    await expect(h.control.initialize()).rejects.toThrow(/stale/);
    expect((await h.control.close(1000)).ok).toBe(true);
  });

  it('checks the executable again after the final startup probe', async () => {
    const h = harness();
    h.probeBrowser.mockImplementationOnce(async () => { h.state.fingerprint.identity = 'changed-during-probe'; return true; });
    await expect(h.control.initialize()).rejects.toThrow(/executable changed/);
    expect(h.control.pauseMessage).toBeDefined();
    await expect(h.control.enqueue((run) => run(['late']))).rejects.toThrow();
  });

  it('does not commit readiness when cancellation arrives during the final startup probe', async () => {
    const h = harness();
    const entered = deferred<void>();
    const release = deferred<boolean>();
    h.probeBrowser.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const startup = h.control.initialize();
    const rejected = expect(startup).rejects.toThrow(/stale/);
    await entered.promise;
    h.control.cancelPending();
    release.resolve(true);
    await rejected;
    await expect(h.control.readback(1000)).rejects.toThrow();
    expect((await h.control.close(1000)).ok).toBe(true);
  });

  it('does not publish a startup failure or readiness after disposal', async () => {
    const h = harness();
    const entered = deferred<void>();
    const release = deferred<number>();
    h.readPort.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const startup = h.control.initialize();
    const rejected = expect(startup).rejects.toThrow(/stale/);
    await entered.promise;
    h.control.dispose();
    release.resolve(h.state.port);
    await rejected;
    expect(h.control.pauseMessage).toBeUndefined();
    expect(h.onPause).not.toHaveBeenCalled();
    expect(h.calls).toEqual([['--version'], ['session', 'info']]);
    await expect(h.control.readback(1000)).rejects.toThrow();
  });

  it('invalidates late native results and pause reports on dispose without OS cleanup', async () => {
    const h = harness();
    await h.control.initialize();
    const entered = deferred<void>();
    const late = deferred<RunResult>();
    h.setHook((argv) => { if (argv[0] === 'click') { entered.resolve(); return late.promise; } return undefined; });
    const action = h.control.enqueue((run) => run(['click']));
    const rejected = expect(action).rejects.toThrow(/stale/);
    await entered.promise;
    h.control.dispose();
    late.resolve(result({ lifecycle: { launched: true } }));
    await rejected;
    expect(h.onPause).not.toHaveBeenCalled();
    expect(h.actions()).toEqual([['click']]);
    await expect(h.control.close(1000)).rejects.toThrow(/unavailable/);
  });
});
