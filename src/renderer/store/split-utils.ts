import { v4 as uuid } from 'uuid';
import { SplitNode, PaneId, SurfaceId, SurfaceType, SurfaceRef } from '../../shared/types';

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

// ─── buildDefaultSplitTree (the sidebar "+" / first-launch factory layout) ───
// wmux's built-in "factory" new-workspace layout: a top row split into two
// panes, plus one pane below.
export function buildDefaultSplitTree(): SplitNode {
  return {
    type: 'branch',
    direction: 'vertical',
    ratio: 0.5,
    children: [
      {
        type: 'branch',
        direction: 'horizontal',
        ratio: 0.5,
        children: [createLeaf(), createLeaf()],
      },
      createLeaf(),
    ],
  };
}

// ─── instantiateLayout (saved default/preset layouts) ────────────────────────
// A saved layout's pane/surface ids are frozen at the moment it was captured
// from a live workspace, so applying it twice (or to two different new
// workspaces) would otherwise hand out duplicate ids — breaking the PTY id ===
// surface id re-attach invariant. Re-mint fresh ids on every use, the same way
// buildDefaultSplitTree() used to mint fresh ids on every call, while carrying
// every other surface field (type/shell/cwd/startupCommands/colorScheme/...)
// through unchanged.
export function instantiateLayout(template: SplitNode): SplitNode {
  if (template.type === 'leaf') {
    return {
      type: 'leaf',
      paneId: `pane-${uuid()}` as PaneId,
      surfaces: template.surfaces.map((s) => ({ ...s, id: `surf-${uuid()}` as SurfaceId })),
      activeSurfaceIndex: template.activeSurfaceIndex,
    };
  }
  return {
    ...template,
    children: [instantiateLayout(template.children[0]), instantiateLayout(template.children[1])],
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

// ─── freezeSurfaceCwds (issue #134: save/restore per-terminal directory) ─────
// Rewrite every surface's spawn `cwd` to the directory it is *actually* sitting
// in, for the copy of the tree that goes into a saved session.
//
// A terminal carries two directories: `cwd`, where it was told to start, and
// `currentCwd`, where shell integration last reported it to be. Only the first
// was persisted, and for a tab opened the ordinary way it is undefined — so on
// restore every terminal in a workspace fell back to the single, workspace-level
// `cwd`, which is itself whichever pane reported a prompt most recently. Two
// terminals on D:\ therefore came back on C:\ (the shell's own default when the
// fallback was empty too), which is exactly what #134 hit: with git worktrees on
// separate drives, restoring a session lost the one thing that identified it.
//
// Freezing happens at save time rather than on every prompt because `cwd` is a
// *spawn* argument. Live-updating it would be rewriting the terminal's history
// while it runs, and PaneWrapper passes it as a prop — the store's copy stays
// untouched, so nothing about the running session changes.
//
// `currentCwd` is carried through as well, so a restored tab can label itself
// with the right folder before its shell has reported a first prompt.
export function freezeSurfaceCwds(tree: SplitNode): SplitNode {
  if (tree.type === 'leaf') {
    return {
      ...tree,
      surfaces: tree.surfaces.map((s) => (s.currentCwd ? { ...s, cwd: s.currentCwd } : s)),
    };
  }
  return {
    ...tree,
    children: [freezeSurfaceCwds(tree.children[0]), freezeSurfaceCwds(tree.children[1])],
  };
}

// ─── patchLeafPrimarySurface (saved-layout pane editing) ─────────────────────
// This lets the Saved Layouts settings UI set `startupCommands`/ `shell` 
// directly on a stored template's pane, same fields Quick Launch
// profiles already use.
export function patchLeafPrimarySurface(
  tree: SplitNode,
  paneId: PaneId,
  patch: Partial<SurfaceRef>,
): SplitNode {
  if (tree.type === 'leaf') {
    if (tree.paneId !== paneId || tree.surfaces.length === 0) return tree;
    const surfaces = [...tree.surfaces];
    surfaces[0] = { ...surfaces[0], ...patch };
    return { ...tree, surfaces };
  }
  const [left, right] = tree.children;
  const newLeft = patchLeafPrimarySurface(left, paneId, patch);
  const newRight = patchLeafPrimarySurface(right, paneId, patch);
  if (newLeft === left && newRight === right) return tree;
  return { ...tree, children: [newLeft, newRight] };
}

// ─── mergeStartupCommands (Overwrite must not clobber manual pane edits) ─────
// "Overwrite" re-captures a saved layout's `splitTree` wholesale from the
// live workspace (freezeSurfaceCwds(active.splitTree)) — which has no idea
// about a startupCommands the user typed directly into a saved layout's pane
// row in Settings, since nothing live ever set that field. Without this, every
// Overwrite silently threw those edits away. Matches old→new panes by
// position (getAllPaneIds order) rather than requiring identical tree shape,
// since geometry can legitimately change between saves; a live pane that
// already has its own startupCommands (e.g. from a quick-launch profile)
// always wins over a stale settings-panel edit.
export function mergeStartupCommands(newTree: SplitNode, oldTree: SplitNode): SplitNode {
  const oldCommandsByIndex = getAllPaneIds(oldTree).map(
    (pid) => findLeaf(oldTree, pid)?.surfaces[0]?.startupCommands,
  );
  let result = newTree;
  getAllPaneIds(newTree).forEach((paneId, i) => {
    const oldCommands = oldCommandsByIndex[i];
    if (!oldCommands || oldCommands.length === 0) return;
    const newSurface = findLeaf(result, paneId)?.surfaces[0];
    if (newSurface && (!newSurface.startupCommands || newSurface.startupCommands.length === 0)) {
      result = patchLeafPrimarySurface(result, paneId, { startupCommands: oldCommands });
    }
  });
  return result;
}

// ─── replaceSoleTerminalSurface (agent spawn --replace-tab) ──────────────────
// Swap a pane's single default terminal tab for `newSurface`, so an agent can
// occupy a freshly-gridded pane without leaving the idle shell behind as a
// dead tab. Only fires when the leaf has EXACTLY one surface and it's a
// terminal — anything else (user tabs, browser/markdown surfaces) falls back
// to append semantics. Returns the replaced surface id so the caller can kill
// its PTY; `replacedSurfaceId: null` means the tree is unchanged.

export function replaceSoleTerminalSurface(
  tree: SplitNode,
  paneId: PaneId,
  newSurface: { id: SurfaceId; type: SurfaceType },
): { tree: SplitNode; replacedSurfaceId: SurfaceId | null } {
  const leaf = findLeaf(tree, paneId);
  if (!leaf || leaf.surfaces.length !== 1 || leaf.surfaces[0].type !== 'terminal') {
    return { tree, replacedSurfaceId: null };
  }
  const replacedSurfaceId = leaf.surfaces[0].id;

  const replaceInNode = (node: SplitNode): SplitNode => {
    if (node.type === 'leaf') {
      if (node.paneId !== paneId) return node;
      return { ...node, surfaces: [newSurface], activeSurfaceIndex: 0 };
    }
    const [left, right] = node.children;
    const newLeft = replaceInNode(left);
    const newRight = replaceInNode(right);
    if (newLeft === left && newRight === right) return node;
    return { ...node, children: [newLeft, newRight] };
  };

  return { tree: replaceInNode(tree), replacedSurfaceId };
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
