import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../src/renderer/store';
import {
  isPaneLocked,
  setLeafLocked,
  treeHasLockedPane,
  unlockedPaneIds,
} from '../../src/renderer/store/pane-lock';
import {
  buildAgentLayout,
  createLeaf,
  dropCodeContent,
  dropEphemeralSurfaces,
  findLeaf,
  freezeSurfaceCwds,
  getAllPaneIds,
  instantiateLayout,
  removeLeaf,
  replaceSoleTerminalSurface,
  splitNode,
} from '../../src/renderer/store/split-utils';
import type { PaneId, SplitNode, SurfaceId, WorkspaceId } from '../../src/shared/types';

type Leaf = Extract<SplitNode, { type: 'leaf' }>;

const A = 'pane-a' as PaneId;
const B = 'pane-b' as PaneId;
const C = 'pane-c' as PaneId;

function leafOf(tree: SplitNode, paneId: PaneId): Leaf {
  const leaf = findLeaf(tree, paneId);
  if (!leaf) throw new Error(`no leaf ${paneId}`);
  return leaf;
}

/** A | (B / C), with B and C addressable by id. */
function threePanes(): SplitNode {
  return {
    type: 'branch',
    direction: 'horizontal',
    ratio: 0.5,
    children: [
      createLeaf(A),
      { type: 'branch', direction: 'vertical', ratio: 0.5, children: [createLeaf(B), createLeaf(C)] },
    ],
  };
}

describe('pane-lock helpers', () => {
  it('isPaneLocked is true only for a leaf carrying locked: true', () => {
    const tree = setLeafLocked(threePanes(), B, true);
    expect(isPaneLocked(tree, B)).toBe(true);
    expect(isPaneLocked(tree, A)).toBe(false);
    expect(isPaneLocked(tree, 'pane-missing' as PaneId)).toBe(false);
  });

  it('a leaf with locked: false is not locked', () => {
    const leaf = { ...createLeaf(A), locked: false };
    expect(isPaneLocked(leaf, A)).toBe(false);
    expect(treeHasLockedPane(leaf)).toBe(false);
  });

  it('treeHasLockedPane sees a lock anywhere in the tree', () => {
    const tree = threePanes();
    expect(treeHasLockedPane(tree)).toBe(false);
    expect(treeHasLockedPane(setLeafLocked(tree, C, true))).toBe(true);
  });

  it('unlockedPaneIds lists unlocked panes in reading order', () => {
    const tree = setLeafLocked(threePanes(), B, true);
    expect(unlockedPaneIds(tree)).toEqual([A, C]);
    expect(unlockedPaneIds(setLeafLocked(setLeafLocked(tree, A, true), C, true))).toEqual([]);
    expect(unlockedPaneIds(threePanes())).toEqual(getAllPaneIds(threePanes()));
  });
});

describe('setLeafLocked', () => {
  it('locks one leaf and leaves its siblings alone', () => {
    const tree = threePanes();
    const locked = setLeafLocked(tree, B, true);
    expect(leafOf(locked, B).locked).toBe(true);
    expect(leafOf(locked, A)).toBe(leafOf(tree, A));
    expect(leafOf(locked, C)).toBe(leafOf(tree, C));
    expect(tree).not.toBe(locked);
    expect(leafOf(tree, B).locked).toBeUndefined();
  });

  it('unlocking removes the key instead of writing false', () => {
    const unlocked = setLeafLocked(setLeafLocked(threePanes(), B, true), B, false);
    expect('locked' in leafOf(unlocked, B)).toBe(false);
    expect(JSON.stringify(unlocked)).not.toContain('locked');
  });

  it('unlocking normalizes a stray locked: false', () => {
    const tree: SplitNode = { ...createLeaf(A), locked: false };
    expect('locked' in (setLeafLocked(tree, A, false) as Leaf)).toBe(false);
  });

  it('returns the same tree when nothing changes', () => {
    const tree = threePanes();
    expect(setLeafLocked(tree, B, false)).toBe(tree);
    expect(setLeafLocked(tree, 'pane-missing' as PaneId, true)).toBe(tree);
    const locked = setLeafLocked(tree, B, true);
    expect(setLeafLocked(locked, B, true)).toBe(locked);
  });
});

