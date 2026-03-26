import React, { useEffect, useState, useCallback } from 'react';
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
  } = useStore();

  const [focusedPaneId, setFocusedPaneId] = useState<PaneId | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [browserWidth, setBrowserWidth] = useState(420);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  // Per-workspace hook activity: workspaceId → { agents: count, tools: count, lastSeen }
  const [hookActivity, setHookActivity] = useState<Record<string, { agents: number; tools: number; lastSeen: number }>>({});
  // Per-surface Claude activity (parsed from terminal output)
  const [claudeActivity, setClaudeActivity] = useState<Record<string, any>>({});;

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

  // Create first workspace on launch
  useEffect(() => {
    if (workspaces.length === 0) {
      createWorkspace({
        title: 'Session 1',
        splitTree: buildDefaultSplitTree(),
      });
    }
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
      if (!cmd || !cmd.surfaceId) return;
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

              // Auto-notify on state transitions from running
              if (prevState === 'running' && (newState === 'idle' || newState === 'interrupted')) {
                const msg = newState === 'interrupted'
                  ? `Interrupted in ${ws.title}`
                  : `Finished in ${ws.title}`;
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
  useEffect(() => {
    if (!window.wmux?.hook?.onEvent) return;
    const unsub = window.wmux.hook.onEvent((event: any) => {
      if (!event?.tool) return;
      const wsId = useStore.getState().activeWorkspaceId;
      if (!wsId) return;
      setHookActivity(prev => {
        const existing = prev[wsId] || { agents: 0, tools: 0, lastSeen: 0 };
        return {
          ...prev,
          [wsId]: {
            agents: event.tool === 'Agent' ? existing.agents + 1 : existing.agents,
            tools: existing.tools + 1,
            lastSeen: Date.now(),
          },
        };
      });
    });
    return unsub;
  }, []);

  // Clear stale activity after 10 seconds of no hooks
  useEffect(() => {
    if (Object.keys(hookActivity).length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setHookActivity(prev => {
        const next: typeof prev = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (now - v.lastSeen < 10000) {
            next[k] = v;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [hookActivity]);

  // Listen for Claude Code activity parsed from terminal output
  useEffect(() => {
    if (!window.wmux?.claudeActivity?.onUpdate) return;
    const unsub = window.wmux.claudeActivity.onUpdate((data: any) => {
      if (!data?.surfaceId || !data?.activity) return;
      setClaudeActivity(prev => ({ ...prev, [data.surfaceId]: data.activity }));
    });
    return unsub;
  }, []);

  // Auto-focus first pane whenever the active workspace changes or gains its first pane
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  useEffect(() => {
    if (!activeWorkspace) return;
    const paneIds = getAllPaneIds(activeWorkspace.splitTree);
    if (paneIds.length > 0 && (focusedPaneId === null || !paneIds.includes(focusedPaneId))) {
      setFocusedPaneId(paneIds[0]);
    }
  }, [activeWorkspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
          />
        )}

        {/* Middle: terminals — ALL workspaces stay mounted, only active is visible */}
        {/* This keeps PTYs alive when switching sessions (Claude Code etc. keep running) */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              style={{
                position: 'absolute',
                inset: 0,
                display: ws.id === activeWorkspaceId ? 'block' : 'none',
              }}
            >
              <SplitContainer
                node={ws.splitTree}
                focusedPaneId={ws.id === activeWorkspaceId ? focusedPaneId : null}
                onRatioChange={(left, right, ratio) => {
                  const newTree = updateRatio(ws.splitTree, left, right, ratio);
                  updateSplitTree(ws.id, newTree);
                }}
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
                const startX = e.clientX;
                const startWidth = browserWidth;
                const onMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  setBrowserWidth(Math.max(250, Math.min(800, startWidth + delta)));
                };
                const onUp = () => {
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
            <div style={{ width: browserWidth, flexShrink: 0, overflow: 'hidden' }}>
              <BrowserPane surfaceId="browser-main" />
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
