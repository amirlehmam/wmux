import { describe, it, expect, vi, beforeEach } from 'vitest';
import { engineOf } from '../../src/shared/types';
import type { SurfaceRef } from '../../src/shared/types';

/**
 * Mutable fakes for the three things v2-browser reaches out to: Electron's
 * windows, the CDP bridge (which lives in ipc-handlers, a module that pulls in
 * node-pty and most of the main process at import time), and the agent-browser
 * runtime singletons. Hoisted so the `vi.mock` factories can close over them.
 */
const env = vi.hoisted(() => ({
  windows: [] as any[],
  wcIdBySurface: new Map<string, number>(),
  acquired: [] as string[],
  /** Swappable so a test can make the dashboard hang or fail. */
  acquireImpl: async (_surfaceId: string): Promise<void> => {},
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => env.windows, getFocusedWindow: () => env.windows[0] ?? null },
}));
vi.mock('../../src/main/ipc-handlers', () => ({
  cdpBridge: {
    wcIdForSurface: (id: string) => env.wcIdBySurface.get(id) ?? null,
    get isAttached() { return env.wcIdBySurface.size > 0; },
    get attachedWebContentsId() { return [...env.wcIdBySurface.values()][0] ?? null; },
  },
}));
vi.mock('../../src/main/agent-browser-runtime', () => ({
  acquireDashboardFor: (surfaceId: string) => {
    env.acquired.push(surfaceId);
    return env.acquireImpl(surfaceId);
  },
  sessionRegistry: {
    ensure: (surfaceId: string) => ({
      surfaceId,
      sessionName: `wmux-${surfaceId}`,
      streamPort: 9300,
      dashboardUrl: `http://127.0.0.1:4848/?port=9300`,
    }),
  },
}));

import {
  handleBrowserV2,
  resolveBrowserTarget,
  runBrowserCommandForTarget,
  type BrowserDeps,
  type BrowserTarget,
} from '../../src/main/v2-browser';

describe('engineOf', () => {
  it('defaults an undefined engine to web', () => {
    const s = { id: 'surf-1', type: 'browser' } as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });

  it('returns an explicit engine', () => {
    const s = { id: 'surf-1', type: 'browser', browserEngine: 'agent' } as SurfaceRef;
    expect(engineOf(s)).toBe('agent');
  });

  it('treats a non-browser surface as web', () => {
    const s = { id: 'surf-1', type: 'terminal', browserEngine: 'agent' } as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });

  it('rejects an unknown engine string from a hand-edited session file', () => {
    const s = { id: 'surf-1', type: 'browser', browserEngine: 'evil' } as unknown as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });
});

// ── routing ────────────────────────────────────────────────────────────────

const SNAPSHOT = { tree: '- button "OK" [ref=e1]', refCount: 1 };

/** Every method the web branch can reach, each recording its own call. */
function makeBridge() {
  return {
    navigate: vi.fn(async () => {}),
    snapshot: vi.fn(async () => SNAPSHOT),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    screenshot: vi.fn(async () => 'BASE64'),
    getText: vi.fn(async () => 'hello page'),
    evaluate: vi.fn(async () => 42),
    wait: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  };
}

const ok = (data: unknown, stdout = ''): any => ({ ok: true, spawnFailed: false, data, stdout, stderr: '' });
const fail = (stderr: string, stdout = ''): any => ({ ok: false, spawnFailed: false, data: null, stdout, stderr });
const neverStarted = (): any => ({ ok: false, spawnFailed: true, data: null, stdout: '', stderr: '' });

function deps(bridge: any, runAgent: any = vi.fn()): BrowserDeps {
  return { bridge: bridge as any, runAgent };
}

const SESSION = {
  surfaceId: 'surf-a',
  sessionName: 'wmux-surf-a',
  streamPort: 9300,
  dashboardUrl: 'http://127.0.0.1:4848/?port=9300',
} as any;

const web = (wcId = 7): BrowserTarget => ({ kind: 'web', wcId });
const agent = (): BrowserTarget => ({ kind: 'agent', session: SESSION });

