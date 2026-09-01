import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import {
  buildWorkspaceTree,
  buildDefaultSplitTree,
  getAllPaneIds,
  MAX_WORKSPACE_PANES,
} from '../../src/renderer/store/split-utils';
import { createWorkspaceSlice, WorkspaceSlice, resolveDefaultSplitTree } from '../../src/renderer/store/workspace-slice';
import { resolveWireLayout } from '../../src/renderer/pipe-bridge';
import { DEFAULT_WORKSPACE_PREFS } from '../../src/renderer/store/settings-slice';
import type { SplitNode } from '../../src/shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// Issue #212 — a new workspace's shape is a setting, and one setting.
//
// It was hard-coded in two places that disagreed: the sidebar `+` built a
// three-pane T, `wmux new-workspace` built a single leaf, and neither Settings
// nor config.toml could change either. The reporter had to rebuild their layout
// by hand after every new workspace.
// ─────────────────────────────────────────────────────────────────────────────

/** Structure only — pane/surface ids are freshly minted on every call. */
function shapeOf(node: SplitNode): any {
  if (node.type === 'leaf') return 'leaf';
  return { d: node.direction, r: Number(node.ratio.toFixed(4)), c: node.children.map(shapeOf) };
}

describe('buildWorkspaceTree', () => {
  it('reproduces the shipped 3-pane T exactly, so nobody\'s sidebar + changes', () => {
    // The property that lets this replace buildDefaultSplitTree outright.
    expect(shapeOf(buildWorkspaceTree(3, 'grid'))).toEqual(shapeOf(buildDefaultSplitTree()));
    expect(shapeOf(buildWorkspaceTree(3, 'grid'))).toEqual({
      d: 'vertical', r: 0.5,
      c: [{ d: 'horizontal', r: 0.5, c: ['leaf', 'leaf'] }, 'leaf'],
    });
  });

  it('builds exactly the requested number of panes, in every layout', () => {
    for (const layout of ['grid', 'columns', 'rows', 'left', 'down'] as const) {
      for (let n = 1; n <= MAX_WORKSPACE_PANES; n++) {
        expect(getAllPaneIds(buildWorkspaceTree(n, layout))).toHaveLength(n);
      }
    }
  });

  it('collapses to a single leaf at one pane, whatever the layout says', () => {
    for (const layout of ['grid', 'columns', 'rows', 'left', 'down'] as const) {
      expect(buildWorkspaceTree(1, layout).type).toBe('leaf');
    }
  });

  it('gives equal sizes in a chain rather than halving repeatedly', () => {
    // 1/N then split-the-rest, so three columns are thirds and not 50/25/25.
    expect(shapeOf(buildWorkspaceTree(3, 'columns'))).toEqual({
      d: 'horizontal', r: 0.3333,
      c: ['leaf', { d: 'horizontal', r: 0.5, c: ['leaf', 'leaf'] }],
    });
  });

  it('puts the main pane first in left and down', () => {
    const left = buildWorkspaceTree(3, 'left') as any;
    expect(left.direction).toBe('horizontal');
    expect(left.children[0].type).toBe('leaf');
    const down = buildWorkspaceTree(3, 'down') as any;
    expect(down.direction).toBe('vertical');
    expect(down.children[0].type).toBe('leaf');
  });

  it('clamps rather than obeying a pane count that would spawn a shell storm', () => {
    // This value reaches here from a hand-edited TOML file and over the pipe,
    // and every pane it makes is a PTY. `panes = 500` is a typo.
    expect(getAllPaneIds(buildWorkspaceTree(500, 'grid'))).toHaveLength(MAX_WORKSPACE_PANES);
    expect(getAllPaneIds(buildWorkspaceTree(0, 'grid'))).toHaveLength(1);
    expect(getAllPaneIds(buildWorkspaceTree(-4, 'grid'))).toHaveLength(1);
    expect(getAllPaneIds(buildWorkspaceTree(NaN, 'grid'))).toHaveLength(1);
  });

  it('mints fresh ids on every call, so two workspaces never share a pane id', () => {
    // Sharing one breaks the PTY-id === surface-id re-attach invariant.
    const a = getAllPaneIds(buildWorkspaceTree(4, 'grid'));
    const b = getAllPaneIds(buildWorkspaceTree(4, 'grid'));
    expect(new Set([...a, ...b]).size).toBe(8);
  });
});

