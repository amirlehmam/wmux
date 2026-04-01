import React, { useEffect, useState, useCallback, useRef } from 'react';
import { v4 as uuid } from 'uuid';
import { useStore } from './store';
import { PaneId, SurfaceId, WorkspaceId, WorkspaceInfo, SplitNode } from '../shared/types';
import SplitContainer from './components/SplitPane/SplitContainer';
import { updateRatio, getAllPaneIds, findLeaf } from './store/split-utils';
import Sidebar from './components/Sidebar/Sidebar';
import Titlebar from './components/Titlebar/Titlebar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import SettingsWindow from './components/Settings/SettingsWindow';
import CommandPalette from './components/CommandPalette/CommandPalette';
import BrowserPane from './components/Browser/BrowserPane';
import Tutorial from './components/Tutorial/Tutorial';

const DEFAULT_SIDEBAR_WIDTH = 240;

/** Get all surface IDs from a split tree */
function getAllSurfaces(tree: SplitNode): string[] {
  if (tree.type === 'leaf') return tree.surfaces.map(s => s.id);
  return [...getAllSurfaces(tree.children[0]), ...getAllSurfaces(tree.children[1])];
}

function findLeafFromTree(node: SplitNode, paneId: PaneId): (SplitNode & { type: 'leaf' }) | null {
  if (node.type === 'leaf') return node.paneId === paneId ? node : null;
  return findLeafFromTree(node.children[0], paneId) || findLeafFromTree(node.children[1], paneId);
}

/** Find the bottom-most pane in the split tree (follows last child of vertical splits) */
function findBottomPane(node: SplitNode): PaneId | null {
  if (node.type === 'leaf') return node.paneId;
  if (node.direction === 'vertical') return findBottomPane(node.children[1]);
  return findBottomPane(node.children[0]);
}

/** Build the default 3-terminal split layout for new workspaces */
function buildDefaultSplitTree(): SplitNode {
  return {
    type: 'branch',
    direction: 'vertical',
    ratio: 0.5,
    children: [
      {
        type: 'branch',
        direction: 'horizontal',
        ratio: 0.5,
        children: [
          {
            type: 'leaf',
            paneId: `pane-${uuid()}` as PaneId,
            surfaces: [{ id: `surf-${uuid()}` as SurfaceId, type: 'terminal' }],
            activeSurfaceIndex: 0,
          },
          {
            type: 'leaf',
            paneId: `pane-${uuid()}` as PaneId,
            surfaces: [{ id: `surf-${uuid()}` as SurfaceId, type: 'terminal' }],
            activeSurfaceIndex: 0,
          },
        ],
      },
      {
        type: 'leaf',
        paneId: `pane-${uuid()}` as PaneId,
        surfaces: [{ id: `surf-${uuid()}` as SurfaceId, type: 'terminal' }],
        activeSurfaceIndex: 0,
      },
    ],
  };
}

