import type { PaneId, SplitNode, SurfaceId, WorkspaceId } from '../../../shared/types';

export type SurfaceDragPreviewTarget = 'left' | 'right' | 'up' | 'down' | 'center';

export interface SurfaceDragPayload {
  workspaceId: WorkspaceId;
  sourcePaneId: PaneId;
  surfaceId: SurfaceId;
}

export interface SurfaceDragPreview extends SurfaceDragPayload {
  targetPaneId: PaneId;
  target: SurfaceDragPreviewTarget;
  previewTree: SplitNode;
  destinationPaneId: PaneId;
  collapsesSourcePane: boolean;
}

export interface SurfaceDragCommitOptions {
  clearZoom?: boolean;
}