describe('the lock survives tree operations', () => {
  it('splitNode on the locked pane keeps it locked and makes the new pane unlocked', () => {
    const tree = setLeafLocked(createLeaf(A), A, true);
    const split = splitNode(tree, A, B, 'terminal', 'horizontal');
    expect(isPaneLocked(split, A)).toBe(true);
    expect(isPaneLocked(split, B)).toBe(false);
    expect('locked' in leafOf(split, B)).toBe(false);
  });

  it('splitNode on a sibling keeps the locked pane locked', () => {
    const tree = setLeafLocked(threePanes(), A, true);
    const split = splitNode(tree, C, 'pane-d' as PaneId, 'terminal', 'vertical');
    expect(isPaneLocked(split, A)).toBe(true);
    expect(isPaneLocked(split, 'pane-d' as PaneId)).toBe(false);
  });

  it('removeLeaf of a sibling keeps the locked pane locked, including through a collapse', () => {
    const tree = setLeafLocked(threePanes(), B, true);
    const withoutC = removeLeaf(tree, C)!;
    expect(isPaneLocked(withoutC, B)).toBe(true);
    const onlyB = removeLeaf(withoutC, A)!;
    expect(onlyB.type).toBe('leaf');
    expect(isPaneLocked(onlyB, B)).toBe(true);
  });

  it('replaceSoleTerminalSurface keeps the lock', () => {
    const tree = setLeafLocked(createLeaf(A), A, true);
    const next = { id: 'surf-new' as SurfaceId, type: 'terminal' as const };
    const { tree: replaced, replacedSurfaceId } = replaceSoleTerminalSurface(tree, A, next);
    expect(replacedSurfaceId).not.toBeNull();
    expect(isPaneLocked(replaced, A)).toBe(true);
  });

  it('buildAgentLayout keeps the anchor locked and makes the new cells unlocked', () => {
    const tree = setLeafLocked(createLeaf(A), A, true);
    const result = buildAgentLayout(tree, A, 3, { width: 1600, height: 900 })!;
    expect(isPaneLocked(result.tree, A)).toBe(true);
    expect(result.newPaneIds).toHaveLength(3);
    for (const id of result.newPaneIds) expect(isPaneLocked(result.tree, id)).toBe(false);
    expect(unlockedPaneIds(result.tree)).toEqual(result.newPaneIds);
  });
});