/** Every verb wmux exposes, with params good enough to build an argv. */
const ALL_VERBS: Array<[string, any]> = [
  ['browser.navigate', { url: 'https://a' }],
  ['browser.snapshot', {}],
  ['browser.click', { ref: 'e1' }],
  ['browser.type', { ref: 'e1', text: 'hi' }],
  ['browser.fill', { ref: 'e1', value: 'v' }],
  ['browser.screenshot', {}],
  ['browser.get_text', {}],
  ['browser.eval', { js: '1+1' }],
  ['browser.wait', { ref: 'e1' }],
  ['browser.back', {}],
  ['browser.forward', {}],
  ['browser.reload', {}],
];

describe('runBrowserCommandForTarget — engine dispatch', () => {
  it('sends a web target to the CDP bridge, and never shells out', async () => {
    const bridge = makeBridge();
    const runAgent = vi.fn();
    const res = await runBrowserCommandForTarget('browser.navigate', { url: 'https://a' }, web(7), deps(bridge, runAgent));

    expect(bridge.navigate).toHaveBeenCalledWith('https://a', undefined, 7);
    expect(runAgent).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });

  it('threads every web verb\'s arguments through in the order cdp-bridge expects', async () => {
    const bridge = makeBridge();
    const d = deps(bridge);
    await runBrowserCommandForTarget('browser.navigate', { url: 'u', timeout: 1234 }, web(3), d);
    await runBrowserCommandForTarget('browser.click', { ref: 'e1' }, web(3), d);
    await runBrowserCommandForTarget('browser.type', { ref: 'e1', text: 't' }, web(3), d);
    await runBrowserCommandForTarget('browser.fill', { ref: 'e1', value: 'v' }, web(3), d);
    await runBrowserCommandForTarget('browser.screenshot', { fullPage: true }, web(3), d);
    await runBrowserCommandForTarget('browser.get_text', { ref: 'e2' }, web(3), d);
    await runBrowserCommandForTarget('browser.eval', { js: '1+1' }, web(3), d);
    await runBrowserCommandForTarget('browser.wait', { ref: 'e1', timeout: 99 }, web(3), d);
    await runBrowserCommandForTarget('browser.back', {}, web(3), d);
    await runBrowserCommandForTarget('browser.forward', {}, web(3), d);
    await runBrowserCommandForTarget('browser.reload', {}, web(3), d);

    expect(bridge.navigate).toHaveBeenCalledWith('u', 1234, 3);
    expect(bridge.click).toHaveBeenCalledWith('e1', 3);
    expect(bridge.type).toHaveBeenCalledWith('e1', 't', 3);
    expect(bridge.fill).toHaveBeenCalledWith('e1', 'v', 3);
    expect(bridge.screenshot).toHaveBeenCalledWith(true, 3);
    expect(bridge.getText).toHaveBeenCalledWith('e2', 3);
    expect(bridge.evaluate).toHaveBeenCalledWith('1+1', 3);
    expect(bridge.wait).toHaveBeenCalledWith('e1', 99, 3);
    expect(bridge.goBack).toHaveBeenCalledWith(3);
    expect(bridge.goForward).toHaveBeenCalledWith(3);
    expect(bridge.reload).toHaveBeenCalledWith(3);
  });

  it('sends an agent target to the CLI with the session pinned, and never touches the bridge', async () => {
    const bridge = makeBridge();
    const runAgent = vi.fn(async () => ok({ url: 'https://a' }));
    await runBrowserCommandForTarget('browser.navigate', { url: 'https://a' }, agent(), deps(bridge, runAgent));

    expect(runAgent).toHaveBeenCalledWith(['--session', 'wmux-surf-a', 'open', 'https://a'], expect.any(Number));
    expect(bridge.navigate).not.toHaveBeenCalled();
  });

  // A server budget above the CLI's client deadline is not a longer budget, it
  // is an unreportable one: the client has already hung up and printed a bare
  // `timed out`, so the server's real diagnosis never reaches the user.
  // browser-timeout.test.ts pins the actual numbers against src/cli/wmux.ts;
  // this pins that a budget is passed at all, per verb.
  it('bounds every agent invocation with a per-verb timeout', async () => {
    const runAgent = vi.fn(async () => ok({}));
    const d = deps(makeBridge(), runAgent);
    await runBrowserCommandForTarget('browser.navigate', { url: 'u' }, agent(), d);
    await runBrowserCommandForTarget('browser.snapshot', {}, agent(), d);
    await runBrowserCommandForTarget('browser.wait', { timeout: 777 }, agent(), d);

    const budgets = runAgent.mock.calls.map((c: any[]) => c[1]);
    for (const ms of budgets) expect(ms).toBeGreaterThan(0);
    // navigate is a page load; a click is not. They must not share a budget.
    expect(budgets[0]).toBeGreaterThan(budgets[1]);
    // An explicit caller timeout is honoured rather than replaced by a default.
    expect(budgets[2]).toBe(777);
  });

  it('never spawns a process for a verb the agent engine cannot express', async () => {
    const runAgent = vi.fn();
    await expect(
      runBrowserCommandForTarget('browser.teleport', {}, agent(), deps(makeBridge(), runAgent)),
    ).rejects.toThrow(/Unknown/);
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe('runBrowserCommandForTarget — agent failures', () => {
  it('surfaces a CLI-reported failure as an error carrying stderr', async () => {
    const runAgent = vi.fn(async () => fail('chrome not installed'));
    await expect(
      runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), runAgent)),
    ).rejects.toThrow(/chrome not installed/);
  });

  it('falls back to stdout when a failing CLI said nothing on stderr', async () => {
    const runAgent = vi.fn(async () => fail('', 'no such session'));
    await expect(
      runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), runAgent)),
    ).rejects.toThrow(/no such session/);
  });

  // spawnFailed and a non-zero exit are opposite problems: one is a wmux/install
  // fault (the resolved binary went stale), the other is the CLI reporting on a
  // page. Echoing an empty stderr for the first reads like a broken install with
  // no explanation, which is exactly what it must not do.
  it('reports a process that never started as a launch failure, not as empty stderr', async () => {
    const runAgent = vi.fn(async () => neverStarted());
    const err = await runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), runAgent))
      .then(() => null, (e: any) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/could not be launched/i);
    expect(err.spawnFailed).toBe(true);
  });

  it('gives a launch failure a different message from a CLI failure', async () => {
    const launch = await runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), vi.fn(async () => neverStarted())))
      .then(() => null, (e: any) => e);
    const cliFailure = await runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(makeBridge(), vi.fn(async () => fail('boom'))))
      .then(() => null, (e: any) => e);

    expect(launch.message).not.toBe(cliFailure.message);
    expect(cliFailure.spawnFailed).toBeFalsy();
  });
});

