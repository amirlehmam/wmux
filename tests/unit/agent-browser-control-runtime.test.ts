import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import {
  ensureStartedSession, getStartedSession, initializeAgentBrowserControl, releaseAgentSession,
  resumeAgentSessionCommands, runAgentBrowserForSession, runManagedAgentBrowser,
  sessionRegistry, setAgentControlPauseReporter, withAgentSessionTeardown, withAgentSessionWork,
} from '../../src/main/agent-browser-runtime';
import type { RunResult } from '../../src/main/agent-browser-cli';
import type { SurfaceId } from '../../src/shared/types';

const reply = (data: unknown): RunResult => ({ ok: true, spawnFailed: false,
  data: { success: true, data }, stdout: JSON.stringify({ success: true, data }), stderr: '' });

async function harness(name: string) {
  const id = `surf-runtime-${name}` as SurfaceId;
  const session = sessionRegistry.ensure(id);
  const binary = path.resolve('fixture-native.exe');
  const socketDir = path.resolve('fixture-native-state');
  const cdpUrl = 'ws://127.0.0.1:41234/devtools/browser/original';
  let active = true;
  let hook: ((argv: string[]) => Promise<RunResult> | RunResult | undefined) | undefined;
  const actions: string[][] = [];
  const calls: string[][] = [];
  const run = vi.fn(async (_binary: string, raw: string[]): Promise<RunResult> => {
    const argv = (raw[0] === '--session' ? raw.slice(2) : raw).filter((arg) => arg !== '--json');
    calls.push(argv);
    const overridden = hook?.(argv);
    if (overridden !== undefined) return overridden;
    if (argv[0] === '--version') return { ...reply(null), stdout: 'agent-browser 0.41.2', data: null };
    if (argv.join(' ') === 'session info') return reply({
      session: session.sessionName, namespace: null, socketDir, active, pid: active ? 123 : null,
      version: active ? '0.41.2' : null, runtimeError: null,
      runtime: active ? { session: session.sessionName, namespace: null, socketDir,
        backgroundPid: 123, browserLaunched: true } : null,
    });
    if (argv.join(' ') === 'get cdp-url') return reply({ cdpUrl });
    actions.push(argv);
    if (argv[0] === 'close') { active = false; return reply({ closed: true }); }
    if (argv.join(' ') === 'get url') return reply({ url: 'https://fixture.test/preserved' });
    return reply({});
  });
  const start = () => ensureStartedSession(id, undefined, {
    binary: () => binary, ensureSession: (id) => sessionRegistry.ensure(id), getSession: (id) => sessionRegistry.get(id),
    captureArgs: () => [], run,
    initializeControl: (session, executable) => initializeAgentBrowserControl(session, executable, {
      run, fingerprint: async () => ({ path: binary, identity: 'same-file' }),
      readPort: async (file) => file.endsWith('.stream') ? session.streamPort : 41235,
      probeBrowser: async (url) => url === cdpUrl,
    }),
  });
  await start();
  actions.length = 0;
  calls.length = 0;
  return { id, session, binary, actions, calls, start, setActive: (value: boolean) => { active = value; },
    setHook: (next: typeof hook) => { hook = next; },
    async cleanup() {
      hook = undefined;
      if (active) await runManagedAgentBrowser(binary, ['--session', session.sessionName, 'close'], 2000);
      releaseAgentSession(id);
      setAgentControlPauseReporter(() => {});
    } };
}