describe('the lock in the store', () => {
  let workspaceId: WorkspaceId;
  let paneId: PaneId;

  beforeEach(() => {
    for (const w of [...useStore.getState().workspaces]) useStore.getState().closeWorkspace(w.id);
    (useStore.getState() as any).setSavedLayouts?.([]);
    workspaceId = useStore.getState().createWorkspace({ title: 'ws', splitTree: createLeaf() });
    useStore.getState().selectWorkspace(workspaceId);
    paneId = (useStore.getState().workspaces[0].splitTree as Leaf).paneId;
  });

  const tree = () => useStore.getState().workspaces.find((w) => w.id === workspaceId)!.splitTree;

  it('setPaneLocked locks and unlocks, dropping the key on unlock', () => {
    useStore.getState().setPaneLocked(workspaceId, paneId, true);
    expect(isPaneLocked(tree(), paneId)).toBe(true);

    useStore.getState().setPaneLocked(workspaceId, paneId, false);
    expect(isPaneLocked(tree(), paneId)).toBe(false);
    expect('locked' in leafOf(tree(), paneId)).toBe(false);
    expect(JSON.stringify(tree())).not.toContain('locked');
  });

  it('setPaneLocked is a no-op for an unchanged lock, an unknown pane or an unknown workspace', () => {
    const before = tree();
    useStore.getState().setPaneLocked(workspaceId, paneId, false);
    useStore.getState().setPaneLocked(workspaceId, 'pane-missing' as PaneId, true);
    useStore.getState().setPaneLocked('ws-missing' as WorkspaceId, paneId, true);
    expect(tree()).toBe(before);
  });

  it('adding and closing a tab in a locked pane keeps it locked', () => {
    useStore.getState().setPaneLocked(workspaceId, paneId, true);
    const added = useStore.getState().addSurface(workspaceId, paneId, 'terminal')!;
    expect(isPaneLocked(tree(), paneId)).toBe(true);

    useStore.getState().closeSurface(workspaceId, paneId, added);
    expect(isPaneLocked(tree(), paneId)).toBe(true);
    expect(leafOf(tree(), paneId).surfaces).toHaveLength(1);
  });

  it('a never-locked workspace serializes without a locked key', () => {
    useStore.getState().addSurface(workspaceId, paneId, 'terminal');
    expect(JSON.stringify(tree())).not.toContain('locked');
  });

  it('a locked pane survives the persistence passes, a JSON round trip and replaceAllWorkspaces', () => {
    useStore.getState().setPaneLocked(workspaceId, paneId, true);
    useStore.getState().addSurface(workspaceId, paneId, 'markdown', { ephemeral: true });

    const saved = JSON.parse(JSON.stringify(dropCodeContent(dropEphemeralSurfaces(freezeSurfaceCwds(tree())))));
    expect(leafOf(saved, paneId).locked).toBe(true);

    useStore.getState().replaceAllWorkspaces([{ title: 'restored', splitTree: saved }]);
    const restored = useStore.getState().workspaces[0].splitTree;
    expect(isPaneLocked(restored, paneId)).toBe(true);
  });

  it('only the locked pane of a restored tree is locked', () => {
    const mixed = setLeafLocked(threePanes(), B, true);
    const saved = JSON.parse(JSON.stringify(dropCodeContent(dropEphemeralSurfaces(freezeSurfaceCwds(mixed)))));
    useStore.getState().replaceAllWorkspaces([{ title: 'restored', splitTree: saved }]);
    const restored = useStore.getState().workspaces[0].splitTree;
    expect(unlockedPaneIds(restored)).toEqual([A, C]);
    expect(isPaneLocked(restored, B)).toBe(true);
  });

  it('a saved layout keeps the lock, and a workspace made from it starts with the matching pane locked', () => {
    useStore.getState().replaceAllWorkspaces([{ title: 'src', splitTree: setLeafLocked(threePanes(), B, true) }]);
    const sourceId = useStore.getState().workspaces[0].id;
    useStore.getState().selectWorkspace(sourceId);

    const layoutId = useStore.getState().saveCurrentLayoutAsPreset('with-lock')!;
    const layout = (useStore.getState() as any).savedLayouts.find((l: any) => l.id === layoutId);
    expect(isPaneLocked(layout.splitTree, B)).toBe(true);

    const newId = useStore.getState().createWorkspaceFromLayout(layoutId)!;
    const created = useStore.getState().workspaces.find((w) => w.id === newId)!.splitTree;
    const ids = getAllPaneIds(created);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(B);
    const lockedIds = ids.filter((id) => isPaneLocked(created, id));
    expect(lockedIds).toHaveLength(1);
    expect(ids.indexOf(lockedIds[0])).toBe(1);
  });
});

describe('instantiateLayout', () => {
  it('carries the lock to the re-minted pane', () => {
    const template = setLeafLocked(threePanes(), B, true);
    const instance = instantiateLayout(template);
    const ids = getAllPaneIds(instance);
    expect(ids.map((id) => isPaneLocked(instance, id))).toEqual([false, true, false]);
  });

  it('writes no locked key for unlocked panes', () => {
    expect(JSON.stringify(instantiateLayout(threePanes()))).not.toContain('locked');
  });
});