describe('resolveDefaultSplitTree — one answer for every entry point', () => {
  function storeWith(prefs: any, savedLayouts: any[] = []) {
    const s = create<WorkspaceSlice>()((...args) => ({
      ...createWorkspaceSlice(...args),
      workspacePrefs: prefs,
      savedLayouts,
    }) as any);
    return s;
  }

  it('honours the configured pane count and layout', () => {
    const store = storeWith({ ...DEFAULT_WORKSPACE_PREFS, newWorkspacePanes: 2, newWorkspaceLayout: 'rows' });
    expect(shapeOf(resolveDefaultSplitTree(store.getState))).toEqual({
      d: 'vertical', r: 0.5, c: ['leaf', 'leaf'],
    });
  });

  it('keeps a saved default layout ranked above it', () => {
    // A saved layout also carries each pane's shell, cwd and startup commands,
    // so it answers the same question more completely.
    const layout = { id: 'L1', name: 'mine', createdAt: 0, splitTree: buildWorkspaceTree(5, 'columns') };
    const store = storeWith(
      { ...DEFAULT_WORKSPACE_PREFS, defaultLayoutId: 'L1', newWorkspacePanes: 2, newWorkspaceLayout: 'rows' },
      [layout],
    );
    expect(getAllPaneIds(resolveDefaultSplitTree(store.getState))).toHaveLength(5);
  });

  it('gives createWorkspace the same tree the sidebar + gets', () => {
    // The divergence #212 reported: same function, two answers, because the
    // fallback was a parameter each caller filled in differently.
    const store = storeWith({ ...DEFAULT_WORKSPACE_PREFS });
    const id = store.getState().createWorkspace({ title: 'via CLI' });
    const ws = store.getState().workspaces.find((w) => w.id === id)!;
    expect(getAllPaneIds(ws.splitTree)).toHaveLength(DEFAULT_WORKSPACE_PREFS.newWorkspacePanes);
    expect(shapeOf(ws.splitTree)).toEqual(shapeOf(buildDefaultSplitTree()));
  });

  it('falls back to the shipped shape when there is no settings slice at all', () => {
    const bare = create<WorkspaceSlice>()((...args) => ({ ...createWorkspaceSlice(...args) }));
    expect(shapeOf(resolveDefaultSplitTree(bare.getState))).toEqual(shapeOf(buildDefaultSplitTree()));
  });
});

describe('resolveWireLayout — what --panes / --layout mean', () => {
  const prefs = { newWorkspacePanes: 3, newWorkspaceLayout: 'grid' } as const;

  it('falls through to the setting when neither flag is given', () => {
    expect(resolveWireLayout(undefined, prefs)).toEqual({ panes: 3, layout: 'grid' });
    expect(resolveWireLayout({}, prefs)).toEqual({ panes: 3, layout: 'grid' });
  });

  it('lets an explicit flag win over the setting', () => {
    expect(resolveWireLayout({ panes: 1 }, prefs)).toEqual({ panes: 1, layout: 'grid' });
    expect(resolveWireLayout({ layout: 'columns' }, prefs)).toEqual({ panes: 3, layout: 'columns' });
  });

  it('reads `single` as a pane count, which is what it is', () => {
    expect(resolveWireLayout({ layout: 'single' }, prefs).panes).toBe(1);
  });

  it('lets an explicit --panes win over `single`', () => {
    // Writing both means the number was meant.
    expect(resolveWireLayout({ layout: 'single', panes: 4 }, prefs).panes).toBe(4);
  });

  it('keeps the configured layout when the flag is a typo', () => {
    // The typo should cost the user their typo, not also the setting they made.
    expect(resolveWireLayout({ layout: 'gird' }, prefs).layout).toBe('grid');
    expect(resolveWireLayout({ layout: 'gird' }, { ...prefs, newWorkspaceLayout: 'rows' }).layout).toBe('rows');
  });
});
