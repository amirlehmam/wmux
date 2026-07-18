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

describe('duplicateSurface', () => {
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

  it('adds a new surface copying type, shell and colorScheme', () => {
    const srcId = currentLeaf().surfaces[0].id;
    useStore.getState().updateSurface(workspaceId, paneId, srcId, {
      shell: 'pwsh',
      cwd: 'C:/one',
      colorScheme: 'prod',
    });

    const newId = useStore.getState().duplicateSurface(workspaceId, paneId, srcId);

    const surfaces = currentLeaf().surfaces;
    expect(surfaces).toHaveLength(2);
    const dup = surfaces.find((s) => s.id === newId)!;
    expect(dup.id).not.toBe(srcId);
    expect(dup.type).toBe('terminal');
    expect(dup.shell).toBe('pwsh');
    expect(dup.cwd).toBe('C:/one');
    expect(dup.colorScheme).toBe('prod');
  });

  it('uses the source live directory (currentCwd) when present', () => {
    const srcId = currentLeaf().surfaces[0].id;
    useStore.getState().updateSurface(workspaceId, paneId, srcId, {
      cwd: 'C:/start',
      currentCwd: 'C:/start/sub',
    });

    const newId = useStore.getState().duplicateSurface(workspaceId, paneId, srcId);
    const dup = currentLeaf().surfaces.find((s) => s.id === newId)!;
    expect(dup.cwd).toBe('C:/start/sub');
  });

  it('makes the duplicate the active surface', () => {
    const srcId = currentLeaf().surfaces[0].id;
    const newId = useStore.getState().duplicateSurface(workspaceId, paneId, srcId);
    const leaf = currentLeaf();
    expect(leaf.surfaces[leaf.activeSurfaceIndex].id).toBe(newId);
  });

  it('returns null when the source surface does not exist', () => {
    const newId = useStore.getState().duplicateSurface(workspaceId, paneId, 'surf-missing' as SurfaceId);
    expect(newId).toBeNull();
    expect(currentLeaf().surfaces).toHaveLength(1);
  });
});
