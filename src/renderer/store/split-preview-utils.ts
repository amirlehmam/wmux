import type { PaneId, SplitNode, SurfaceId, SurfaceRef } from '../../shared/types';
import { findLeaf, removeLeaf } from './split-utils';

export type SplitPreviewDirection = 'left' | 'right' | 'up' | 'down';

export interface SplitPreviewResult {
  tree: SplitNode;
  destinationPaneId: PaneId;
  collapsesSourcePane: boolean;
}

type LeafNode = SplitNode & { type: 'leaf' };

interface SurfaceRemovalResult {
  tree: SplitNode | null;
  surface: SurfaceRef;
  collapsesSourcePane: boolean;
}

export function previewSplitAndMoveSurface(
  tree: SplitNode,
  targetPaneId: PaneId,
  sourcePaneId: PaneId,
  surfaceId: SurfaceId,
  direction: SplitPreviewDirection,
): SplitPreviewResult | null {
  const sourceLeaf = findLeaf(tree, sourcePaneId);
  const targetLeaf = findLeaf(tree, targetPaneId);
  if (!sourceLeaf || !targetLeaf) return null;

  const draggedSurface = sourceLeaf.surfaces.find((surface) => surface.id === surfaceId);
  if (!draggedSurface) return null;

  if (sourcePaneId === targetPaneId && sourceLeaf.surfaces.length === 1) {
    return null;
  }

  const removal = removeSurfaceForPreview(tree, sourcePaneId, surfaceId);
  if (!removal?.tree) return null;

  const destinationPaneId = createPreviewPaneId(targetPaneId, surfaceId, direction);
  const destinationLeaf: LeafNode = {
    type: 'leaf',
    paneId: destinationPaneId,
    surfaces: [removal.surface],
    activeSurfaceIndex: 0,
  };

  const previewTree = splitTargetForPreview(removal.tree, targetPaneId, destinationLeaf, direction);
  if (!previewTree) return null;

  return {
    tree: previewTree,
    destinationPaneId,
    collapsesSourcePane: removal.collapsesSourcePane,
  };
}

export function previewMoveSurface(
  tree: SplitNode,
  sourcePaneId: PaneId,
  surfaceId: SurfaceId,
  targetPaneId: PaneId,
): SplitPreviewResult | null {
  if (sourcePaneId === targetPaneId) return null;

  const sourceLeaf = findLeaf(tree, sourcePaneId);
  const targetLeaf = findLeaf(tree, targetPaneId);
  if (!sourceLeaf || !targetLeaf) return null;

  const draggedSurface = sourceLeaf.surfaces.find((surface) => surface.id === surfaceId);
  if (!draggedSurface) return null;

  if (sourceLeaf.surfaces.length > 1) {
    return null;
  }

  const removal = removeSurfaceForPreview(tree, sourcePaneId, surfaceId);
  if (!removal?.tree) return null;

  const updatedTarget = findLeaf(removal.tree, targetPaneId);
  if (!updatedTarget) return null;

  const targetSurfaces = [...updatedTarget.surfaces, removal.surface];
  const previewTree = patchLeaf(removal.tree, targetPaneId, {
    surfaces: targetSurfaces,
    activeSurfaceIndex: targetSurfaces.length - 1,
  });

  return {
    tree: previewTree,
    destinationPaneId: targetPaneId,
    collapsesSourcePane: true,
  };
}

function removeSurfaceForPreview(
  tree: SplitNode,
  sourcePaneId: PaneId,
  surfaceId: SurfaceId,
): SurfaceRemovalResult | null {
  const sourceLeaf = findLeaf(tree, sourcePaneId);
  if (!sourceLeaf) return null;

  const surfaceIndex = sourceLeaf.surfaces.findIndex((surface) => surface.id === surfaceId);
  if (surfaceIndex === -1) return null;

  const surface = sourceLeaf.surfaces[surfaceIndex];
  const remainingSurfaces = sourceLeaf.surfaces.filter((candidate) => candidate.id !== surfaceId);

  if (remainingSurfaces.length === 0) {
    return {
      tree: removeLeaf(tree, sourcePaneId),
      surface,
      collapsesSourcePane: true,
    };
  }

  return {
    tree: patchLeaf(tree, sourcePaneId, {
      surfaces: remainingSurfaces,
      activeSurfaceIndex: Math.min(sourceLeaf.activeSurfaceIndex, remainingSurfaces.length - 1),
    }),
    surface,
    collapsesSourcePane: false,
  };
}

function splitTargetForPreview(
  tree: SplitNode,
  targetPaneId: PaneId,
  destinationLeaf: LeafNode,
  direction: SplitPreviewDirection,
): SplitNode | null {
  let changed = false;
  const splitDirection = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const destinationFirst = direction === 'left' || direction === 'up';

  const result = replaceLeaf(tree, targetPaneId, (targetLeaf) => {
    changed = true;
    return {
      type: 'branch',
      direction: splitDirection,
      ratio: 0.5,
      children: destinationFirst
        ? [destinationLeaf, targetLeaf]
        : [targetLeaf, destinationLeaf],
    };
  });

  return changed ? result : null;
}

function patchLeaf(
  tree: SplitNode,
  paneId: PaneId,
  patch: Partial<Pick<LeafNode, 'surfaces' | 'activeSurfaceIndex'>>,
): SplitNode {
  return replaceLeaf(tree, paneId, (leaf) => ({ ...leaf, ...patch }));
}

function replaceLeaf(
  tree: SplitNode,
  paneId: PaneId,
  replacement: (leaf: LeafNode) => SplitNode,
): SplitNode {
  if (tree.type === 'leaf') {
    return tree.paneId === paneId ? replacement(tree) : tree;
  }

  const [left, right] = tree.children;
  const newLeft = replaceLeaf(left, paneId, replacement);
  const newRight = replaceLeaf(right, paneId, replacement);

  if (newLeft === left && newRight === right) return tree;
  return { ...tree, children: [newLeft, newRight] };
}

function createPreviewPaneId(
  targetPaneId: PaneId,
  surfaceId: SurfaceId,
  direction: SplitPreviewDirection,
): PaneId {
  const targetSuffix = targetPaneId.replace(/^pane-/, '');
  const surfaceSuffix = surfaceId.replace(/^surf-/, '');
  return `pane-preview-${direction}-${targetSuffix}-${surfaceSuffix}` as PaneId;
}
