import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { PaneId, SplitNode, SurfaceId, WorkspaceId, QuickLaunchProfile, ShellInfo } from '../../../shared/types';
import { findLeaf, removeLeaf, splitNode } from '../../store/split-utils';
import TerminalPane from '../Terminal/TerminalPane';
import BrowserPane from '../Browser/BrowserPane';
import MarkdownPane from '../Markdown/MarkdownPane';
import DiffPane from '../Diff/DiffPane';
import NotificationRing from '../Terminal/NotificationRing';
import SurfaceTabBar from './SurfaceTabBar';
import { useStore } from '../../store';
import type { SurfaceDragCommitOptions, SurfaceDragPayload, SurfaceDragPreviewTarget } from './drag-preview-types';
import {
  getSurfaceDragDropDecision,
  parseSurfaceDragData,
  type SurfaceDragData,
} from './surface-drag-preview';
import '../../styles/splitpane.css';
import '../../styles/terminal.css';

interface PaneWrapperProps {
  paneId: PaneId;
  workspaceId: WorkspaceId;
  leaf: SplitNode & { type: 'leaf' };
  isFocused: boolean;
  surfaceDrag: SurfaceDragPayload | null;
  onSurfaceDragStart: (payload: SurfaceDragPayload) => void;
  onSurfaceDragEnd: () => void;
  onSurfaceDragPreviewTarget: (targetPaneId: PaneId, target: SurfaceDragPreviewTarget) => void;
  onClearSurfaceDragPreview: () => void;
  onSurfaceDragCommit: (options?: SurfaceDragCommitOptions) => void;
}

