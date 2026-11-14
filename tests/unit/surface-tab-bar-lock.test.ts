// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneId, SurfaceId, SurfaceRef } from '../../src/shared/types';
import SurfaceTabBar from '../../src/renderer/components/SplitPane/SurfaceTabBar';

const binding = { key: 'x', ctrl: true, alt: false, shift: false };

const store = create(() => ({
  agentMeta: new Map(),
  activeWorkspaceId: 'ws-1',
  renameSurface: () => {},
  surfaceProgress: {},
  agentStates: {},
  agentDetections: {},
  shortcuts: { newSurface: binding, splitRight: binding, splitDown: binding, closeSurfaceOrPane: binding },
  terminalPrefs: { oscTitleTabs: false },
  oscTitles: {},
  browserTitles: {},
}));

vi.mock('../../src/renderer/store', () => ({ get useStore() { return store; } }));
vi.mock('../../src/renderer/i18n', () => ({ useT: () => (_key: string, fallback: string) => fallback }));

const surfaces: SurfaceRef[] = [
  { id: 's-1' as SurfaceId, type: 'terminal', title: 'one' },
  { id: 's-2' as SurfaceId, type: 'terminal', title: 'two' },
];

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
});

function renderBar(locked: boolean, onToggleLock = vi.fn()) {
  act(() => {
    root!.render(
      React.createElement(SurfaceTabBar, {
        paneId: 'pane-1' as PaneId,
        surfaces,
        activeSurfaceIndex: 0,
        onSelect: () => {},
        onClose: () => {},
        onNew: () => {},
        onNewTyped: () => {},
        onClosePane: () => {},
        onSplitRight: () => {},
        onSplitDown: () => {},
        locked,
        onToggleLock,
      }),
    );
  });
  return onToggleLock;
}

function openTabMenu(): HTMLElement {
  const tab = container.querySelector('.surface-tab') as HTMLElement;
  act(() => {
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  return document.body.querySelector('.ctx-menu') as HTMLElement;
}

const padlock = () => container.querySelector('[aria-label="Unlock pane"]') as HTMLButtonElement | null;
const menuLabels = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);

describe('SurfaceTabBar pane lock', () => {
  it('shows a padlock reachable by aria-label on a locked pane, with the tooltip', () => {
    renderBar(true);

    const lock = padlock();
    expect(lock).not.toBeNull();
    expect(lock!.title).toBe('Pane locked: agents and moved tabs can’t enter. Click to unlock.');
  });

  it('shows no padlock on an unlocked pane', () => {
    renderBar(false);

    expect(padlock()).toBeNull();
    expect(container.querySelector('.surface-tab-bar__ctl--lock')).toBeNull();
  });

  it('offers "Unlock pane" in the tab menu of a locked pane', () => {
    renderBar(true);

    const labels = menuLabels(openTabMenu());
    expect(labels).toContain('Unlock pane');
    expect(labels).not.toContain('Lock pane');
  });

  it('offers "Lock pane" in the tab menu of an unlocked pane', () => {
    renderBar(false);

    const labels = menuLabels(openTabMenu());
    expect(labels).toContain('Lock pane');
    expect(labels).not.toContain('Unlock pane');
  });

  it('keeps the lock item above the separator that precedes Close', () => {
    renderBar(false);

    const menu = openTabMenu();
    const lockItem = Array.from(menu.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent === 'Lock pane')!;
    const separator = menu.querySelector('.ctx-menu__separator')!;
    expect(lockItem.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('calls onToggleLock when the padlock is clicked', () => {
    const toggle = renderBar(true);

    act(() => padlock()!.click());

    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('calls onToggleLock and closes the menu when the menu item is picked', () => {
    const toggle = renderBar(false);

    const menu = openTabMenu();
    const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent === 'Lock pane') as HTMLElement;
    act(() => item.click());

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.ctx-menu')).toBeNull();
  });

  it('keeps +, split and close-pane rendered and enabled on a locked pane', () => {
    renderBar(true);

    const controls = [
      container.querySelector('.surface-tab-bar__ctl--new'),
      container.querySelector('[aria-label="Split right"]'),
      container.querySelector('[aria-label="Split down"]'),
      container.querySelector('.surface-tab-bar__ctl--close'),
    ] as (HTMLButtonElement | null)[];

    for (const control of controls) {
      expect(control).not.toBeNull();
      expect(control!.disabled).toBe(false);
    }
  });

  it('places the padlock before the + button', () => {
    renderBar(true);

    const lock = container.querySelector('.surface-tab-bar__ctl--lock')!;
    const add = container.querySelector('.surface-tab-bar__ctl--new')!;
    expect(lock.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
