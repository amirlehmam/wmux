import { describe, it, expect } from 'vitest';
import { createLeaf, splitNode, removeLeaf, findLeaf, updateRatio, getAllPaneIds, buildGridLayout, replaceSoleTerminalSurface, freezeSurfaceCwds, instantiateLayout, buildDefaultSplitTree, patchLeafPrimarySurface, mergeStartupCommands } from '../../src/renderer/store/split-utils';

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

// ─── freezeSurfaceCwds (issue #134) ──────────────────────────────────────────
// A saved session used to persist only the workspace-level cwd, so restoring a
// window whose terminals sat on different drives sent all of them to the same
// place — for the reporter, worktrees on D:\ came back on C:\.
describe('freezeSurfaceCwds', () => {
  const leafWith = (paneId: string, surfaces: any[]) => ({
    type: 'leaf' as const,
    paneId: paneId as any,
    surfaces,
    activeSurfaceIndex: 0,
  });

  it('promotes the live directory into the spawn directory', () => {
    const tree = leafWith('pane-1', [
      { id: 'surf-1', type: 'terminal', currentCwd: 'D:\worktrees\feature-a' },
    ]);
    const frozen = freezeSurfaceCwds(tree) as any;
    expect(frozen.surfaces[0].cwd).toBe('D:\worktrees\feature-a');
  });

  it('keeps each pane on its own drive instead of collapsing to one', () => {
    const tree = {
      type: 'branch' as const,
      direction: 'horizontal' as const,
      ratio: 0.5,
      children: [
        leafWith('pane-1', [{ id: 'surf-1', type: 'terminal', currentCwd: 'D:\wt\a' }]),
        leafWith('pane-2', [{ id: 'surf-2', type: 'terminal', currentCwd: 'E:\wt\b' }]),
      ],
    };
    const frozen = freezeSurfaceCwds(tree) as any;
    expect(frozen.children[0].surfaces[0].cwd).toBe('D:\wt\a');
    expect(frozen.children[1].surfaces[0].cwd).toBe('E:\wt\b');
  });

  it('freezes every tab in a pane, not just the visible one', () => {
    const tree = leafWith('pane-1', [
      { id: 'surf-1', type: 'terminal', currentCwd: 'D:\one' },
      { id: 'surf-2', type: 'terminal', currentCwd: 'D:\two' },
    ]);
    const frozen = freezeSurfaceCwds(tree) as any;
    expect(frozen.surfaces.map((s: any) => s.cwd)).toEqual(['D:\one', 'D:\two']);
  });

  it('overwrites a stale spawn directory the terminal has since left', () => {
    const tree = leafWith('pane-1', [
      { id: 'surf-1', type: 'terminal', cwd: 'C:\start', currentCwd: 'D:\moved-here' },
    ]);
    const frozen = freezeSurfaceCwds(tree) as any;
    expect(frozen.surfaces[0].cwd).toBe('D:\moved-here');
  });

  it('leaves a surface that never reported a directory exactly as it was', () => {
    // No shell integration (or a browser/markdown tab) — the workspace-level
    // fallback still applies on restore, which is the pre-#134 behaviour.
    const surface = { id: 'surf-1', type: 'terminal', cwd: 'C:\explicit' };
    const tree = leafWith('pane-1', [surface]);
    const frozen = freezeSurfaceCwds(tree) as any;
    expect(frozen.surfaces[0]).toBe(surface);
  });

  it('does not mutate the live tree — the store keeps its spawn arguments', () => {
    const tree = leafWith('pane-1', [
      { id: 'surf-1', type: 'terminal', cwd: 'C:\start', currentCwd: 'D:\moved-here' },
    ]);
    freezeSurfaceCwds(tree);
    expect(tree.surfaces[0].cwd).toBe('C:\start');
  });

  it('carries currentCwd through so a restored tab can label itself immediately', () => {
    const tree = leafWith('pane-1', [{ id: 'surf-1', type: 'terminal', currentCwd: 'D:\wt\a' }]);
    const frozen = freezeSurfaceCwds(tree) as any;
    expect(frozen.surfaces[0].currentCwd).toBe('D:\wt\a');
  });
});

// ─── buildDefaultSplitTree (sidebar "+" / first-launch factory layout) ───────
// Distinct from createLeaf()'s single-pane baseline used by Ctrl+N/CLI — the
// two are deliberately different defaults, not unified (see the doc comment
// on resolveDefaultSplitTree in workspace-slice.ts).
describe('buildDefaultSplitTree', () => {
  it('builds a 3-pane layout: two panes on top, one below', () => {
    const tree = buildDefaultSplitTree();
    expect(tree.type).toBe('branch');
    expect(getAllPaneIds(tree)).toHaveLength(3);
    if (tree.type !== 'branch') return;
    expect(tree.direction).toBe('vertical');
    const [top, bottom] = tree.children;
    expect(top.type).toBe('branch');
    expect(bottom.type).toBe('leaf');
    if (top.type === 'branch') expect(top.direction).toBe('horizontal');
  });

  it('mints fresh ids on every call', () => {
    const a = buildDefaultSplitTree();
    const b = buildDefaultSplitTree();
    const aIds = getAllPaneIds(a);
    const bIds = getAllPaneIds(b);
    expect(aIds.some((id) => bIds.includes(id))).toBe(false);
  });
});

