// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneId, SurfaceId, SurfaceRef, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';
import SurfaceTabBar from '../../src/renderer/components/SplitPane/SurfaceTabBar';
import Sidebar from '../../src/renderer/components/Sidebar/Sidebar';

const store = create(() => ({
  activeWorkspaceId: 'ws-1' as WorkspaceId,
  agentMeta: new Map(),
  agentStates: {},
  agentDetections: {},
  agentIdentities: {},
  surfaceProgress: {},
  oscTitles: {},
  terminalPrefs: { oscTitleTabs: false },
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
// These independent panels are unrelated to workspace-list gestures.
vi.mock('../../src/renderer/components/Sidebar/OrchestrationPanel', () => ({ default: () => null }));
vi.mock('../../src/renderer/components/Sidebar/AgentRosterBanner', () => ({ default: () => null }));

const paneId = 'pane-1' as PaneId;
const surfaces: SurfaceRef[] = ['a', 'b'].map(id => ({
  id: id as SurfaceId, type: 'terminal', customTitle: `Terminal ${id}`,
}));
const workspaces: WorkspaceInfo[] = ['ws-1', 'ws-2'].map(id => ({
  id: id as WorkspaceId, title: id, shell: 'pwsh', pinned: false, unreadCount: 0,
  shellState: 'idle',
  splitTree: { type: 'leaf', paneId, activeSurfaceIndex: 0, surfaces },
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.classList.remove('wmux-dragging');
  vi.clearAllMocks();
});

function element(selector: string): HTMLElement {
  const result = container.querySelector<HTMLElement>(selector);
  expect(result, selector).not.toBeNull();
  return result!;
}
function doubleClick(target: Element, button = 0): void {
  act(() => { target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button, detail: 2 })); });
}
function click(target: HTMLElement): void {
  act(() => target.click());
}
function auxClick(target: Element, button = 1): MouseEvent {
  const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button });
  act(() => { target.dispatchEvent(event); });
  return event;
}
function transfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '', dropEffect: '',
    setData: (key: string, value: string) => { data.set(key, value); },
    getData: (key: string) => data.get(key) || '',
  };
}
function drag(target: Element, type: string, dataTransfer: ReturnType<typeof transfer>): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientX: { value: 100 }, clientY: { value: 100 },
  });
  act(() => { target.dispatchEvent(event); });
}

function renderTabs(overrides: Partial<React.ComponentProps<typeof SurfaceTabBar>> = {}) {
  const props = {
    paneId, surfaces, activeSurfaceIndex: 0,
    onNew: vi.fn(), onSelect: vi.fn(), onClose: vi.fn(),
    onNewTyped: vi.fn(), onSplitRight: vi.fn(), onClosePane: vi.fn(),
    onReorderSurface: vi.fn(), onDropSurface: vi.fn(), onSurfaceDragEnd: vi.fn(),
    ...overrides,
  };
  act(() => root.render(React.createElement(SurfaceTabBar, props)));
  return props;
}

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const props = {
    workspaces, activeWorkspaceId: workspaces[0].id, sidebarWidth: 240,
    onWidthChange: vi.fn(), onSelect: vi.fn(), onClose: vi.fn(), onCreate: vi.fn(),
    onCreateFromLayout: vi.fn(), onManageLayouts: vi.fn(), onRename: vi.fn(),
    onReorder: vi.fn(), onUpdateMetadata: vi.fn(),
    ...overrides,
  };
  act(() => root.render(React.createElement(Sidebar, props)));
  return props;
}

describe('overflowing tabs (#403)', () => {
  it('maps mouse wheel and horizontal trackpad motion to the tab strip', () => {
    renderTabs();
    const strip = element('.surface-tab-bar__tabs');
    Object.defineProperties(strip, { scrollWidth: { value: 1000 }, clientWidth: { value: 200 } });
    const wheel = (options: WheelEventInit) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options });
      strip.dispatchEvent(event);
      return event;
    };
    expect(wheel({ deltaY: 80 }).defaultPrevented).toBe(true);
    expect(strip.scrollLeft).toBe(80);
    wheel({ deltaX: -30 });
    expect(strip.scrollLeft).toBe(50);
    wheel({ deltaY: 2, deltaMode: 1 });
    expect(strip.scrollLeft).toBe(106);
    expect(wheel({ deltaY: 80, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(strip.scrollLeft).toBe(106);
  });
  it('reveals a keyboard-selected tab without scrolling the workspace', () => {
    renderTabs();
    const strip = element('.surface-tab-bar__tabs');
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 200 } as DOMRect);
    vi.spyOn(strip.children[1], 'getBoundingClientRect').mockReturnValue({ left: 250, right: 350 } as DOMRect);
    renderTabs({ activeSurfaceIndex: 1 });
    expect(strip.scrollLeft).toBe(150);
  });
});

