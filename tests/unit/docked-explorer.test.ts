// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ExplorerPanel } from '../../src/renderer/components/Explorer/ExplorerPanel';
import { useStore } from '../../src/renderer/store';
import type { SplitNode } from '../../src/shared/types';

it('offers sidebar placement and promotes the terminal actually supplying the explorer root', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.wmux = { explorer: { listDir: async (_id: string, relPath: string) => ({ root: 'C:\\repo', relPath, entries: [], truncated: false }),
    diffStats: async () => ({ files: [], baseline: 'git' }) }, hook: { onEvent: () => () => {} } };
  useStore.getState().replaceAllWorkspaces([{ id: 'ws-source', title: 'source', splitTree: {
    type: 'leaf', paneId: 'pane-source', activeSurfaceIndex: 0,
    surfaces: [{ id: 'surf-source', type: 'terminal', cwd: 'C:\\repo' }],
  } }]);
  const promote = vi.fn();
  const moveSide = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExplorerPanel, { focusedPaneId: 'pane-source',
      onClose: () => {}, onMoveToWorkspace: promote, onMoveSide: moveSide })));
    const menu = container.querySelector<HTMLSelectElement>('select[aria-label="Move panel"]')!;
    expect(menu.textContent).toContain('Move below workspaces');
    await act(async () => { menu.value = 'workspace'; menu.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(promote).toHaveBeenCalledExactlyOnceWith('surf-source');
    await act(async () => { menu.value = 'side'; menu.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(moveSide).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('keeps a docked explorer on its own terminal when focus or active workspace changes', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const tree: SplitNode = { type: 'leaf', paneId: 'pane-source', activeSurfaceIndex: 0,
    surfaces: [{ id: 'surf-source', type: 'terminal', cwd: 'C:\\repo' }] };
  const listDir = vi.fn(async (_id: string, relPath: string) => ({ root: 'C:\\repo', relPath, entries: [], truncated: false }));
  window.wmux = { explorer: { listDir, diffStats: async () => ({ files: [], baseline: 'git' }) },
    hook: { onEvent: () => () => {} } };
  useStore.getState().replaceAllWorkspaces([
    { id: 'ws-source', title: 'source', splitTree: tree },
    { id: 'ws-other', title: 'other', cwd: 'D:\\other' },
  ]);
  const [source, other] = useStore.getState().workspaces;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExplorerPanel, { docked: true, workspaceId: source.id,
      rootSurfaceId: 'surf-source', focusedPaneId: 'pane-explorer', onClose: () => {} })));
    expect(listDir).toHaveBeenCalledWith('surf-source', '', { showHidden: false });
    await act(async () => useStore.getState().selectWorkspace(other.id));
    expect(container.querySelector('.explorer-panel__root')?.textContent).toBe('repo');
    expect(listDir.mock.calls.every(([id]) => id === 'surf-source')).toBe(true);
    listDir.mockClear();
    await act(async () => useStore.getState().updateSplitTree(source.id, { ...tree, surfaces: [] }));
    expect(listDir).not.toHaveBeenCalled();
    expect(container.querySelector('.explorer-panel__root')?.textContent).toBe('Explorer');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
