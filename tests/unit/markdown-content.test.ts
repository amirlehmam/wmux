import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createSurfaceSlice, SurfaceSlice } from '../../src/renderer/store/surface-slice';
import { getAllPaneIds, findLeaf, splitNode } from '../../src/renderer/store/split-utils';
import { WorkspaceId, PaneId, SurfaceId } from '../../src/shared/types';

// setMarkdownContent locates the owning pane by surfaceId across all
// workspaces/panes, so the pipe bridge (which only knows the surfaceId) can
// render content into a markdown surface (issue #54).

type TestStore = WorkspaceSlice & SurfaceSlice;

function makeStore() {
  return create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createSurfaceSlice(...args),
  }));
}

describe('surface-slice: setMarkdownContent (issue #54)', () => {
  let useStore: ReturnType<typeof makeStore>;
  let workspaceId: WorkspaceId;
  let paneId: PaneId;

  beforeEach(() => {
    useStore = makeStore();
    workspaceId = useStore.getState().createWorkspace({ title: 'MD WS' });
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId)!;
    paneId = getAllPaneIds(ws.splitTree)[0];
  });

  function getSurface(surfaceId: SurfaceId) {
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId)!;
    for (const pid of getAllPaneIds(ws.splitTree)) {
      const leaf = findLeaf(ws.splitTree, pid);
      const s = leaf?.surfaces.find((su) => su.id === surfaceId);
      if (s) return s;
    }
    return undefined;
  }

  it('persists content onto the markdown surface', () => {
    const surfaceId = useStore.getState().addSurface(workspaceId, paneId, 'markdown');
    useStore.getState().setMarkdownContent(surfaceId, '# Hello');
    expect(getSurface(surfaceId)?.markdownContent).toBe('# Hello');
  });

  it('overwrites previously set content', () => {
    const surfaceId = useStore.getState().addSurface(workspaceId, paneId, 'markdown');
    useStore.getState().setMarkdownContent(surfaceId, 'first');
    useStore.getState().setMarkdownContent(surfaceId, 'second');
    expect(getSurface(surfaceId)?.markdownContent).toBe('second');
  });

  it('is a no-op for an unknown surface id (does not throw)', () => {
    expect(() =>
      useStore.getState().setMarkdownContent('surf-nonexistent' as SurfaceId, 'x'),
    ).not.toThrow();
  });

  it('finds the target surface in a non-first pane', () => {
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId)!;
    const newPaneId = 'pane-second' as PaneId;
    const newTree = splitNode(ws.splitTree, paneId, newPaneId, 'markdown', 'horizontal');
    useStore.getState().updateSplitTree(workspaceId, newTree);

    const leaf = findLeaf(newTree, newPaneId)!;
    const surfaceId = leaf.surfaces[0].id; // markdown surface auto-created by splitNode

    useStore.getState().setMarkdownContent(surfaceId, 'in second pane');
    expect(getSurface(surfaceId)?.markdownContent).toBe('in second pane');
  });
});
