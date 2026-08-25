import { describe, it, expect, vi } from 'vitest';
import { engineOf } from '../../src/shared/types';
import type { SurfaceRef } from '../../src/shared/types';

// v2-browser reaches the real bridge through ipc-handlers, which pulls in
// node-pty and most of the main process at import time. Routing is
// dependency-injected, so the module only has to exist — nothing here reads it.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));
vi.mock('../../src/main/ipc-handlers', () => ({ cdpBridge: {} }));

import { runBrowserCommandForTarget, type BrowserDeps, type BrowserTarget } from '../../src/main/v2-browser';

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

    expect(runAgent).toHaveBeenCalledWith(['--session', 'wmux-surf-a', 'open', 'https://a']);
    expect(bridge.navigate).not.toHaveBeenCalled();
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

  it('answers ok:true for the action verbs on both engines', async () => {
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
