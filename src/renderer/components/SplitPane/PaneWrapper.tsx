import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { PaneId, SplitNode, SurfaceId, WorkspaceId, QuickLaunchProfile, ShellInfo, engineOf } from '../../../shared/types';
import { workspaceFallbackCwd } from '../../../shared/paths';
import { findLeaf, splitNode } from '../../store/split-utils';
import KeptAliveTerminal from '../Terminal/KeptAliveTerminal';
import BrowserPane from '../Browser/BrowserPane';
import MarkdownPane from '../Markdown/MarkdownPane';
import DiffPane from '../Diff/DiffPane';
import { worktreeDiffBase } from '../Diff/diff-base';
import CodePane from '../Code/CodePane';
import PromptsPane from '../Terminal/PromptsPane';
import GitPane from '../Git/GitPane';
import { gitRootFor } from '../Git/open-git';
import NotificationRing from '../Terminal/NotificationRing';
import SurfaceTabBar from './SurfaceTabBar';
import { useStore } from '../../store';
import { shouldRememberUrl } from '../../utils/browser-start-page';
import { activeHistoryUrl } from '../../../shared/browser-history';
import { keyDismissesAttention } from './attention-dismiss';
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
  /**
   * Focus this pane. The leaf's React onClick never sees a click on a terminal,
   * which is portalled from TerminalHost (#346), so the terminal slot calls it.
   */
  onActivate?: () => void;
  /** Focus another pane — the one a split from this pane's tab bar just created. */
  onFocusPane?: (paneId: PaneId) => void;
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
  onActivate,
  onFocusPane,
}: PaneWrapperProps) {
  const { surfaces, activeSurfaceIndex, paneId } = leaf;

  const notifications = useStore((s) => s.notifications);
  const markRead = useStore((s) => s.markRead);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const addSurface = useStore((s) => s.addSurface);
  const updateSurface = useStore((s) => s.updateSurface);
  const requestCloseSurface = useStore((s) => s.requestCloseSurface);
  const duplicateSurface = useStore((s) => s.duplicateSurface);
  const closeOtherSurfaces = useStore((s) => s.closeOtherSurfaces);
  const closeSurfacesToRight = useStore((s) => s.closeSurfacesToRight);
  const browserPrefs = useStore((s) => s.browserPrefs);
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

  // Root element — the attention ring's interaction listeners hang off it.
  const paneRef = useRef<HTMLDivElement>(null);

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

  const markPaneRead = useCallback(() => {
    for (const surfaceId of surfaceIds) markRead(surfaceId as SurfaceId);
  }, [surfaceIds, markRead]);

  // Arrival-time focus is handled by addNotification. Keep this keyed only on
  // focus transitions so hidden-tab alerts remain unread until acknowledged.
  // Keyboard pane navigation lands no interaction inside the destination pane.
  useEffect(() => {
    if (isFocused && hasUnread) markPaneRead();
  }, [isFocused]);

  // ...and clear it on actual INTERACTION, which is the case focus alone misses.
  //
  // Notifications from hidden tabs or an inactive window can still be unread
  // when the pane is already focused; the next interaction acknowledges them.
  //
  // Capture phase is load-bearing for keydown: xterm's hidden helper textarea is
  // a descendant of this element and consumes the event, so a bubble-phase
  // listener here would never see a keystroke — only clicks would dismiss, and
  // typing (the exact case reported) still would not.
  //
  // Attached only while there is something to dismiss, so the common case costs
  // no listeners at all.
  useEffect(() => {
    const el = paneRef.current;
    if (!hasUnread || !el) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (keyDismissesAttention(e.key)) markPaneRead();
    };
    el.addEventListener('keydown', onKeyDown, true);
    el.addEventListener('mousedown', markPaneRead, true);
    return () => {
      el.removeEventListener('keydown', onKeyDown, true);
      el.removeEventListener('mousedown', markPaneRead, true);
    };
  }, [hasUnread, markPaneRead]);

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
            // The terminal itself lives in TerminalHost and survives this pane
            // remounting (#346); this is only the slot it is shown in.
            <KeptAliveTerminal
              surfaceId={surface.id}
              onActivate={onActivate}
              shell={surface.shell || workspace?.shell}
              cwd={surface.cwd || workspaceFallbackCwd(surface.shell || workspace?.shell, workspace)}
              colorScheme={surface.colorScheme}
              startupCommands={surface.startupCommands}
              env={surface.env}
              claudeSessionId={surface.claudeSessionId}
              codexSessionId={surface.codexSessionId}
              opencodeSessionId={surface.opencodeSessionId}
              agySessionId={surface.agySessionId}
              qwenSessionId={surface.qwenSessionId}
              ompSessionId={surface.ompSessionId}
              piSessionFile={surface.piSessionFile}
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
              // The layer above hides it; BrowserPane needs to know so a pane
              // an agent drives can keep painting meanwhile.
              visible={isVisible}
              onActivate={onActivate}
              focused={isFocused && isActive}
              // Remembered page, then the configured Start page, then blank.
              // The Start page link is new in #232: a browser TAB used to skip
              // `browserPrefs.defaultUrl` entirely and go straight to
              // BrowserPane's default, so a user who had set a start page still
              // got the vendor's GitHub repo in every tab they opened.
              //
              // No vendor filtering here, unlike the panel — see
              // utils/browser-start-page.ts. A tab's url is written directly by
              // openInWmuxBrowser when the user clicks a link, so filtering it
              // would blank a pane opened on wmux's own issue tracker on purpose.
              {...(surface.url || browserPrefs.defaultUrl
                ? { initialUrl: surface.url || browserPrefs.defaultUrl }
                : {})}
              // Read through engineOf, never off the raw field: the session
              // file is user-editable, so a corrupt value has to degrade to
              // `web` here exactly as it does in main (v2-browser) and in the
              // pipe bridge.
              engine={engineOf(surface)}
              onEngineChange={(e) =>
                updateSurface(workspaceId, paneId, surface.id, { browserEngine: e })}
              // Persist the live URL into the surface so a split-tree
              // restructure (which remounts this pane) restores the page the
              // user was on instead of resetting to the default (issue #40).
              onUrlChange={(u) => {
                if (shouldRememberUrl(u)) {
                  updateSurface(workspaceId, paneId, surface.id, { url: u });
                }
              }}
              // Back/Forward across that same remount, and across a restart
              // (#315). Same guard as the URL: a stack whose page would not be
              // remembered is not remembered either.
              initialHistory={surface.browserHistory}
              onHistoryChange={(history) => {
                if (shouldRememberUrl(activeHistoryUrl(history))) {
                  updateSurface(workspaceId, paneId, surface.id, { browserHistory: history });
                }
              }}
            />
          )}
          {surface.type === 'markdown' && (
            <MarkdownPane
              surfaceId={surface.id}
              content={surface.markdownContent}
              filePath={surface.markdownFilePath}
              viewMode={surface.markdownViewMode}
              cwd={workspace?.cwd}
              fileMtime={surface.markdownFileMtime}
              dirty={surface.markdownDirty}
              // All of these persist onto the surface (issue #116) so they
              // survive the remount that a split-tree restructure causes,
              // exactly like markdownContent itself.
              onViewModeChange={(mode) =>
                updateSurface(workspaceId, paneId, surface.id, { markdownViewMode: mode })}
              onFileLoaded={({ content, filePath, fileName, mtimeMs }) =>
                updateSurface(workspaceId, paneId, surface.id, {
                  markdownContent: content,
                  markdownFilePath: filePath,
                  markdownFileName: fileName,
                  markdownFileMtime: mtimeMs,
                  // A load from disk IS what is on disk, so the buffer is clean
                  // again — this is also what makes "Discard changes" work.
                  markdownDirty: false,
                })}
              onEdit={(next) =>
                updateSurface(workspaceId, paneId, surface.id, {
                  markdownContent: next,
                  markdownDirty: true,
                })}
              onSaved={({ filePath, fileName, mtimeMs }) =>
                updateSurface(workspaceId, paneId, surface.id, {
                  markdownFilePath: filePath,
                  markdownFileName: fileName,
                  markdownFileMtime: mtimeMs,
                  markdownDirty: false,
                })}
            />
          )}
          {/* A tab opened from the explorer is pinned to the explorer's root
              (#325); one made by Ctrl+Shift+G follows the workspace. A
              worktree workspace's base applies only inside its worktree. */}
          {surface.type === 'diff' && (
            <DiffPane
              surfaceId={surface.id}
              cwd={surface.cwd ?? workspace?.cwd}
              baseRef={worktreeDiffBase(surface.cwd ?? workspace?.cwd, workspace?.worktree)}
            />
          )}
          {surface.type === 'code' && <CodePane surfaceId={surface.id} />}
          {surface.type === 'prompts' && <PromptsPane surfaceId={surface.id} />}
          {/* Pinned to its own folder (#362): it never follows focus. */}
          {surface.type === 'git' && (
            <GitPane
              surfaceId={surface.id}
              cwd={surface.cwd ?? workspace?.cwd}
              surface={surface}
              onPatch={(patch) => updateSurface(workspaceId, paneId, surface.id, patch)}
            />
          )}
        </div>
      );
    });

  const handleNewSurface = () => {
    if (activeWorkspaceId) {
      addSurface(activeWorkspaceId, paneId, 'terminal');
    }
  };

  const handleNewSurfaceTyped = (type: 'terminal' | 'browser' | 'markdown' | 'prompts' | 'git') => {
    if (activeWorkspaceId) {
      // A Git tab pins the folder it opens on (#362) — this pane's terminal.
      const gitRoot = type === 'git' && workspace ? gitRootFor(workspace, paneId) : undefined;
      addSurface(activeWorkspaceId, paneId, type, gitRoot ? { cwd: gitRoot } : undefined);
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
      // The profile's name is the tab's DEFAULT, not a rename (#291): a program
      // that sets its own window title takes the label over.
      defaultTitle: profile.name,
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
      // PTY teardown lives in the store's closeSurface action (issue #65), so
      // every close route — this tab-× button, Ctrl+W, and `wmux close-surface` —
      // reaps the shell through the same chokepoint. User gestures go through
      // requestCloseSurface first, which stops to confirm when the tab holds
      // unsaved markdown edits (issue #116, F3).
      requestCloseSurface(activeWorkspaceId, paneId, surfaceId);
    }
  };

  const handleDuplicateSurface = () => {
    const active = surfaces[activeSurfaceIndex];
    if (activeWorkspaceId && active) {
      duplicateSurface(activeWorkspaceId, paneId, active.id);
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

  const splitAndFocus = (direction: 'horizontal' | 'vertical') => {
    if (!activeWorkspaceId) return;
    const { workspaces, updateSplitTree } = useStore.getState();
    const ws = workspaces.find(w => w.id === activeWorkspaceId);
    if (ws) {
      const newPaneId = `pane-${crypto.randomUUID()}` as PaneId;
      const newTree = splitNode(ws.splitTree, paneId, newPaneId, 'terminal', direction);
      if (newTree === ws.splitTree) return; // pane not in the tree: no split, nothing to focus
      updateSplitTree(activeWorkspaceId, newTree);
      // Deferred, not called inline: the button's click goes on to bubble up to
      // the leaf's onClick in SplitContainer (the layout menu too — portals
      // bubble through the React tree), which focuses THIS pane. Both updates
      // land in one batch and the last one wins, so an inline call would hand
      // focus straight back to the pane that was split.
      queueMicrotask(() => onFocusPane?.(newPaneId));
    }
  };

  const handleSplitRight = () => splitAndFocus('horizontal');
  const handleSplitDown = () => splitAndFocus('vertical');

  const handleClosePane = () => {
    if (!activeWorkspaceId) return;
    // Reaping and tree surgery both live in the store action now — this button,
    // `wmux close-pane` and closeSurface's last-tab path had each grown their own
    // copy, and all three killed the shells before discovering they were not
    // going to remove anything (a one-pane workspace). See surface-slice.closePane.
    useStore.getState().closePane(activeWorkspaceId, paneId);
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
    <div
      ref={paneRef}
      data-pane-id={paneId}
      className={`pane-wrapper ${isFocused ? 'pane-wrapper--focused' : ''} ${dragActive ? 'pane-wrapper--drag-active' : ''}`}
    >
      <SurfaceTabBar
        paneId={paneId}
        workspaceShell={workspace?.shell}
        surfaces={surfaces}
        activeSurfaceIndex={activeSurfaceIndex}
        onSelect={handleSelectSurface}
        onClose={handleCloseSurface}
        onDuplicate={handleDuplicateSurface}
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
