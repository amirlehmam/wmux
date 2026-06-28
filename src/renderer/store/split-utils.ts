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

// ─── adjustPaneRatio (issue #64: keyboard pane resize) ───────────────────────
// Move the divider adjacent to `paneId` along `orientation` by `delta`. We walk
// to the DEEPEST branch of the matching orientation that contains the pane (its
// nearest enclosing divider) and nudge that branch's ratio. "Move the divider"
// semantics (always +delta = right/down) match tmux `resize-pane` and stay
// predictable regardless of which child the pane sits in.
export function adjustPaneRatio(
  tree: SplitNode,
  paneId: PaneId,
  orientation: 'horizontal' | 'vertical',
  delta: number,
): SplitNode {
  if (tree.type === 'leaf') return tree;

  const [left, right] = tree.children;
  const inLeft = branchContainsPaneId(left, paneId);
  const inRight = branchContainsPaneId(right, paneId);
  if (!inLeft && !inRight) return tree;

  // Prefer a deeper matching divider (nearest to the pane) over this one.
  const childWithPane = inLeft ? left : right;
  const adjustedChild = adjustPaneRatio(childWithPane, paneId, orientation, delta);
  if (adjustedChild !== childWithPane) {
    return inLeft
      ? { ...tree, children: [adjustedChild, right] }
      : { ...tree, children: [left, adjustedChild] };
  }

  // No deeper match — this is the nearest enclosing divider for the pane.
  if (tree.direction === orientation) {
    return { ...tree, ratio: clampRatio(tree.ratio + delta) };
  }
  return tree;
}

// ─── collectActiveTerminalSurfaceIds (issue #64: broadcast input) ────────────
// One id per pane: the pane's ACTIVE surface, if it's a terminal. PTY id ===
// surface id, so callers `pty.write(id, …)` to fan keystrokes across the visible
// terminal of every pane (background keep-alive tabs are intentionally skipped —
// broadcasting to shells the user can't see would be surprising).
export function collectActiveTerminalSurfaceIds(tree: SplitNode): SurfaceId[] {
  if (tree.type === 'leaf') {
    const active = tree.surfaces[tree.activeSurfaceIndex];
    return active && active.type === 'terminal' ? [active.id] : [];
  }
  return [
    ...collectActiveTerminalSurfaceIds(tree.children[0]),
    ...collectActiveTerminalSurfaceIds(tree.children[1]),
  ];
}

// ─── buildGridLayout ──────────────────────────────────────────────────────────
// Replace the ENTIRE workspace split tree with a balanced grid of `count` cells.
//
// Cell [0,0] (top-left) is the anchor pane, keeping its original surfaces plus
// any surfaces absorbed from every other existing pane as extra tabs. This way
// no PTY is killed and no running process is lost when the orchestrator takes
// over the viewport — a dev server that was running in another pane simply
// becomes a tab in the top-left cell of the new grid.
//
// The `count - 1` remaining cells are brand-new leaves, returned in row-major
// order so callers (spawn-agents.sh) can assign agents to them by index.
//
// Grid shape: cols = ceil(sqrt(count)), rows = ceil(count / cols) — wider than
// tall, matching the typical 16:9 workspace aspect ratio.
//
// Why replace-entire-tree instead of wrap-anchor-in-place: the old behaviour
// wrapped the anchor leaf with the grid subtree, which meant the grid only
// occupied the anchor's rectangle. With multiple existing panes, N agents got
// crammed into 1/N-th of the viewport while the rest stayed untouched. The
// orchestrator's goal is to take over the whole workspace, so full replacement
// is the correct semantic — we just have to preserve surfaces as tabs so no
// work is lost in the transition.

export function buildGridLayout(
  tree: SplitNode,
  anchorPaneId: PaneId,
  count: number,
  surfaceType: SurfaceType = 'terminal',
): { tree: SplitNode; newPaneIds: PaneId[] } {
  if (count < 2) return { tree, newPaneIds: [] };

  const anchor = findLeaf(tree, anchorPaneId);
  if (!anchor) return { tree, newPaneIds: [] };

  // Absorb surfaces from every OTHER existing pane into the anchor as extra
  // tabs. The anchor's original surfaces come first, so its active tab index
  // still points at the orchestrator's own surface after the merge.
  const allPaneIds = getAllPaneIds(tree);
  const absorbedSurfaces: typeof anchor.surfaces = [];
  for (const pid of allPaneIds) {
    if (pid === anchorPaneId) continue;
    const otherLeaf = findLeaf(tree, pid);
    if (otherLeaf?.surfaces) absorbedSurfaces.push(...otherLeaf.surfaces);
  }

  const mergedAnchor: SplitNode & { type: 'leaf' } = {
    ...anchor,
    surfaces: [...anchor.surfaces, ...absorbedSurfaces],
    activeSurfaceIndex: anchor.activeSurfaceIndex,
  };

  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));

  const cells: SplitNode[] = [];
  const newPaneIds: PaneId[] = [];
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      cells.push(mergedAnchor);
    } else {
      const id = `pane-${uuid()}` as PaneId;
      newPaneIds.push(id);
      cells.push(createLeaf(id, surfaceType));
    }
  }

  // Chain each row horizontally (left to right): A | (B | (C | D))
  // ratio[i] = 1 / (rowLen - i) so every cell ends up at 1/rowLen of the row width.
  const rowTrees: SplitNode[] = [];
  for (let r = 0; r < rows; r++) {
    const start = r * cols;
    const end = Math.min(start + cols, count);
    const rowCells = cells.slice(start, end);
    let rowTree: SplitNode = rowCells[rowCells.length - 1];
    for (let c = rowCells.length - 2; c >= 0; c--) {
      rowTree = {
        type: 'branch',
        direction: 'horizontal',
        ratio: 1 / (rowCells.length - c),
        children: [rowCells[c], rowTree],
      };
    }
    rowTrees.push(rowTree);
  }

  // Chain rows vertically (top to bottom) using the same ratio pattern.
  let gridTree: SplitNode = rowTrees[rowTrees.length - 1];
  for (let r = rowTrees.length - 2; r >= 0; r--) {
    gridTree = {
      type: 'branch',
      direction: 'vertical',
      ratio: 1 / (rowTrees.length - r),
      children: [rowTrees[r], gridTree],
    };
  }

  // Replace the entire workspace tree with the grid. Other panes' containers
  // are discarded; their surfaces already live inside mergedAnchor.
  return { tree: gridTree, newPaneIds };
}
