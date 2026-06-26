import { describe, expect, it } from 'vitest';
import type { PaneId, SplitNode, SurfaceId, SurfaceRef } from '../../src/shared/types';
import { findLeaf, getAllPaneIds } from '../../src/renderer/store/split-utils';
import {
  previewMoveSurface,
  previewSplitAndMoveSurface,
} from '../../src/renderer/store/split-preview-utils';

function surface(id: string, type: SurfaceRef['type'] = 'terminal'): SurfaceRef {
  return { id: id as SurfaceId, type };
}

function leaf(paneId: string, surfaces: SurfaceRef[], activeSurfaceIndex = 0): SplitNode & { type: 'leaf' } {
  return {
    type: 'leaf',
    paneId: paneId as PaneId,
    surfaces,
    activeSurfaceIndex,
  };
}

function branch(left: SplitNode, right: SplitNode, direction: 'horizontal' | 'vertical' = 'horizontal'): SplitNode {
  return {
    type: 'branch',
    direction,
    ratio: 0.5,
    children: [left, right],
  };
}

function allSurfaceIds(tree: SplitNode): string[] {
  if (tree.type === 'leaf') return tree.surfaces.map((s) => s.id);
  return [...allSurfaceIds(tree.children[0]), ...allSurfaceIds(tree.children[1])];
}

