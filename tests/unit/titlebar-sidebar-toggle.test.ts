// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Titlebar from '../../src/renderer/components/Titlebar/Titlebar';
import Sidebar from '../../src/renderer/components/Sidebar/Sidebar';
import { DEFAULT_SHORTCUTS, DEFAULT_SIDEBAR_PREFS, DEFAULT_WORKSPACE_PREFS } from '../../src/renderer/store/settings-slice';

const store = create(() => ({
  sidebarVisible: true,
  browserOpen: false,
  sidebarPrefs: DEFAULT_SIDEBAR_PREFS,
  workspacePrefs: DEFAULT_WORKSPACE_PREFS,
  shortcuts: DEFAULT_SHORTCUTS,
  savedLayouts: [],
}));
const toggleSidebar = vi.fn(() => store.setState(s => ({ sidebarVisible: !s.sidebarVisible })));
vi.mock('../../src/renderer/store', () => ({ get useStore() { return store; } }));
vi.mock('../../src/renderer/i18n', () => ({ useT: () => (key: string, fallback?: string) => fallback ?? key }));
vi.mock('../../src/renderer/components/Titlebar/UpdateBadge', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Sidebar/OrchestrationPanel', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Sidebar/AgentRosterBanner', () => ({ default: () => null }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  store.setState({ sidebarVisible: true, browserOpen: false, shortcuts: DEFAULT_SHORTCUTS });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderTitlebar() {
  const onToggleExplorer = vi.fn();
  function Header() {
    const sidebarVisible = store(s => s.sidebarVisible);
    const browserOpen = store(s => s.browserOpen);
    return React.createElement(Titlebar, {
      sidebarVisible, onToggleSidebar: toggleSidebar,
      notifications: [], workspaceNames: new Map(), notificationPanelOpen: false,
      onToggleNotificationPanel: vi.fn(), onNotificationJump: vi.fn(), onMarkAllNotificationsRead: vi.fn(),
      explorerOpen: true, onToggleExplorer,
      browserOpen, onToggleBrowser: () => store.setState(s => ({ browserOpen: !s.browserOpen })),
    });
  }
  act(() => root.render(React.createElement(Header)));
  return onToggleExplorer;
}

function sidebarButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('.titlebar__logo + button');
  expect(button).not.toBeNull();
  return button!;
}

describe('titlebar sidebar toggle', () => {
  it('provides a persistent, labelled toggle beside the logo without replacing the explorer action', () => {
    const onToggleExplorer = renderTitlebar();
    const button = sidebarButton();
    expect(button.title).toBe('Collapse sidebar (Ctrl+B)');
    expect(button.getAttribute('aria-label')).toBe(button.title);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toBe('titlebar__btn');
    // Help and devtools moved to Settings → Help (2.47.0); a divider now
    // separates the sidebar toggle from the pane panels.
    expect(button.nextElementSibling?.className).toBe('titlebar__divider');
    expect(container.querySelector('[title="titlebar.help"], [title="titlebar.devtools"]')).toBeNull();
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    act(() => button.click());
    expect(store.getState().sidebarVisible).toBe(false);
    expect(button.isConnected).toBe(true);
    expect(button.title).toBe('Expand sidebar (Ctrl+B)');
    expect(button.getAttribute('aria-label')).toBe(button.title);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    act(() => button.click());
    expect(store.getState().sidebarVisible).toBe(true);
    expect(toggleSidebar).toHaveBeenCalledTimes(2);
    const explorer = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle file explorer"]');
    expect(explorer).not.toBeNull();
    act(() => explorer!.click());
    expect(onToggleExplorer).toHaveBeenCalledOnce();
    expect(toggleSidebar).toHaveBeenCalledTimes(2);
  });

  it('toggles the browser panel and reflects external visibility and shortcut changes', () => {
    renderTitlebar();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle browser panel"]')!;
    expect(button).not.toBeNull();
    expect(button.title).toBe('Toggle browser panel (Ctrl+Shift+I)');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.classList.contains('titlebar__btn--active')).toBe(false);
    act(() => button.click());
    expect(store.getState().browserOpen).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.classList.contains('titlebar__btn--active')).toBe(true);
    act(() => button.click());
    expect(store.getState().browserOpen).toBe(false);
    act(() => store.setState({
      browserOpen: true,
      shortcuts: { ...DEFAULT_SHORTCUTS, openBrowser: { key: 'b', alt: true } },
    }));
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toBe('Toggle browser panel (Alt+B)');
  });

  it('reflects sidebar visibility changes made outside the titlebar', () => {
    renderTitlebar();
    act(() => store.setState({ sidebarVisible: false }));
    expect(sidebarButton().getAttribute('aria-pressed')).toBe('false');
    expect(sidebarButton().title).toBe('Expand sidebar (Ctrl+B)');
    expect(toggleSidebar).not.toHaveBeenCalled();
  });

  it('uses the existing App state and action while preserving drag-to-expand and resize collapse', () => {
    const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
    const titlebar = app.match(/<Titlebar[\s\S]*?\/>/)?.[0];
    expect(titlebar).toContain('sidebarVisible={sidebarVisible}');
    expect(titlebar).toContain('onToggleSidebar={toggleSidebar}');
    expect(titlebar).toContain('browserOpen={sideBrowserVisible}');
    expect(titlebar).toContain('onToggleBrowser={toggleSideBrowser}');
    expect(app).toContain('className="sidebar-expand-strip"');
    expect(app).toContain('onCollapse={toggleSidebar}');
  });

  it('removes the old sidebar header, collapse button, and their unused styles', () => {
    act(() => root.render(React.createElement(Sidebar, {
      workspaces: [], activeWorkspaceId: null, sidebarWidth: 240,
      onWidthChange: vi.fn(), onSelect: vi.fn(), onClose: vi.fn(),
      onCreate: vi.fn(), onCreateFromLayout: vi.fn(), onManageLayouts: vi.fn(),
      onRename: vi.fn(), onReorder: vi.fn(), onUpdateMetadata: vi.fn(),
    })));
    expect(container.querySelector('.sidebar__header')).toBeNull();
    expect(container.querySelector('.sidebar__collapse-btn')).toBeNull();
    expect(container.querySelector('.sidebar')?.firstElementChild?.className).toBe('sidebar__list');
    const css = readFileSync(join(__dirname, '../../src/renderer/styles/sidebar.css'), 'utf8');
    expect(css).not.toContain('.sidebar__header');
    expect(css).not.toContain('.sidebar__collapse-btn');
  });
});
