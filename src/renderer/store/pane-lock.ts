import type { PaneId, SplitNode } from '../../shared/types';
import { findLeaf } from './split-utils';

export function isPaneLocked(tree: SplitNode, paneId: PaneId): boolean {
  return findLeaf(tree, paneId)?.locked === true;
}

export function treeHasLockedPane(tree: SplitNode): boolean {
  if (tree.type === 'leaf') return tree.locked === true;
  return treeHasLockedPane(tree.children[0]) || treeHasLockedPane(tree.children[1]);
}

/** Pane ids in reading order, locked panes left out. */
export function unlockedPaneIds(tree: SplitNode): PaneId[] {
  if (tree.type === 'leaf') return tree.locked === true ? [] : [tree.paneId];
  return [...unlockedPaneIds(tree.children[0]), ...unlockedPaneIds(tree.children[1])];
}

/**
 * Unlocking removes the key rather than writing `locked: false`, so a tree
 * that was never locked serializes exactly as it did before the feature.
 * Returns the same tree when nothing changes.
 */
export function setLeafLocked(tree: SplitNode, paneId: PaneId, locked: boolean): SplitNode {
  if (tree.type === 'leaf') {
    if (tree.paneId !== paneId) return tree;
    if (locked) return tree.locked === true ? tree : { ...tree, locked: true };
    if (!('locked' in tree)) return tree;
    const { locked: _drop, ...rest } = tree;
    return rest;
  }
  const [left, right] = tree.children;
  const newLeft = setLeafLocked(left, paneId, locked);
  const newRight = setLeafLocked(right, paneId, locked);
  if (newLeft === left && newRight === right) return tree;
  return { ...tree, children: [newLeft, newRight] };
}
