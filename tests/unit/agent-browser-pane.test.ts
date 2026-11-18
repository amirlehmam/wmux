// @vitest-environment jsdom
import { act, createElement, useEffect, useImperativeHandle, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserPane, { disableTarget, engineTransition, resolveInputUrl, webviewHiding } from '../../src/renderer/components/Browser/BrowserPane';
import { create } from 'zustand';
import { createSurfaceSlice, type SurfaceSlice } from '../../src/renderer/store/surface-slice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createLeaf, findLeaf, splitNode } from '../../src/renderer/store/split-utils';
import type { PaneId, SplitNode, SurfaceId } from '../../src/shared/types';
import { ensureStartedSession, releaseAgentSession, type AgentBrowserStartupDeps } from '../../src/main/agent-browser-runtime';
import { SessionRegistry } from '../../src/main/agent-browser-session';
import { AgentBrowserViewer as MainAgentBrowserViewer } from '../../src/main/agent-browser-viewer';

const viewerAction = vi.hoisted(() => vi.fn(async (_action: unknown) => {}));
const viewerConnection = vi.hoisted(() => ({ autoConnect: true, connect: (_connected: boolean) => {} }));
const tabs = [
  { tabId: 't1', title: 'First', url: 'https://initial.test/', active: true },
  { tabId: 't9', title: 'Other', url: 'https://other.test/', active: false },
];
vi.mock('../../src/renderer/components/Browser/AgentBrowserViewer', () => ({
  default: function Viewer(props: { visible: boolean; ref: Ref<{ action: typeof viewerAction }>;
    onPageState: (url: string, title: string) => void; onConnection: (connected: boolean) => void; onTabs: (tabs: unknown[]) => void; onStartNew: () => void }) {
    useImperativeHandle(props.ref, () => ({ action: viewerAction }));
    useEffect(() => {
      viewerConnection.connect = props.onConnection;
      if (viewerConnection.autoConnect) props.onConnection(true);
    }, []);
    return createElement('div', {}, createElement('button', { 'data-viewer': String(props.visible), onClick: () => {
      props.onPageState('https://agent.test/next', 'Agent title');
      props.onTabs(tabs);
    } }, 'fixture page'), createElement('button', { onClick: props.onStartNew }, 'Start new session'));
  },
}));

let root: Root;
let container: HTMLDivElement;
let api: { enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
let loadURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  viewerAction.mockClear();
  viewerConnection.autoConnect = true;
  viewerConnection.connect = () => {};
  loadURL = vi.fn(async () => {});
  Object.defineProperty(HTMLElement.prototype, 'loadURL', { value: loadURL, configurable: true });
  api = { enable: vi.fn(async () => ({ installed: true, dashboardUrl: 'https://dashboard.test/' })),
    disable: vi.fn(async () => ({})), status: vi.fn(async () => ({ installed: true, dashboardAvailable: true })) };
  window.wmux = { agentBrowser: api };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (HTMLElement.prototype as any).loadURL;
  vi.useRealTimers();
});
const render = async (extra = {}) => {
  await act(async () => { root.render(createElement(BrowserPane, { surfaceId: 'surf-pane', engine: 'agent', initialUrl: 'https://initial.test/', ...extra })); });
};
const click = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === label)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
};

