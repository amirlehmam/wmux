import React, { useState, useCallback, useEffect } from 'react';
import { WorkspaceInfo, WorkspaceId } from '../../../shared/types';
import WorkspaceRow from './WorkspaceRow';
import SidebarResizeHandle from './SidebarResizeHandle';
import WorkspaceContextMenu from './WorkspaceContextMenu';
import SessionMenu from './SessionMenu';
import '../../styles/sidebar.css';

interface ContextMenuState {
  x: number;
  y: number;
  workspaceId: WorkspaceId;
}

interface SidebarProps {
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: WorkspaceId | null;
  sidebarWidth: number;
  onWidthChange: (newWidth: number) => void;
  onSelect: (id: WorkspaceId) => void;
  onClose: (id: WorkspaceId) => void;
  onCreate: () => void;
  onRename: (id: WorkspaceId, title: string) => void;
  onReorder: (ids: WorkspaceId[]) => void;
  onUpdateMetadata: (id: WorkspaceId, partial: Partial<WorkspaceInfo>) => void;
  hookActivity?: Record<string, { lastTool: string; toolCount: number; lastSeen: number }>;
  claudeActivity?: Record<string, any>;
  onSaveSession?: (name: string) => void;
  onLoadSession?: (name: string) => void;
  onCollapse?: () => void;
}

