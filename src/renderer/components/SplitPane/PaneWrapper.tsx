import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { PaneId, SplitNode, SurfaceId, WorkspaceId } from '../../../shared/types';
import { removeLeaf, splitNode } from '../../store/split-utils';
import TerminalPane from '../Terminal/TerminalPane';
import BrowserPane from '../Browser/BrowserPane';
import MarkdownPane from '../Markdown/MarkdownPane';
import DiffPane from '../Diff/DiffPane';
import NotificationRing from '../Terminal/NotificationRing';
import SurfaceTabBar from './SurfaceTabBar';
import { useStore } from '../../store';
import '../../styles/splitpane.css';
import '../../styles/terminal.css';

interface PaneWrapperProps {
  paneId: PaneId;
  workspaceId: WorkspaceId;
  leaf: SplitNode & { type: 'leaf' };
  isFocused: boolean;
}

export default function PaneWrapper({ leaf, workspaceId, isFocused }: PaneWrapperProps) {
  const { surfaces, activeSurfaceIndex, paneId } = leaf;
  const activeSurface = surfaces[activeSurfaceIndex];

  const notifications = useStore((s) => s.notifications);
  const markRead = useStore((s) => s.markRead);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const addSurface = useStore((s) => s.addSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const selectSurface = useStore((s) => s.selectSurface);
  const moveSurface = useStore((s) => s.moveSurface);
  const splitAndMoveSurface = useStore((s) => s.splitAndMoveSurface);
  const reorderSurface = useStore((s) => s.reorderSurface);
  const shortcuts = useStore((s) => s.shortcuts);
  const workspace = useStore((s) => s.workspaces.find(w => w.id === workspaceId));

  const surfaceIds = useMemo(() => surfaces.map((s) => s.id), [surfaces]);

  const hasUnread = useMemo(
    () => notifications.some((n) => !n.read && surfaceIds.includes(n.surfaceId as SurfaceId)),
    [notifications, surfaceIds],
  );

  // ─── Find bar state ───────────────────────────────────────────────────────
  const [findBarVisible, setFindBarVisible] = useState(false);

  // ─── Copy mode state ──────────────────────────────────────────────────────
  const [copyModeActive, setCopyModeActive] = useState(false);

  // ─── Drag active state ────────────────────────────────────────────────────
  const [dragActive, setDragActive] = useState(false);

  // Track "just fired" state for flash animation
  const [justFired, setJustFired] = useState(false);
  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read && surfaceIds.includes(n.surfaceId as SurfaceId)).length,
    [notifications, surfaceIds],
  );
  const prevUnreadCount = useRef(unreadCount);

  useEffect(() => {
    const currentCount = unreadCount;

    if (currentCount > prevUnreadCount.current) {
      setJustFired(true);
      const timer = setTimeout(() => setJustFired(false), 950);
      prevUnreadCount.current = currentCount;
      return () => clearTimeout(timer);
    }

    prevUnreadCount.current = currentCount;
  }, [unreadCount]);

  // When pane receives focus, mark all surfaces as read
  useEffect(() => {
    if (isFocused && hasUnread) {
      for (const surfaceId of surfaceIds) {
        markRead(surfaceId as SurfaceId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  // Keyboard shortcut listeners for find (Ctrl+F) and copy mode (Ctrl+Alt+[)
  useEffect(() => {
    if (!isFocused) return;

    function handleKeyDown(e: KeyboardEvent) {
      const findBinding = shortcuts.find;
      const copyModeBinding = shortcuts.copyMode;

      // Match find shortcut (default: Ctrl+F)
      const matchesFind =
        e.key === findBinding.key &&
        !!findBinding.ctrl === e.ctrlKey &&
        !!findBinding.shift === e.shiftKey &&
        !!findBinding.alt === e.altKey;

      if (matchesFind) {
        e.preventDefault();
        setFindBarVisible((v) => !v);
        return;
      }

      // Match copy mode shortcut (default: Ctrl+Alt+[)
      const matchesCopyMode =
        e.key === copyModeBinding.key &&
        !!copyModeBinding.ctrl === e.ctrlKey &&
        !!copyModeBinding.shift === e.shiftKey &&
        !!copyModeBinding.alt === e.altKey;

      if (matchesCopyMode) {
        e.preventDefault();
        setCopyModeActive((v) => !v);
        return;
      }

      // Escape exits copy mode
      if (e.key === 'Escape' && copyModeActive) {
        setCopyModeActive(false);
        return;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFocused, shortcuts, copyModeActive]);

  // ─── Global drag tracking ─────────────────────────────────────────────────
  useEffect(() => {
    const handleDragStart = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('application/wmux-surface')) {
        setDragActive(true);
      }
    };
    const handleDragEnd = () => setDragActive(false);
    const handleDrop = () => setDragActive(false);

    document.addEventListener('dragstart', handleDragStart);
    document.addEventListener('dragend', handleDragEnd);
    document.addEventListener('drop', handleDrop);
    return () => {
      document.removeEventListener('dragstart', handleDragStart);
      document.removeEventListener('dragend', handleDragEnd);
      document.removeEventListener('drop', handleDrop);
    };
  }, []);

  const handleFindBarClose = useCallback(() => {
    setFindBarVisible(false);
  }, []);

  const isWorkspaceActive = workspaceId === activeWorkspaceId;

  const renderAllSurfaces = () =>
    surfaces.map((surface, index) => {
      const isActive = index === activeSurfaceIndex;
      const isVisible = isActive && isWorkspaceActive;
      return (
        <div
          key={surface.id}
          className="pane-wrapper__surface-layer"
          style={{
            visibility: isActive ? 'visible' : 'hidden',
            zIndex: isActive ? 1 : 0,
          }}
        >
          {surface.type === 'terminal' && (
            <TerminalPane
              surfaceId={surface.id}
              shell={workspace?.shell}
              cwd={workspace?.cwd}
              focused={isFocused && isActive}
              visible={isVisible}
              showFindBar={findBarVisible && isFocused && isActive}
              onFindBarClose={handleFindBarClose}
              copyModeActive={copyModeActive && isFocused && isActive}
            />
          )}
          {surface.type === 'browser' && <BrowserPane surfaceId={surface.id} />}
          {surface.type === 'markdown' && <MarkdownPane surfaceId={surface.id} />}
          {surface.type === 'diff' && <DiffPane surfaceId={surface.id} cwd={workspace?.cwd} />}
        </div>
      );
    });

  const handleNewSurface = () => {
    if (activeWorkspaceId) {
      addSurface(activeWorkspaceId, paneId, 'terminal');
    }
  };

  const handleSelectSurface = (index: number) => {
    if (activeWorkspaceId) {
      selectSurface(activeWorkspaceId, paneId, index);
    }
  };

  const handleDropSurface = (sourcePaneId: PaneId, surfaceId: SurfaceId, targetPaneId: PaneId) => {
    if (activeWorkspaceId) {
      moveSurface(activeWorkspaceId, sourcePaneId, surfaceId, targetPaneId);
    }
  };

  const handleCloseSurface = (surfaceId: SurfaceId) => {
    if (activeWorkspaceId) {
      // Kill PTY BEFORE removing from store — so re-mount after tree collapse
      // doesn't find a dead PTY. Only explicit close kills the PTY.
      window.wmux?.pty?.kill(surfaceId);
      closeSurface(activeWorkspaceId, paneId, surfaceId);
    }
  };

  const handleSplitRight = () => {
    if (!activeWorkspaceId) return;
    const { workspaces, updateSplitTree } = useStore.getState();
    const ws = workspaces.find(w => w.id === activeWorkspaceId);
    if (ws) {
      const newPaneId = `pane-${crypto.randomUUID()}` as PaneId;
      const newTree = splitNode(ws.splitTree, paneId, newPaneId, 'terminal', 'horizontal');
      updateSplitTree(activeWorkspaceId, newTree);
    }
  };

  const handleSplitDown = () => {
    if (!activeWorkspaceId) return;
    const { workspaces, updateSplitTree } = useStore.getState();
    const ws = workspaces.find(w => w.id === activeWorkspaceId);
    if (ws) {
      const newPaneId = `pane-${crypto.randomUUID()}` as PaneId;
      const newTree = splitNode(ws.splitTree, paneId, newPaneId, 'terminal', 'vertical');
      updateSplitTree(activeWorkspaceId, newTree);
    }
  };

  const handleClosePane = () => {
    if (!activeWorkspaceId) return;
    // Kill all PTYs in this pane first
    for (const surface of surfaces) {
      if (surface.type === 'terminal') {
        window.wmux?.pty?.kill(surface.id);
      }
    }
    // Remove the pane atomically (not surface-by-surface, which corrupts state)
    const { workspaces, updateSplitTree } = useStore.getState();
    const ws = workspaces.find(w => w.id === activeWorkspaceId);
    if (ws) {
      const newTree = removeLeaf(ws.splitTree, paneId);
      if (newTree) updateSplitTree(activeWorkspaceId, newTree);
    }
  };

  const handleEdgeDrop = (e: React.DragEvent, direction: 'left' | 'right' | 'up' | 'down') => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    document.body.classList.remove('wmux-dragging');
    const data = e.dataTransfer.getData('application/wmux-surface');
    if (!data || !activeWorkspaceId) return;
    try {
      const { sourcePaneId, surfaceId } = JSON.parse(data);
      splitAndMoveSurface(activeWorkspaceId, paneId, sourcePaneId as PaneId, surfaceId as SurfaceId, direction);
    } catch {}
  };

  const handleCenterDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    document.body.classList.remove('wmux-dragging');
    const data = e.dataTransfer.getData('application/wmux-surface');
    if (!data || !activeWorkspaceId) return;
    try {
      const { sourcePaneId, surfaceId } = JSON.parse(data);
      if (sourcePaneId !== paneId) {
        moveSurface(activeWorkspaceId, sourcePaneId as PaneId, surfaceId as SurfaceId, paneId);
      }
    } catch {}
  };

  const preventDragDefault = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleReorderSurface = (surfaceId: SurfaceId, newIndex: number) => {
    if (activeWorkspaceId) {
      reorderSurface(activeWorkspaceId, paneId, surfaceId, newIndex);
    }
  };

  return (
    <div className={`pane-wrapper ${isFocused ? 'pane-wrapper--focused' : ''} ${dragActive ? 'pane-wrapper--drag-active' : ''}`}>
      <SurfaceTabBar
        paneId={paneId}
        surfaces={surfaces}
        activeSurfaceIndex={activeSurfaceIndex}
        onSelect={handleSelectSurface}
        onClose={handleCloseSurface}
        onNew={handleNewSurface}
        onClosePane={handleClosePane}
        onSplitRight={handleSplitRight}
        onSplitDown={handleSplitDown}
        onDropSurface={handleDropSurface}
        onReorderSurface={handleReorderSurface}
        isDragActive={dragActive}
      />
      <div className="pane-wrapper__content">
        {renderAllSurfaces()}
        <NotificationRing visible={hasUnread} flashing={justFired} />
        <div
          className="pane-wrapper__unfocused-overlay"
          style={{ opacity: isFocused ? 0 : 1 }}
        />
        <div className="pane-wrapper__drop-zones">
          <div className="pane-drop-zone pane-drop-zone--left" onDragOver={preventDragDefault} onDrop={(e) => handleEdgeDrop(e, 'left')} />
          <div className="pane-drop-zone pane-drop-zone--right" onDragOver={preventDragDefault} onDrop={(e) => handleEdgeDrop(e, 'right')} />
          <div className="pane-drop-zone pane-drop-zone--top" onDragOver={preventDragDefault} onDrop={(e) => handleEdgeDrop(e, 'up')} />
          <div className="pane-drop-zone pane-drop-zone--bottom" onDragOver={preventDragDefault} onDrop={(e) => handleEdgeDrop(e, 'down')} />
          <div className="pane-drop-zone pane-drop-zone--center" onDragOver={preventDragDefault} onDrop={handleCenterDrop} />
        </div>
      </div>
    </div>
  );
}
