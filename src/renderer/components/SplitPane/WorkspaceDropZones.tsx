import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import type { PaneId, WorkspaceInfo } from '../../../shared/types';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { moveSurfaceToWorkspaceEdge, type SplitPreviewDirection } from '../../store/split-preview-utils';
import type { SurfaceDragPayload } from './drag-preview-types';
import SplitPreviewOverlay from './SplitPreviewOverlay';

/** Outer-edge targets complement each leaf's targets: a browser can occupy
 * the entire bottom/right of a layout, regardless of its current parent. */
export default function WorkspaceDropZones({ workspace, drag, onEnd, onClearPreview, onCommit }: {
  workspace: WorkspaceInfo;
  drag: SurfaceDragPayload;
  onEnd(): void;
  onClearPreview(): void;
  onCommit(): void;
}) {
  const [edge, setEdge] = useState<SplitPreviewDirection | null>(null);
  const t = useT();
  const preview = edge ? moveSurfaceToWorkspaceEdge(workspace.splitTree, drag.sourcePaneId,
    drag.surfaceId, edge, 'pane-workspace-preview' as PaneId) : null;
  return <>
    {preview && <SplitPreviewOverlay tree={preview.tree} destinationPaneId={preview.destinationPaneId}
      draggedSurfaceId={drag.surfaceId} workspaceShell={workspace.shell} />}
    {(['left', 'right', 'up', 'down'] as const).map((direction) => (
      <div key={direction} className={`workspace-drop-edge workspace-drop-edge--${direction}`}
        onDragOver={(event) => {
          event.preventDefault(); event.stopPropagation();
          event.dataTransfer.dropEffect = 'move';
          onClearPreview(); setEdge(direction);
        }}
        onDragLeave={() => setEdge(null)}
        onDrop={(event) => {
          event.preventDefault(); event.stopPropagation();
          const store = useStore.getState();
          const current = store.workspaces.find((ws) => ws.id === workspace.id);
          if (current && store.activeWorkspaceId === workspace.id && drag.workspaceId === workspace.id) {
            const result = moveSurfaceToWorkspaceEdge(current.splitTree, drag.sourcePaneId,
              drag.surfaceId, direction, `pane-${uuid()}` as PaneId);
            if (result) { store.updateSplitTree(workspace.id, result.tree); onCommit(); }
          }
          setEdge(null); onEnd();
          document.body.classList.remove('wmux-dragging');
        }}
      ><span>{t('splitPreview.workspaceEdge', 'Workspace edge')}</span></div>
    ))}
  </>;
}