describe('the two engines are indistinguishable to a caller', () => {
  // A caller must not be able to tell which engine it got by the error it
  // receives for a verb neither supports — same message, same JSON-RPC code.
  it('rejects an unknown verb byte-identically on both engines', async () => {
    const d = deps(makeBridge(), vi.fn());
    const fromWeb = await runBrowserCommandForTarget('browser.nope', {}, web(), d).then(() => null, (e: any) => e);
    const fromAgent = await runBrowserCommandForTarget('browser.nope', {}, agent(), d).then(() => null, (e: any) => e);

    expect(fromWeb.message).toBe('Unknown: browser.nope');
    expect(fromAgent.message).toBe(fromWeb.message);
    expect(fromWeb.rpcCode).toBe(-32601);
    expect(fromAgent.rpcCode).toBe(-32601);
  });

  it('maps every verb wmux exposes onto the agent engine', async () => {
    // The guard that catches a 13th verb being added to the web switch and
    // forgotten in the translation table: it would throw -32601 here.
    const runAgent = vi.fn(async () => ok({}));
    for (const [method, params] of ALL_VERBS) {
      const err = await runBrowserCommandForTarget(method, params, agent(), deps(makeBridge(), runAgent))
        .then(() => null, (e: any) => e);
      expect(err?.rpcCode, `${method} is unmapped on the agent engine`).not.toBe(-32601);
    }
    expect(runAgent).toHaveBeenCalledTimes(ALL_VERBS.length);
  });

  it('returns the same result shape from both engines for snapshot', async () => {
    const bridge = makeBridge();
    const fromWeb = await runBrowserCommandForTarget('browser.snapshot', {}, web(), deps(bridge));
    const fromAgent = await runBrowserCommandForTarget('browser.snapshot', {}, agent(), deps(bridge, vi.fn(async () => ok(SNAPSHOT))));

    expect(Object.keys(fromAgent).sort()).toEqual(Object.keys(fromWeb).sort());
    expect(fromAgent).toEqual(SNAPSHOT);
  });

  it('returns the same result shape from both engines for get_text', async () => {
    const bridge = makeBridge();
    const fromWeb = await runBrowserCommandForTarget('browser.get_text', {}, web(), deps(bridge));
    const fromAgent = await runBrowserCommandForTarget('browser.get_text', {}, agent(), deps(bridge, vi.fn(async () => ok(null, 'hello page'))));

    expect(fromWeb).toEqual({ text: 'hello page' });
    expect(Object.keys(fromAgent)).toEqual(Object.keys(fromWeb));
    expect(fromAgent.text).toBe('hello page');
  });

  it('returns the same result shape from both engines for screenshot', async () => {
    const bridge = makeBridge();
    const fromWeb = await runBrowserCommandForTarget('browser.screenshot', {}, web(), deps(bridge));
    const fromAgent = await runBrowserCommandForTarget('browser.screenshot', {}, agent(), deps(bridge, vi.fn(async () => ok({ data: 'BASE64' }))));

    expect(fromWeb).toEqual({ data: 'BASE64' });
    expect(Object.keys(fromAgent)).toEqual(Object.keys(fromWeb));
    expect(fromAgent.data).toBe('BASE64');
  });

  it('returns the same result shape from both engines for eval', async () => {
    const bridge = makeBridge();
    const fromWeb = await runBrowserCommandForTarget('browser.eval', { js: '1+1' }, web(), deps(bridge));
    const fromAgent = await runBrowserCommandForTarget('browser.eval', { js: '1+1' }, agent(), deps(bridge, vi.fn(async () => ok({ result: 42 }))));

    expect(fromWeb).toEqual({ result: 42 });
    expect(Object.keys(fromAgent)).toEqual(Object.keys(fromWeb));
    expect(fromAgent.result).toBe(42);
  });

  // A falsy-but-present result must survive the coercion: `?? `-chained
  // fallbacks would quietly replace `false`/`0`/`''` with the raw stdout.
  it('preserves a falsy eval result rather than falling through to stdout', async () => {
    const fromAgent = await runBrowserCommandForTarget(
      'browser.eval', { js: 'false' }, agent(),
      deps(makeBridge(), vi.fn(async () => ok({ result: false }, 'ignored'))),
    );
    expect(fromAgent).toEqual({ result: false });
  });

  it('answers ok:true for the action verbs on all engines', async () => {
    const bridge = makeBridge();
    for (const method of ['browser.navigate', 'browser.click', 'browser.type', 'browser.fill', 'browser.wait', 'browser.back', 'browser.forward', 'browser.reload']) {
      const params = { url: 'u', ref: 'e1', text: 't', value: 'v' };
      const fromWeb = await runBrowserCommandForTarget(method, params, web(), deps(bridge));
      const fromAgent = await runBrowserCommandForTarget(method, params, agent(), deps(bridge, vi.fn(async () => ok(null))));
      expect(fromAgent, method).toEqual(fromWeb);
      expect(fromAgent, method).toEqual({ ok: true });
    }
  });
});

