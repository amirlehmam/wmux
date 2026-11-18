// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentViewerBridge, AgentViewerEvent, PaneId, SplitNode, SurfaceId, SurfaceRef } from '../../src/shared/types';
import BrowserPane from '../../src/renderer/components/Browser/BrowserPane';
import { beginAgentBrowserHandoff, clearAgentBrowserHandoff } from '../../src/renderer/store/agent-browser-handoff';
import SplitPreviewOverlay from '../../src/renderer/components/SplitPane/SplitPreviewOverlay';
import SurfaceTabBar from '../../src/renderer/components/SplitPane/SurfaceTabBar';

const store = create(() => ({
  activeWorkspaceId: 'ws-1',
  agentMeta: new Map(),
  agentStates: {},
  agentDetections: {},
  agentIdentities: {},
  surfaceProgress: {},
  oscTitles: { 'surf-b': { title: 'osc must not reach a browser tab', at: 1 } },
  browserTitles: { 'surf-b': { title: 'Page Title', at: 1 } },
  terminalPrefs: { oscTitleTabs: true },
  sidebarPrefs: { activeTabIndicator: 'leftRail' },
  appearancePrefs: { uiMode: 'classic' },
  shortcuts: {
    newSurface: { key: 't', ctrl: true },
    splitRight: { key: 'd', ctrl: true },
    closeSurfaceOrPane: { key: 'w', ctrl: true },
  },
  renameSurface: vi.fn(),
  savedLayouts: [],
  saveCurrentLayoutAsPreset: vi.fn(),
}));
vi.mock('../../src/renderer/store', () => ({ get useStore() { return store; } }));
vi.mock('../../src/renderer/i18n', () => ({ useT: () => (_key: string, fallback: string) => fallback }));