describe('split preview helpers', () => {
  it('previews splitting the source pane right when the pane still has another surface', () => {
    const tree = leaf('pane-1', [surface('surf-drag'), surface('surf-stay')]);

    const result = previewSplitAndMoveSurface(
      tree,
      'pane-1' as PaneId,
      'pane-1' as PaneId,
      'surf-drag' as SurfaceId,
      'right',
    );

    expect(result).not.toBeNull();
    expect(result?.collapsesSourcePane).toBe(false);
    expect(getAllPaneIds(result!.tree)).toHaveLength(2);

    const sourceLeaf = findLeaf(result!.tree, 'pane-1' as PaneId);
    expect(sourceLeaf?.surfaces.map((s) => s.id)).toEqual(['surf-stay']);

    const destinationLeaf = findLeaf(result!.tree, result!.destinationPaneId);
    expect(destinationLeaf?.surfaces.map((s) => s.id)).toEqual(['surf-drag']);
  });

  it('places preview panes on the requested side of the target pane', () => {
    const tree = leaf('pane-1', [surface('surf-drag'), surface('surf-stay')]);

    const leftResult = previewSplitAndMoveSurface(
      tree,
      'pane-1' as PaneId,
      'pane-1' as PaneId,
      'surf-drag' as SurfaceId,
      'left',
    );

    const upResult = previewSplitAndMoveSurface(
      tree,
      'pane-1' as PaneId,
      'pane-1' as PaneId,
      'surf-drag' as SurfaceId,
      'up',
    );

    const rightResult = previewSplitAndMoveSurface(
      tree,
      'pane-1' as PaneId,
      'pane-1' as PaneId,
      'surf-drag' as SurfaceId,
      'right',
    );

    const downResult = previewSplitAndMoveSurface(
      tree,
      'pane-1' as PaneId,
      'pane-1' as PaneId,
      'surf-drag' as SurfaceId,
      'down',
    );

    expect(leftResult).not.toBeNull();
    expect(getAllPaneIds(leftResult!.tree)[0]).toBe(leftResult!.destinationPaneId);
    expect(leftResult!.tree.type).toBe('branch');
    expect(leftResult!.tree.type === 'branch' ? leftResult!.tree.direction : null).toBe('horizontal');
    expect(upResult).not.toBeNull();
    expect(getAllPaneIds(upResult!.tree)[0]).toBe(upResult!.destinationPaneId);
    expect(upResult!.tree.type).toBe('branch');
    expect(upResult!.tree.type === 'branch' ? upResult!.tree.direction : null).toBe('vertical');
    expect(rightResult).not.toBeNull();
    expect(getAllPaneIds(rightResult!.tree)[1]).toBe(rightResult!.destinationPaneId);
    expect(rightResult!.tree.type).toBe('branch');
    expect(rightResult!.tree.type === 'branch' ? rightResult!.tree.direction : null).toBe('horizontal');
    expect(downResult).not.toBeNull();
    expect(getAllPaneIds(downResult!.tree)[1]).toBe(downResult!.destinationPaneId);
    expect(downResult!.tree.type).toBe('branch');
    expect(downResult!.tree.type === 'branch' ? downResult!.tree.direction : null).toBe('vertical');
  });

  it('previews source pane collapse when dragging its only surface to another pane edge', () => {
    const tree = branch(
      leaf('pane-source', [surface('surf-drag')]),
      leaf('pane-target', [surface('surf-target')]),
    );

    const result = previewSplitAndMoveSurface(
      tree,
      'pane-target' as PaneId,
      'pane-source' as PaneId,
      'surf-drag' as SurfaceId,
      'right',
    );

    expect(result).not.toBeNull();
    expect(result?.collapsesSourcePane).toBe(true);
    expect(getAllPaneIds(result!.tree)).not.toContain('pane-source');

    const targetLeaf = findLeaf(result!.tree, 'pane-target' as PaneId);
    const destinationLeaf = findLeaf(result!.tree, result!.destinationPaneId);
    expect(targetLeaf?.surfaces.map((s) => s.id)).toEqual(['surf-target']);
    expect(destinationLeaf?.surfaces.map((s) => s.id)).toEqual(['surf-drag']);
  });

  it('returns null for dragging the only surface onto its own pane edge', () => {
    const tree = leaf('pane-1', [surface('surf-drag')]);

    const result = previewSplitAndMoveSurface(
      tree,
      'pane-1' as PaneId,
      'pane-1' as PaneId,
      'surf-drag' as SurfaceId,
      'right',
    );

    expect(result).toBeNull();
  });

  it('previews center move only when the source pane collapses', () => {
    const tree = branch(
      leaf('pane-source', [surface('surf-drag')]),
      leaf('pane-target', [surface('surf-target')]),
    );

    const result = previewMoveSurface(
      tree,
      'pane-source' as PaneId,
      'surf-drag' as SurfaceId,
      'pane-target' as PaneId,
    );

    expect(result).not.toBeNull();
    expect(result?.destinationPaneId).toBe('pane-target');
    expect(result?.collapsesSourcePane).toBe(true);
    expect(getAllPaneIds(result!.tree)).toEqual(['pane-target']);

    const targetLeaf = findLeaf(result!.tree, 'pane-target' as PaneId);
    expect(targetLeaf?.surfaces.map((s) => s.id)).toEqual(['surf-target', 'surf-drag']);
    expect(targetLeaf?.activeSurfaceIndex).toBe(1);
  });

  it('returns null for center move when the source pane remains visible', () => {
    const tree = branch(
      leaf('pane-source', [surface('surf-drag'), surface('surf-stay')]),
      leaf('pane-target', [surface('surf-target')]),
    );

    const result = previewMoveSurface(
      tree,
      'pane-source' as PaneId,
      'surf-drag' as SurfaceId,
      'pane-target' as PaneId,
    );

    expect(result).toBeNull();
  });

  it('returns null for invalid pane or surface ids', () => {
    const tree = leaf('pane-1', [surface('surf-1')]);

    expect(previewSplitAndMoveSurface(
      tree,
      'pane-missing' as PaneId,
      'pane-1' as PaneId,
      'surf-1' as SurfaceId,
      'right',
    )).toBeNull();

    expect(previewSplitAndMoveSurface(
      tree,
      'pane-1' as PaneId,
      'pane-missing' as PaneId,
      'surf-1' as SurfaceId,
      'right',
    )).toBeNull();

    expect(previewSplitAndMoveSurface(
      tree,
      'pane-1' as PaneId,
      'pane-1' as PaneId,
      'surf-missing' as SurfaceId,
      'right',
    )).toBeNull();

    expect(previewMoveSurface(
      tree,
      'pane-1' as PaneId,
      'surf-missing' as SurfaceId,
      'pane-1' as PaneId,
    )).toBeNull();

    expect(previewMoveSurface(
      tree,
      'pane-1' as PaneId,
      'surf-1' as SurfaceId,
      'pane-missing' as PaneId,
    )).toBeNull();
  });

  it('preserves every original surface id in split previews', () => {
    const tree = branch(
      leaf('pane-source', [surface('surf-drag'), surface('surf-source-stay')]),
      leaf('pane-target', [surface('surf-target')]),
      'vertical',
    );

    const result = previewSplitAndMoveSurface(
      tree,
      'pane-target' as PaneId,
      'pane-source' as PaneId,
      'surf-drag' as SurfaceId,
      'down',
    );

    expect(result).not.toBeNull();
    expect(allSurfaceIds(result!.tree).sort()).toEqual([
      'surf-drag',
      'surf-source-stay',
      'surf-target',
    ]);
  });
});
