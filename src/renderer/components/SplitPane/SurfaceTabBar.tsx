import React, { useState } from 'react';
import { SurfaceRef, SurfaceId, PaneId } from '../../../shared/types';
import { useStore } from '../../store';

interface SurfaceTabBarProps {
  paneId: PaneId;
  surfaces: SurfaceRef[];
  activeSurfaceIndex: number;
  onSelect: (index: number) => void;
  onClose: (surfaceId: SurfaceId) => void;
  onNew: () => void;
  onClosePane?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onDropSurface?: (sourcePaneId: PaneId, surfaceId: SurfaceId, targetPaneId: PaneId) => void;
}

function surfaceIcon(type: string, isAgent: boolean): string {
  if (isAgent) return '>_';
  switch (type) {
    case 'terminal': return '>';
    case 'browser': return '◎';
    case 'markdown': return '¶';
    case 'diff': return '±';
    default: return '○';
  }
}

function surfaceLabel(surface: SurfaceRef, agentLabel?: string): string {
  if (agentLabel) return agentLabel;
  switch (surface.type) {
    case 'terminal': return 'Terminal';
    case 'browser': return 'Browser';
    case 'markdown': return 'Markdown';
    case 'diff': return 'Diff';
    default: return 'Tab';
  }
}

export default function SurfaceTabBar({
  paneId,
  surfaces,
  activeSurfaceIndex,
  onSelect,
  onClose,
  onNew,
  onClosePane,
  onSplitRight,
  onSplitDown,
  onDropSurface,
}: SurfaceTabBarProps) {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const agentMeta = useStore((state) => state.agentMeta);
  const getAgentMeta = (surfaceId: string) => agentMeta.get(surfaceId as any);

  // Always show tab bar (even for 1 surface — like browser tabs)
  return (
    <div
      className="surface-tab-bar"
      role="tablist"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOverIndex(null);
        const data = e.dataTransfer.getData('application/wmux-surface');
        if (data && onDropSurface) {
          try {
            const { sourcePaneId, surfaceId } = JSON.parse(data);
            if (sourcePaneId !== paneId) {
              onDropSurface(sourcePaneId as PaneId, surfaceId as SurfaceId, paneId);
            }
          } catch {}
        }
      }}
      onDragLeave={() => setDragOverIndex(null)}
    >
      <div className="surface-tab-bar__tabs">
        {surfaces.map((surface, index) => {
          const isActive = index === activeSurfaceIndex;
          const agentMeta = getAgentMeta(surface.id);
          const isAgent = !!agentMeta;
          return (
            <div
              key={surface.id}
              className={[
                'surface-tab',
                isActive ? 'surface-tab--active' : '',
                dragOverIndex === index ? 'surface-tab--drag-over' : '',
                isAgent ? 'surface-tab--agent' : '',
              ].filter(Boolean).join(' ')}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(index)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'application/wmux-surface',
                  JSON.stringify({ sourcePaneId: paneId, surfaceId: surface.id })
                );
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverIndex(index);
              }}
            >
              <span className="surface-tab__icon">{surfaceIcon(surface.type, isAgent)}</span>
              <span className="surface-tab__label">{surfaceLabel(surface, agentMeta?.label)}</span>
              {surfaces.length > 1 && (
                <button
                  className="surface-tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(surface.id);
                  }}
                  tabIndex={-1}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        className="surface-tab-bar__new-btn"
        onClick={onNew}
        tabIndex={-1}
        title="New tab (Ctrl+T)"
      >
        +
      </button>
      {onSplitRight && (
        <button
          className="surface-tab-bar__split-btn"
          onClick={onSplitRight}
          tabIndex={-1}
          title="Split right (Ctrl+D)"
        >
          ⏐
        </button>
      )}
      {onSplitDown && (
        <button
          className="surface-tab-bar__split-btn"
          onClick={onSplitDown}
          tabIndex={-1}
          title="Split down (Ctrl+Shift+D)"
        >
          ⎯
        </button>
      )}
      {onClosePane && (
        <button
          className="surface-tab-bar__close-pane-btn"
          onClick={onClosePane}
          tabIndex={-1}
          title="Close pane"
        >
          ×
        </button>
      )}
    </div>
  );
}