// ── target resolution ──────────────────────────────────────────────────────

/**
 * A renderer window that answers the four `window.__wmux_*` globals
 * `resolveBrowserTarget` reaches for. Dispatch is on the global's name and the
 * first quoted argument, because that string of JS is genuinely how main talks
 * to the store.
 */
function fakeWindow(opts: {
  workspaceOf?: Record<string, string>;
  browsersIn?: Record<string, string[]>;
  engines?: Record<string, string>;
  created?: string;
  destroyed?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => opts.destroyed ?? false,
    webContents: {
      executeJavaScript: async (js: string) => {
        calls.push(js);
        const arg = /"([^"]+)"/.exec(js)?.[1] ?? '';
        if (js.includes('__wmux_getBrowserEngine')) return opts.engines?.[arg] ?? 'web';
        if (js.includes('__wmux_getWorkspaceIdForSurface')) return opts.workspaceOf?.[arg] ?? null;
        if (js.includes('__wmux_listBrowserSurfaces')) return opts.browsersIn?.[arg] ?? [];
        if (js.includes('__wmux_splitPane')) return opts.created ? { surfaceId: opts.created } : null;
        return null;
      },
    },
  };
}

// Module state (the #62 caller→browser binding) lives for the whole file, so
// every test uses its own caller id rather than trying to reset it.
let callerSeq = 0;
const nextCaller = () => `surf-caller-${++callerSeq}`;

