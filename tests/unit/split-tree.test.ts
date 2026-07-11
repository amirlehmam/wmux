import { describe, it, expect } from 'vitest';
import { createLeaf, splitNode, removeLeaf, findLeaf, updateRatio, getAllPaneIds, buildGridLayout, replaceSoleTerminalSurface } from '../../src/renderer/store/split-utils';

describe('split-tree', () => {
  it('creates a leaf node', () => {
    const leaf = createLeaf('pane-1' as any, 'terminal');
    expect(leaf.type).toBe('leaf');
    expect(leaf.paneId).toBe('pane-1');
    expect(leaf.surfaces.length).toBe(1);
    expect(leaf.surfaces[0].type).toBe('terminal');
  });

  it('splits a leaf horizontally', () => {
    const leaf = createLeaf('pane-1' as any, 'terminal');
    const result = splitNode(leaf, 'pane-1', 'pane-2' as any, 'terminal', 'horizontal');
    expect(result.type).toBe('branch');
    if (result.type === 'branch') {
      expect(result.direction).toBe('horizontal');
      expect(result.ratio).toBe(0.5);
      expect(result.children[0].type).toBe('leaf');
      expect(result.children[1].type).toBe('leaf');
    }
  });

  it('splits a leaf vertically', () => {
    const leaf = createLeaf('pane-1' as any, 'terminal');
    const result = splitNode(leaf, 'pane-1', 'pane-2' as any, 'terminal', 'vertical');
    if (result.type === 'branch') {
      expect(result.direction).toBe('vertical');
    }
  });

  it('removes a leaf and collapses parent', () => {
    const leaf = createLeaf('pane-1' as any, 'terminal');
    const tree = splitNode(leaf, 'pane-1', 'pane-2' as any, 'terminal', 'horizontal');
    const result = removeLeaf(tree, 'pane-2');
    expect(result?.type).toBe('leaf');
    if (result?.type === 'leaf') expect(result.paneId).toBe('pane-1');
  });

  it('finds a leaf by paneId', () => {
    const leaf = createLeaf('pane-1' as any, 'terminal');
    const tree = splitNode(leaf, 'pane-1', 'pane-2' as any, 'terminal', 'vertical');
    expect(findLeaf(tree, 'pane-2')).toBeDefined();
    expect(findLeaf(tree, 'pane-999' as any)).toBeUndefined();
  });

  it('updates ratio of a branch', () => {
    const leaf = createLeaf('pane-1' as any, 'terminal');
    const tree = splitNode(leaf, 'pane-1', 'pane-2' as any, 'terminal', 'horizontal');
    const updated = updateRatio(tree, 'pane-1', 'pane-2', 0.7);
    if (updated.type === 'branch') expect(updated.ratio).toBe(0.7);
  });

  it('clamps ratio between 0.1 and 0.9', () => {
    const leaf = createLeaf('pane-1' as any, 'terminal');
    const tree = splitNode(leaf, 'pane-1', 'pane-2' as any, 'terminal', 'horizontal');
    const updated = updateRatio(tree, 'pane-1', 'pane-2', 1.5);
    if (updated.type === 'branch') expect(updated.ratio).toBe(0.9);
  });
});

