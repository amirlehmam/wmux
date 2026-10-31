import { describe, expect, it } from 'vitest';
import type { PaneId, SurfaceId, SplitNode } from '../../src/shared/types';
import { moveSurfaceToWorkspaceEdge } from '../../src/renderer/store/split-preview-utils';
import { findLeaf, getAllPaneIds } from '../../src/renderer/store/split-utils';

const pane = (id: string) => id as PaneId;
const surf = (id: string) => id as SurfaceId;
const leaf = (id: string, ids = [id]): SplitNode => ({ type: 'leaf', paneId: pane(id),
  surfaces: ids.map((s) => ({ id: surf(s), type: 'terminal' })), activeSurfaceIndex: 0 });
const tree: SplitNode = { type: 'branch', direction: 'horizontal', ratio: 0.3,
  children: [leaf('a'), { type: 'branch', direction: 'vertical', ratio: 0.6,
    children: [leaf('b'), leaf('c')] }] };

describe('workspace edge moves (#405)', () => {
  it.each(['left', 'right', 'up', 'down'] as const)('moves a nested pane to the whole workspace %s', (direction) => {
    const result = moveSurfaceToWorkspaceEdge(tree, pane('c'), surf('c'), direction, pane('new'))!;
    expect(result.tree.type).toBe('branch');
    if (result.tree.type !== 'branch') throw new Error('expected branch');
    expect(result.tree.direction).toBe(['left', 'right'].includes(direction) ? 'horizontal' : 'vertical');
    const index = ['left', 'up'].includes(direction) ? 0 : 1;
    expect(result.tree.children[index]).toEqual(leaf('new', ['c']));
    expect(getAllPaneIds(result.tree).sort()).toEqual(['a', 'b', 'new']);
    expect(findLeaf(result.tree, pane('a'))).toBe(findLeaf(tree, pane('a')));
    expect(getAllPaneIds(tree)).toEqual(['a', 'b', 'c']);
  });
  it('detaches one tab without losing the other tabs', () => {
    const result = moveSurfaceToWorkspaceEdge(leaf('a', ['one', 'two']), pane('a'), surf('two'), 'down', pane('new'))!;
    expect(findLeaf(result.tree, pane('a'))?.surfaces.map((s) => s.id)).toEqual(['one']);
    expect(result.collapsesSourcePane).toBe(false);
  });
  it('rejects the sole tab and stale or foreign sources', () => {
    expect(moveSurfaceToWorkspaceEdge(leaf('a'), pane('a'), surf('a'), 'up', pane('new'))).toBeNull();
    expect(moveSurfaceToWorkspaceEdge(tree, pane('missing'), surf('a'), 'up', pane('new'))).toBeNull();
    expect(moveSurfaceToWorkspaceEdge(tree, pane('a'), surf('c'), 'up', pane('new'))).toBeNull();
  });
});