function resetEnv(): void {
  env.windows = [];
  env.wcIdBySurface = new Map();
  env.acquired = [];
  env.acquireImpl = async () => {};
}

describe('resolveBrowserTarget — which engine a command lands on', () => {
  beforeEach(resetEnv);

  /**
   * THE regression this rewrite exists for.
   *
   * A surface toggled web → agent keeps its CDP registration: nothing calls
   * cdp.detach on a toggle and pruneDead() only drops DESTROYED webContents. So
   * wcIdForSurface returns a perfectly valid, NON-null id for an agent-mode
   * surface — and a resolver that only consults the engine when the wcId came
   * back null routes the command to the web engine, driving CDP against
   * agent-browser's own dashboard SPA and corrupting the pane the user is
   * watching. Silently.
   */
  it('routes to the agent engine for a toggled surface that still has a live wcId', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-toggled'] },
      engines: { 'surf-toggled': 'agent' },
    })];
    env.wcIdBySurface.set('surf-toggled', 5); // the stale-but-valid registration

    const target = await resolveBrowserTarget(caller);

    expect(target?.kind).toBe('agent');
    expect((target as any).session.sessionName).toBe('wmux-surf-toggled');
  });

  it('still routes an ordinary web surface to the bridge, wcId intact', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-web'] },
      engines: { 'surf-web': 'web' },
    })];
    env.wcIdBySurface.set('surf-web', 11);

    expect(await resolveBrowserTarget(caller)).toEqual({ kind: 'web', wcId: 11 });
  });

  // The second command for a caller takes the already-bound fast path, which
  // must notice a toggle that happened between the two.
  it('notices a toggle that happens after the caller is already bound', async () => {
    const caller = nextCaller();
    const engines: Record<string, string> = { 'surf-flip': 'web' };
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-flip'] },
      engines,
    })];
    env.wcIdBySurface.set('surf-flip', 7);

    expect((await resolveBrowserTarget(caller))?.kind).toBe('web');
    engines['surf-flip'] = 'agent'; // user flips the pane
    expect((await resolveBrowserTarget(caller))?.kind).toBe('agent');
  });

  // A surface that STARTED in agent mode and has no webview at all: the wcId
  // path gives up with null, which is the expected answer, not a failure.
  it('routes to the agent engine when there is no wcId to be had', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-native'] },
      engines: { 'surf-native': 'agent' },
    })];

    const target = await resolveBrowserTarget(caller);
    expect(target?.kind).toBe('agent');
  });

  /**
   * `firstWindow()` is `getAllWindows()[0]`, but a surface may live in window 2
   * — the #143 "window ≠ workspace" mistake. `resolveBrowserWcId` has the same
   * shape and its wrong answer is a benign fall-back to the shared browser;
   * a wrong answer about the ENGINE silently dispatches to the wrong one, so
   * this query has to poll every window and take the first affirmative.
   */
  it('asks every window, not just the first, which engine a surface is on (#143)', async () => {
    const caller = nextCaller();
    const engines: Record<string, string> = { 'surf-elsewhere': 'web' };
    const home = fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-elsewhere'] },
      engines,
    });
    env.windows = [home];
    env.wcIdBySurface.set('surf-elsewhere', 3);
    expect((await resolveBrowserTarget(caller))?.kind).toBe('web'); // binds the caller

    // A second window opens in front of the one holding the surface, and the
    // pane flips to agent mode. Window 0 knows nothing about either.
    env.windows = [fakeWindow({}), home];
    engines['surf-elsewhere'] = 'agent';

    expect((await resolveBrowserTarget(caller))?.kind).toBe('agent');
  });

  // The first command a caller issues used to poll 5s for a CDP attachment that
  // an agent-mode surface is never going to make — latency the CLI's own
  // deadline was spending at the same time.
  it('does not poll for a wcId that an agent surface will never produce', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-nopoll'] },
      engines: { 'surf-nopoll': 'agent' },
    })];

    const started = Date.now();
    expect((await resolveBrowserTarget(caller))?.kind).toBe('agent');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('treats a renderer that rejects the query as web rather than failing the command', async () => {
    const caller = nextCaller();
    const win = fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-noisy'] },
    });
    const inner = win.webContents.executeJavaScript;
    win.webContents.executeJavaScript = async (js: string) => {
      if (js.includes('__wmux_getBrowserEngine')) throw new Error('renderer went away');
      return inner(js);
    };
    env.windows = [win];
    env.wcIdBySurface.set('surf-noisy', 9);

    expect(await resolveBrowserTarget(caller)).toEqual({ kind: 'web', wcId: 9 });
  });
});