describe('shared CLI control integration', () => {
  it('forgets a proven absent daemon so explicit teardown can bootstrap a fresh control', async () => {
    const h = await harness('absent-close');
    try {
      h.setActive(false);
      const closed = await withAgentSessionTeardown(h.id, async () => {
        const result = await runManagedAgentBrowser(h.binary, ['--session', h.session.sessionName, 'close'], 2000);
        if (result.ok) releaseAgentSession(h.id);
        return result;
      });
      expect(closed.ok).toBe(true);
      expect(h.actions).toEqual([]);
      h.setActive(true);
      const session = await h.start();
      expect(getStartedSession(h.id)).toBe(session);
      expect(h.actions).toEqual([['--pin-tab', 'open']]);
      await runAgentBrowserForSession(['--session', session.sessionName, 'reload'], 2000);
      expect(h.actions.at(-1)).toEqual(['reload']);
    } finally { await h.cleanup(); }
  });

  it('serializes a pipe command behind an entire multi-step viewer operation', async () => {
    const h = await harness('order');
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    h.setHook((argv) => {
      if (argv[0] !== 'click') return undefined;
      h.actions.push(argv);
      return gate.then(() => reply({}));
    });
    try {
      const viewer = withAgentSessionWork(h.session, async (run) => {
        await run(['click', '@e1'], 2000);
        await run(['tab', 't2'], 2000);
      });
      await vi.waitFor(() => expect(h.actions).toHaveLength(1));
      const pipe = runAgentBrowserForSession(['--session', h.session.sessionName, 'fill', '@e2', 'text'], 2000);
      expect(h.actions).toEqual([['click', '@e1']]);
      complete();
      await Promise.all([viewer, pipe]);
      expect(h.actions).toEqual([['click', '@e1'], ['tab', 't2'], ['fill', '@e2', 'text']]);
    } finally { complete(); await h.cleanup(); }
  });

  it('pauses both callers on an unknown outcome and resumes only through the explicit barrier', async () => {
    const h = await harness('resume');
    const report = vi.fn();
    setAgentControlPauseReporter(report);
    h.setHook((argv) => {
      if (argv[0] !== 'click') return undefined;
      h.actions.push(argv);
      return { ...reply(null), ok: false, timedOut: true, data: null, stderr: 'CLI timed out' };
    });
    try {
      await expect(runAgentBrowserForSession(['--session', h.session.sessionName, 'click', '@e1'], 2000)).rejects.toThrow(/timed out/);
      expect(report).toHaveBeenCalledWith(h.id, expect.stringContaining('paused'));
      const calls = h.calls.length;
      await expect(withAgentSessionWork(h.session, (run) => run(['reload'], 2000))).rejects.toThrow(/paused/);
      expect(h.calls).toHaveLength(calls);
      h.setHook(undefined);
      const check = vi.fn(async () => {});
      await resumeAgentSessionCommands(h.session, check);
      expect(check.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(h.calls.slice(calls)).toContainEqual(['get', 'cdp-url']);
      expect(h.actions).toEqual([['click', '@e1']]);
      await runAgentBrowserForSession(['--session', h.session.sessionName, 'reload'], 2000);
      expect(h.actions).toEqual([['click', '@e1'], ['reload']]);
    } finally { await h.cleanup(); }
  });

  it.each([false, true])('keeps queued close alive beyond caller waiting (released record: %s)', async (released) => {
    const h = await harness(`late-close-${released}`);
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    h.setHook((argv) => {
      if (argv[0] !== 'click') return undefined;
      h.actions.push(argv);
      return gate.then(() => reply({}));
    });
    vi.useFakeTimers();
    try {
      const running = runAgentBrowserForSession(['--session', h.session.sessionName, 'click', '@e1'], 10_000).catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.actions).toEqual([['click', '@e1']]);
      if (released) releaseAgentSession(h.id);
      const close = runManagedAgentBrowser(h.binary, ['--session', h.session.sessionName, 'close'], 1000);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await close).toMatchObject({ ok: false, stderr: expect.stringContaining('pending') });
      expect(h.actions).toEqual([['click', '@e1']]);
      complete();
      await vi.advanceTimersByTimeAsync(0);
      await running;
      expect(h.actions).toEqual([['click', '@e1'], ['close']]);
      if (released) {
        await expect(runAgentBrowserForSession(['--session', h.session.sessionName, 'reload'], 1000)).rejects.toThrow('identity is unavailable');
      } else {
        expect(await runManagedAgentBrowser(h.binary, ['--session', h.session.sessionName, 'close'], 1000)).toMatchObject({ ok: true });
        expect(h.actions).toEqual([['click', '@e1'], ['close']]);
      }
    } finally {
      complete();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      await h.cleanup();
    }
  });

  it('fences a detached session during preflight but preserves guarded teardown readback', async () => {
    const h = await harness('teardown');
    let invalidate = true;
    h.setHook((argv) => {
      if (argv.join(' ') === 'session info' && invalidate) {
        invalidate = false;
        releaseAgentSession(h.id);
      }
      return undefined;
    });
    try {
      await expect(runAgentBrowserForSession(['--session', h.session.sessionName, 'reload'], 2000)).rejects.toThrow(/cancelled|stale|available/);
      expect(h.actions).toEqual([]);
      expect(getStartedSession(h.id)).toBeUndefined();
      h.setHook(undefined);
      const result = await withAgentSessionTeardown(h.id, () => runManagedAgentBrowser(
        h.binary, ['--session', h.session.sessionName, '--json', 'get', 'url'], 2000,
      ));
      expect(result.data).toEqual({ success: true, data: { url: 'https://fixture.test/preserved' } });
      expect(h.actions).toEqual([['get', 'url']]);
    } finally { await h.cleanup(); }
  });
});
