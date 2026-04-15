import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SurfaceRef, SurfaceId, PaneId, WorkspaceId } from '../../../shared/types';
import { useStore } from '../../store';

interface SurfaceTabBarProps {
  paneId: PaneId;
  workspaceShell?: string;
  surfaces: SurfaceRef[];
  activeSurfaceIndex: number;
  onSelect: (index: number) => void;
  onClose: (surfaceId: SurfaceId) => void;
  onNew: () => void;
  onClosePane?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onDropSurface?: (sourcePaneId: PaneId, surfaceId: SurfaceId, targetPaneId: PaneId) => void;
  onReorderSurface?: (surfaceId: SurfaceId, newIndex: number) => void;
  isDragActive?: boolean;
  isFocused?: boolean;
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

function getShellLabel(shell?: string): string | null {
  if (!shell) return null;
  const normalized = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || shell.toLowerCase();
  if (normalized === 'pwsh.exe' || normalized === 'pwsh') return 'PowerShell';
  if (normalized === 'powershell.exe' || normalized === 'powershell') return 'Windows PowerShell';
  if (normalized === 'cmd.exe' || normalized === 'cmd') return 'Command Prompt';
  if (normalized === 'bash.exe' || normalized === 'bash') return 'Bash';
  if (normalized === 'zsh' || normalized === 'zsh.exe') return 'Zsh';
  if (normalized === 'wsl.exe' || normalized === 'wsl') return 'WSL';
  if (normalized === 'git-bash.exe') return 'Git Bash';
  return normalized.replace(/\.exe$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function surfaceLabel(surface: SurfaceRef, agentLabel?: string, workspaceShell?: string): string {
  if (surface.customTitle) return surface.customTitle;
  if (agentLabel) return agentLabel;
  switch (surface.type) {
    case 'terminal': return getShellLabel(surface.shell || workspaceShell) || 'Terminal';
    case 'browser': return 'Browser';
    case 'markdown': return 'Markdown';
    case 'diff': return 'Diff';
    default: return 'Tab';
  }
}

export default function SurfaceTabBar({
  paneId,
  workspaceShell,
  surfaces,
  activeSurfaceIndex,
  onSelect,
  onClose,
  onNew,
  onClosePane,
  onSplitRight,
  onSplitDown,
  onDropSurface,
  onReorderSurface,
  isDragActive,
  isFocused,
}: SurfaceTabBarProps) {
  const [draggingSurfaceId, setDraggingSurfaceId] = useState<SurfaceId | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<SurfaceId | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const agentMeta = useStore((state) => state.agentMeta);
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId);
  const renameSurface = useStore((state) => state.renameSurface);
  const getAgentMeta = (surfaceId: string) => agentMeta.get(surfaceId as any);

  // Start rename for the active surface
  const startRename = useCallback(() => {
    const activeSurface = surfaces[activeSurfaceIndex];
    if (!activeSurface) return;
    setRenamingId(activeSurface.id);
    setRenameValue(activeSurface.customTitle || '');
  }, [surfaces, activeSurfaceIndex]);

  // Commit rename
  const commitRename = useCallback(() => {
    if (renamingId && activeWorkspaceId) {
      renameSurface(activeWorkspaceId, paneId, renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renamingId, activeWorkspaceId, paneId, renameValue, renameSurface]);

  // Cancel rename
  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  // Listen for keyboard shortcut rename event (only when focused)
  useEffect(() => {
    if (!isFocused) return;
    const handler = () => startRename();
    document.addEventListener('wmux:rename-surface', handler);
    return () => document.removeEventListener('wmux:rename-surface', handler);
  }, [isFocused, startRename]);

  // Auto-focus rename input
  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

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
        const savedInsertIndex = insertIndex;
        setInsertIndex(null);
        setDraggingSurfaceId(null);
        document.body.classList.remove('wmux-dragging');
        const data = e.dataTransfer.getData('application/wmux-surface');
        if (!data) return;
        try {
          const { sourcePaneId, surfaceId } = JSON.parse(data);
          if (sourcePaneId === paneId && onReorderSurface && savedInsertIndex !== null) {
            const currentIndex = surfaces.findIndex(s => s.id === surfaceId);
            const adjustedIndex = savedInsertIndex > currentIndex ? savedInsertIndex - 1 : savedInsertIndex;
            if (adjustedIndex !== currentIndex) {
              onReorderSurface(surfaceId as SurfaceId, adjustedIndex);
            }
          } else if (sourcePaneId !== paneId && onDropSurface) {
            onDropSurface(sourcePaneId as PaneId, surfaceId as SurfaceId, paneId);
          }
        } catch {}
      }}
      onDragLeave={() => setInsertIndex(null)}
    >
      <div className="surface-tab-bar__tabs">
        {surfaces.map((surface, index) => {
          const isActive = index === activeSurfaceIndex;
          const agentMeta = getAgentMeta(surface.id);
          const isAgent = !!agentMeta;
          const isRenaming = renamingId === surface.id;
          return (
            <div
              key={surface.id}
              className={[
                'surface-tab',
                isActive ? 'surface-tab--active' : '',
                draggingSurfaceId === surface.id ? 'surface-tab--dragging' : '',
                insertIndex === index ? 'surface-tab--insert-before' : '',
                insertIndex === index + 1 && index === surfaces.length - 1 ? 'surface-tab--insert-after' : '',
                isAgent ? 'surface-tab--agent' : '',
              ].filter(Boolean).join(' ')}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(index)}
              onDoubleClick={() => {
                setRenamingId(surface.id);
                setRenameValue(surface.customTitle || '');
              }}
              draggable={!isRenaming}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'application/wmux-surface',
                  JSON.stringify({ sourcePaneId: paneId, surfaceId: surface.id })
                );
                e.dataTransfer.effectAllowed = 'move';
                setDraggingSurfaceId(surface.id);
                document.body.classList.add('wmux-dragging');
              }}
              onDragEnd={() => {
                setDraggingSurfaceId(null);
                setInsertIndex(null);
                document.body.classList.remove('wmux-dragging');
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const midpoint = rect.left + rect.width / 2;
                const newInsertIndex = e.clientX < midpoint ? index : index + 1;
                setInsertIndex(newInsertIndex);
              }}
            >
              <span className="surface-tab__icon">{surfaceIcon(surface.type, isAgent)}</span>
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  className="surface-tab__rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { commitRename(); e.stopPropagation(); }
                    if (e.key === 'Escape') { cancelRename(); e.stopPropagation(); }
                    e.stopPropagation();
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  placeholder={surfaceLabel(surface, agentMeta?.label, workspaceShell)}
                />
              ) : (
                <span className="surface-tab__label">{surfaceLabel(surface, agentMeta?.label, workspaceShell)}</span>
              )}
              {surfaces.length > 1 && !isRenaming && (
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
