import type { PaneId, SplitNode, SurfaceId, SurfaceRef } from '../../../shared/types';
import { useStore } from '../../store';
import '../../styles/splitpane.css';
import { getSurfaceLabel } from './surface-label';

interface SplitPreviewOverlayProps {
  tree: SplitNode;
  destinationPaneId: PaneId;
  draggedSurfaceId: SurfaceId;
  workspaceShell?: string;
}

export default function SplitPreviewOverlay({
  tree,
  destinationPaneId,
  draggedSurfaceId,
  workspaceShell,
}: SplitPreviewOverlayProps) {
  const agentMeta = useStore((state) => state.agentMeta);
  const getPreviewSurfaceLabel = (surface: SurfaceRef) =>
    getSurfaceLabel(surface, agentMeta.get(surface.id)?.label, workspaceShell);

  return (
    <div className="split-preview-overlay" aria-hidden="true">
      <PreviewNode
        node={tree}
        destinationPaneId={destinationPaneId}
        draggedSurfaceId={draggedSurfaceId}
        getPreviewSurfaceLabel={getPreviewSurfaceLabel}
      />
    </div>
  );
}

function PreviewNode({
  node,
  destinationPaneId,
  draggedSurfaceId,
  getPreviewSurfaceLabel,
}: {
  node: SplitNode;
  destinationPaneId: PaneId;
  draggedSurfaceId: SurfaceId;
  getPreviewSurfaceLabel: (surface: SurfaceRef) => string;
}) {
  if (node.type === 'leaf') {
    const isDestination = node.paneId === destinationPaneId;

    return (
      <div className={`split-preview-pane ${isDestination ? 'split-preview-pane--destination' : ''}`}>
        <div className="split-preview-pane__tabs">
          {node.surfaces.map((surface, index) => (
            <span
              key={surface.id}
              className={[
                'split-preview-pane__tab',
                surface.id === draggedSurfaceId ? 'split-preview-pane__tab--dragged' : '',
                index === node.activeSurfaceIndex ? 'split-preview-pane__tab--active' : '',
              ].filter(Boolean).join(' ')}
            >
              {getPreviewSurfaceLabel(surface)}
            </span>
          ))}
        </div>
        <div className="split-preview-pane__body">
          <span className="split-preview-pane__line" />
          <span className="split-preview-pane__line" />
          <span className="split-preview-pane__line" />
          <span className="split-preview-pane__line" />
        </div>
        {isDestination && <span className="split-preview-pane__destination-label">Drop here</span>}
      </div>
    );
  }

  const [left, right] = node.children;

  return (
    <div className={`split-preview-container split-preview-container--${node.direction}`}>
      <div className="split-preview-container__child" style={{ flex: node.ratio }}>
        <PreviewNode
          node={left}
          destinationPaneId={destinationPaneId}
          draggedSurfaceId={draggedSurfaceId}
          getPreviewSurfaceLabel={getPreviewSurfaceLabel}
        />
      </div>
      <div className={`split-preview-container__divider split-preview-container__divider--${node.direction}`} />
      <div className="split-preview-container__child" style={{ flex: 1 - node.ratio }}>
        <PreviewNode
          node={right}
          destinationPaneId={destinationPaneId}
          draggedSurfaceId={draggedSurfaceId}
          getPreviewSurfaceLabel={getPreviewSurfaceLabel}
        />
      </div>
    </div>
  );
}
