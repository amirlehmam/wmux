// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneId, SurfaceId } from '../../src/shared/types';
import SurfaceTabBar from '../../src/renderer/components/SplitPane/SurfaceTabBar';
import { useStore } from '../../src/renderer/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState({
    language: 'en',
    shortcuts: {
      ...initialState.shortcuts,
      splitRight: { key: 'r', ctrl: true, alt: true, shift: false },
      splitDown: { key: 's', ctrl: true, alt: false, shift: true },
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initialState);
});

function renderSplits() {
  const onSplitRight = vi.fn();
  const onSplitDown = vi.fn();
  act(() => root.render(createElement(SurfaceTabBar, {
    paneId: 'pane-test' as PaneId,
    surfaces: [{ id: 'surf-test' as SurfaceId, type: 'terminal' }],
    activeSurfaceIndex: 0,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onSplitRight,
    onSplitDown,
  })));
  return { onSplitRight, onSplitDown };
}

describe('pane header split buttons', () => {
  it('splits in either direction directly and shows the configured shortcuts', () => {
    const { onSplitRight, onSplitDown } = renderSplits();

    const right = host.querySelector<HTMLButtonElement>('[aria-label="Split right"]')!;
    const down = host.querySelector<HTMLButtonElement>('[aria-label="Split down"]')!;
    expect(right.title).toBe('Split right (Ctrl+Alt+R)');
    expect(down.title).toBe('Split down (Ctrl+Shift+S)');
    expect(right.hasAttribute('aria-haspopup')).toBe(false);
    expect(down.hasAttribute('aria-haspopup')).toBe(false);

    act(() => right.click());
    expect(onSplitRight).toHaveBeenCalledOnce();
    expect(onSplitDown).not.toHaveBeenCalled();
    act(() => down.click());
    expect(onSplitDown).toHaveBeenCalledOnce();
    expect(onSplitRight).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it.each([
    { index: 0, label: 'Split right', shortcut: 'Ctrl+Alt+R', action: 'onSplitRight' },
    { index: 1, label: 'Split down', shortcut: 'Ctrl+Shift+S', action: 'onSplitDown' },
  ] as const)('offers $label through the compact dropdown', ({ index, label, shortcut, action }) => {
    const handlers = renderSplits();
    const trigger = host.querySelector<HTMLButtonElement>('.surface-tab-bar__layout-menu')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(items).toHaveLength(2);
    expect(items[index].textContent).toContain(label);
    expect(items[index].querySelector('.surface-tab-menu__kbd')?.textContent).toBe(shortcut);
    act(() => items[index].click());
    expect(handlers[action]).toHaveBeenCalledOnce();
    expect(handlers[action === 'onSplitRight' ? 'onSplitDown' : 'onSplitRight']).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
