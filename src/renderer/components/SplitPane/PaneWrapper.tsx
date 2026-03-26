import React, { useEffect, useRef, useState, useCallback } from 'react';
import { PaneId, SplitNode, SurfaceId } from '../../../shared/types';
import TerminalPane from '../Terminal/TerminalPane';
import BrowserPane from '../Browser/BrowserPane';
import MarkdownPane from '../Markdown/MarkdownPane';
import NotificationRing from '../Terminal/NotificationRing';
import SurfaceTabBar from './SurfaceTabBar';
import { useStore } from '../../store';
import '../../styles/splitpane.css';
import '../../styles/terminal.css';

interface PaneWrapperProps {
  paneId: PaneId;
  leaf: SplitNode & { type: 'leaf' };
  isFocused: boolean;
}

export default function PaneWrapper({ leaf, isFocused }: PaneWrapperProps) {
  const { surfaces, activeSurfaceIndex, paneId } = leaf;
  const activeSurface = surfaces[activeSurfaceIndex];

  const notifications = useStore((s) => s.notifications);
  const markRead = useStore((s) => s.markRead);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const addSurface = useStore((s) => s.addSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const selectSurface = useStore((s) => s.selectSurface);
  const moveSurface = useStore((s) => s.moveSurface);
  const shortcuts = useStore((s) => s.shortcuts);

  const surfaceIds = surfaces.map((s) => s.id);

  const hasUnread = notifications.some(
    (n) => !n.read && surfaceIds.includes(n.surfaceId as SurfaceId),
  );

  // ─── Find bar state ───────────────────────────────────────────────────────
  const [findBarVisible, setFindBarVisible] = useState(false);

  // ─── Copy mode state ──────────────────────────────────────────────────────
  const [copyModeActive, setCopyModeActive] = useState(false);

  // Track "just fired" state for flash animation
  const [justFired, setJustFired] = useState(false);
  const prevUnreadCount = useRef(
    notifications.filter((n) => !n.read && surfaceIds.includes(n.surfaceId as SurfaceId)).length,
  );

  useEffect(() => {
    const currentCount = notifications.filter(
      (n) => !n.read && surfaceIds.includes(n.surfaceId as SurfaceId),
    ).length;

    if (currentCount > prevUnreadCount.current) {
      setJustFired(true);
      const timer = setTimeout(() => setJustFired(false), 950);
      prevUnreadCount.current = currentCount;
      return () => clearTimeout(timer);
    }

    prevUnreadCount.current = currentCount;
  }, [notifications, surfaceIds]);

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

  const handleFindBarClose = useCallback(() => {
    setFindBarVisible(false);
  }, []);

  const renderSurface = () => {
    if (!activeSurface) return null;
    switch (activeSurface.type) {
      case 'terminal':
        return (
          <TerminalPane
            key={activeSurface.id}
            surfaceId={activeSurface.id}
            focused={isFocused}
            showFindBar={findBarVisible && isFocused}
            onFindBarClose={handleFindBarClose}
            copyModeActive={copyModeActive && isFocused}
          />
        );
      case 'browser':
        return <BrowserPane key={activeSurface.id} surfaceId={activeSurface.id} />;
      case 'markdown':
        return <MarkdownPane key={activeSurface.id} surfaceId={activeSurface.id} />;
      default:
        return null;
    }
  };

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
      closeSurface(activeWorkspaceId, paneId, surfaceId);
    }
  };

  return (
    <div className="pane-wrapper">
      <SurfaceTabBar
        paneId={paneId}
        surfaces={surfaces}
        activeSurfaceIndex={activeSurfaceIndex}
        onSelect={handleSelectSurface}
        onClose={handleCloseSurface}
        onNew={handleNewSurface}
        onDropSurface={handleDropSurface}
      />
      <div className="pane-wrapper__content">
        {renderSurface()}
        <NotificationRing visible={hasUnread} flashing={justFired} />
        <div
          className="pane-wrapper__unfocused-overlay"
          style={{ opacity: isFocused ? 0 : 1 }}
        />
      </div>
    </div>
  );
}