describe('Page presentation', () => {
  it('defaults to the page without waiting for dashboard status', async () => {
    api.status.mockImplementation(() => new Promise(() => {}));
    await render();
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(api.enable).toHaveBeenCalledTimes(1);
    expect(loadURL).not.toHaveBeenCalled();
  });

  it('retains only the latest address navigation until startup and viewer connection finish', async () => {
    viewerConnection.autoConnect = false;
    let finishEnable!: (value: { installed: boolean }) => void;
    api.enable.mockImplementationOnce(() => new Promise((resolve) => { finishEnable = resolve; }));
    await render();
    const submit = async (url: string) => {
      const input = container.querySelector('input')!;
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, url);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    };
    await submit('first.test');
    await submit('latest.test');
    expect(viewerAction).not.toHaveBeenCalled();
    await act(async () => finishEnable({ installed: true }));
    expect(viewerAction).not.toHaveBeenCalled();
    await act(async () => viewerConnection.connect(true));
    expect(viewerAction).toHaveBeenCalledExactlyOnceWith({ type: 'navigate', url: 'https://latest.test' });
    await act(async () => viewerConnection.connect(true));
    expect(viewerAction).toHaveBeenCalledOnce();
    expect(api.enable).toHaveBeenCalledOnce();
    expect(api.disable).not.toHaveBeenCalled();
  });

  it('keeps Page usable when the optional dashboard is unavailable', async () => {
    api.status.mockResolvedValue({ installed: true, dashboardAvailable: false });
    await render();
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(loadURL).not.toHaveBeenCalled();
  });

  it('round-trips Page/Dashboard inside the same outer pane without engine lifecycle calls', async () => {
    await render();
    const outer = container.querySelector('.browser-pane');
    const webview = container.querySelector('webview');
    await click('…');
    await click('Show dashboard');
    expect(container.querySelector('[data-viewer="false"]')).toBeTruthy();
    await click('…');
    await click('Return to page');
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(container.querySelector('.browser-pane')).toBe(outer);
    expect(container.querySelector('webview')).toBe(webview);
    expect(api.enable).toHaveBeenCalledTimes(1);
    expect(api.disable).not.toHaveBeenCalled();
  });

  it('passes hidden-workspace state down without disabling the session', async () => {
    await render();
    await render({ visible: false });
    expect(container.querySelector('[data-viewer="false"]')).toBeTruthy();
    expect(api.disable).not.toHaveBeenCalled();
    expect(api.enable).toHaveBeenCalledTimes(1);
  });

  it('takes authoritative streamed URL/title without launch-capable URL polling', async () => {
    vi.useFakeTimers();
    const onUrlChange = vi.fn(), onTitleChange = vi.fn();
    await render({ onUrlChange, onTitleChange });
    await click('fixture page');
    expect(onUrlChange).toHaveBeenCalledWith('https://agent.test/next');
    expect(onTitleChange).toHaveBeenCalledWith('Agent title');
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(api.enable).toHaveBeenCalledTimes(1);
  });

  it('routes menu, stable tab controls and refresh to Chrome even while showing Dashboard', async () => {
    await render({ onEngineChange: vi.fn() });
    expect(container.querySelector('.browser-pane__chrome-tabs')).toBeNull();
    await click('fixture page');
    expect(container.querySelectorAll('.browser-pane__chrome-tab')).toHaveLength(2);
    await click('Other');
    const close = container.querySelectorAll<HTMLButtonElement>('[aria-label="Close tab"]')[1];
    await act(async () => close.click());
    expect(viewerAction.mock.calls.map((call) => call[0])).toEqual([{ type: 'tab-select', tabId: 't9' }, { type: 'tab-close', tabId: 't9' }]);
    await click('…');
    await click('Show dashboard');
    await click('←');
    await click('→');
    await click('↻');
    await act(async () => document.dispatchEvent(new CustomEvent('wmux:refresh-surface', { detail: { surfaceId: 'surf-pane' } })));
    expect(viewerAction.mock.calls.slice(-4).map((call) => call[0])).toEqual([{ type: 'back' }, { type: 'forward' }, { type: 'reload' }, { type: 'reload' }]);
    await click('…');
    await click('New tab');
    expect(viewerAction).toHaveBeenLastCalledWith({ type: 'tab-new' });
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(document.activeElement).toBe(container.querySelector('input'));
    expect(container.querySelector('input')?.value).toBe('');
    expect(api.enable).toHaveBeenCalledOnce();
    expect(api.disable).not.toHaveBeenCalled();
  });

  it('preserves an address edit across authoritative agent URL/title updates until blur', async () => {
    await render();
    const input = container.querySelector('input')!;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'draft.example');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('fixture page');
    expect(input.value).toBe('draft.example');
    await act(async () => input.blur());
    expect(input.value).toBe('https://agent.test/next');
  });

  it('leaves Web refresh and address navigation on the guest, with no Agent menu', async () => {
    const reload = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'reload', { value: reload, configurable: true });
    try {
      await render({ engine: 'web' });
      expect(container.querySelector('[aria-label="Browser menu"]')).toBeNull();
      await act(async () => document.dispatchEvent(new CustomEvent('wmux:refresh-surface', { detail: { surfaceId: 'surf-pane' } })));
      expect(reload).toHaveBeenCalledOnce();
      await act(async () => window.dispatchEvent(new CustomEvent('wmux:browser-navigate', { detail: { surfaceId: 'surf-pane', url: 'example.com' } })));
      expect(loadURL).toHaveBeenLastCalledWith('https://example.com');
      expect(viewerAction).not.toHaveBeenCalled();
    } finally { delete (HTMLElement.prototype as any).reload; }
  });

  it('starts a deliberately fresh blank session via disable then enable, never the old streamed URL', async () => {
    await render();
    await click('fixture page');
    api.disable.mockClear();
    api.enable.mockClear();
    await click('Start new session');
    expect(api.disable).toHaveBeenCalledExactlyOnceWith('surf-pane', true);
    expect(api.enable).toHaveBeenCalledExactlyOnceWith('surf-pane', 'about:blank');
    expect(api.disable.mock.invocationCallOrder[0]).toBeLessThan(api.enable.mock.invocationCallOrder[0]);
  });

  it('reports failed close and explicitly retries it before any new startup', async () => {
    await render();
    api.disable.mockRejectedValueOnce(new Error('Close timed out'));
    await click('Start new session');
    expect(container.querySelector('[data-viewer]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Close timed out');
    expect(api.enable).toHaveBeenCalledOnce();
    await click('Try again');
    expect(api.disable).toHaveBeenCalledTimes(2);
    expect(api.enable).toHaveBeenLastCalledWith('surf-pane', 'about:blank');
  });

  it('retries a failed fresh close from unavailable Dashboard before opening only a blank session', async () => {
    api.status.mockResolvedValue({ installed: true, dashboardAvailable: false });
    await render();
    api.disable.mockRejectedValueOnce(new Error('Close failed'));
    await click('Start new session');
    await click('…');
    await click('Show dashboard');
    expect(container.textContent).toContain('The activity viewer did not start');
    let finishClose!: () => void;
    api.disable.mockImplementationOnce(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    await click('Try again');
    expect(api.disable).toHaveBeenLastCalledWith('surf-pane', true);
    expect(api.enable).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Starting browser session');
    await act(async () => finishClose());
    expect(api.enable).toHaveBeenCalledTimes(2);
    expect(api.enable).toHaveBeenLastCalledWith('surf-pane', 'about:blank');
  });

  it('clears fresh-start retry intent after success so a later Dashboard retry does not close the healthy session', async () => {
    api.status.mockResolvedValue({ installed: true, dashboardAvailable: false });
    await render();
    await click('Start new session');
    expect(api.disable).toHaveBeenCalledOnce();
    expect(api.enable).toHaveBeenCalledTimes(2);
    await click('…');
    await click('Show dashboard');
    await click('Try again');
    expect(api.disable).toHaveBeenCalledOnce();
    expect(api.enable).toHaveBeenCalledTimes(3);
  });

  it('does not renew startup after a pending fresh close completes after switching to Web', async () => {
    await render();
    let finish!: () => void;
    api.disable.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await click('Start new session');
    await render({ engine: 'web' });
    await act(async () => finish());
    expect(api.enable).toHaveBeenCalledOnce();
  });

  it('offers setup for a missing binary and returns from unavailable Dashboard without a new session', async () => {
    api.enable.mockResolvedValueOnce({ installed: false });
    await render();
    expect(container.textContent).toContain('Install');
    expect(container.querySelector('[data-viewer]')).toBeNull();
    await render({ engine: 'web' });
    api.status.mockResolvedValue({ installed: true, dashboardAvailable: false });
    await render();
    await click('…');
    await click('Show dashboard');
    expect(container.textContent).toContain('The activity viewer did not start');
    await click('…');
    await click('Return to page');
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(api.enable).toHaveBeenCalledTimes(2);
  });

  it('reports startup failure instead of presenting a ready page', async () => {
    api.enable.mockRejectedValue(new Error('Chrome startup failed'));
    await render();
    expect(container.querySelector('[data-viewer]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Chrome startup failed');
    api.enable.mockResolvedValueOnce({ installed: true });
    await click('Try again');
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
  });
});

describe('Agent surface lifetime belongs to the store, not the view', () => {
  const paneId = 'pane-retained' as PaneId;
  const neighborId = 'pane-neighbor' as PaneId;
  let surfaceId: SurfaceId;
  let nextSurface = 0;
  let defaultUrl: string | undefined;
  const makeStore = () => create<WorkspaceSlice & SurfaceSlice>()((...args) => ({
    ...createWorkspaceSlice(...args), ...createSurfaceSlice(...args),
  }));
  let store: ReturnType<typeof makeStore>;
  let workspaceId: ReturnType<WorkspaceSlice['createWorkspace']>;
  let launch: ReturnType<typeof vi.fn>;
  let viewerPolicy: MainAgentBrowserViewer;

  beforeEach(() => {
    surfaceId = `surf-retained-${nextSurface++}` as SurfaceId;
    defaultUrl = undefined;
    store = makeStore();
    workspaceId = store.getState().createWorkspace({ title: 'Agent', splitTree: {
      ...createLeaf(paneId, 'browser'),
      surfaces: [{ id: surfaceId, type: 'browser', browserEngine: 'agent', url: 'https://initial.test/' }],
    } });
    const registry = new SessionRegistry();
    launch = vi.fn(async () => ({ ok: true, spawnFailed: false, data: null, stdout: '', stderr: '' }));
    const deps: AgentBrowserStartupDeps = { binary: () => 'mock-native', run: launch,
      ensureSession: (id) => registry.ensure(id), getSession: (id) => registry.get(id), releaseSession: (id) => registry.release(id) };
    viewerPolicy = new MainAgentBrowserViewer({ session: (id) => registry.get(id),
      connect: vi.fn(), run: launch, readClipboard: () => '', writeClipboard: () => {} });
    api.enable.mockImplementation(async (id, url) => {
      if (!viewerPolicy.canEnable(id)) throw new Error('Browser session is paused. Retry Start new session before enabling it.');
      await ensureStartedSession(id, url, deps);
      return { installed: true };
    });
    api.disable.mockImplementation(async (id) => {
      viewerPolicy.forget(id);
      releaseAgentSession(id);
      registry.release(id);
      return {};
    });
  });

  afterEach(async () => {
    await act(async () => store.getState().closeWorkspace(workspaceId));
  });

  function Layout({ absent = false }: { absent?: boolean }) {
    const workspaces = store((s) => s.workspaces);
    const renderTree = (tree: SplitNode): ReturnType<typeof createElement> => {
      if (tree.type === 'branch') return createElement('div', { key: 'branch' }, ...tree.children.map(renderTree));
      const surface = tree.surfaces.find((s) => s.id === surfaceId);
      return createElement('section', { key: tree.paneId }, surface && !absent && createElement(BrowserPane, {
        surfaceId, engine: surface.browserEngine, initialUrl: surface.url || defaultUrl,
        onUrlChange: (url) => store.getState().updateSurface(workspaceId, tree.paneId, surfaceId, { url }),
      }));
    };
    return workspaces[0] ? renderTree(workspaces[0].splitTree) : null;
  }
  const layout = async (absent = false) => { await act(async () => root.render(createElement(Layout, { absent }))); };
  const patch = async (browserEngine: 'web' | 'agent') => {
    await act(async () => store.getState().updateSurface(workspaceId, paneId, surfaceId, { browserEngine }));
  };
  const savedUrl = () => findLeaf(store.getState().workspaces[0].splitTree, paneId)!.surfaces[0].url;

  it.each([false, true])('retains the same session across actual split/collapse remounts (startup pending: %s)', async (pending) => {
    let finish!: (value: Awaited<ReturnType<typeof launch>>) => void;
    if (pending) launch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await layout();
    const original = container.querySelector('.browser-pane');
    await act(async () => store.getState().updateSplitTree(workspaceId,
      splitNode(store.getState().workspaces[0].splitTree, paneId, neighborId, 'terminal', 'horizontal')));
    expect(container.querySelector('.browser-pane')).not.toBe(original);
    await act(async () => store.getState().closePane(workspaceId, neighborId));
    expect(api.disable).not.toHaveBeenCalled();
    expect(api.enable.mock.calls.map((call) => call[0])).toEqual([surfaceId, surfaceId, surfaceId]);
    expect(launch).toHaveBeenCalledOnce();
    if (pending) await act(async () => finish({ ok: true, spawnFailed: false, data: null, stdout: '', stderr: '' }));
    expect(container.querySelector('[data-viewer="true"]')).toBeTruthy();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('cannot clear a failed-restart pause by unmounting and mounting again', async () => {
    await layout();
    viewerPolicy.pauseForRestart(surfaceId);
    await layout(true);
    await layout();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('session is paused');
    expect(viewerPolicy.canEnable(surfaceId)).toBe(false);
    expect(api.disable).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('still cancels in-flight native startup on real close while its view is absent', async () => {
    let finish!: (value: Awaited<ReturnType<typeof launch>>) => void;
    launch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await layout();
    await layout(true);
    expect(api.disable).not.toHaveBeenCalled();
    await act(async () => store.getState().closeWorkspace(workspaceId));
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
    await act(async () => finish({ ok: true, spawnFailed: false, data: null, stdout: '', stderr: '' }));
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][1].at(-1)).toBe('close');
    expect(container.querySelector('[data-viewer]')).toBeNull();
  });

  it.each(['surface', 'pane', 'workspace', 'layout'])('closes an Agent %s even with no mounted view', async (kind) => {
    await layout();
    await layout(true);
    expect(api.disable).not.toHaveBeenCalled();
    await act(async () => {
      if (kind === 'surface') store.getState().closeSurface(workspaceId, paneId, surfaceId);
      if (kind === 'pane') store.getState().closePane(workspaceId, paneId);
      if (kind === 'workspace') store.getState().closeWorkspace(workspaceId);
      if (kind === 'layout') store.getState().replaceAllWorkspaces([{ title: 'replacement', splitTree: createLeaf() }]);
    });
    expect(api.disable).toHaveBeenCalledWith(surfaceId);
  });

  it('closes a retained Agent ID when restoring its saved Web layout without replacing the restored URL', async () => {
    await layout();
    await patch('web');
    const saved = store.getState().workspaces[0];
    await patch('agent');
    await layout(true);
    api.disable.mockClear();
    let finish!: (value: { url: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => {
      store.getState().replaceAllWorkspaces([saved]);
      workspaceId = store.getState().workspaces[0].id;
    });
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
    await layout();
    await act(async () => finish({ url: 'https://outgoing-agent.test/' }));
    expect(savedUrl()).toBe('https://initial.test/');
    expect(loadURL).not.toHaveBeenCalledWith('https://outgoing-agent.test/');
    await act(async () => store.getState().closeWorkspace(workspaceId));
    expect(api.disable).toHaveBeenCalledOnce();
  });

  it.each([false, true])('starts a new close lifetime on Web-to-Agent layout replacement (old close pending: %s)', async (pending) => {
    await layout();
    const savedAgent = store.getState().workspaces[0];
    let finish!: (value: { url: string }) => void;
    if (pending) api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await patch('web');
    await act(async () => {
      store.getState().replaceAllWorkspaces([savedAgent]);
      workspaceId = store.getState().workspaces[0].id;
    });
    await act(async () => store.getState().closeWorkspace(workspaceId));
    expect(api.disable.mock.calls).toEqual([[surfaceId], [surfaceId]]);
    if (pending) await act(async () => finish({ url: 'https://old-agent.test/' }));
  });

  it('keeps the native session when layout replacement retains an Agent ID in Agent mode', async () => {
    await layout();
    const savedAgent = store.getState().workspaces[0];
    await act(async () => {
      store.getState().replaceAllWorkspaces([savedAgent]);
      workspaceId = store.getState().workspaces[0].id;
    });
    expect(api.disable).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
    await act(async () => store.getState().closeWorkspace(workspaceId));
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
  });

  it.each([false, true])('hands fresh readback to Web with one disable (view absent: %s)', async (absent) => {
    await layout();
    await click('fixture page');
    if (absent) await layout(true);
    let finish!: (value: { url: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await patch('web');
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
    if (absent) await layout();
    await act(async () => finish({ url: 'https://fresh.test/' }));
    expect(savedUrl()).toBe('https://fresh.test/');
    expect(loadURL).toHaveBeenLastCalledWith('https://fresh.test/');
    expect(api.disable).toHaveBeenCalledOnce();
  });

  it.each(['did-navigate', 'did-stop-loading', 'did-start-navigation'])('ignores late Dashboard %s during the Agent-to-Web handoff', async (event) => {
    const dashboard = 'https://dashboard.test/';
    api.enable.mockResolvedValue({ installed: true, dashboardUrl: dashboard });
    await layout();
    await click('…');
    await click('Show dashboard');
    const wv = container.querySelector('webview')!;
    Object.assign(wv, { getURL: () => dashboard, canGoBack: () => false, canGoForward: () => false });
    let finish!: (value: { url: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await patch('web');
    loadURL.mockClear();
    await act(async () => wv.dispatchEvent(Object.assign(new Event(event), { url: dashboard, isMainFrame: true })));
    expect(savedUrl()).toBe('https://initial.test/');
    await act(async () => finish({ url: 'https://native-readback.test/' }));
    expect(savedUrl()).toBe('https://native-readback.test/');
    expect(loadURL).toHaveBeenLastCalledWith('https://native-readback.test/');
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
  });

  it.each(['https://explicit-web.test/', 'https://dashboard.test/'])('lets explicit Web navigation to %s supersede readback even with the outgoing Dashboard guest', async (url) => {
    api.enable.mockResolvedValue({ installed: true, dashboardUrl: 'https://dashboard.test/' });
    await layout();
    await click('…');
    await click('Show dashboard');
    const wv = container.querySelector('webview')!;
    Object.assign(wv, { getURL: () => url, canGoBack: () => false, canGoForward: () => false });
    let finish!: (value: { url: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await patch('web');
    await act(async () => window.dispatchEvent(new CustomEvent('wmux:browser-navigate', { detail: { surfaceId, url } })));
    expect(loadURL).toHaveBeenLastCalledWith(url);
    await act(async () => {
      wv.dispatchEvent(Object.assign(new Event('did-start-navigation'), { url, isMainFrame: true }));
      wv.dispatchEvent(Object.assign(new Event('did-navigate'), { url }));
      wv.dispatchEvent(new Event('did-stop-loading'));
    });
    loadURL.mockClear();
    await act(async () => finish({ url: 'https://older-native.test/' }));
    expect(savedUrl()).toBe(url);
    expect(container.querySelector('input')?.value).toBe(url);
    expect(loadURL).not.toHaveBeenCalled();
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
  });

  it.each([
    { restoredUrl: 'https://initial.test/', navigateAgain: false },
    { restoredUrl: 'https://restored-web.test/', navigateAgain: false },
    { restoredUrl: 'https://restored-web.test/', navigateAgain: true },
    { restoredUrl: undefined, navigateAgain: false },
    { restoredUrl: '', navigateAgain: false },
    { restoredUrl: undefined, navigateAgain: false, startUrl: 'https://configured-start.test/' },
  ])('loads a retained mounted Agent Dashboard guest onto the incoming saved Web URL ($restoredUrl, newer navigation: $navigateAgain)', async ({ restoredUrl, navigateAgain, startUrl }) => {
    api.enable.mockResolvedValue({ installed: true, dashboardUrl: 'https://dashboard.test/' });
    await layout();
    await click('…');
    await click('Show dashboard');
    const wv = container.querySelector('webview')!;
    Object.assign(wv, { getURL: () => 'https://dashboard.test/' });
    const saved = store.getState().workspaces[0];
    defaultUrl = startUrl;
    let finish!: (value: { url?: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    loadURL.mockClear();
    await act(async () => {
      store.getState().replaceAllWorkspaces([{ ...saved, splitTree: {
        ...createLeaf(paneId, 'browser'), surfaces: [{ id: surfaceId, type: 'browser', url: restoredUrl }],
      } }]);
      workspaceId = store.getState().workspaces[0].id;
    });
    expect(container.querySelector('webview')).toBe(wv);
    if (navigateAgain) {
      const url = 'https://newer-explicit.test/';
      await act(async () => window.dispatchEvent(new CustomEvent('wmux:browser-navigate', { detail: { surfaceId, url } })));
      Object.assign(wv, { getURL: () => url, canGoBack: () => false, canGoForward: () => false });
      await act(async () => wv.dispatchEvent(Object.assign(new Event('did-navigate'), { url })));
      await act(async () => finish({ url: 'https://older-native.test/' }));
      expect(savedUrl()).toBe(url);
      expect(loadURL).toHaveBeenLastCalledWith(url);
      expect(loadURL).not.toHaveBeenCalledWith(restoredUrl);
    } else {
      await act(async () => finish({}));
      expect(savedUrl()).toBe(restoredUrl);
      expect(loadURL).toHaveBeenLastCalledWith(restoredUrl || startUrl || 'about:blank');
    }
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
  });

  it('persists fresh readback when the Web view mounts only after teardown completes', async () => {
    await layout();
    await layout(true);
    api.disable.mockResolvedValueOnce({ url: 'https://unmounted.test/' });
    await patch('web');
    expect(savedUrl()).toBe('https://unmounted.test/');
    await layout();
    expect(container.querySelector('input')?.value).toBe('https://unmounted.test/');
    expect(api.disable).toHaveBeenCalledOnce();
  });

  it('does not replay a completed handoff over a later Web navigation on remount', async () => {
    await layout();
    api.disable.mockResolvedValueOnce({ url: 'https://readback.test/' });
    await patch('web');
    await act(async () => store.getState().updateSurface(workspaceId, paneId, surfaceId, { url: 'https://later-web.test/' }));
    await layout(true);
    loadURL.mockClear();
    await layout();
    expect(container.querySelector('input')?.value).toBe('https://later-web.test/');
    expect(loadURL).not.toHaveBeenCalled();
    expect(api.disable).toHaveBeenCalledOnce();
  });

  it.each(['store', 'page', 'page-start', 'address'])('keeps newer %s Web navigation across a pending handoff and split/collapse remount', async (navigation) => {
    await layout();
    let finish!: (value: { url: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await patch('web');
    await act(async () => store.getState().updateSplitTree(workspaceId,
      splitNode(store.getState().workspaces[0].splitTree, paneId, neighborId, 'terminal', 'horizontal')));
    const nextUrl = 'https://newer-web.test/';
    if (navigation === 'store') {
      await act(async () => store.getState().updateSurface(workspaceId, paneId, surfaceId, { url: nextUrl }));
    } else if (navigation === 'address') {
      await act(async () => window.dispatchEvent(new CustomEvent('wmux:browser-navigate', { detail: { surfaceId, url: nextUrl } })));
    } else {
      const wv = container.querySelector('webview')!;
      Object.assign(wv, { canGoBack: () => false, canGoForward: () => false });
      const event = navigation === 'page-start' ? 'did-start-navigation' : 'did-navigate';
      await act(async () => wv.dispatchEvent(Object.assign(new Event(event), { url: nextUrl, isMainFrame: true })));
    }
    loadURL.mockClear();
    await act(async () => finish({ url: 'https://older-agent.test/' }));
    expect(loadURL).not.toHaveBeenCalledWith('https://older-agent.test/');
    expect(savedUrl()).not.toBe('https://older-agent.test/');
    if (navigation === 'store' || navigation === 'page') expect(savedUrl()).toBe(nextUrl);
    await act(async () => store.getState().closePane(workspaceId, neighborId));
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
  });

  it('does not invalidate pending readback when the remounted Web guest initially loads its saved URL', async () => {
    await layout();
    let finish!: (value: { url: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await patch('web');
    await layout(true);
    await layout();
    const wv = container.querySelector('webview')!;
    Object.assign(wv, { getURL: () => 'https://initial.test/', canGoBack: () => false, canGoForward: () => false });
    await act(async () => {
      wv.dispatchEvent(Object.assign(new Event('did-start-navigation'), { url: 'https://initial.test/', isMainFrame: true }));
      wv.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://initial.test/' }));
      wv.dispatchEvent(new Event('did-stop-loading'));
    });
    await act(async () => finish({ url: 'https://fresh.test/' }));
    expect(savedUrl()).toBe('https://fresh.test/');
    expect(loadURL).toHaveBeenLastCalledWith('https://fresh.test/');
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
  });

  it('does not replace an explicit restored Web URL with a pending handoff from the prior layout', async () => {
    await layout();
    let finish!: (value: { url: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await patch('web');
    await layout(true);
    const saved = store.getState().workspaces[0];
    await act(async () => {
      store.getState().replaceAllWorkspaces([{ ...saved, splitTree: {
        ...createLeaf(paneId, 'browser'), surfaces: [{ id: surfaceId, type: 'browser', url: 'https://restored-web.test/' }],
      } }]);
      workspaceId = store.getState().workspaces[0].id;
    });
    await layout();
    await act(async () => finish({ url: 'https://older-agent.test/' }));
    expect(savedUrl()).toBe('https://restored-web.test/');
    expect(loadURL).not.toHaveBeenCalledWith('https://older-agent.test/');
    expect(api.disable).toHaveBeenCalledExactlyOnceWith(surfaceId);
  });

  it('persists the last streamed URL when unmounted readback fails', async () => {
    await layout();
    await click('fixture page');
    await layout(true);
    api.disable.mockRejectedValueOnce(new Error('readback failed'));
    await patch('web');
    expect(api.disable).toHaveBeenCalledOnce();
    await layout();
    expect(savedUrl()).toBe('https://agent.test/next');
    expect(container.querySelector('input')?.value).toBe('https://agent.test/next');
  });

  it('invalidates a pending handoff immediately on real close, even if the ID is later loaded again', async () => {
    await layout();
    let finish!: (value: { url: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await patch('web');
    await act(async () => {
      store.getState().closeWorkspace(workspaceId);
      workspaceId = store.getState().createWorkspace({ title: 'Loaded', splitTree: {
        ...createLeaf(paneId, 'browser'), surfaces: [{ id: surfaceId, type: 'browser', url: 'https://loaded.test/' }],
      } });
    });
    await act(async () => finish({ url: 'https://closed.test/' }));
    expect(savedUrl()).toBe('https://loaded.test/');
    expect(loadURL).not.toHaveBeenCalledWith('https://closed.test/');
  });

  it('does not apply an old readback to a newer Agent/Web transition', async () => {
    await layout();
    let finish!: (value: { url: string }) => void;
    api.disable.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await patch('web');
    await patch('agent');
    api.disable.mockResolvedValueOnce({ url: 'https://new.test/' });
    await patch('web');
    await act(async () => finish({ url: 'https://stale.test/' }));
    expect(savedUrl()).toBe('https://new.test/');
    expect(loadURL).not.toHaveBeenCalledWith('https://stale.test/');
  });
});

describe('unchanged Web decisions', () => {
  it('only changes engine lifecycle on an actual transition', () => {
    expect(engineTransition('agent', 'agent', 'https://a.test/')).toEqual({ action: 'none' });
    expect(engineTransition('web', 'agent', 'https://a.test/')).toEqual({ action: 'enable', url: 'https://a.test/' });
    expect(engineTransition('agent', 'web', 'https://a.test/')).toEqual({ action: 'disable' });
  });
  it('hands back the agent URL without redundantly navigating Web', () => {
    expect(disableTarget({ url: 'https://agent.test/' }, 'fallback', 'dashboard')).toBe('https://agent.test/');
    expect(disableTarget({}, 'https://same.test/', 'https://same.test/')).toBeNull();
  });
  it('keeps the existing address rules', () => {
    expect(resolveInputUrl('example.com')).toBe('https://example.com');
    expect(resolveInputUrl('two words')).toContain('google.com/search?q=');
  });
  it('hides overlays and blank pages with visibility, not unmounting', () => {
    expect(webviewHiding({ overlay: true, isBlank: false, isAgent: true, visible: true, keepRendering: false }))
      .toEqual({ style: { visibility: 'hidden' } });
  });
});
