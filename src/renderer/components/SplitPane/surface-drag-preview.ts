import type { PaneId, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../../shared/types';
import { previewMoveSurface, previewSplitAndMoveSurface } from '../../store/split-preview-utils';
import type {
  SurfaceDragCommitOptions,
  SurfaceDragPayload,
  SurfaceDragPreview,
  SurfaceDragPreviewTarget,
} from './drag-preview-types';

export interface SurfaceDragData {
  sourcePaneId: PaneId;
  surfaceId: SurfaceId;
}

export interface PendingSurfaceDragPreviewTarget {
  targetPaneId: PaneId;
  target: SurfaceDragPreviewTarget;
}

export interface BuildSurfaceDragPreviewOptions {
  workspaces: Pick<WorkspaceInfo, 'id' | 'splitTree'>[];
  activeWorkspaceId: WorkspaceId | null;
  drag: SurfaceDragPayload | null;
  pendingTarget: PendingSurfaceDragPreviewTarget | null;
}

export type SurfaceDragDropDecision =
  | { action: 'cancel' }
  | { action: 'commit'; commitOptions: SurfaceDragCommitOptions };

export function buildSurfaceDragPreview({
  workspaces,
  activeWorkspaceId,
  drag,
  pendingTarget,
}: BuildSurfaceDragPreviewOptions): SurfaceDragPreview | null {
  if (!pendingTarget || !drag) return null;

  const workspace = workspaces.find((candidate) => candidate.id === drag.workspaceId);
  if (!workspace || workspace.id !== activeWorkspaceId) return null;

  const result = pendingTarget.target === 'center'
    ? previewMoveSurface(workspace.splitTree, drag.sourcePaneId, drag.surfaceId, pendingTarget.targetPaneId)
    : previewSplitAndMoveSurface(
      workspace.splitTree,
      pendingTarget.targetPaneId,
      drag.sourcePaneId,
      drag.surfaceId,
      pendingTarget.target,
    );

  if (!result) return null;

  return {
    ...drag,
    targetPaneId: pendingTarget.targetPaneId,
    target: pendingTarget.target,
    previewTree: result.tree,
    destinationPaneId: result.destinationPaneId,
    collapsesSourcePane: result.collapsesSourcePane,
  };
}

export function getSurfaceDragDropDecision({
  target,
  sourcePaneId,
  targetPaneId,
  sourceSurfaceCount,
}: {
  target: 'edge' | 'center';
  sourcePaneId: PaneId;
  targetPaneId: PaneId;
  sourceSurfaceCount: number;
}): SurfaceDragDropDecision {
  if (target === 'edge') {
    if (sourcePaneId === targetPaneId && sourceSurfaceCount === 1) {
      return { action: 'cancel' };
    }

    return { action: 'commit', commitOptions: { clearZoom: true } };
  }

  if (sourcePaneId === targetPaneId) {
    return { action: 'cancel' };
  }

  return {
    action: 'commit',
    commitOptions: { clearZoom: sourceSurfaceCount === 1 },
  };
}

export function parseSurfaceDragData(data: string): SurfaceDragData | null {
  try {
    const parsed = JSON.parse(data) as Partial<Record<'sourcePaneId' | 'surfaceId', unknown>>;
    if (typeof parsed.sourcePaneId !== 'string' || typeof parsed.surfaceId !== 'string') {
      return null;
    }

    return {
      sourcePaneId: parsed.sourcePaneId as PaneId,
      surfaceId: parsed.surfaceId as SurfaceId,
    };
  } catch {
    return null;
  }
}
