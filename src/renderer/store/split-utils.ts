import { v4 as uuid } from 'uuid';
import { SplitNode, PaneId, SurfaceId, SurfaceType } from '../../shared/types';

// ─── Leaf factory ────────────────────────────────────────────────────────────

export function createLeaf(
  paneId?: PaneId,
  surfaceType: SurfaceType = 'terminal',
): SplitNode & { type: 'leaf' } {
  const resolvedPaneId: PaneId = paneId ?? (`pane-${uuid()}` as PaneId);
  const surfaceId: SurfaceId = `surf-${uuid()}` as SurfaceId;
  return {
    type: 'leaf',
    paneId: resolvedPaneId,
    surfaces: [{ id: surfaceId, type: surfaceType }],
    activeSurfaceIndex: 0,
  };
}

// ─── splitNode ───────────────────────────────────────────────────────────────

export function splitNode(
  tree: SplitNode,
  targetPaneId: PaneId,
  newPaneId: PaneId,
  surfaceType: SurfaceType,
  direction: 'horizontal' | 'vertical',
): SplitNode {
  if (tree.type === 'leaf') {
    if (tree.paneId !== targetPaneId) return tree;
    const newLeaf = createLeaf(newPaneId, surfaceType);
    return {
      type: 'branch',
      direction,
      ratio: 0.5,
      children: [tree, newLeaf],
    };
  }

  // Branch — recurse into children
  const [left, right] = tree.children;
  const newLeft = splitNode(left, targetPaneId, newPaneId, surfaceType, direction);
  const newRight = splitNode(right, targetPaneId, newPaneId, surfaceType, direction);

  if (newLeft === left && newRight === right) return tree; // nothing changed
  return { ...tree, children: [newLeft, newRight] };
}

// ─── removeLeaf ──────────────────────────────────────────────────────────────

export function removeLeaf(tree: SplitNode, paneId: PaneId): SplitNode | null {
  if (tree.type === 'leaf') {
    return tree.paneId === paneId ? null : tree;
  }

  const [left, right] = tree.children;

  const newLeft = removeLeaf(left, paneId);
  const newRight = removeLeaf(right, paneId);

  // If left was removed, collapse to right
  if (newLeft === null) return newRight;
  // If right was removed, collapse to left
  if (newRight === null) return newLeft;
  // Neither changed
  if (newLeft === left && newRight === right) return tree;
  // Both still exist but something changed deeper
  return { ...tree, children: [newLeft, newRight] };
}

// ─── findLeaf ────────────────────────────────────────────────────────────────

export function findLeaf(
  tree: SplitNode,
  paneId: PaneId,
): (SplitNode & { type: 'leaf' }) | undefined {
  if (tree.type === 'leaf') {
    return tree.paneId === paneId ? tree : undefined;
  }
  return findLeaf(tree.children[0], paneId) ?? findLeaf(tree.children[1], paneId);
}

// ─── updateRatio ─────────────────────────────────────────────────────────────

function clampRatio(r: number): number {
  return Math.min(0.9, Math.max(0.1, r));
}

function branchContainsPaneId(node: SplitNode, paneId: PaneId): boolean {
  if (node.type === 'leaf') return node.paneId === paneId;
  return branchContainsPaneId(node.children[0], paneId) ||
    branchContainsPaneId(node.children[1], paneId);
}

export function updateRatio(
  tree: SplitNode,
  leftPaneId: PaneId,
  rightPaneId: PaneId,
  newRatio: number,
): SplitNode {
  if (tree.type === 'leaf') return tree;

  const [left, right] = tree.children;

  // Check if this branch directly contains both panes (one per child subtree)
  const leftHasLeft = branchContainsPaneId(left, leftPaneId);
  const leftHasRight = branchContainsPaneId(left, rightPaneId);
  const rightHasLeft = branchContainsPaneId(right, leftPaneId);
  const rightHasRight = branchContainsPaneId(right, rightPaneId);

  if ((leftHasLeft && rightHasRight) || (leftHasRight && rightHasLeft)) {
    return { ...tree, ratio: clampRatio(newRatio) };
  }

  // Recurse
  const newLeft = updateRatio(left, leftPaneId, rightPaneId, newRatio);
  const newRight = updateRatio(right, leftPaneId, rightPaneId, newRatio);
  if (newLeft === left && newRight === right) return tree;
  return { ...tree, children: [newLeft, newRight] };
}

// ─── getAllPaneIds ────────────────────────────────────────────────────────────

export function getAllPaneIds(tree: SplitNode): PaneId[] {
  if (tree.type === 'leaf') return [tree.paneId];
  return [...getAllPaneIds(tree.children[0]), ...getAllPaneIds(tree.children[1])];
}