export default function Sidebar({
  workspaces,
  activeWorkspaceId,
  sidebarWidth,
  onWidthChange,
  onSelect,
  onClose,
  onCreate,
  onRename,
  onReorder,
  onUpdateMetadata,
  hookActivity,
  claudeActivity,
  onSaveSession,
  onLoadSession,
  onCollapse,
}: SidebarProps) {
  const [draggedId, setDraggedId] = useState<WorkspaceId | null>(null);
  const [dragOverId, setDragOverId] = useState<WorkspaceId | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({});
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [saveInputOpen, setSaveInputOpen] = useState(false);
  const [saveInputValue, setSaveInputValue] = useState('');

  useEffect(() => {
    let polling = false;
    const interval = setInterval(async () => {
      if (polling || !window.wmux?.agent?.list) return;
      polling = true;
      try {
        const agents = await window.wmux.agent.list();
        const counts: Record<string, number> = {};
        for (const agent of agents || []) {
          if (agent.status === 'running') {
            counts[agent.workspaceId] = (counts[agent.workspaceId] || 0) + 1;
          }
        }
        setAgentCounts(counts);
      } catch {}
      polling = false;
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // ── Resize ───────────────────────────────────────────────────────────────
  const handleResizeDelta = useCallback(
    (delta: number) => {
      const newWidth = Math.min(600, Math.max(180, sidebarWidth + delta));
      onWidthChange(newWidth);
    },
    [sidebarWidth, onWidthChange],
  );

  // ── Drag-and-drop ────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, id: WorkspaceId) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: WorkspaceId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id !== draggedId) {
      setDragOverId(id);
    }
  }, [draggedId]);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: WorkspaceId) => {
      e.preventDefault();
      if (!draggedId || draggedId === targetId) return;

      const ids = workspaces.map((w) => w.id);
      const fromIdx = ids.indexOf(draggedId);
      const toIdx = ids.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;

      const reordered = [...ids];
      reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, draggedId);
      onReorder(reordered);

      setDraggedId(null);
      setDragOverId(null);
    },
    [draggedId, workspaces, onReorder],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  // ── Context menu ─────────────────────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent, id: WorkspaceId) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, workspaceId: id });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // ── Pin/unpin from context menu ──────────────────────────────────────────
  const handlePin = useCallback(
    (id: WorkspaceId) => {
      const ws = workspaces.find((w) => w.id === id);
      if (ws) onUpdateMetadata(id, { pinned: !ws.pinned });
    },
    [workspaces, onUpdateMetadata],
  );

  // ── Color from context menu ──────────────────────────────────────────────
  const handleSetColor = useCallback(
    (id: WorkspaceId, color: string | null) => {
      onUpdateMetadata(id, { customColor: color ?? undefined });
    },
    [onUpdateMetadata],
  );

  // ── Move helpers ─────────────────────────────────────────────────────────
  const handleMoveUp = useCallback(
    (id: WorkspaceId) => {
      const ids = workspaces.map((w) => w.id);
      const idx = ids.indexOf(id);
      if (idx <= 0) return;
      const reordered = [...ids];
      [reordered[idx - 1], reordered[idx]] = [reordered[idx], reordered[idx - 1]];
      onReorder(reordered);
    },
    [workspaces, onReorder],
  );

  const handleMoveDown = useCallback(
    (id: WorkspaceId) => {
      const ids = workspaces.map((w) => w.id);
      const idx = ids.indexOf(id);
      if (idx === -1 || idx >= ids.length - 1) return;
      const reordered = [...ids];
      [reordered[idx], reordered[idx + 1]] = [reordered[idx + 1], reordered[idx]];
      onReorder(reordered);
    },
    [workspaces, onReorder],
  );

  const handleMoveToTop = useCallback(
    (id: WorkspaceId) => {
      const ids = workspaces.map((w) => w.id);
      const idx = ids.indexOf(id);
      if (idx <= 0) return;
      const reordered = [id, ...ids.filter((i) => i !== id)];
      onReorder(reordered);
    },
    [workspaces, onReorder],
  );

  // ── Mark as read/unread ──────────────────────────────────────────────────
  const handleMarkRead = useCallback(
    (id: WorkspaceId) => {
      onUpdateMetadata(id, { unreadCount: 0 });
    },
    [onUpdateMetadata],
  );

  const handleMarkUnread = useCallback(
    (id: WorkspaceId) => {
      const ws = workspaces.find((w) => w.id === id);
      if (ws && ws.unreadCount === 0) {
        onUpdateMetadata(id, { unreadCount: 1 });
      }
    },
    [workspaces, onUpdateMetadata],
  );

  // ── Close other workspaces ───────────────────────────────────────────────
  const handleCloseOthers = useCallback(
    (id: WorkspaceId) => {
      workspaces
        .filter((w) => w.id !== id)
        .forEach((w) => onClose(w.id));
    },
    [workspaces, onClose],
  );

  return (
    <div className="sidebar" style={{ width: sidebarWidth }}>
      {/* Spacer for titlebar area + collapse button */}
      <div className="sidebar__header">
        {onCollapse && (
          <button
            className="sidebar__collapse-btn"
            onClick={onCollapse}
            title="Collapse sidebar (Ctrl+B)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06z"/>
            </svg>
          </button>
        )}
      </div>

      <div className="sidebar__list">
        {workspaces.map((ws) => (
          <WorkspaceRow
            key={ws.id}
            workspace={ws}
            isActive={ws.id === activeWorkspaceId}
            onSelect={() => onSelect(ws.id)}
            onClose={() => onClose(ws.id)}
            onRename={(newTitle) => onRename(ws.id, newTitle)}
            onContextMenu={(e) => handleContextMenu(e, ws.id)}
            draggable
            onDragStart={(e) => handleDragStart(e, ws.id)}
            onDragOver={(e) => handleDragOver(e, ws.id)}
            onDrop={(e) => handleDrop(e, ws.id)}
            onDragEnd={handleDragEnd}
            isDragOver={dragOverId === ws.id}
            agentCount={agentCounts[ws.id] || 0}
            hookActivity={hookActivity?.[ws.id]}
            claudeActivity={claudeActivity}
          />
        ))}
      </div>

      <div className="sidebar__footer">
        {saveInputOpen ? (
          <input
            className="sidebar__save-input"
            placeholder="Session name..."
            value={saveInputValue}
            onChange={(e) => setSaveInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && saveInputValue.trim()) {
                onSaveSession?.(saveInputValue.trim());
                setSaveInputOpen(false);
                setSaveInputValue('');
              }
              if (e.key === 'Escape') { setSaveInputOpen(false); setSaveInputValue(''); }
            }}
            onBlur={() => { setSaveInputOpen(false); setSaveInputValue(''); }}
            autoFocus
          />
        ) : (
          <>
            <button className="sidebar__footer-btn" onClick={() => setSaveInputOpen(true)} title="Save session">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4.414A1 1 0 0 0 14.707 4L12 1.293A1 1 0 0 0 11.586 1H2zm0 1h1v3.5a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V2h.586L14 4.414V14H2V2zm3 0v3h5V2H5zm3 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
            </button>
            <button className="sidebar__footer-btn" onClick={() => setSessionMenuOpen(!sessionMenuOpen)} title="Load session">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9zM2.5 3a.5.5 0 0 0-.5.5V6h12v-.5a.5.5 0 0 0-.5-.5H9c-.964 0-1.71-.572-2.331-1.184C6.268 3.394 5.762 3 5.264 3H2.5zM14 7H2v5.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5V7z"/></svg>
            </button>
            <button className="sidebar__new-btn" onClick={onCreate} title="New workspace">
              +
            </button>
          </>
        )}
        {sessionMenuOpen && (
          <SessionMenu
            onLoad={(name) => { onLoadSession?.(name); setSessionMenuOpen(false); }}
            onClose={() => setSessionMenuOpen(false)}
          />
        )}
      </div>

      <SidebarResizeHandle onWidthChange={handleResizeDelta} />

      {contextMenu && (
        <WorkspaceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          workspaceId={contextMenu.workspaceId}
          workspace={workspaces.find((w) => w.id === contextMenu.workspaceId)!}
          onClose={closeContextMenu}
          onPin={handlePin}
          onRename={onRename}
          onSetColor={handleSetColor}
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          onMoveToTop={handleMoveToTop}
          onCloseWorkspace={(id) => { onClose(id); closeContextMenu(); }}
          onCloseOthers={(id) => { handleCloseOthers(id); closeContextMenu(); }}
          onMarkRead={handleMarkRead}
          onMarkUnread={handleMarkUnread}
        />
      )}
    </div>
  );
}