const PAGE = 'http://127.0.0.1:5208/a';
const webviewApi = {
  getURL: () => PAGE,
  getTitle: () => 'Page A',
  canGoBack: () => false,
  canGoForward: () => false,
  loadURL: vi.fn(() => Promise.resolve()),
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.assign(HTMLElement.prototype, webviewApi);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  clearAgentBrowserHandoff('surf-b');
  container.remove();
  for (const key of Object.keys(webviewApi)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  delete (window as unknown as { wmux?: unknown }).wmux;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

type PaneProps = React.ComponentProps<typeof BrowserPane>;

function renderPane(props: Partial<PaneProps> = {}) {
  const onTitleChange = vi.fn();
  act(() => root.render(React.createElement(BrowserPane, { surfaceId: 'surf-b', initialUrl: PAGE, onTitleChange, ...props })));
  return onTitleChange;
}
function fire(type: string, fields: Record<string, unknown> = {}): void {
  const webview = container.querySelector('webview')!;
  act(() => { webview.dispatchEvent(Object.assign(new Event(type), fields)); });
}

describe('BrowserPane reports the page title', () => {
  it('publishes each title the page sets', () => {
    const onTitleChange = renderPane();
    fire('page-title-updated', { title: 'Page A' });
    fire('page-title-updated', { title: 'Page A, later' });
    expect(onTitleChange.mock.calls).toEqual([['Page A'], ['Page A, later']]);
  });

  it('clears on a new document, because an untitled page fires no title event', () => {
    const onTitleChange = renderPane();
    fire('did-navigate', { url: 'http://127.0.0.1:5208/b' });
    expect(onTitleChange).toHaveBeenCalledExactlyOnceWith('');
  });

  it('still records the URL on a new document', () => {
    const onUrlChange = vi.fn();
    renderPane({ onUrlChange });
    fire('did-navigate', { url: 'http://127.0.0.1:5208/b' });
    expect(onUrlChange).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:5208/b');
  });

  it('keeps the title through an in-page navigation, which fires no new one', () => {
    const onTitleChange = renderPane();
    fire('did-navigate-in-page', { url: `${PAGE}#x`, isMainFrame: true });
    expect(onTitleChange).not.toHaveBeenCalled();
  });

  it('clears on a failed main-frame load, whose page is gone', () => {
    const onTitleChange = renderPane();
    fire('did-fail-load', { isMainFrame: true, errorCode: -102, validatedURL: 'http://127.0.0.1:5209/' });
    expect(onTitleChange).toHaveBeenCalledExactlyOnceWith('');
  });

  it('keeps the title when a load was only aborted or a subframe failed', () => {
    const onTitleChange = renderPane();
    fire('did-fail-load', { isMainFrame: true, errorCode: -3 });
    fire('did-fail-load', { isMainFrame: false, errorCode: -102 });
    expect(onTitleChange).not.toHaveBeenCalled();
  });

  it('works without a listener, as the side panel mounts it', () => {
    renderPane({ onTitleChange: undefined });
    fire('page-title-updated', { title: 'Page A' });
    fire('did-navigate', { url: PAGE });
  });
});

describe('BrowserPane in agent mode', () => {
  function agentBridge(disableResult: { url?: string } | null = { url: PAGE }) {
    let listener: (event: AgentViewerEvent) => void;
    const viewer: AgentViewerBridge = {
      attach: vi.fn(async () => {}), detach: vi.fn(), ack: vi.fn(), input: vi.fn(), action: vi.fn(async () => {}),
      onEvent: (callback) => { listener = callback; return vi.fn(); },
    };
    (window as unknown as { wmux: unknown }).wmux = {
      agentViewer: viewer,
      agentBrowser: {
        enable: vi.fn(async () => ({ installed: true, dashboardUrl: 'http://127.0.0.1:4848/?port=9300' })),
        status: vi.fn(async () => ({ dashboardAvailable: true })),
        disable: vi.fn(async () => disableResult),
      },
    };
    return (message: AgentViewerEvent['message']) => {
      const token = vi.mocked(viewer.attach).mock.calls.at(-1)![1];
      act(() => listener({ surfaceId: 'surf-b', token, revision: 1, message }));
    };
  }
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  it('labels the tab from the authoritative streamed active tab', async () => {
    const emit = agentBridge();
    const onTitleChange = renderPane({ engine: 'agent' });
    await settle();
    emit({ type: 'tabs', tabs: [{ tabId: 't1', active: true, title: 'Agent Page A', url: PAGE }] });
    expect(onTitleChange).toHaveBeenLastCalledWith('Agent Page A');
  });

  it("never publishes the dashboard's own title or clears on its navigation", async () => {
    agentBridge();
    const onTitleChange = renderPane({ engine: 'agent' });
    await settle();
    onTitleChange.mockClear();
    fire('page-title-updated', { title: 'agent-browser' });
    fire('did-navigate', { url: 'http://127.0.0.1:4848/?port=9300' });
    expect(onTitleChange).not.toHaveBeenCalled();
  });

  it('follows streamed URL/title changes and ignores inactive tab titles', async () => {
    const emit = agentBridge();
    const onUrlChange = vi.fn();
    const onTitleChange = renderPane({ engine: 'agent', onUrlChange });
    await settle();
    emit({ type: 'url', url: 'https://example.com/x' });
    emit({ type: 'tabs', tabs: [
      { tabId: 't1', active: false, title: 'Inactive', url: PAGE },
      { tabId: 't2', active: true, title: 'Agent Page B', url: 'https://example.com/x' },
    ] });
    expect(onTitleChange).toHaveBeenLastCalledWith('Agent Page B');
    expect(onTitleChange).not.toHaveBeenCalledWith('Inactive');
    expect(onUrlChange).toHaveBeenLastCalledWith('https://example.com/x');
  });

  it('restores the title when leaving needs no navigation, as after cancelling setup', async () => {
    agentBridge();
    vi.mocked(window.wmux.agentBrowser.enable).mockResolvedValue({ installed: false });
    const onTitleChange = vi.fn();
    const render = (engine: 'agent' | 'web') => act(() => root.render(React.createElement(BrowserPane, { surfaceId: 'surf-b', initialUrl: PAGE, engine, onTitleChange })));
    render('agent');
    await settle();
    beginAgentBrowserHandoff('surf-b');
    render('web');
    await settle();
    expect(onTitleChange).toHaveBeenLastCalledWith('Page A');
    expect(webviewApi.loadURL).not.toHaveBeenCalledWith(PAGE);
  });

  it('leaves the title to the next page when leaving does navigate', async () => {
    agentBridge({ url: 'https://example.com/' });
    const onTitleChange = vi.fn();
    const render = (engine: 'agent' | 'web') => act(() => root.render(React.createElement(BrowserPane, { surfaceId: 'surf-b', initialUrl: PAGE, engine, onTitleChange })));
    render('agent');
    await settle();
    beginAgentBrowserHandoff('surf-b');
    render('web');
    await settle();
    expect(onTitleChange).toHaveBeenLastCalledWith('');
    expect(webviewApi.loadURL).toHaveBeenCalledWith('https://example.com/');
  });
});

describe('the labels read the stored title', () => {
  const browserTab: SurfaceRef = { id: 'surf-b' as SurfaceId, type: 'browser', url: PAGE };
  const paneId = 'pane-1' as PaneId;

  it('in the tab bar', () => {
    act(() => root.render(React.createElement(SurfaceTabBar, {
      paneId, surfaces: [browserTab], activeSurfaceIndex: 0,
      onNew: vi.fn(), onSelect: vi.fn(), onClose: vi.fn(),
      onNewTyped: vi.fn(), onSplitRight: vi.fn(), onClosePane: vi.fn(),
    })));
    expect(container.querySelector('.surface-tab__label')?.textContent).toBe('Page Title');
  });

  it('in the split-drag preview', () => {
    const tree: SplitNode = { type: 'leaf', paneId, activeSurfaceIndex: 0, surfaces: [browserTab] };
    act(() => root.render(React.createElement(SplitPreviewOverlay, {
      tree, destinationPaneId: paneId, draggedSurfaceId: browserTab.id,
    })));
    expect(container.querySelector('.split-preview-pane__tab')?.textContent).toBe('Page Title');
  });
});