describe('the dashboard reference an agent command takes', () => {
  beforeEach(resetEnv);

  function agentWorld(caller: string, surfaceId: string): void {
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': [surfaceId] },
      engines: { [surfaceId]: 'agent' },
    })];
  }

  it('takes it for the surface the command actually runs against', async () => {
    const caller = nextCaller();
    agentWorld(caller, 'surf-dash');
    await resolveBrowserTarget(caller);
    expect(env.acquired).toEqual(['surf-dash']);
  });

  /**
   * The dashboard is a VIEWER. A cold `dashboard start` can take 30s, which is
   * longer than the CLI's entire client-side deadline for most verbs — so
   * waiting for it would turn "the viewer is slow" into "every browser command
   * times out". Resolution must complete while the acquire is still in flight.
   */
  it('does not wait for the dashboard to come up', async () => {
    const caller = nextCaller();
    agentWorld(caller, 'surf-slow');
    env.acquireImpl = () => new Promise<void>(() => {}); // never settles

    const target = await Promise.race([
      resolveBrowserTarget(caller),
      new Promise((r) => setTimeout(() => r('TIMED_OUT'), 1000)),
    ]);
    expect((target as any)?.kind).toBe('agent');
  });

  it('survives a dashboard that fails to start, and still returns a usable target', async () => {
    const caller = nextCaller();
    agentWorld(caller, 'surf-nodash');
    env.acquireImpl = async () => { throw new Error('dashboard failed to start'); };

    const target = await resolveBrowserTarget(caller);
    expect(target?.kind).toBe('agent');
  });
});

describe('handleBrowserV2 error codes', () => {
  beforeEach(resetEnv);

  const respondTo = (method: string, params: any) =>
    new Promise<{ code?: number; message?: string; result?: any }>((resolve) => {
      handleBrowserV2(method, params, (result) => resolve({ result }), (code, message) => resolve({ code, message }));
    });

  /**
   * The batch loop already forwarded `err.rpcCode ?? -32000` while this path
   * responded a flat -32000, so an unknown verb reported -32601 inside a batch
   * and -32000 as a single command — destroying, one frame up the stack, the
   * engine-indistinguishable -32601 the runner goes to some trouble to produce.
   */
  it('forwards the JSON-RPC code an unknown verb threw, rather than flattening it', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-codes'] },
    })];
    env.wcIdBySurface.set('surf-codes', 4);

    const single = await respondTo('browser.nope', { caller });
    expect(single.code).toBe(-32601);
    expect(single.message).toBe('Unknown: browser.nope');
  });

  it('agrees with the batch path on that code', async () => {
    const caller = nextCaller();
    env.windows = [fakeWindow({
      workspaceOf: { [caller]: 'ws-1' },
      browsersIn: { 'ws-1': ['surf-codes2'] },
    })];
    env.wcIdBySurface.set('surf-codes2', 4);

    const batch = await respondTo('browser.batch', { caller, commands: [{ method: 'browser.nope', params: {} }] });
    expect(batch.result.results[0].error.code).toBe(-32601);
  });

  it('still reports a browser that could not be opened as -32000', async () => {
    // No window at all: resolution returns null and nothing was ever attempted.
    const answer = await respondTo('browser.snapshot', { caller: nextCaller() });
    expect(answer.code).toBe(-32000);
    expect(answer.message).toBe('Could not open browser panel');
  });
});
