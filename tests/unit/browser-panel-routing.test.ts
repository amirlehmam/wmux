import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  windows: [] as any[],
  focused: null as any,
  ids: new Map<string, number>(),
  guests: new Map<number, any>(),
  bridge: {
    wcIdForSurface: vi.fn((id: string): number | null => env.ids.get(id) ?? null),
    surfaceIdFor: vi.fn(() => 'panel'),
    isAttached: true,
    attachedWebContentsId: 999,
    navigate: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ tree: 'panel', refCount: 0 })),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    screenshot: vi.fn(async () => 'PNG'),
    getText: vi.fn(async () => 'text'),
    evaluate: vi.fn(async () => 42),
    wait: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => env.windows, getFocusedWindow: () => env.focused },
  webContents: { fromId: (id: number) => env.guests.get(id) },
}));
vi.mock('../../src/main/ipc-handlers', () => ({ cdpBridge: env.bridge }));
vi.mock('../../src/main/browser-keep-rendering', () => ({ keepRenderingLeases: { touch: vi.fn(async () => {}) } }));
vi.mock('../../src/main/agent-browser-runtime', async (original) => ({
  withDeadline: (await original<typeof import('../../src/main/agent-browser-runtime')>()).withDeadline,
  acquireDashboardFor: vi.fn(),
  ensureStartedSession: vi.fn(),
  runAgentBrowserForSession: vi.fn(),
}));

import { handleBrowserV2 } from '../../src/main/v2-browser';

function windowWithPanel(id: number, workspace = `ws-${id}`, caller = `caller-${id}`) {
  let closed = false;
  let docked = false;
  let destroyed = false;
  const surfaceId = `panel-${id}`;
  const panelTarget = vi.fn((requested: string | undefined, reveal: boolean, owner?: string) => {
    if (requested !== undefined && requested !== workspace) return { error: 'Unknown workspace' };
    if (owner !== undefined && owner !== caller) return { error: 'Caller moved' };
    if (docked) return { error: 'Panel is docked' };
    if (closed && !reveal) return { error: 'Panel is closed' };
    if (reveal) closed = false;
    return { surfaceId };
  });
  const globals = {
    __wmux_locateSurface: vi.fn((surface: string) => surface === caller ? { workspaceId: workspace } : null),
    __wmux_browserPanelTarget: panelTarget,
    __wmux_splitPane: vi.fn(),
    __wmux_getBrowserEngine: vi.fn(() => 'agent'),
  };
  const win = {
    id,
    isDestroyed: () => destroyed,
    webContents: { executeJavaScript: vi.fn(async (js: string) => Function('window', `return ${js}`)(globals)) },
  };
  env.windows.push(win);
  env.ids.set(surfaceId, id);
  env.guests.set(id, { isDestroyed: () => false, hostWebContents: win.webContents });
  return {
    win, globals, panelTarget, surfaceId,
    close: () => { closed = true; },
    dock: () => { docked = true; },
    destroy: () => { destroyed = true; },
    isClosed: () => closed,
  };
}

function request(method: string, params: any = { panel: true }): Promise<any> {
  return new Promise((resolve) => handleBrowserV2(method, params,
    (result) => resolve({ result }), (code, message) => resolve({ error: { code, message } })));
}

beforeEach(() => {
  vi.clearAllMocks();
  env.windows = [];
  env.focused = null;
  env.ids.clear();
  env.guests.clear();
});
afterEach(() => vi.useRealTimers());

