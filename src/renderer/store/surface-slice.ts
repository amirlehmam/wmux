import { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import { WorkspaceId, PaneId, SurfaceId, SurfaceRef, SurfaceType } from '../../shared/types';
import { findLeaf, removeLeaf } from './split-utils';
import { WorkspaceSlice } from './workspace-slice';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SurfaceSlice {
  /** Add a new surface (tab) to a pane; returns the new SurfaceId */
  addSurface: (
    workspaceId: WorkspaceId,
    paneId: PaneId,
    type: SurfaceType,
  ) => SurfaceId;

  /** Close a surface; if it's the last one in the pane, the pane is removed */
  closeSurface: (workspaceId: WorkspaceId, paneId: PaneId, surfaceId: SurfaceId) => void;

  /** Advance to the next surface in the pane (wraps around) */
  nextSurface: (workspaceId: WorkspaceId, paneId: PaneId) => void;

  /** Go back to the previous surface in the pane (wraps around) */
  prevSurface: (workspaceId: WorkspaceId, paneId: PaneId) => void;

  /** Select a surface by 0-based index */
  selectSurface: (workspaceId: WorkspaceId, paneId: PaneId, index: number) => void;

  /** Move a surface from one pane to another (drag-and-drop) */
  moveSurface: (workspaceId: WorkspaceId, sourcePaneId: PaneId, surfaceId: SurfaceId, targetPaneId: PaneId) => void;
}

// ─── Helper: update a leaf's surfaces in the split tree ──────────────────────

type SliceState = SurfaceSlice & WorkspaceSlice;

// ─── Slice creator ───────────────────────────────────────────────────────────

export const createSurfaceSlice: StateCreator<SliceState, [], [], SurfaceSlice> = (_set, get) => ({
  addSurface(workspaceId, paneId, type) {
    const surfaceId: SurfaceId = `surf-${uuid()}` as SurfaceId;

    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return surfaceId;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return surfaceId;

    const newSurface: SurfaceRef = { id: surfaceId, type };
    const newSurfaces = [...leaf.surfaces, newSurface];
    const newActiveSurfaceIndex = newSurfaces.length - 1;

    // Rebuild tree with updated leaf (immutable)
    const updatedTree = patchLeaf(ws.splitTree, paneId, {
      surfaces: newSurfaces,
      activeSurfaceIndex: newActiveSurfaceIndex,
    });

    updateSplitTree(workspaceId, updatedTree);
    return surfaceId;
  },

  closeSurface(workspaceId, paneId, surfaceId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    const newSurfaces = leaf.surfaces.filter((s) => s.id !== surfaceId);

    if (newSurfaces.length === 0) {
      // No surfaces left — remove the pane entirely
      const newTree = removeLeaf(ws.splitTree, paneId);
      if (newTree) {
        updateSplitTree(workspaceId, newTree);
      }
      // If newTree is null the workspace has no panes; leave it intact
      // (workspace-level empty state is handled elsewhere)
      return;
    }

    // Clamp activeSurfaceIndex so it stays in bounds
    const newActiveIndex = Math.min(leaf.activeSurfaceIndex, newSurfaces.length - 1);
    const updatedTree = patchLeaf(ws.splitTree, paneId, {
      surfaces: newSurfaces,
      activeSurfaceIndex: newActiveIndex,
    });

    updateSplitTree(workspaceId, updatedTree);
  },

  nextSurface(workspaceId, paneId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf || leaf.surfaces.length <= 1) return;

    const newIndex = (leaf.activeSurfaceIndex + 1) % leaf.surfaces.length;
    const updatedTree = patchLeaf(ws.splitTree, paneId, { activeSurfaceIndex: newIndex });
    updateSplitTree(workspaceId, updatedTree);
  },

  prevSurface(workspaceId, paneId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf || leaf.surfaces.length <= 1) return;

    const newIndex = (leaf.activeSurfaceIndex - 1 + leaf.surfaces.length) % leaf.surfaces.length;
    const updatedTree = patchLeaf(ws.splitTree, paneId, { activeSurfaceIndex: newIndex });
    updateSplitTree(workspaceId, updatedTree);
  },

  moveSurface(workspaceId, sourcePaneId, surfaceId, targetPaneId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const sourceLeaf = findLeaf(ws.splitTree, sourcePaneId);
    const targetLeaf = findLeaf(ws.splitTree, targetPaneId);
    if (!sourceLeaf || !targetLeaf) return;

    // Find the surface in the source
    const surfaceIndex = sourceLeaf.surfaces.findIndex((s) => s.id === surfaceId);
    if (surfaceIndex === -1) return;
    const surface = sourceLeaf.surfaces[surfaceIndex];

    // Remove from source
    const newSourceSurfaces = sourceLeaf.surfaces.filter((s) => s.id !== surfaceId);
    let tree = ws.splitTree;

    if (newSourceSurfaces.length === 0) {
      // Source pane is now empty — remove it
      tree = removeLeaf(tree, sourcePaneId) ?? tree;
    } else {
      tree = patchLeaf(tree, sourcePaneId, {
        surfaces: newSourceSurfaces,
        activeSurfaceIndex: Math.min(sourceLeaf.activeSurfaceIndex, newSourceSurfaces.length - 1),
      });
    }

    // Add to target
    const updatedTargetLeaf = findLeaf(tree, targetPaneId);
    if (updatedTargetLeaf) {
      const newTargetSurfaces = [...updatedTargetLeaf.surfaces, surface];
      tree = patchLeaf(tree, targetPaneId, {
        surfaces: newTargetSurfaces,
        activeSurfaceIndex: newTargetSurfaces.length - 1,
      });
    }

    updateSplitTree(workspaceId, tree);
  },

  selectSurface(workspaceId, paneId, index) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    const clampedIndex = Math.max(0, Math.min(index, leaf.surfaces.length - 1));
    if (clampedIndex === leaf.activeSurfaceIndex) return;

    const updatedTree = patchLeaf(ws.splitTree, paneId, { activeSurfaceIndex: clampedIndex });
    updateSplitTree(workspaceId, updatedTree);
  },
});

// ─── patchLeaf — immutable leaf update inside an arbitrary tree ───────────────

import { SplitNode } from '../../shared/types';

function patchLeaf(
  tree: SplitNode,
  paneId: PaneId,
  patch: Partial<Pick<SplitNode & { type: 'leaf' }, 'surfaces' | 'activeSurfaceIndex'>>,
): SplitNode {
  if (tree.type === 'leaf') {
    if (tree.paneId !== paneId) return tree;
    return { ...tree, ...patch };
  }

  const [left, right] = tree.children;
  const newLeft = patchLeaf(left, paneId, patch);
  const newRight = patchLeaf(right, paneId, patch);

  if (newLeft === left && newRight === right) return tree;
  return { ...tree, children: [newLeft, newRight] };
}
