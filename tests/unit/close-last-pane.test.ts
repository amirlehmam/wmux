import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createSurfaceSlice, SurfaceSlice } from '../../src/renderer/store/surface-slice';
import { removeLeaf, createLeaf, getAllPaneIds, splitNode } from '../../src/renderer/store/split-utils';
import { WorkspaceId, PaneId, SurfaceId } from '../../src/shared/types';

/**
 * Split a workspace's tree in place. There is no `splitPane` store action —
 * splitting is still duplicated between PaneWrapper and pipe-bridge, the same
 * way pane-closing was before this change. Out of scope here; the test drives
 * the tree directly rather than pretending an action exists.
 */
function splitInStore(
  store: ReturnType<typeof makeStore>,
  wsId: WorkspaceId,
  paneId: PaneId,
): PaneId {
  const ws = store.getState().workspaces.find((w) => w.id === wsId)!;
  const newPaneId = `pane-test-${getAllPaneIds(ws.splitTree).length}` as PaneId;
  store.getState().updateSplitTree(
    wsId,
    splitNode(ws.splitTree, paneId, newPaneId, 'terminal', 'horizontal'),
  );
  return newPaneId;
}

// ─────────────────────────────────────────────────────────────────────────────
// A close that cannot happen must not kill anything.
//
// `removeLeaf()` returns null when the pane being removed is the tree's only
// leaf — a correct answer to "what is left after removing it": nothing. Every
// caller read that null as "nothing to do" and skipped the state update, but
// they had ALREADY killed the pane's PTYs. `wmux new-workspace` produces
// exactly a one-leaf tree, so this was the common case, not the exotic one:
// every process in the pane died, the tree never changed, and each xterm just
// printed "[process exited]" under a tab that was still there.
//
// The invariant below is deliberately phrased as an implication rather than as
// an expected end state, because either resolution is defensible — close the
// workspace, or refuse and keep the shells. What is NOT defensible is killing
// the processes and then silently declining to close.
// ─────────────────────────────────────────────────────────────────────────────

type TestStore = WorkspaceSlice & SurfaceSlice;

function makeStore() {
  return create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createSurfaceSlice(...args),
  }));
}

/** Records every PTY id the store asks the main process to reap. */
function installPtySpy(): string[] {
  const killed: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    wmux: { pty: { kill: (id: string) => { killed.push(id); } } },
  };
  return killed;
}

describe('removeLeaf null contract', () => {
  it('returns null when the removed pane is the only leaf', () => {
    const leaf = createLeaf();
    expect(removeLeaf(leaf, leaf.type === 'leaf' ? leaf.paneId : ('x' as PaneId))).toBeNull();
  });

  it('returns a tree when a sibling survives', () => {
    const store = makeStore();
    const wsId = store.getState().createWorkspace({ title: 'ws' });
    const ws0 = store.getState().workspaces.find((w) => w.id === wsId)!;
    const [paneId] = getAllPaneIds(ws0.splitTree);
    splitInStore(store, wsId, paneId);
    const ws1 = store.getState().workspaces.find((w) => w.id === wsId)!;
    expect(removeLeaf(ws1.splitTree, paneId)).not.toBeNull();
  });
});

describe('closing the last pane of a workspace', () => {
  let store: ReturnType<typeof makeStore>;
  let killed: string[];
  let wsId: WorkspaceId;
  let paneId: PaneId;

  beforeEach(() => {
    killed = installPtySpy();
    store = makeStore();
    wsId = store.getState().createWorkspace({ title: 'solo' });
    const ws = store.getState().workspaces.find((w) => w.id === wsId)!;
    [paneId] = getAllPaneIds(ws.splitTree);
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it('closePane never kills shells without the pane actually going away', () => {
    const before = store.getState().workspaces.find((w) => w.id === wsId)!;
    expect(getAllPaneIds(before.splitTree)).toHaveLength(1);

    store.getState().closePane(wsId, paneId);

    const after = store.getState().workspaces.find((w) => w.id === wsId);
    // The implication: if anything was reaped, the close must have happened.
    if (killed.length > 0) {
      expect(after, 'PTYs were killed but the workspace survived').toBeUndefined();
    }
  });

  it('closePane on the only pane closes the whole workspace', () => {
    store.getState().closePane(wsId, paneId);
    expect(store.getState().workspaces.find((w) => w.id === wsId)).toBeUndefined();
  });

  it('closeSurface on the last tab of the only pane leaves no zombie tab', () => {
    const ws = store.getState().workspaces.find((w) => w.id === wsId)!;
    const leaf = ws.splitTree.type === 'leaf' ? ws.splitTree : null;
    const surfaceId = leaf!.surfaces[0].id as SurfaceId;

    store.getState().closeSurface(wsId, paneId, surfaceId);

    const after = store.getState().workspaces.find((w) => w.id === wsId);
    if (after) {
      // Survived: the tab must still be usable, i.e. its shell was NOT reaped.
      expect(killed, 'tab still rendered but its PTY was killed').not.toContain(surfaceId);
    }
  });

  it('closePane on a two-pane workspace removes only that pane and keeps the workspace', () => {
    splitInStore(store, wsId, paneId);
    const split = store.getState().workspaces.find((w) => w.id === wsId)!;
    const panes = getAllPaneIds(split.splitTree);
    expect(panes).toHaveLength(2);

    store.getState().closePane(wsId, panes[1]);

    const after = store.getState().workspaces.find((w) => w.id === wsId);
    expect(after).toBeDefined();
    expect(getAllPaneIds(after!.splitTree)).toEqual([panes[0]]);
  });
});