describe('explicit panel page commands', () => {
  const verbs: Array<[string, any, keyof typeof env.bridge, any[]]> = [
    ['navigate', { url: 'https://localhost:5173' }, 'navigate', ['https://localhost:5173', undefined, 2]],
    ['snapshot', {}, 'snapshot', [2]],
    ['click', { ref: 'e1' }, 'click', ['e1', 2]],
    ['type', { ref: 'e1', text: 'hello' }, 'type', ['e1', 'hello', 2]],
    ['fill', { ref: 'e1', value: 'hello' }, 'fill', ['e1', 'hello', 2]],
    ['screenshot', { fullPage: true }, 'screenshot', [true, 2]],
    ['get_text', { ref: 'e1' }, 'getText', ['e1', 2]],
    ['eval', { js: '1+1' }, 'evaluate', ['1+1', 2]],
    ['wait', { ref: 'e1', timeout: 123 }, 'wait', ['e1', 123, 2]],
    ['back', {}, 'goBack', [2]],
    ['forward', {}, 'goForward', [2]],
    ['reload', {}, 'reload', [2]],
  ];
  it.each(verbs)('routes %s to the caller workspace panel in another window', async (verb, params, bridgeMethod, args) => {
    const other = windowWithPanel(1);
    const owner = windowWithPanel(2);
    env.focused = other.win;
    const reply = await request(`browser.${verb}`, { ...params, panel: true, caller: 'caller-2' });
    expect(reply.error).toBeUndefined();
    expect(env.bridge[bridgeMethod]).toHaveBeenCalledWith(...args);
    expect(owner.panelTarget).toHaveBeenCalledWith('ws-2', verb === 'navigate', 'caller-2');
    expect(other.panelTarget).not.toHaveBeenCalled();
    expect(owner.globals.__wmux_splitPane).not.toHaveBeenCalled();
  });

  it('uses only a focused live window when no caller was supplied', async () => {
    const first = windowWithPanel(1);
    const focused = windowWithPanel(2);
    env.focused = focused.win;
    expect((await request('browser.snapshot')).error).toBeUndefined();
    expect(focused.panelTarget).toHaveBeenCalledWith(undefined, false, undefined);
    expect(first.panelTarget).not.toHaveBeenCalled();
    env.focused = null;
    expect((await request('browser.snapshot')).error.code).toBe(-32000);
    env.focused = first.win;
    first.destroy();
    expect((await request('browser.snapshot')).error.code).toBe(-32000);
  });

  it('refuses stale callers rather than adopting the focused workspace', async () => {
    const focused = windowWithPanel(1);
    env.focused = focused.win;
    expect((await request('browser.navigate', { panel: true, caller: 'gone', url: 'https://example.com' })).error.code).toBe(-32000);
    expect(focused.panelTarget).not.toHaveBeenCalled();
    expect(env.bridge.navigate).not.toHaveBeenCalled();
  });

  it('fails closed for a closed non-navigation target and a docked navigation target', async () => {
    const panel = windowWithPanel(1);
    env.focused = panel.win;
    panel.close();
    expect((await request('browser.reload')).error.message).toMatch(/closed/);
    expect(panel.isClosed()).toBe(true);
    panel.dock();
    expect((await request('browser.navigate', { panel: true, url: 'https://example.com' })).error.message).toMatch(/docked/);
    expect(panel.isClosed()).toBe(true);
    expect(env.bridge.navigate).not.toHaveBeenCalled();
  });

  it('reveals a closed panel for valid web navigation and uses the normal CDP runner', async () => {
    const panel = windowWithPanel(1);
    panel.close();
    env.focused = panel.win;
    expect(await request('browser.navigate', { panel: true, url: 'http://localhost:3000' })).toEqual({ result: { ok: true } });
    expect(panel.isClosed()).toBe(false);
    expect(env.bridge.navigate).toHaveBeenCalledWith('http://localhost:3000', undefined, 1);
  });

  it.each([undefined, null, 42, '', 'not a URL', 'javascript:alert(1)', 'file:///tmp/test', 'ftp://example.com', 'https://'])('rejects invalid navigation %s before lookup or reveal', async (url) => {
    const panel = windowWithPanel(1);
    env.focused = panel.win;
    const reply = await request('browser.navigate', { panel: true, url });
    expect(reply.error.code).toBe(-32602);
    expect(panel.win.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it.each([{ panel: false }, { panel: null }, { panel: 'true' }, { panel: 1 },
    { panel: true, surfaceId: 'surf-x' }, { panel: true, caller: '' }, { panel: true, caller: null }])('rejects invalid panel targeting %j', async (params) => {
    windowWithPanel(1);
    expect((await request('browser.snapshot', params)).error.code).toBe(-32602);
    expect(env.bridge.snapshot).not.toHaveBeenCalled();
  });

  it('does not use the shared attachment when the renderer bridge is missing or rejects', async () => {
    const panel = windowWithPanel(1);
    env.focused = panel.win;
    panel.win.webContents.executeJavaScript.mockResolvedValueOnce(undefined);
    expect((await request('browser.snapshot')).error.code).toBe(-32000);
    panel.win.webContents.executeJavaScript.mockRejectedValueOnce(new Error('reloading'));
    expect((await request('browser.snapshot')).error.message).toBe('reloading');
    expect(env.bridge.snapshot).not.toHaveBeenCalled();
  });

  it('rejects a per-ID attachment hosted by another window', async () => {
    const panel = windowWithPanel(1);
    const other = windowWithPanel(2);
    env.focused = panel.win;
    env.ids.set(panel.surfaceId, 2);
    expect((await request('browser.snapshot')).error.message).toMatch(/does not belong/);
    expect(env.bridge.snapshot).not.toHaveBeenCalled();
    expect(other.panelTarget).not.toHaveBeenCalled();
  });

  it('times out a missing per-ID attachment without falling back to shared', async () => {
    vi.useFakeTimers();
    const panel = windowWithPanel(1);
    env.focused = panel.win;
    env.ids.clear();
    const reply = request('browser.snapshot');
    await vi.advanceTimersByTimeAsync(5100);
    expect((await reply).error.code).toBe(-32000);
    expect(env.bridge.snapshot).not.toHaveBeenCalled();
  });

  it('does not reveal after a caller lookup completes beyond its readiness deadline', async () => {
    vi.useFakeTimers();
    const panel = windowWithPanel(1);
    panel.close();
    let finish!: (value: any) => void;
    panel.win.webContents.executeJavaScript.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reply = request('browser.navigate', { panel: true, caller: 'caller-1', url: 'https://example.com' });
    await vi.advanceTimersByTimeAsync(5100);
    expect((await reply).error.code).toBe(-32000);
    finish({ workspaceId: 'ws-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.panelTarget).not.toHaveBeenCalled();
    expect(panel.isClosed()).toBe(true);
    expect(env.bridge.navigate).not.toHaveBeenCalled();
  });

  it('guards a renderer request that executes after the readiness deadline', async () => {
    vi.useFakeTimers();
    const panel = windowWithPanel(1);
    env.focused = panel.win;
    panel.close();
    let queued!: () => any;
    panel.win.webContents.executeJavaScript.mockImplementationOnce((js: string) => new Promise((resolve) => {
      queued = () => resolve(Function('window', `return ${js}`)(panel.globals));
    }));
    const reply = request('browser.navigate', { panel: true, url: 'https://example.com' });
    await vi.advanceTimersByTimeAsync(5100);
    expect((await reply).error.code).toBe(-32000);
    queued();
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.panelTarget).not.toHaveBeenCalled();
    expect(panel.isClosed()).toBe(true);
  });

  it('leaves unflagged legacy shared routing unchanged', async () => {
    const panel = windowWithPanel(1);
    expect(await request('browser.snapshot', {})).toEqual({ result: { tree: 'panel', refCount: 0 } });
    expect(env.bridge.snapshot).toHaveBeenCalledWith(999);
    expect(panel.panelTarget).not.toHaveBeenCalled();
  });
});

describe('panel engine operations', () => {
  it.each(['browser.get_engine', 'browser.set_engine'])('reports web for %s without waiting for CDP or mutating a surface engine', async (method) => {
    const panel = windowWithPanel(1);
    env.focused = panel.win;
    env.ids.clear();
    expect(await request(method, { panel: true, engine: 'web' })).toEqual({ result: { engine: 'web' } });
    expect(panel.panelTarget).toHaveBeenCalledWith(undefined, false, undefined);
    expect(env.bridge.wcIdForSurface).not.toHaveBeenCalled();
    expect(panel.globals.__wmux_getBrowserEngine).not.toHaveBeenCalled();
  });

  it('rejects the agent engine before resolving or revealing anything', async () => {
    const panel = windowWithPanel(1);
    env.focused = panel.win;
    expect((await request('browser.set_engine', { panel: true, engine: 'agent' })).error.code).toBe(-32602);
    expect(panel.panelTarget).not.toHaveBeenCalled();
  });

  it.each(['browser.get_engine', 'browser.set_engine'])('never opens a closed panel for %s', async (method) => {
    const panel = windowWithPanel(1);
    env.focused = panel.win;
    panel.close();
    expect((await request(method, { panel: true, engine: 'web' })).error.message).toMatch(/closed/);
    expect(panel.isClosed()).toBe(true);
  });
});

describe('panel batches', () => {
  it.each([
    { panel: true, commands: [{ method: 'browser.snapshot' }] },
    { commands: [{ method: 'browser.snapshot' }, { method: 'browser.snapshot', params: { panel: true } }] },
  ])('refuses unsupported panel selectors before executing any command', async (params) => {
    const panel = windowWithPanel(1);
    env.focused = panel.win;
    expect((await request('browser.batch', params)).error.code).toBe(-32602);
    expect(panel.win.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(env.bridge.snapshot).not.toHaveBeenCalled();
  });
});
