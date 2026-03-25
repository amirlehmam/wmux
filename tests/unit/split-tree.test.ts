import { describe, it, expect } from 'vitest';
import { createLeaf, splitNode, removeLeaf, findLeaf, updateRatio } from '../../src/renderer/store/split-utils';

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