export default function App() {
  const {
    workspaces,
    activeWorkspaceId,
    createWorkspace,
    closeWorkspace,
    selectWorkspace,
    renameWorkspace,
    reorderWorkspaces,
    updateWorkspaceMetadata,
    updateSplitTree,
    sidebarVisible,
    shortcuts,
    notifications,
    markRead,
    markAllRead,
    selectSurface,
    setAgentMeta,
    addNotification,
    toggleSidebar,
  } = useStore();

  const [focusedPaneId, setFocusedPaneId] = useState<PaneId | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [browserWidth, setBrowserWidth] = useState(420);
  const [isResizingBrowser, setIsResizingBrowser] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  // Per-workspace hook activity: workspaceId → { lastTool, toolCount, lastSeen }
  const [hookActivity, setHookActivity] = useState<Record<string, { lastTool: string; toolCount: number; lastSeen: number }>>({});
  // Per-surface Claude activity (parsed from terminal output)
  const [claudeActivity, setClaudeActivity] = useState<Record<string, any>>({});
  // Track when each workspace entered "running" state (for notification threshold)
  const runningStartTimes = useRef<Record<string, number>>({});
  // Browser URL tracking is now per-workspace via WorkspaceInfo.browserUrl

  // Global keyboard listener for command palette toggle (Ctrl+Shift+P)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const binding = shortcuts.commandPalette;
      const matches =
        e.key === binding.key &&
        !!binding.ctrl === e.ctrlKey &&
        !!binding.shift === e.shiftKey &&
        !!binding.alt === e.altKey;

      if (matches) {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
        return;
      }

      // Also close palette on Escape when open
      if (e.key === 'Escape' && commandPaletteOpen) {
        setCommandPaletteOpen(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, commandPaletteOpen]);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);

  // Open tutorial on first launch
  useEffect(() => {
    if (!localStorage.getItem('wmux-tutorial-seen')) {
      setTutorialOpen(true);
    }
  }, []);

  const handleTutorialClose = useCallback(() => {
    localStorage.setItem('wmux-tutorial-seen', '1');
    setTutorialOpen(false);
  }, []);

  // Initialize workspaces: try loading saved session first, then create default
  useEffect(() => {
    (async () => {
      try {
        const sessions = await window.wmux?.session?.list();
        if (sessions && sessions.length > 0) {
          const session = await window.wmux?.session?.load(sessions[0].name);
          if (session) {
            const { replaceAllWorkspaces } = useStore.getState();
            replaceAllWorkspaces(session.workspaces);
            if (session.sidebarWidth) setSidebarWidth(session.sidebarWidth);
            return;
          }
        }
      } catch {}
      // No saved session — create default workspace
      if (useStore.getState().workspaces.length === 0) {
        createWorkspace({
          title: 'Session 1',
          splitTree: buildDefaultSplitTree(),
        });
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Expose helpers for main process queries
  useEffect(() => {
    (window as any).__wmux_getActiveWorkspaceId = () => useStore.getState().activeWorkspaceId;
    (window as any).__wmux_getPaneLoads = () => {
      const state = useStore.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (!ws) return [];
      return getAllPaneIds(ws.splitTree).map((pid) => {
        const leaf = findLeafFromTree(ws.splitTree, pid);
        return { paneId: pid, tabCount: leaf ? leaf.surfaces.length : 0 };
      });
    };
    return () => {
      delete (window as any).__wmux_getActiveWorkspaceId;
      delete (window as any).__wmux_getPaneLoads;
    };
  }, []);

  // Listen for agent spawn events from main process
  useEffect(() => {
    if (!window.wmux?.agent?.onUpdate) return;
    const unsub = window.wmux.agent.onUpdate((event: any) => {
      if (event.type === 'spawned') {
        const { surfaceId, paneId, workspaceId, label } = event;
        const state = useStore.getState();
        const ws = state.workspaces.find((w) => w.id === workspaceId);
        if (!ws) return;

        const addSurfaceToLeaf = (node: SplitNode): SplitNode => {
          if (node.type === 'leaf' && node.paneId === paneId) {
            return { ...node, surfaces: [...node.surfaces, { id: surfaceId, type: 'terminal' }], activeSurfaceIndex: node.surfaces.length };
          }
          if (node.type === 'branch') {
            return { ...node, children: [addSurfaceToLeaf(node.children[0]), addSurfaceToLeaf(node.children[1])] as [SplitNode, SplitNode] };
          }
          return node;
        };
        state.updateSplitTree(workspaceId, addSurfaceToLeaf(ws.splitTree));
        setAgentMeta(surfaceId, { agentId: event.agentId, label, status: 'running' });
      }
    });
    return unsub;
  }, [setAgentMeta]);

  // Listen for real-time metadata updates from shell integration (pipe server → IPC → here)
  useEffect(() => {
    if (!window.wmux?.metadata?.onUpdate) return;
    const unsub = window.wmux.metadata.onUpdate((cmd: any) => {
      if (!cmd) return;

      // ports_update has no surfaceId — handle globally
      if (cmd.command === 'ports_update') {
        try {
          const portsByPid = JSON.parse(cmd.args?.[0] || '{}');
          const allPorts = Object.values(portsByPid).flat() as number[];
          // Only keep dev-relevant ports — ignore ephemeral system ports
          const DEV_PORTS = [3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8888];
          const devPorts = allPorts.filter((p: number) => DEV_PORTS.includes(p));
          if (devPorts.length > 0) {
            const port = devPorts[0];
            // Navigate browser to first detected dev port
            const currentWs = useStore.getState().activeWorkspaceId;
            if (currentWs) {
              const ws = useStore.getState().workspaces.find(w => w.id === currentWs);
              const prevPorts = ws?.ports || [];
              // Only auto-navigate if this is a NEW port (not already known)
              if (!prevPorts.includes(port)) {
                window.wmux?.browser?.navigate?.('', `http://localhost:${port}`);
              }
            }
          }
          // Only store dev-relevant ports in workspace metadata (not system ports)
          for (const ws of useStore.getState().workspaces) {
            updateWorkspaceMetadata(ws.id, { ports: devPorts.length > 0 ? devPorts : undefined });
          }
        } catch {}
        return;
      }

      if (!cmd.surfaceId) return;
      // Find which workspace owns this surface
      for (const ws of useStore.getState().workspaces) {
        const allSurfaces = getAllSurfaces(ws.splitTree);
        if (allSurfaces.includes(cmd.surfaceId)) {
          switch (cmd.command) {
            case 'report_pwd':
              updateWorkspaceMetadata(ws.id, { cwd: cmd.args?.[0] });
              break;
            case 'report_git_branch': {
              const branch = cmd.args?.[0];
              const dirty = cmd.args?.[1] === 'dirty';
              updateWorkspaceMetadata(ws.id, { gitBranch: branch, gitDirty: dirty });
              break;
            }
            case 'clear_git_branch':
              updateWorkspaceMetadata(ws.id, { gitBranch: undefined, gitDirty: undefined });
              break;
            case 'report_pr': {
              const [num, status, ...labelParts] = cmd.args || [];
              updateWorkspaceMetadata(ws.id, {
                prNumber: num ? parseInt(num) : undefined,
                prStatus: status as any,
                prLabel: labelParts.join(' '),
              });
              break;
            }
            case 'clear_pr':
              updateWorkspaceMetadata(ws.id, { prNumber: undefined, prStatus: undefined, prLabel: undefined });
              break;
            case 'report_shell_state': {
              const newState = cmd.args?.[0] as 'idle' | 'running' | 'interrupted';
              const prevState = ws.shellState;
              updateWorkspaceMetadata(ws.id, { shellState: newState });

              // Track when command started running
              if (newState === 'running') {
                runningStartTimes.current[ws.id] = Date.now();
              }

              // Only notify for commands that ran longer than 5 seconds
              if (prevState === 'running' && (newState === 'idle' || newState === 'interrupted')) {
                const startTime = runningStartTimes.current[ws.id];
                const elapsed = startTime ? (Date.now() - startTime) / 1000 : 0;
                delete runningStartTimes.current[ws.id];

                if (elapsed >= 5) {
                  const duration = elapsed >= 60
                    ? `${Math.floor(elapsed / 60)}m${Math.round(elapsed % 60)}s`
                    : `${Math.round(elapsed)}s`;
                  const msg = newState === 'interrupted'
                    ? `Interrupted in ${ws.title} (${duration})`
                    : `Finished in ${ws.title} (${duration})`;
                  addNotification({
                    surfaceId: cmd.surfaceId as SurfaceId,
                    workspaceId: ws.id,
                    text: msg,
                  });
                  window.wmux?.notification?.fire({
                    surfaceId: cmd.surfaceId,
                    text: msg,
                    title: 'wmux',
                  });
                }
              }
              break;
            }
          }
          break;
        }
      }
    });
    return unsub;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for Claude Code hook events — tie to active workspace
  // Also auto-create diff surface when Edit/Write tools fire
  useEffect(() => {
    if (!window.wmux?.hook?.onEvent) return;
    const unsub = window.wmux.hook.onEvent((event: any) => {
      if (!event?.tool) return;
      const state = useStore.getState();
      const wsId = state.activeWorkspaceId;
      if (!wsId) return;

      // Track hook activity for sidebar display
      setHookActivity(prev => {
        const existing = prev[wsId] || { lastTool: '', toolCount: 0, lastSeen: 0 };
        return {
          ...prev,
          [wsId]: {
            lastTool: event.tool,
            toolCount: existing.toolCount + 1,
            lastSeen: Date.now(),
          },
        };
      });

      // Auto-open diff tab in the BOTTOM pane when Claude edits/writes files
      if ((event.tool === 'Edit' || event.tool === 'Write') && event.file) {
        const ws = state.workspaces.find(w => w.id === wsId);
        if (ws) {
          const bottomPaneId = findBottomPane(ws.splitTree);
          if (bottomPaneId) {
            const bottomLeaf = findLeafFromTree(ws.splitTree, bottomPaneId);
            // Only add diff tab if bottom pane doesn't already have one
            if (bottomLeaf && !bottomLeaf.surfaces.some(s => s.type === 'diff')) {
              state.addSurface(wsId, bottomPaneId, 'diff');
            }
          }
        }
      }
    });
    return unsub;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear stale hook activity after 4 seconds of no hooks.
  // Runs every 2 seconds for responsive cleanup — tool labels disappear
  // quickly once Claude stops using tools, instead of lingering for 10+ seconds.
  useEffect(() => {
    const timer = setInterval(() => {
      setHookActivity(prev => {
        if (Object.keys(prev).length === 0) return prev;
        const now = Date.now();
        const next: typeof prev = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (now - v.lastSeen < 4000) {
            next[k] = v;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for Claude Code activity parsed from terminal output
  useEffect(() => {
    if (!window.wmux?.claudeActivity?.onUpdate) return;
    const unsub = window.wmux.claudeActivity.onUpdate((data: any) => {
      if (!data?.surfaceId || !data?.activity) return;
      setClaudeActivity(prev => ({ ...prev, [data.surfaceId]: data.activity }));
    });
    return unsub;
  }, []);

  // Respond to main process auto-save requests (30s timer + on quit)
  useEffect(() => {
    if (!window.wmux?.session?.onAutoSaveRequest) return;
    const unsub = window.wmux.session.onAutoSaveRequest(() => {
      const state = useStore.getState();
      const data = {
        version: 1,
        windows: [{
          bounds: { x: 0, y: 0, width: 0, height: 0 }, // main process fills real bounds
          sidebarWidth,
          activeWorkspaceId: state.activeWorkspaceId,
          workspaces: state.workspaces.map(ws => ({
            id: ws.id,
            title: ws.title,
            customColor: ws.customColor,
            pinned: ws.pinned,
            shell: ws.shell,
            splitTree: ws.splitTree,
          })),
        }],
      };
      window.wmux.session.pushAutoSave(data);
    });
    return unsub;
  }, [sidebarWidth]);

  // Auto-focus first pane whenever the active workspace changes or gains its first pane
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  useEffect(() => {
    if (!activeWorkspace) return;
    const paneIds = getAllPaneIds(activeWorkspace.splitTree);
    if (paneIds.length > 0 && (focusedPaneId === null || !paneIds.includes(focusedPaneId))) {
      setFocusedPaneId(paneIds[0]);
    }
  }, [activeWorkspace?.id, activeWorkspace?.splitTree]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRatioChange = useCallback(
    (leftPaneId: PaneId, rightPaneId: PaneId, ratio: number) => {
      if (!activeWorkspace) return;
      const newTree = updateRatio(activeWorkspace.splitTree, leftPaneId, rightPaneId, ratio);
      updateSplitTree(activeWorkspace.id, newTree);
    },
    [activeWorkspace, updateSplitTree],
  );

  const handlePaneFocus = useCallback((paneId: PaneId) => {
    setFocusedPaneId(paneId);
  }, []);

  const handleSidebarWidthChange = useCallback((newWidth: number) => {
    setSidebarWidth(newWidth);
  }, []);

  const handleCreateWorkspace = useCallback(() => {
    const wsCount = useStore.getState().workspaces.length;
    const newId = createWorkspace({
      title: `Session ${wsCount + 1}`,
      splitTree: buildDefaultSplitTree(),
    });
    selectWorkspace(newId);
  }, [createWorkspace, selectWorkspace]);

  const handleSaveSession = useCallback(async (name: string) => {
    const state = useStore.getState();
    const session = {
      name,
      savedAt: Date.now(),
      workspaces: state.workspaces.map(ws => ({
        title: ws.title,
        customColor: ws.customColor,
        shell: ws.shell,
        cwd: ws.cwd || '',
        splitTree: ws.splitTree,
        browserUrl: ws.browserUrl || '',
      })),
      sidebarWidth,
    };
    await window.wmux?.session?.save(session);
    window.wmux?.notification?.fire({ surfaceId: '', text: `Session "${name}" saved`, title: 'wmux' });
  }, [sidebarWidth]);

  const handleLoadSession = useCallback(async (name: string) => {
    const session = await window.wmux?.session?.load(name);
    if (!session) return;
    const { replaceAllWorkspaces } = useStore.getState();
    replaceAllWorkspaces(session.workspaces);
    if (session.sidebarWidth) setSidebarWidth(session.sidebarWidth);
  }, []);

  const handleUpdateMetadata = useCallback(
    (id: WorkspaceId, partial: Partial<WorkspaceInfo>) => {
      updateWorkspaceMetadata(id, partial);
    },
    [updateWorkspaceMetadata],
  );

  const handlePaletteClose = useCallback(() => {
    setCommandPaletteOpen(false);
  }, []);

  const handlePaletteAction = useCallback((action: string) => {
    console.log(`[wmux] Command palette action: ${action}`);
    setCommandPaletteOpen(false);
  }, []);

  const workspaceNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of workspaces) map.set(ws.id, ws.title);
    return map;
  }, [workspaces]);

  const handleNotificationJump = useCallback(
    (workspaceId: WorkspaceId, surfaceId: SurfaceId, _paneId?: PaneId) => {
      selectWorkspace(workspaceId);
      const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      function findPaneForSurface(node: SplitNode): { paneId: PaneId; index: number } | null {
        if (node.type === 'leaf') {
          const idx = node.surfaces.findIndex((s) => s.id === surfaceId);
          if (idx !== -1) return { paneId: node.paneId, index: idx };
          return null;
        }
        return findPaneForSurface(node.children[0]) || findPaneForSurface(node.children[1]);
      }
      const found = findPaneForSurface(ws.splitTree);
      if (found) {
        setFocusedPaneId(found.paneId);
        selectSurface(workspaceId, found.paneId, found.index);
      }
      markRead(surfaceId);
    },
    [selectWorkspace, markRead, selectSurface],
  );

  const handleToggleNotifPanel = useCallback(() => {
    setNotifPanelOpen((o) => !o);
  }, []);

  useKeyboardShortcuts(focusedPaneId, setSettingsOpen, () => setBrowserOpen(o => !o), handleToggleNotifPanel);

  // Derive a title for the titlebar: active workspace title or blank
  const titlebarText = activeWorkspace?.title ?? '';

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {tutorialOpen && <Tutorial onClose={handleTutorialClose} />}
      {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />}
      <Titlebar
        title={titlebarText}
        onHelpClick={() => setTutorialOpen(true)}
        onDevToolsClick={() => window.wmux?.system?.toggleDevTools?.()}
        notifications={notifications}
        workspaceNames={workspaceNames}
        notificationPanelOpen={notifPanelOpen}
        onToggleNotificationPanel={handleToggleNotifPanel}
        onNotificationJump={handleNotificationJump}
        onMarkAllNotificationsRead={() => markAllRead()}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {sidebarVisible && (
          <Sidebar
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            sidebarWidth={sidebarWidth}
            onWidthChange={handleSidebarWidthChange}
            onSelect={selectWorkspace}
            onClose={closeWorkspace}
            onCreate={handleCreateWorkspace}
            onRename={renameWorkspace}
            onReorder={reorderWorkspaces}
            onUpdateMetadata={handleUpdateMetadata}
            hookActivity={hookActivity}
            claudeActivity={claudeActivity}
            onSaveSession={handleSaveSession}
            onLoadSession={handleLoadSession}
            onCollapse={toggleSidebar}
          />
        )}

        {/* Middle: terminals — ALL workspaces stay mounted, only active is visible */}
        {/* This keeps PTYs alive when switching sessions (Claude Code etc. keep running) */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minWidth: 0 }}>
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              style={{
                position: 'absolute',
                inset: 0,
                visibility: ws.id === activeWorkspaceId ? 'visible' : 'hidden',
                pointerEvents: ws.id === activeWorkspaceId ? 'auto' : 'none',
              }}
            >
              <SplitContainer
                node={ws.splitTree}
                workspaceId={ws.id}
                focusedPaneId={ws.id === activeWorkspaceId ? focusedPaneId : null}
                onRatioChange={ws.id === activeWorkspaceId ? handleRatioChange : undefined}
                onPaneFocus={handlePaneFocus}
              />
            </div>
          ))}
        </div>

        {/* Right: browser panel */}
        {browserOpen && (
          <>
            <div
              style={{
                width: 4,
                cursor: 'col-resize',
                flexShrink: 0,
                position: 'relative',
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingBrowser(true);
                const startX = e.clientX;
                const startWidth = browserWidth;
                const onMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  setBrowserWidth(Math.max(250, Math.min(800, startWidth + delta)));
                };
                const onUp = () => {
                  setIsResizingBrowser(false);
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
            >
              <div style={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: 1,
                background: 'rgba(255,255,255,0.04)',
                transform: 'translateX(-50%)',
              }} />
            </div>
            <div style={{ width: browserWidth, flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
              {isResizingBrowser && (
                <div style={{
                  position: 'absolute', inset: 0, zIndex: 10,
                  cursor: 'col-resize', background: 'transparent',
                }} />
              )}
              {/* Browser close button */}
              <button
                onClick={() => setBrowserOpen(false)}
                style={{
                  position: 'absolute', top: 6, right: 8, zIndex: 20,
                  background: 'rgba(0,0,0,0.5)', border: 'none', color: '#999',
                  cursor: 'pointer', fontSize: 14, padding: '2px 6px', lineHeight: 1,
                  borderRadius: 3, backdropFilter: 'blur(4px)',
                }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.color = '#fff'; (e.target as HTMLElement).style.background = 'rgba(220,50,50,0.7)'; }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.color = '#999'; (e.target as HTMLElement).style.background = 'rgba(0,0,0,0.5)'; }}
                title="Close browser panel"
              >×</button>
              {/* Per-workspace browser — all stay mounted, only active visible */}
              {workspaces.map((ws) => (
                <div
                  key={`browser-${ws.id}`}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: ws.id === activeWorkspaceId ? 'block' : 'none',
                  }}
                >
                  <BrowserPane
                    surfaceId={`browser-${ws.id}`}
                    initialUrl={ws.browserUrl}
                    onUrlChange={(url) => { updateWorkspaceMetadata(ws.id, { browserUrl: url }); }}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {commandPaletteOpen && (
        <CommandPalette
          onClose={handlePaletteClose}
          onAction={handlePaletteAction}
        />
      )}
    </div>
  );
}