export default function PaneWrapper({
  leaf,
  workspaceId,
  isFocused,
  surfaceDrag,
  onSurfaceDragStart,
  onSurfaceDragEnd,
  onSurfaceDragPreviewTarget,
  onClearSurfaceDragPreview,
  onSurfaceDragCommit,
}: PaneWrapperProps) {
  const { surfaces, activeSurfaceIndex, paneId } = leaf;

  const notifications = useStore((s) => s.notifications);
  const markRead = useStore((s) => s.markRead);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const addSurface = useStore((s) => s.addSurface);
  const updateSurface = useStore((s) => s.updateSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const closeOtherSurfaces = useStore((s) => s.closeOtherSurfaces);
  const closeSurfacesToRight = useStore((s) => s.closeSurfacesToRight);
  const selectSurface = useStore((s) => s.selectSurface);
  const moveSurface = useStore((s) => s.moveSurface);
  const splitAndMoveSurface = useStore((s) => s.splitAndMoveSurface);
  const reorderSurface = useStore((s) => s.reorderSurface);
  const shortcuts = useStore((s) => s.shortcuts);
  const workspace = useStore((s) => s.workspaces.find(w => w.id === workspaceId));
  const globalProfiles = useStore((s) => s.quickLaunchProfiles);
  const [projectProfiles, setProjectProfiles] = useState<QuickLaunchProfile[]>([]);
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([]);

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

  // Safety net: reset stale drag state when this workspace becomes active.
  // If a drop on an edge/center zone detaches the source element before dragend
  // fires, other panes stay stuck with dragActive=true across workspace switches.
  useEffect(() => {
    if (isWorkspaceActive) {
      setDragActive(false);
    }
  }, [isWorkspaceActive]);

  useEffect(() => {
    if (!surfaceDrag) {
      setDragActive(false);
    }
  }, [surfaceDrag]);

  const renderAllSurfaces = () =>
    surfaces.map((surface, index) => {
      const isActive = index === activeSurfaceIndex;
      const isVisible = isActive && isWorkspaceActive;
      return (
        <div
          key={surface.id}
          className="pane-wrapper__surface-layer"
          style={{
            // Must use isVisible (not isActive) — explicit `visibility: visible`
            // on a child overrides a hidden ancestor (CSS spec), so inactive
            // workspaces would keep painting their active tabs on top of the
            // visible workspace. Gate on isWorkspaceActive to respect parent.
            visibility: isVisible ? 'visible' : 'hidden',
            zIndex: isActive ? 1 : 0,
          }}
        >
          {surface.type === 'terminal' && (
            <TerminalPane
              surfaceId={surface.id}
              shell={surface.shell || workspace?.shell}
              cwd={surface.cwd || workspace?.cwd}
              colorScheme={surface.colorScheme}
              startupCommands={surface.startupCommands}
              focused={isFocused && isActive}
              visible={isVisible}
              showFindBar={findBarVisible && isFocused && isActive}
              onFindBarClose={handleFindBarClose}
              copyModeActive={copyModeActive && isFocused && isActive}
            />
          )}
          {surface.type === 'browser' && (
            <BrowserPane
              surfaceId={surface.id}
              workspaceId={workspaceId}
              {...(surface.url ? { initialUrl: surface.url } : {})}
              // Persist the live URL into the surface so a split-tree
              // restructure (which remounts this pane) restores the page the
              // user was on instead of resetting to the default (issue #40).
              onUrlChange={(u) => {
                if (u && u !== 'about:blank') {
                  updateSurface(workspaceId, paneId, surface.id, { url: u });
                }
              }}
            />
          )}
          {surface.type === 'markdown' && <MarkdownPane surfaceId={surface.id} content={surface.markdownContent} />}
          {surface.type === 'diff' && <DiffPane surfaceId={surface.id} cwd={workspace?.cwd} />}
        </div>
      );
    });

  const handleNewSurface = () => {
    if (activeWorkspaceId) {
      addSurface(activeWorkspaceId, paneId, 'terminal');
    }
  };

  const handleNewSurfaceTyped = (type: 'terminal' | 'browser' | 'markdown') => {
    if (activeWorkspaceId) {
      addSurface(activeWorkspaceId, paneId, type);
    }
  };

  // Load project-level quick-launch profiles from <workspace cwd>/.wmux.json
  // (issue #32, mirrors cmux's cmux.json). Reloads when the workspace cwd changes.
  useEffect(() => {
    let cancelled = false;
    const dir = workspace?.cwd;
    if (!dir || !window.wmux?.config?.getProjectProfiles) {
      setProjectProfiles([]);
      return;
    }
    window.wmux.config.getProjectProfiles(dir)
      .then((profiles: QuickLaunchProfile[]) => {
        if (!cancelled) setProjectProfiles(Array.isArray(profiles) ? profiles : []);
      })
      .catch(() => { if (!cancelled) setProjectProfiles([]); });
    return () => { cancelled = true; };
  }, [workspace?.cwd]);

  // Fetch available shells once on mount for the shell picker dropdown
  useEffect(() => {
    window.wmux?.system?.getShells?.()
      .then((shells: ShellInfo[]) => setAvailableShells(Array.isArray(shells) ? shells : []))
      .catch(() => {});
  }, []);

  const handleNewSurfaceShell = (shell: ShellInfo) => {
    if (activeWorkspaceId) {
      addSurface(activeWorkspaceId, paneId, 'terminal', { shell: shell.command });
    }
  };

  const quickLaunchProfiles = useMemo(
    () => [
      ...globalProfiles.map((p) => ({ ...p, source: 'global' as const })),
      ...projectProfiles.map((p) => ({ ...p, source: 'project' as const })),
    ],
    [globalProfiles, projectProfiles],
  );

  const handleNewSurfaceProfile = (profile: QuickLaunchProfile) => {
    if (!activeWorkspaceId) return;
    // Relative profile cwd (e.g. "./server" in a project .wmux.json) resolves
    // against the workspace cwd; otherwise node-pty would resolve it against the
    // app directory. Absolute paths (drive-letter, UNC, or POSIX root) pass through.
    const resolveCwd = (cwd?: string): string | undefined => {
      if (!cwd) return undefined;
      const isAbsolute = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') || cwd.startsWith('/');
      const base = workspace?.cwd;
      if (isAbsolute || !base) return cwd;
      const rel = cwd.replace(/^[.][\\/]/, '').replace(/\//g, '\\');
      // Strip trailing separators without a regex (avoids ReDoS-class patterns).
      let trimmedBase = base;
      while (trimmedBase.length > 0 && (trimmedBase.endsWith('\\') || trimmedBase.endsWith('/'))) {
        trimmedBase = trimmedBase.slice(0, -1);
      }
      return trimmedBase + '\\' + rel;
    };
    addSurface(activeWorkspaceId, paneId, profile.type, {
      customTitle: profile.name,
      shell: profile.shell,
      cwd: resolveCwd(profile.cwd),
      startupCommands: profile.startupCommands,
      url: profile.url,
    });
  };

  const handleSelectSurface = (index: number) => {
    if (activeWorkspaceId) {
      selectSurface(activeWorkspaceId, paneId, index);
    }
  };

  const handleDropSurface = (sourcePaneId: PaneId, surfaceId: SurfaceId, targetPaneId: PaneId) => {
    if (!activeWorkspaceId || targetPaneId !== paneId || sourcePaneId === targetPaneId) {
      onSurfaceDragEnd();
      return;
    }

    const sourceLeaf = getSourceLeaf(sourcePaneId);
    if (!sourceLeaf?.surfaces.some((surface) => surface.id === surfaceId)) {
      onSurfaceDragEnd();
      return;
    }

    onSurfaceDragCommit({ clearZoom: sourceLeaf.surfaces.length === 1 });
    moveSurface(activeWorkspaceId, sourcePaneId, surfaceId, targetPaneId);
  };

  const handleCloseSurface = (surfaceId: SurfaceId) => {
    if (activeWorkspaceId) {
      // PTY teardown now lives in the store's closeSurface action (issue #65), so
      // every close route — this tab-× button, Ctrl+W, and `wmux close-surface` —
      // reaps the shell through the same chokepoint.
      closeSurface(activeWorkspaceId, paneId, surfaceId);
    }
  };

  const handleCloseOtherSurfaces = (surfaceId: SurfaceId) => {
    if (activeWorkspaceId) {
      closeOtherSurfaces(activeWorkspaceId, paneId, surfaceId);
    }
  };

  const handleCloseSurfacesToRight = (surfaceId: SurfaceId) => {
    if (activeWorkspaceId) {
      closeSurfacesToRight(activeWorkspaceId, paneId, surfaceId);
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

  const getSourceLeaf = (sourcePaneId: PaneId) => {
    const ws = activeWorkspaceId
      ? useStore.getState().workspaces.find(w => w.id === activeWorkspaceId)
      : undefined;
    return ws ? findLeaf(ws.splitTree, sourcePaneId) : undefined;
  };

  const getValidSurfaceDragData = (data: string): SurfaceDragData | null => {
    const parsed = parseSurfaceDragData(data);
    if (!parsed) return null;

    const sourceLeaf = getSourceLeaf(parsed.sourcePaneId);
    if (!sourceLeaf?.surfaces.some((surface) => surface.id === parsed.surfaceId)) {
      return null;
    }

    return parsed;
  };

  const handleEdgeDrop = (e: React.DragEvent, direction: 'left' | 'right' | 'up' | 'down') => {
    e.preventDefault();
    setDragActive(false);
    document.body.classList.remove('wmux-dragging');
    const data = e.dataTransfer.getData('application/wmux-surface');
    if (!data || !activeWorkspaceId) {
      onSurfaceDragEnd();
      return;
    }
    try {
      const dragData = getValidSurfaceDragData(data);
      if (!dragData) {
        onSurfaceDragEnd();
        return;
      }
      const { sourcePaneId, surfaceId } = dragData;
      const sourceLeaf = getSourceLeaf(sourcePaneId);
      if (!sourceLeaf) {
        onSurfaceDragEnd();
        return;
      }

      const decision = getSurfaceDragDropDecision({
        target: 'edge',
        sourcePaneId,
        targetPaneId: paneId,
        sourceSurfaceCount: sourceLeaf.surfaces.length,
      });

      if (decision.action === 'cancel') {
        onSurfaceDragEnd();
        return;
      }

      onSurfaceDragCommit(decision.commitOptions);
      splitAndMoveSurface(activeWorkspaceId, paneId, sourcePaneId, surfaceId, direction);
    } catch {
      onSurfaceDragEnd();
    }
  };

  const handleCenterDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    document.body.classList.remove('wmux-dragging');
    const data = e.dataTransfer.getData('application/wmux-surface');
    if (!data || !activeWorkspaceId) {
      onSurfaceDragEnd();
      return;
    }
    try {
      const dragData = getValidSurfaceDragData(data);
      if (!dragData) {
        onSurfaceDragEnd();
        return;
      }
      const { sourcePaneId, surfaceId } = dragData;
      const sourceLeaf = getSourceLeaf(sourcePaneId);
      if (!sourceLeaf) {
        onSurfaceDragEnd();
        return;
      }

      const decision = getSurfaceDragDropDecision({
        target: 'center',
        sourcePaneId,
        targetPaneId: paneId,
        sourceSurfaceCount: sourceLeaf.surfaces.length,
      });

      if (decision.action === 'cancel') {
        onSurfaceDragEnd();
        return;
      }

      onSurfaceDragCommit(decision.commitOptions);
      moveSurface(activeWorkspaceId, sourcePaneId, surfaceId, paneId);
    } catch {
      onSurfaceDragEnd();
    }
  };

  const handleDropZoneDragOver = (e: React.DragEvent, target: SurfaceDragPreviewTarget) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (!surfaceDrag) return;
    onSurfaceDragPreviewTarget(paneId, target);
  };

  const handleDropZonesDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const outside =
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom;

    if (outside) onClearSurfaceDragPreview();
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
        workspaceShell={workspace?.shell}
        surfaces={surfaces}
        activeSurfaceIndex={activeSurfaceIndex}
        onSelect={handleSelectSurface}
        onClose={handleCloseSurface}
        onCloseOthers={handleCloseOtherSurfaces}
        onCloseToRight={handleCloseSurfacesToRight}
        onNew={handleNewSurface}
        onNewTyped={handleNewSurfaceTyped}
        shells={availableShells}
        onNewShell={handleNewSurfaceShell}
        profiles={quickLaunchProfiles}
        onNewProfile={handleNewSurfaceProfile}
        onClosePane={handleClosePane}
        onSplitRight={handleSplitRight}
        onSplitDown={handleSplitDown}
        onDropSurface={handleDropSurface}
        onReorderSurface={handleReorderSurface}
        surfaceDrag={surfaceDrag}
        onSurfaceDragPreviewTarget={onSurfaceDragPreviewTarget}
        onClearSurfaceDragPreview={onClearSurfaceDragPreview}
        onSurfaceDragStart={(surfaceId) => onSurfaceDragStart({
          workspaceId,
          sourcePaneId: paneId,
          surfaceId,
        })}
        onSurfaceDragEnd={onSurfaceDragEnd}
        isDragActive={dragActive}
        isFocused={isFocused}
      />
      <div className="pane-wrapper__content">
        {renderAllSurfaces()}
        <NotificationRing visible={hasUnread} flashing={justFired} />
        <div
          className="pane-wrapper__unfocused-overlay"
          style={{ opacity: isFocused ? 0 : 1 }}
        />
        <div className="pane-wrapper__drop-zones" onDragLeave={handleDropZonesDragLeave}>
          <div className="pane-drop-zone pane-drop-zone--left" onDragOver={(e) => handleDropZoneDragOver(e, 'left')} onDrop={(e) => handleEdgeDrop(e, 'left')} />
          <div className="pane-drop-zone pane-drop-zone--right" onDragOver={(e) => handleDropZoneDragOver(e, 'right')} onDrop={(e) => handleEdgeDrop(e, 'right')} />
          <div className="pane-drop-zone pane-drop-zone--top" onDragOver={(e) => handleDropZoneDragOver(e, 'up')} onDrop={(e) => handleEdgeDrop(e, 'up')} />
          <div className="pane-drop-zone pane-drop-zone--bottom" onDragOver={(e) => handleDropZoneDragOver(e, 'down')} onDrop={(e) => handleEdgeDrop(e, 'down')} />
          <div className="pane-drop-zone pane-drop-zone--center" onDragOver={(e) => handleDropZoneDragOver(e, 'center')} onDrop={handleCenterDrop} />
        </div>
      </div>
    </div>
  );
}
