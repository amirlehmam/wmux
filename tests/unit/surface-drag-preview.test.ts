import { describe, expect, it } from 'vitest';
import type { PaneId, SplitNode, SurfaceId, SurfaceRef, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';
import { findLeaf } from '../../src/renderer/store/split-utils';
import {
  buildSurfaceDragPreview,
  getSurfaceDragDropDecision,
  parseSurfaceDragData,
} from '../../src/renderer/components/SplitPane/surface-drag-preview';

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

function branch(left: SplitNode, right: SplitNode): SplitNode {
  return {
    type: 'branch',
    direction: 'horizontal',
    ratio: 0.5,
    children: [left, right],
  };
}

function workspace(id: string, splitTree: SplitNode): WorkspaceInfo {
  return {
    id: id as WorkspaceId,
    title: id,
    pinned: false,
    shell: 'pwsh.exe',
    splitTree,
    unreadCount: 0,
  };
}

describe('surface drag preview decisions', () => {
  it('builds an edge preview for the active workspace without mutating the real tree', () => {
    const splitTree = branch(
      leaf('pane-source', [surface('surf-drag'), surface('surf-stay')]),
      leaf('pane-target', [surface('surf-target')]),
    );

    const preview = buildSurfaceDragPreview({
      workspaces: [workspace('ws-active', splitTree)],
      activeWorkspaceId: 'ws-active' as WorkspaceId,
      drag: {
        workspaceId: 'ws-active' as WorkspaceId,
        sourcePaneId: 'pane-source' as PaneId,
        surfaceId: 'surf-drag' as SurfaceId,
      },
      pendingTarget: {
        targetPaneId: 'pane-target' as PaneId,
        target: 'right',
      },
    });

    expect(preview).not.toBeNull();
    expect(preview?.workspaceId).toBe('ws-active');
    expect(preview?.target).toBe('right');
    expect(preview?.collapsesSourcePane).toBe(false);
    expect(findLeaf(splitTree, 'pane-source' as PaneId)?.surfaces.map((s) => s.id)).toEqual([
      'surf-drag',
      'surf-stay',
    ]);
  });

  it('returns null when the drag does not belong to the active workspace', () => {
    const splitTree = leaf('pane-1', [surface('surf-drag')]);

    const preview = buildSurfaceDragPreview({
      workspaces: [workspace('ws-active', splitTree), workspace('ws-other', splitTree)],
      activeWorkspaceId: 'ws-active' as WorkspaceId,
      drag: {
        workspaceId: 'ws-other' as WorkspaceId,
        sourcePaneId: 'pane-1' as PaneId,
        surfaceId: 'surf-drag' as SurfaceId,
      },
      pendingTarget: {
        targetPaneId: 'pane-1' as PaneId,
        target: 'right',
      },
    });

    expect(preview).toBeNull();
  });

  it('builds a center preview only when moving the surface collapses the source pane', () => {
    const collapsingTree = branch(
      leaf('pane-source', [surface('surf-drag')]),
      leaf('pane-target', [surface('surf-target')]),
    );
    const stableTree = branch(
      leaf('pane-source', [surface('surf-drag'), surface('surf-stay')]),
      leaf('pane-target', [surface('surf-target')]),
    );

    const baseRequest = {
      activeWorkspaceId: 'ws-active' as WorkspaceId,
      drag: {
        workspaceId: 'ws-active' as WorkspaceId,
        sourcePaneId: 'pane-source' as PaneId,
        surfaceId: 'surf-drag' as SurfaceId,
      },
      pendingTarget: {
        targetPaneId: 'pane-target' as PaneId,
        target: 'center' as const,
      },
    };

    expect(buildSurfaceDragPreview({
      ...baseRequest,
      workspaces: [workspace('ws-active', collapsingTree)],
    })?.collapsesSourcePane).toBe(true);

    expect(buildSurfaceDragPreview({
      ...baseRequest,
      workspaces: [workspace('ws-active', stableTree)],
    })).toBeNull();
  });

  it('keeps edge drops on the only surface in its own pane as cancel-only', () => {
    expect(getSurfaceDragDropDecision({
      target: 'edge',
      sourcePaneId: 'pane-source' as PaneId,
      targetPaneId: 'pane-source' as PaneId,
      sourceSurfaceCount: 1,
    })).toEqual({ action: 'cancel' });
  });

  it('clears zoom for geometry-changing edge drops and source-collapsing center drops', () => {
    expect(getSurfaceDragDropDecision({
      target: 'edge',
      sourcePaneId: 'pane-source' as PaneId,
      targetPaneId: 'pane-target' as PaneId,
      sourceSurfaceCount: 2,
    })).toEqual({ action: 'commit', commitOptions: { clearZoom: true } });

    expect(getSurfaceDragDropDecision({
      target: 'center',
      sourcePaneId: 'pane-source' as PaneId,
      targetPaneId: 'pane-target' as PaneId,
      sourceSurfaceCount: 1,
    })).toEqual({ action: 'commit', commitOptions: { clearZoom: true } });

    expect(getSurfaceDragDropDecision({
      target: 'center',
      sourcePaneId: 'pane-source' as PaneId,
      targetPaneId: 'pane-target' as PaneId,
      sourceSurfaceCount: 2,
    })).toEqual({ action: 'commit', commitOptions: { clearZoom: false } });
  });

  it('parses only well-formed surface drag payloads', () => {
    expect(parseSurfaceDragData(JSON.stringify({
      sourcePaneId: 'pane-source',
      surfaceId: 'surf-drag',
    }))).toEqual({
      sourcePaneId: 'pane-source',
      surfaceId: 'surf-drag',
    });

    expect(parseSurfaceDragData('{ nope')).toBeNull();
    expect(parseSurfaceDragData(JSON.stringify({ sourcePaneId: 42, surfaceId: 'surf-drag' }))).toBeNull();
    expect(parseSurfaceDragData(JSON.stringify({ sourcePaneId: 'pane-source' }))).toBeNull();
  });
});
