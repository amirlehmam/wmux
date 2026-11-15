// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneId, SplitNode, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';
import { en } from '../../src/renderer/i18n/locales/en';

const setMarkdownContent = vi.fn();
const store = create(() => ({
  shortcuts: {},
  workspaces: [] as WorkspaceInfo[],
  activeWorkspaceId: 'ws-1' as WorkspaceId | null,
  selectWorkspace: () => {},
  savedLayouts: [],
  createWorkspaceFromLayout: () => null,
  requestLayoutSave: () => true,
  appearancePrefs: { hubEnabled: false, uiMode: 'classic' },
  setAppearancePrefs: () => {},
  setMarkdownContent,
}));

vi.mock('../../src/renderer/store', () => ({ get useStore() { return store; } }));
vi.mock('../../src/renderer/i18n', () => ({
  useT: () => (key: string, fallback?: string) => (en as Record<string, string>)[key] ?? fallback ?? key,
}));
vi.mock('../../src/renderer/components/Settings/KeyboardSettings', () => ({ actionLabel: (a: string) => a }));
vi.mock('../../src/renderer/components/SplitPane/use-osc-title', () => ({
  useWorkspaceLabels: () => new Map(),
}));

import CommandPalette from '../../src/renderer/components/CommandPalette/CommandPalette';

const ALL_LOCKED_MESSAGE = 'All panes are locked. Unlock one to open a file.';

function leaf(paneId: string, locked?: true): SplitNode {
  return {
    type: 'leaf',
    paneId: paneId as PaneId,
    activeSurfaceIndex: 0,
    surfaces: [{ id: `s-${paneId}` as SurfaceId, type: 'terminal', title: 't' }],
    ...(locked ? { locked } : {}),
  };
}

function workspace(tree: SplitNode): WorkspaceInfo {
  return { id: 'ws-1' as WorkspaceId, title: 'W', pinned: false, shell: 'pwsh', unreadCount: 0, splitTree: tree };
}

const split = (a: SplitNode, b: SplitNode): SplitNode =>
  ({ type: 'split', direction: 'horizontal', ratio: 0.5, children: [a, b] }) as SplitNode;

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn>;
let openFile: ReturnType<typeof vi.fn>;
let createSurface: ReturnType<typeof vi.fn>;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onClose = vi.fn();
  setMarkdownContent.mockClear();
  openFile = vi.fn(async () => ({ content: '# hi', filePath: 'C:\\docs\\note.md', mtimeMs: 7 }));
  createSurface = vi.fn(() => ({ surfaceId: 'surf-new', paneId: 'pane-2' }));
  Object.assign(window, { wmux: { markdown: { openFile } }, __wmux_createSurface: createSurface });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as any).wmux;
  delete (window as any).__wmux_createSurface;
});

function renderPalette(tree: SplitNode) {
  store.setState({ workspaces: [workspace(tree)], activeWorkspaceId: 'ws-1' as WorkspaceId });
  act(() => {
    root.render(React.createElement(CommandPalette, { onClose, onAction: () => {} }));
  });
  const item = [...container.querySelectorAll('.command-palette__item')].find(
    (el) => el.querySelector('.command-palette__item-label')?.textContent === en['palette.openMarkdown'],
  );
  expect(item, 'Open Markdown File item is listed').toBeDefined();
  return item!;
}

const activate = (item: Element) =>
  act(async () => {
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });

async function pickOpenMarkdown(tree: SplitNode) {
  await activate(renderPalette(tree));
}

describe('palette "Open Markdown File…" with locked panes', () => {
  it('does not open the dialog and says so when every pane is locked', async () => {
    await pickOpenMarkdown(split(leaf('pane-1', true), leaf('pane-2', true)));

    expect(openFile).not.toHaveBeenCalled();
    expect(createSurface).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(ALL_LOCKED_MESSAGE);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still opens the dialog and places the file when an unlocked pane exists', async () => {
    await pickOpenMarkdown(split(leaf('pane-1', true), leaf('pane-2')));

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(createSurface).toHaveBeenCalledWith({ type: 'markdown' });
    expect(setMarkdownContent).toHaveBeenCalledWith('surf-new', '# hi', {
      fileName: 'note.md',
      filePath: 'C:\\docs\\note.md',
      mtimeMs: 7,
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so instead of dropping the file when createSurface reports an error after the dialog', async () => {
    createSurface.mockReturnValue({ error: 'No unlocked panes in workspace ws-1' } as never);
    await pickOpenMarkdown(leaf('pane-1'));

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(setMarkdownContent).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(ALL_LOCKED_MESSAGE);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes quietly when the dialog is canceled', async () => {
    openFile.mockResolvedValue({ canceled: true } as never);
    await pickOpenMarkdown(leaf('pane-1'));

    expect(createSurface).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a second activation while the file dialog is pending', async () => {
    let resolveDialog!: (v: unknown) => void;
    openFile.mockReturnValue(new Promise((r) => { resolveDialog = r; }) as never);
    const item = renderPalette(leaf('pane-1'));

    await activate(item);
    await activate(item);
    expect(openFile).toHaveBeenCalledTimes(1);

    await act(async () => { resolveDialog({ canceled: true }); });
    expect(onClose).toHaveBeenCalledTimes(1);

    await activate(item);
    expect(openFile).toHaveBeenCalledTimes(2);
  });

  it('does not close or message a palette that was unmounted while the dialog was pending', async () => {
    let resolveDialog!: (v: unknown) => void;
    openFile.mockReturnValue(new Promise((r) => { resolveDialog = r; }) as never);
    const item = renderPalette(leaf('pane-1'));
    await activate(item);

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => { resolveDialog({ canceled: true }); });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the status region mounted and empty until there is something to say', () => {
    renderPalette(leaf('pane-1'));
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toBe('');
  });

  it('writes the message into the same status element that was already mounted', async () => {
    const item = renderPalette(split(leaf('pane-1', true), leaf('pane-2', true)));
    const before = container.querySelector('[role="status"]');
    await activate(item);
    expect(container.querySelector('[role="status"]')).toBe(before);
    expect(before!.textContent).toBe(ALL_LOCKED_MESSAGE);
  });
});