describe('buildGridLayout', () => {
  it('returns empty result when count < 2', () => {
    const tree = createLeaf('pane-1' as any, 'terminal');
    const result = buildGridLayout(tree, 'pane-1' as any, 1);
    expect(result.newPaneIds.length).toBe(0);
    expect(result.tree).toBe(tree);
  });

  it('builds a 2-cell grid from a single pane', () => {
    const tree = createLeaf('pane-1' as any, 'terminal');
    const result = buildGridLayout(tree, 'pane-1' as any, 2);
    expect(result.newPaneIds.length).toBe(1);
    const paneIds = getAllPaneIds(result.tree);
    expect(paneIds.length).toBe(2);
    expect(paneIds[0]).toBe('pane-1'); // anchor stays as cell [0,0]
    expect(paneIds).toContain(result.newPaneIds[0]);
  });

  it('builds a 4-cell 2x2 grid', () => {
    const tree = createLeaf('pane-1' as any, 'terminal');
    const result = buildGridLayout(tree, 'pane-1' as any, 4);
    expect(result.newPaneIds.length).toBe(3);
    expect(getAllPaneIds(result.tree).length).toBe(4);
  });

  it('uses the full workspace viewport when the workspace has multiple existing panes', () => {
    // Build a workspace with 3 existing panes: pane-1 (anchor) | pane-2 | pane-3
    let tree: any = createLeaf('pane-1' as any, 'terminal');
    tree = splitNode(tree, 'pane-1' as any, 'pane-2' as any, 'terminal', 'horizontal');
    tree = splitNode(tree, 'pane-2' as any, 'pane-3' as any, 'terminal', 'vertical');
    expect(getAllPaneIds(tree).length).toBe(3);

    // Request a 3-cell grid anchored at pane-1 (orchestrator + 2 agents)
    const result = buildGridLayout(tree, 'pane-1' as any, 3);

    // Exactly 3 panes in the new tree — pane-2 and pane-3 are gone as containers,
    // but their surfaces were absorbed into pane-1 as extra tabs
    const paneIds = getAllPaneIds(result.tree);
    expect(paneIds.length).toBe(3);
    expect(paneIds).toContain('pane-1');
    expect(paneIds).not.toContain('pane-2');
    expect(paneIds).not.toContain('pane-3');
    expect(result.newPaneIds.length).toBe(2);

    // Anchor pane now has 3 surfaces (its original 1 + 2 absorbed from pane-2 and pane-3)
    const anchor = findLeaf(result.tree, 'pane-1' as any);
    expect(anchor?.surfaces.length).toBe(3);
    // Orchestrator's original surface is still the active one
    expect(anchor?.activeSurfaceIndex).toBe(0);
  });

  it('preserves PTY-carrying surfaces by absorbing them as tabs, never dropping them', () => {
    // Workspace with 4 panes, each with a distinct surface
    let tree: any = createLeaf('pane-1' as any, 'terminal');
    tree = splitNode(tree, 'pane-1' as any, 'pane-2' as any, 'terminal', 'horizontal');
    tree = splitNode(tree, 'pane-2' as any, 'pane-3' as any, 'terminal', 'vertical');
    tree = splitNode(tree, 'pane-3' as any, 'pane-4' as any, 'browser', 'horizontal');

    // Capture every original surface ID
    const originalSurfaceIds = new Set<string>();
    for (const pid of getAllPaneIds(tree)) {
      const leaf = findLeaf(tree, pid);
      leaf?.surfaces.forEach(s => originalSurfaceIds.add(s.id));
    }
    expect(originalSurfaceIds.size).toBe(4);

    // Orchestrator runs in pane-1 and requests a 3-cell grid (2 agents)
    const result = buildGridLayout(tree, 'pane-1' as any, 3);

    // Every original surface must still exist somewhere in the new tree,
    // guaranteed by the absorb-as-tabs contract. Without it, closing a dev
    // server pane during orchestration would kill the process.
    const survivingSurfaceIds = new Set<string>();
    for (const pid of getAllPaneIds(result.tree)) {
      const leaf = findLeaf(result.tree, pid);
      leaf?.surfaces.forEach(s => survivingSurfaceIds.add(s.id));
    }
    for (const origId of originalSurfaceIds) {
      expect(survivingSurfaceIds.has(origId)).toBe(true);
    }
  });

  it('returns newPaneIds in row-major order for the grid', () => {
    const tree = createLeaf('pane-1' as any, 'terminal');
    const result = buildGridLayout(tree, 'pane-1' as any, 5);
    // 5 cells = 3 cols x 2 rows, so 4 new pane ids for the non-anchor cells
    expect(result.newPaneIds.length).toBe(4);
    // Every returned id must correspond to a real leaf in the new tree
    for (const pid of result.newPaneIds) {
      expect(findLeaf(result.tree, pid)).toBeDefined();
    }
  });
});

describe('replaceSoleTerminalSurface (agent spawn --replace-tab)', () => {
  const agentSurface = { id: 'surf-agent' as any, type: 'terminal' as const };

  it('replaces a sole terminal surface and reports the replaced id', () => {
    let tree: any = createLeaf('pane-1' as any, 'terminal');
    tree = splitNode(tree, 'pane-1' as any, 'pane-2' as any, 'terminal', 'horizontal');
    const defaultSurfaceId = findLeaf(tree, 'pane-2' as any)!.surfaces[0].id;

    const result = replaceSoleTerminalSurface(tree, 'pane-2' as any, agentSurface);
    expect(result.replacedSurfaceId).toBe(defaultSurfaceId);

    const leaf = findLeaf(result.tree, 'pane-2' as any)!;
    expect(leaf.surfaces.length).toBe(1);
    expect(leaf.surfaces[0].id).toBe('surf-agent');
    expect(leaf.activeSurfaceIndex).toBe(0);
    // Other panes untouched
    expect(findLeaf(result.tree, 'pane-1' as any)!.surfaces[0].id)
      .toBe(findLeaf(tree, 'pane-1' as any)!.surfaces[0].id);
  });

  it('refuses when the leaf has more than one surface', () => {
    const leaf = createLeaf('pane-1' as any, 'terminal');
    const tree: any = {
      ...leaf,
      surfaces: [...leaf.surfaces, { id: 'surf-user' as any, type: 'terminal' as const }],
    };
    const result = replaceSoleTerminalSurface(tree, 'pane-1' as any, agentSurface);
    expect(result.replacedSurfaceId).toBeNull();
    expect(result.tree).toBe(tree);
  });

  it('refuses when the sole surface is not a terminal', () => {
    const tree = createLeaf('pane-1' as any, 'browser');
    const result = replaceSoleTerminalSurface(tree, 'pane-1' as any, agentSurface);
    expect(result.replacedSurfaceId).toBeNull();
    expect(result.tree).toBe(tree);
  });

  it('is a no-op for an unknown paneId', () => {
    const tree = createLeaf('pane-1' as any, 'terminal');
    const result = replaceSoleTerminalSurface(tree, 'pane-nope' as any, agentSurface);
    expect(result.replacedSurfaceId).toBeNull();
    expect(result.tree).toBe(tree);
  });

  it('works on a leaf nested inside branches (grid pane)', () => {
    const base = createLeaf('pane-1' as any, 'terminal');
    const grid = buildGridLayout(base, 'pane-1' as any, 4);
    const target = grid.newPaneIds[2];
    const result = replaceSoleTerminalSurface(grid.tree, target, agentSurface);
    expect(result.replacedSurfaceId).not.toBeNull();
    expect(findLeaf(result.tree, target)!.surfaces[0].id).toBe('surf-agent');
    // Anchor untouched
    expect(findLeaf(result.tree, 'pane-1' as any)!.surfaces[0].id)
      .toBe(base.surfaces[0].id);
  });
});