describe('middle-click tab close', () => {
  it.each([
    ['.surface-tab', 'a'],
    ['.surface-tab:nth-child(2)', 'b'],
    ['.surface-tab__label', 'a'],
    ['.surface-tab__icon', 'a'],
    ['.surface-tab__close', 'a'],
  ])('closes the clicked tab once through %s without selecting it', (selector, id) => {
    const props = renderTabs();
    expect(auxClick(element(selector)).defaultPrevented).toBe(true);
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith(id);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onNew).not.toHaveBeenCalled();
  });

  it('uses the existing close action for the last tab too', () => {
    const props = renderTabs({ surfaces: surfaces.slice(0, 1) });
    expect(container.querySelector('.surface-tab__close')).toBeNull();
    auxClick(element('.surface-tab'));
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith(surfaces[0].id);
  });

  it('ignores primary and secondary auxiliary clicks', () => {
    const props = renderTabs();
    for (const button of [0, 2]) {
      expect(auxClick(element('.surface-tab'), button).defaultPrevented).toBe(false);
    }
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('does not close tabs or create new ones from middle-clicks outside a tab', () => {
    const props = renderTabs();
    for (const selector of ['.surface-tab-bar', '.surface-tab-bar__tabs', '.surface-tab-bar__ctl--new']) {
      auxClick(element(selector));
    }
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onNew).not.toHaveBeenCalled();
  });

  it('prevents middle-button autoscroll on press but closes only on release', () => {
    const props = renderTabs();
    for (const button of [0, 1, 2]) {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button });
      act(() => { element('.surface-tab__label').dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(button === 1);
    }
    expect(props.onClose).not.toHaveBeenCalled();
    auxClick(element('.surface-tab__label'));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

describe('double-click empty tab-strip space', () => {
  it.each(['.surface-tab-bar__tabs', '.surface-tab-bar'])(
    'uses the same default-terminal action as + on %s', selector => {
      const props = renderTabs();
      doubleClick(element(selector));
      expect(props.onNew).toHaveBeenCalledTimes(1);
      expect(props.onNewTyped).not.toHaveBeenCalled();
      click(element('.surface-tab-bar__ctl--new'));
      expect(props.onNew).toHaveBeenCalledTimes(2);
    },
  );

  it('also works when a pane has no tabs', () => {
    const props = renderTabs({ surfaces: [] });
    doubleClick(element('.surface-tab-bar'));
    expect(props.onNew).toHaveBeenCalledOnce();
  });

  it('ignores single clicks and non-primary double-clicks', () => {
    const props = renderTabs();
    const blank = element('.surface-tab-bar__tabs');
    click(blank);
    doubleClick(blank, 1);
    doubleClick(blank, 2);
    expect(props.onNew).not.toHaveBeenCalled();
  });

  it.each(['.surface-tab', '.surface-tab__label', '.surface-tab__icon'])(
    'preserves tab rename without creating anything on %s', selector => {
      const props = renderTabs();
      doubleClick(element(selector));
      expect(container.querySelector('.surface-tab__rename-input')).not.toBeNull();
      expect(props.onNew).not.toHaveBeenCalled();
      doubleClick(element('.surface-tab__rename-input'));
      expect(props.onNew).not.toHaveBeenCalled();
    },
  );

  it.each(['.surface-tab__close', '.surface-tab-bar__cluster', '.surface-tab-bar__group', '.surface-tab-bar__ctl--layout', '.surface-tab-bar__ctl--close'])(
    'does not treat %s as empty space', selector => {
      const props = renderTabs();
      doubleClick(element(selector));
      expect(props.onNew).not.toHaveBeenCalled();
    },
  );

  it('does not add a third tab when + is clicked twice', () => {
    const props = renderTabs();
    const plus = element('.surface-tab-bar__ctl--new');
    click(plus);
    click(plus);
    doubleClick(plus);
    expect(props.onNew).toHaveBeenCalledTimes(2);
  });

  it('ignores double-clicks bubbling through a portalled dropdown', () => {
    const props = renderTabs();
    click(element('.surface-tab-bar__caret'));
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    doubleClick(menu!);
    expect(props.onNew).not.toHaveBeenCalled();
  });

  it('ignores empty-space double-clicks during a surface drag from another pane', () => {
    const props = renderTabs({ isDragActive: true });
    doubleClick(element('.surface-tab-bar__tabs'));
    expect(props.onNew).not.toHaveBeenCalled();
  });

  it('preserves local tab reorder and resumes creation after the drop', () => {
    const props = renderTabs();
    const tabs = container.querySelectorAll('.surface-tab');
    const data = transfer();
    drag(tabs[0], 'dragstart', data);
    doubleClick(element('.surface-tab-bar__tabs'));
    expect(props.onNew).not.toHaveBeenCalled();
    drag(tabs[1], 'dragover', data);
    drag(element('.surface-tab-bar'), 'drop', data);
    expect(props.onReorderSurface).toHaveBeenCalledWith(surfaces[0].id, 1);
    expect(props.onSurfaceDragEnd).toHaveBeenCalledOnce();
    expect(document.body.classList.contains('wmux-dragging')).toBe(false);
    doubleClick(element('.surface-tab-bar__tabs'));
    expect(props.onNew).toHaveBeenCalledOnce();
  });

  it('preserves surface drops from another pane', () => {
    const props = renderTabs();
    const data = transfer();
    data.setData('application/wmux-surface', JSON.stringify({ sourcePaneId: 'pane-other', surfaceId: 'surf-other' }));
    drag(element('.surface-tab-bar'), 'drop', data);
    expect(props.onDropSurface).toHaveBeenCalledWith('pane-other', 'surf-other', paneId);
    expect(props.onNew).not.toHaveBeenCalled();
  });
});

describe('double-click empty workspace-list space', () => {
  it('uses the same configured-workspace action as the footer +', () => {
    const props = renderSidebar();
    doubleClick(element('.sidebar__list'));
    expect(props.onCreate).toHaveBeenCalledOnce();
    expect(props.onCreateFromLayout).not.toHaveBeenCalled();
    click(element('.sidebar__new-btn'));
    expect(props.onCreate).toHaveBeenCalledTimes(2);
  });

  it('works when there are no workspaces', () => {
    const props = renderSidebar({ workspaces: [], activeWorkspaceId: null });
    doubleClick(element('.sidebar__list'));
    expect(props.onCreate).toHaveBeenCalledOnce();
  });

  it('ignores single clicks and non-primary double-clicks', () => {
    const props = renderSidebar();
    const blank = element('.sidebar__list');
    click(blank);
    doubleClick(blank, 1);
    doubleClick(blank, 2);
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('preserves workspace-title rename without creating a workspace', () => {
    const props = renderSidebar();
    doubleClick(element('.workspace-row__title'));
    expect(container.querySelector('.workspace-row__rename-input')).not.toBeNull();
    expect(props.onCreate).not.toHaveBeenCalled();
    doubleClick(element('.workspace-row__rename-input'));
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it.each(['.workspace-row', '.workspace-row__header', '.workspace-row__status', '.workspace-row__close', '.sidebar', '.sidebar__footer', '.sidebar-resize-handle'])(
    'does not treat %s as empty list space', selector => {
      const props = renderSidebar();
      doubleClick(element(selector));
      expect(props.onCreate).not.toHaveBeenCalled();
    },
  );

  it('does not add a third workspace when + is clicked twice', () => {
    const props = renderSidebar();
    const plus = element('.sidebar__new-btn');
    click(plus);
    click(plus);
    doubleClick(plus);
    expect(props.onCreate).toHaveBeenCalledTimes(2);
  });

  it('preserves workspace reorder and resumes creation after the drop', () => {
    const props = renderSidebar();
    const rows = container.querySelectorAll('.workspace-row');
    const data = transfer();
    drag(rows[0], 'dragstart', data);
    doubleClick(element('.sidebar__list'));
    expect(props.onCreate).not.toHaveBeenCalled();
    drag(rows[1], 'dragover', data);
    drag(rows[1], 'drop', data);
    expect(props.onReorder).toHaveBeenCalledWith([workspaces[1].id, workspaces[0].id]);
    doubleClick(element('.sidebar__list'));
    expect(props.onCreate).toHaveBeenCalledOnce();
  });
});