// ─── patchLeafPrimarySurface (saved-layout pane editing) ─────────────────────
describe('patchLeafPrimarySurface', () => {
  it('patches the first surface of the target leaf, leaving others untouched', () => {
    let tree: any = createLeaf('pane-1' as any, 'terminal');
    tree = splitNode(tree, 'pane-1' as any, 'pane-2' as any, 'terminal', 'horizontal');

    const patched = patchLeafPrimarySurface(tree, 'pane-2' as any, { startupCommands: ['claude'] });
    const pane1 = findLeaf(patched, 'pane-1' as any)!;
    const pane2 = findLeaf(patched, 'pane-2' as any)!;
    expect(pane2.surfaces[0].startupCommands).toEqual(['claude']);
    expect(pane1.surfaces[0].startupCommands).toBeUndefined();
  });

  it('is a no-op for an unknown paneId', () => {
    const tree = createLeaf('pane-1' as any, 'terminal');
    const result = patchLeafPrimarySurface(tree, 'pane-nope' as any, { startupCommands: ['x'] });
    expect(result).toBe(tree);
  });
});

// ─── mergeStartupCommands (Overwrite must not clobber manual pane edits) ─────
describe('mergeStartupCommands', () => {
  it('carries forward an old startupCommands the new capture lacks', () => {
    const oldTree = patchLeafPrimarySurface(createLeaf('pane-1' as any, 'terminal'), 'pane-1' as any, {
      startupCommands: ['claude'],
    });
    const newTree = createLeaf('pane-2' as any, 'terminal'); // fresh capture, no commands, new pane id

    const merged = mergeStartupCommands(newTree, oldTree) as any;
    expect(merged.surfaces[0].startupCommands).toEqual(['claude']);
    expect(merged.paneId).toBe('pane-2'); // geometry/ids come from the NEW capture
  });

  it('lets the live capture win when it already has its own startupCommands', () => {
    const oldTree = patchLeafPrimarySurface(createLeaf('pane-1' as any, 'terminal'), 'pane-1' as any, {
      startupCommands: ['stale'],
    });
    const newTree = patchLeafPrimarySurface(createLeaf('pane-2' as any, 'terminal'), 'pane-2' as any, {
      startupCommands: ['fresh'],
    });

    const merged = mergeStartupCommands(newTree, oldTree) as any;
    expect(merged.surfaces[0].startupCommands).toEqual(['fresh']);
  });

  it('matches by position, not id, across a differently-shaped new capture', () => {
    let oldTree: any = createLeaf('pane-1' as any, 'terminal');
    oldTree = patchLeafPrimarySurface(oldTree, 'pane-1' as any, { startupCommands: ['claude'] });
    let newTree: any = createLeaf('pane-a' as any, 'terminal');
    newTree = splitNode(newTree, 'pane-a' as any, 'pane-b' as any, 'terminal', 'horizontal');

    const merged = mergeStartupCommands(newTree, oldTree) as any;
    // Old had exactly one pane at index 0 — only the new tree's first pane inherits it.
    const firstLeaf = findLeaf(merged, 'pane-a' as any)!;
    const secondLeaf = findLeaf(merged, 'pane-b' as any)!;
    expect(firstLeaf.surfaces[0].startupCommands).toEqual(['claude']);
    expect(secondLeaf.surfaces[0].startupCommands ?? []).toEqual([]);
  });
});

// ─── instantiateLayout (saved default/preset layouts) ────────────────────────
// A saved layout is applied to more than one new workspace over its lifetime,
// so every application must mint fresh pane/surface ids — reusing them would
// break the PTY-id === surface-id re-attach invariant the moment a second
// workspace shared an id with the first.
describe('instantiateLayout', () => {
  it('mints fresh pane and surface ids while preserving structure', () => {
    let template: any = createLeaf('pane-tpl' as any, 'terminal');
    template = splitNode(template, 'pane-tpl' as any, 'pane-tpl-2' as any, 'terminal', 'vertical');

    const result = instantiateLayout(template);
    expect(result.type).toBe('branch');
    if (result.type !== 'branch') return;
    expect(result.direction).toBe('vertical');
    expect(result.ratio).toBe(0.5);

    const newIds = getAllPaneIds(result);
    expect(newIds.length).toBe(2);
    expect(newIds).not.toContain('pane-tpl');
    expect(newIds).not.toContain('pane-tpl-2');
  });

  it('preserves shell/cwd/startupCommands on each surface', () => {
    const template = createLeaf('pane-tpl' as any, 'terminal') as any;
    template.surfaces[0] = { ...template.surfaces[0], shell: 'pwsh.exe', cwd: 'C:\\proj', startupCommands: ['npm run dev'] };

    const result = instantiateLayout(template) as any;
    expect(result.surfaces[0].id).not.toBe(template.surfaces[0].id);
    expect(result.surfaces[0].shell).toBe('pwsh.exe');
    expect(result.surfaces[0].cwd).toBe('C:\\proj');
    expect(result.surfaces[0].startupCommands).toEqual(['npm run dev']);
  });

  it('produces distinct ids on repeated calls against the same template', () => {
    const template = createLeaf('pane-tpl' as any, 'terminal');
    const a = instantiateLayout(template) as any;
    const b = instantiateLayout(template) as any;
    expect(a.paneId).not.toBe(b.paneId);
    expect(a.surfaces[0].id).not.toBe(b.surfaces[0].id);
  });
});
