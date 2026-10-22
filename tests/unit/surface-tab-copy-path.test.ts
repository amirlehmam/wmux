// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneId, SurfaceRef, SurfaceId } from '../../src/shared/types';
import SurfaceTabBar from '../../src/renderer/components/SplitPane/SurfaceTabBar';
import { useStore } from '../../src/renderer/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const writeText = vi.fn();
const onSelect = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  onSelect.mockReset();
  Object.assign(window, { wmux: { clipboard: { writeText } } });
  useStore.setState({ language: 'en' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { wmux?: unknown }).wmux;
});

function openMenu(surface: Partial<SurfaceRef>): HTMLElement | undefined {
  act(() => root.render(createElement(SurfaceTabBar, {
    paneId: 'pane-test' as PaneId,
    surfaces: [
      { id: 'active' as SurfaceId, type: 'terminal' },
      { id: 'target' as SurfaceId, type: 'markdown', ...surface },
    ],
    activeSurfaceIndex: 0,
    onSelect,
    onClose: vi.fn(),
    onNew: vi.fn(),
  })));
  const tab = host.querySelectorAll('.surface-tab')[1];
  act(() => {
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
  });
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((item) => item.textContent === 'Copy full path');
}

describe('tab context menu: copy full path', () => {
  it.each([
    { type: 'markdown', markdownFilePath: 'C:\\My Project\\projects\\dbnator.md', customTitle: 'renamed' },
    { type: 'code', codeFilePath: '\\\\server\\share\\src\\main.ts', customTitle: 'renamed' },
  ] satisfies Partial<SurfaceRef>[])('copies the clicked $type tab path without selecting it', async (surface) => {
    const item = openMenu(surface)!;
    expect(item).toBeDefined();
    await act(async () => item.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(surface.markdownFilePath ?? surface.codeFilePath);
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('.ctx-menu')).toBeNull();
  });

  it.each(['markdown', 'code', 'terminal', 'browser'] as const)(
    'offers no file path for a pathless %s tab', (type) => {
      expect(openMenu({ type })).toBeUndefined();
      expect(writeText).not.toHaveBeenCalled();
    },
  );

  it('supports keyboard activation and handles clipboard rejection', async () => {
    writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    const item = openMenu({ markdownFilePath: 'C:\\repo\\doc.md' })!;
    await act(async () => {
      item.focus();
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith('C:\\repo\\doc.md');
    expect(document.querySelector('.ctx-menu')).toBeNull();
  });
});
