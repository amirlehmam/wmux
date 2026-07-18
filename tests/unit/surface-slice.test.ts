import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createSurfaceSlice, SurfaceSlice } from '../../src/renderer/store/surface-slice';
import { WorkspaceId, PaneId, SurfaceId, SplitNode } from '../../src/shared/types';

type TestStore = WorkspaceSlice & SurfaceSlice;

function makeStore() {
  return create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createSurfaceSlice(...args),
  }));
}

function leafOf(tree: SplitNode, paneId: PaneId) {
  if (tree.type === 'leaf') return tree.paneId === paneId ? tree : null;
  return leafOf(tree.children[0], paneId) ?? leafOf(tree.children[1], paneId);
}

describe('surface-slice', () => {
  let useStore: ReturnType<typeof makeStore>;
  let workspaceId: WorkspaceId;
  let paneId: PaneId;

  beforeEach(() => {
    useStore = makeStore();
    workspaceId = useStore.getState().createWorkspace({ title: 'Test WS' });
    const tree = useStore.getState().workspaces[0].splitTree;
    paneId = (tree as Extract<SplitNode, { type: 'leaf' }>).paneId;
  });

  function currentLeaf() {
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId)!;
    return leafOf(ws.splitTree, paneId)!;
  }

  describe('renameSurface', () => {
    it('sets customTitle on the target surface', () => {
      const id = currentLeaf().surfaces[0].id;
      useStore.getState().renameSurface(workspaceId, paneId, id, 'My Tab');
      expect(currentLeaf().surfaces[0].customTitle).toBe('My Tab');
    });

    it('clears customTitle when given an empty string', () => {
      const id = currentLeaf().surfaces[0].id;
      useStore.getState().renameSurface(workspaceId, paneId, id, 'X');
      useStore.getState().renameSurface(workspaceId, paneId, id, '');
      expect(currentLeaf().surfaces[0].customTitle).toBeUndefined();
    });
  });

  describe('closeOtherSurfaces', () => {
    it('keeps only the target surface and drops the rest', () => {
      const keep = currentLeaf().surfaces[0].id;
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      expect(currentLeaf().surfaces).toHaveLength(3);

      useStore.getState().closeOtherSurfaces(workspaceId, paneId, keep);

      const surfaces = currentLeaf().surfaces;
      expect(surfaces).toHaveLength(1);
      expect(surfaces[0].id).toBe(keep);
      expect(currentLeaf().activeSurfaceIndex).toBe(0);
    });

    it('is a no-op when the target is the only surface', () => {
      const only = currentLeaf().surfaces[0].id;
      useStore.getState().closeOtherSurfaces(workspaceId, paneId, only);
      expect(currentLeaf().surfaces).toHaveLength(1);
      expect(currentLeaf().surfaces[0].id).toBe(only);
    });

    it('does nothing when the target surface does not exist', () => {
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      expect(currentLeaf().surfaces).toHaveLength(2);
      useStore.getState().closeOtherSurfaces(workspaceId, paneId, 'surf-missing' as SurfaceId);
      expect(currentLeaf().surfaces).toHaveLength(2);
    });
  });
});
