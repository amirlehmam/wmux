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
import ShortcutCheatSheet from './components/CheatSheet/ShortcutCheatSheet';
import BrowserPane from './components/Browser/BrowserPane';
import Tutorial from './components/Tutorial/Tutorial';
import SplitPreviewOverlay from './components/SplitPane/SplitPreviewOverlay';
import { initPipeBridge } from './pipe-bridge';
import { useUiTheme } from './hooks/useUiTheme';
import type {
  SurfaceDragCommitOptions,
  SurfaceDragPayload,
  SurfaceDragPreview,
  SurfaceDragPreviewTarget,
} from './components/SplitPane/drag-preview-types';
import { buildSurfaceDragPreview } from './components/SplitPane/surface-drag-preview';

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

/** Apply `~/.wmux/config.toml`'s `[terminal]` section onto the terminal prefs slice. */
function applyUserConfigTerminal(state: ReturnType<typeof useStore.getState>, terminal: any): void {
  if (!terminal) return;
  const patch: Partial<typeof state.terminalPrefs> = {};
  if (terminal.fontFamily !== undefined) patch.fontFamily = terminal.fontFamily;
  if (terminal.fontSize !== undefined) patch.fontSize = terminal.fontSize;
  if (terminal.theme !== undefined) patch.theme = terminal.theme;
  if (terminal.cursorStyle !== undefined) patch.cursorStyle = terminal.cursorStyle;
  if (terminal.cursorBlink !== undefined) patch.cursorBlink = terminal.cursorBlink;
  if (terminal.scrollbackLines !== undefined) patch.scrollbackLines = terminal.scrollbackLines;
  if (terminal.userColorSchemes) {
    // Merge: file-defined schemes replace by-name but don't clobber others.
    patch.userColorSchemes = {
      ...state.terminalPrefs.userColorSchemes,
      ...terminal.userColorSchemes,
    };
  }
  if (Object.keys(patch).length) state.setTerminalPrefs(patch);
}

/** Find the bottom-most pane in the split tree (follows last child of vertical splits) */
function findBottomPane(node: SplitNode): PaneId | null {
  if (node.type === 'leaf') return node.paneId;
  if (node.direction === 'vertical') return findBottomPane(node.children[1]);
  return findBottomPane(node.children[0]);
}

// ─── Shell-integration / hook metadata handlers (issue #53) ───────────────────
// Extracted from the metadata + hook listeners so each function stays under the
// cognitive-complexity budget. `fireNotification` is the single place that both
// adds the in-app bell entry and raises the OS toast (via the renderer → main
// NOTIFICATION_FIRE chokepoint).

const DEV_PORTS = [3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8888];

type StoreAction = (...args: any[]) => void;
type MetaDeps = {
  updateWorkspaceMetadata: StoreAction;
  addNotification: StoreAction;
  runningStartTimes: React.MutableRefObject<Record<string, number>>;
};

function fireNotification(
  surfaceId: string,
  workspaceId: WorkspaceId | null,
  text: string,
  addNotification: StoreAction,
): void {
  if (workspaceId) {
    addNotification({ surfaceId: (surfaceId || '') as SurfaceId, workspaceId, text });
  }
  window.wmux?.notification?.fire({ surfaceId: surfaceId || '', text, title: 'wmux' });
}

/** Resolve the workspace that owns a surface, or undefined. */
function workspaceForSurface(surfaceId: string): WorkspaceInfo | undefined {
  if (!surfaceId) return undefined;
  return useStore.getState().workspaces.find(ws => getAllSurfaces(ws.splitTree).includes(surfaceId));
}

function handlePortsUpdate(cmd: any, updateWorkspaceMetadata: StoreAction): void {
  try {
    const portsByPid = JSON.parse(cmd.args?.[0] || '{}');
    const allPorts = Object.values(portsByPid).flat() as number[];
    const devPorts = allPorts.filter((p: number) => DEV_PORTS.includes(p));
    if (devPorts.length > 0) {
      const currentWs = useStore.getState().activeWorkspaceId;
      const ws = useStore.getState().workspaces.find(w => w.id === currentWs);
      // Only auto-navigate the browser to a NEW dev port.
      if (currentWs && !(ws?.ports || []).includes(devPorts[0])) {
        window.wmux?.browser?.navigate?.(`browser-${currentWs}`, `http://localhost:${devPorts[0]}`);
      }
    }
    for (const ws of useStore.getState().workspaces) {
      updateWorkspaceMetadata(ws.id, { ports: devPorts.length > 0 ? devPorts : undefined });
    }
  } catch {}
}

/** `wmux notify <text>` — works even outside a pane (falls back to active workspace). */
function handleNotifyCommand(cmd: any, addNotification: StoreAction): void {
  const text = (cmd.args || []).join(' ').trim() || 'Notification';
  const ws = workspaceForSurface(cmd.surfaceId);
  const wsId = ws?.id || useStore.getState().activeWorkspaceId;
  fireNotification(cmd.surfaceId, wsId, text, addNotification);
}

/** report_shell_state: notify when a foreground command ran ≥ 5s. */
function applyShellState(cmd: any, ws: WorkspaceInfo, deps: MetaDeps): void {
  const newState = cmd.args?.[0] as 'idle' | 'running' | 'interrupted';
  const prevState = ws.shellState;
  deps.updateWorkspaceMetadata(ws.id, { shellState: newState });

  if (newState === 'running') {
    deps.runningStartTimes.current[ws.id] = Date.now();
    return;
  }
  if (prevState !== 'running' || (newState !== 'idle' && newState !== 'interrupted')) return;

  const startTime = deps.runningStartTimes.current[ws.id];
  const elapsed = startTime ? (Date.now() - startTime) / 1000 : 0;
  delete deps.runningStartTimes.current[ws.id];
  if (elapsed < 5) return;

  const duration = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m${Math.round(elapsed % 60)}s`
    : `${Math.round(elapsed)}s`;
  const msg = newState === 'interrupted'
    ? `Interrupted in ${ws.title} (${duration})`
    : `Finished in ${ws.title} (${duration})`;
  fireNotification(cmd.surfaceId, ws.id, msg, deps.addNotification);
}

/** Dispatch a surface-scoped metadata command to the owning workspace. */
function handleSurfaceMetadata(cmd: any, ws: WorkspaceInfo, deps: MetaDeps): void {
  switch (cmd.command) {
    case 'report_pwd':
      deps.updateWorkspaceMetadata(ws.id, { cwd: cmd.args?.[0] });
      break;
    case 'report_git_branch':
      deps.updateWorkspaceMetadata(ws.id, { gitBranch: cmd.args?.[0], gitDirty: cmd.args?.[1] === 'dirty' });
      break;
    case 'clear_git_branch':
      deps.updateWorkspaceMetadata(ws.id, { gitBranch: undefined, gitDirty: undefined });
      break;
    case 'report_pr': {
      const [num, status, ...labelParts] = cmd.args || [];
      deps.updateWorkspaceMetadata(ws.id, {
        prNumber: num ? parseInt(num) : undefined,
        prStatus: status as any,
        prLabel: labelParts.join(' '),
      });
      break;
    }
    case 'clear_pr':
      deps.updateWorkspaceMetadata(ws.id, { prNumber: undefined, prStatus: undefined, prLabel: undefined });
      break;
    case 'report_shell_state':
      applyShellState(cmd, ws, deps);
      break;
  }
}

/** Claude Code Notification (needs input) / Stop (turn finished) hook events. */
function handleAgentLifecycleEvent(event: any, addNotification: StoreAction): void {
  const state = useStore.getState();
  const prefs = state.notificationPrefs;
  if (event.event === 'Notification' && prefs.agentInputNotify === false) return;
  if (event.event === 'Stop' && prefs.agentStopNotify === false) return;

  const sid = (event.surfaceId as string) || '';
  const ws = workspaceForSurface(sid);
  const wsId = ws?.id || state.activeWorkspaceId;
  const wsTitle = ws?.title || state.workspaces.find(w => w.id === wsId)?.title || '';

  let text: string;
  if (event.event === 'Notification') {
    text = event.message || 'Claude Code needs your input';
  } else {
    text = wsTitle ? `Claude Code finished in ${wsTitle}` : 'Claude Code finished';
  }
  fireNotification(sid, wsId, text, addNotification);
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

  useUiTheme();

  const [focusedPaneId, setFocusedPaneId] = useState<PaneId | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Shortcut cheat-sheet overlay (issue #64, toggled by F1 via wmux:toggle-cheatsheet).
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  useEffect(() => {
    const toggle = () => setCheatSheetOpen((open) => !open);
    document.addEventListener('wmux:toggle-cheatsheet', toggle);
    return () => document.removeEventListener('wmux:toggle-cheatsheet', toggle);
  }, []);
  // Broadcast-input mode banner (issue #64): mirror the runtime store flag.
  const broadcastInputActive = useStore((s) => s.broadcastInputActive);
  // Browser panel auto-opens on startup unless disabled in Settings (issue #22).
  const [browserOpen, setBrowserOpen] = useState(() => useStore.getState().browserPrefs.openOnStartup);
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

  // Open tutorial on first launch, unless the welcome screen is disabled in
  // Settings (issue #22). The "seen" flag still prevents re-showing it.
  useEffect(() => {
    const showWelcome = useStore.getState().workspacePrefs.showWelcomeScreen;
    if (showWelcome && !localStorage.getItem('wmux-tutorial-seen')) {
      setTutorialOpen(true);
    }
  }, []);

  const handleTutorialClose = useCallback(() => {
    localStorage.setItem('wmux-tutorial-seen', '1');
    setTutorialOpen(false);
  }, []);

  // Initialize workspaces: prefer the rolling auto-saved session (the file
  // main writes every 30s + on quit), fall back to the most recent named
  // session, then to a fresh default. The auto-save is the user's actual last
  // state — earlier versions only restored named sessions, so on every
  // restart users with no manually-saved snapshot lost their workspaces.
  useEffect(() => {
    (async () => {
      try {
        const autoSaved = await window.wmux?.session?.loadAuto?.();
        if (autoSaved && Array.isArray(autoSaved.workspaces) && autoSaved.workspaces.length > 0) {
          const { replaceAllWorkspaces } = useStore.getState();
          replaceAllWorkspaces(autoSaved.workspaces, autoSaved.activeIndex);
          if (autoSaved.sidebarWidth) setSidebarWidth(autoSaved.sidebarWidth);
          return;
        }
      } catch {}
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
  }, []);

  // Expose helpers for main process queries + pipe bridge
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
    // Initialize pipe bridge — exposes store operations for V2 pipe handlers
    initPipeBridge();
    return () => {
      delete (window as any).__wmux_getActiveWorkspaceId;
      delete (window as any).__wmux_getPaneLoads;
    };
  }, []);

  // Load ~/.wmux/config.toml on startup and listen for `wmux reload-config`.
  // File-wins-at-startup, app-wins-at-runtime: file values are applied over
  // persisted Zustand state, then in-app edits take over until reload/restart.
  useEffect(() => {
    const cfg = (window as any).wmux?.config;
    if (!cfg?.getUserConfig) return;

    const apply = (result: any) => {
      const state = useStore.getState();
      applyUserConfigTerminal(state, result?.terminal);

      // App UI theme override (issue #67): `[appearance] ui-theme = "..."`.
      const uiTheme = result?.appearance?.uiTheme;
      if (uiTheme) state.setAppearancePrefs({ uiTheme });
    };

    cfg.getUserConfig().then(apply).catch(() => { /* no-op */ });
    const unsub = cfg.onUserConfigUpdated?.(apply);
    return () => { try { unsub?.(); } catch { /* no-op */ } };
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
    const deps: MetaDeps = { updateWorkspaceMetadata, addNotification, runningStartTimes };
    const unsub = window.wmux.metadata.onUpdate((cmd: any) => {
      if (!cmd) return;
      // ports_update and notify have no (required) surfaceId — handle globally.
      if (cmd.command === 'ports_update') { handlePortsUpdate(cmd, updateWorkspaceMetadata); return; }
      if (cmd.command === 'notify') { handleNotifyCommand(cmd, addNotification); return; }
      // set_workspace_status is keyed on workspaceId (not surfaceId) — a
      // coordinator setting a named workspace's status via `wmux set-status
      // --workspace`. Handle before the surfaceId guard below.
      if (cmd.command === 'set_workspace_status') {
        const [state, text] = cmd.args || [];
        if (state === 'idle' || state === 'running' || state === 'interrupted') {
          const target = useStore.getState().workspaces.find((w) => w.id === cmd.workspaceId);
          if (target) {
            updateWorkspaceMetadata(target.id, { shellState: state, notificationText: text || undefined });
          }
        }
        return;
      }

      if (!cmd.surfaceId) return;
      const ws = workspaceForSurface(cmd.surfaceId);
      if (ws) handleSurfaceMetadata(cmd, ws, deps);
    });
    return unsub;
  }, []);

  // Listen for Claude Code hook events — tie to active workspace
  // Also auto-create diff surface when Edit/Write tools fire
  useEffect(() => {
    if (!window.wmux?.hook?.onEvent) return;
    const unsub = window.wmux.hook.onEvent((event: any) => {
      // Agent lifecycle (issue #53): Notification = agent needs input/permission,
      // Stop = agent finished its turn. These have no `tool`, so handle first.
      if (event?.event === 'Notification' || event?.event === 'Stop') {
        handleAgentLifecycleEvent(event, addNotification);
        return;
      }
      if (!event?.tool) return;
      const state = useStore.getState();
      // Resolve the workspace that OWNS the agent's pane (issue #63), so the
      // diff tab and sidebar activity attach to the agent's workspace — not
      // whichever workspace happens to be focused. Fall back to the active
      // workspace only when the event carries no surfaceId (legacy hooks).
      const ownerWs = workspaceForSurface(event.surfaceId)
        ?? state.workspaces.find(w => w.id === state.activeWorkspaceId);
      if (!ownerWs) return;
      const wsId = ownerWs.id;

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

      // Auto-open diff tab in the BOTTOM pane when Claude edits/writes files.
      // Opt-out via Settings → Workspace (issue #66): users who find the tab
      // popping up and stealing focus disruptive can turn it off entirely.
      if ((event.tool === 'Edit' || event.tool === 'Write') && state.workspacePrefs.autoOpenDiffTab) {
        const ws = ownerWs;
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
  }, []);

  // NOTE: hookActivity entries are intentionally kept forever (not cleaned up).
  // WorkspaceRow uses the lastSeen timestamp + TTL to decide what to display.
  // Keeping stale entries lets us distinguish "Claude was active but stopped"
  // (idle) from "a regular shell command is running" (no hookActivity at all).

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
            cwd: ws.cwd, // issue #20 — restore so new terminals reopen in the workspace folder
            splitTree: ws.splitTree,
            browserUrl: ws.browserUrl,
            browserWidth: ws.browserWidth,
          })),
        }],
      };
      window.wmux.session.pushAutoSave(data);
    });
    return unsub;
  }, [sidebarWidth]);

  // Auto-focus first pane whenever the active workspace changes or gains its first pane
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  // During drag use live browserWidth state; otherwise use the persisted value from the
  // workspace (falls back to browserWidth for workspaces that have never been resized).
  const displayBrowserWidth = isResizingBrowser ? browserWidth : (activeWorkspace?.browserWidth ?? browserWidth);

  useEffect(() => {
    if (!activeWorkspace) return;
    const paneIds = getAllPaneIds(activeWorkspace.splitTree);
    if (paneIds.length > 0 && (focusedPaneId === null || !paneIds.includes(focusedPaneId))) {
      setFocusedPaneId(paneIds[0]);
    }
  }, [activeWorkspace?.id, activeWorkspace?.splitTree]);

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
        browserWidth: ws.browserWidth,
      })),
      sidebarWidth,
      terminalPrefs: { ...state.terminalPrefs },
    };
    await window.wmux?.session?.save(session);
    window.wmux?.notification?.fire({ surfaceId: '', text: `Session "${name}" saved`, title: 'wmux' });
  }, [sidebarWidth]);

  const handleLoadSession = useCallback(async (name: string) => {
    const session = await window.wmux?.session?.load(name);
    if (!session) return;
    const { replaceAllWorkspaces, setTerminalPrefs } = useStore.getState();
    replaceAllWorkspaces(session.workspaces);
    if (session.sidebarWidth) setSidebarWidth(session.sidebarWidth);
    if (session.terminalPrefs) setTerminalPrefs(session.terminalPrefs);
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

  const [zoomedPaneId, setZoomedPaneId] = useState<PaneId | null>(null);
  const [surfaceDrag, setSurfaceDrag] = useState<SurfaceDragPayload | null>(null);
  const [surfaceDragPreview, setSurfaceDragPreview] = useState<SurfaceDragPreview | null>(null);
  const surfaceDragRef = useRef<SurfaceDragPayload | null>(null);
  const surfaceDragPreviewRef = useRef<SurfaceDragPreview | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const pendingPreviewTargetRef = useRef<{ targetPaneId: PaneId; target: SurfaceDragPreviewTarget } | null>(null);

  const handleToggleZoom = useCallback(() => {
    setZoomedPaneId((prev) => (prev ? null : focusedPaneId));
  }, [focusedPaneId]);

  useEffect(() => {
    surfaceDragRef.current = surfaceDrag;
  }, [surfaceDrag]);

  useEffect(() => {
    surfaceDragPreviewRef.current = surfaceDragPreview;
  }, [surfaceDragPreview]);

  useEffect(() => {
    return () => {
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
      }
    };
  }, []);

  const handleSurfaceDragStart = useCallback((payload: SurfaceDragPayload) => {
    surfaceDragRef.current = payload;
    setSurfaceDrag(payload);
  }, []);

  const handleSurfaceDragEnd = useCallback(() => {
    pendingPreviewTargetRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    surfaceDragRef.current = null;
    surfaceDragPreviewRef.current = null;
    setSurfaceDrag(null);
    setSurfaceDragPreview(null);
    document.body.classList.remove('wmux-dragging');
  }, []);

  const handleSurfaceDragPreviewTarget = useCallback((targetPaneId: PaneId, target: SurfaceDragPreviewTarget) => {
    pendingPreviewTargetRef.current = { targetPaneId, target };

    if (previewFrameRef.current !== null) return;

    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;

      const pending = pendingPreviewTargetRef.current;
      const drag = surfaceDragRef.current;
      if (!pending || !drag) {
        surfaceDragPreviewRef.current = null;
        setSurfaceDragPreview(null);
        return;
      }

      const nextPreview = buildSurfaceDragPreview({
        workspaces: useStore.getState().workspaces,
        activeWorkspaceId,
        drag,
        pendingTarget: pending,
      });
      surfaceDragPreviewRef.current = nextPreview;
      setSurfaceDragPreview(nextPreview);
    });
  }, [activeWorkspaceId]);

  const handleClearSurfaceDragPreview = useCallback(() => {
    pendingPreviewTargetRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    surfaceDragPreviewRef.current = null;
    setSurfaceDragPreview(null);
  }, []);

  const handleSurfaceDragCommit = useCallback((options?: SurfaceDragCommitOptions) => {
    if (options?.clearZoom || surfaceDragPreviewRef.current) setZoomedPaneId(null);
    pendingPreviewTargetRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    surfaceDragRef.current = null;
    surfaceDragPreviewRef.current = null;
    setSurfaceDrag(null);
    setSurfaceDragPreview(null);
    document.body.classList.remove('wmux-dragging');
  }, []);

  useEffect(() => {
    if (!surfaceDrag) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleSurfaceDragEnd();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [surfaceDrag, handleSurfaceDragEnd]);

  // Clear zoom when the zoomed pane no longer exists
  useEffect(() => {
    if (!zoomedPaneId || !activeWorkspace) return;
    const paneIds = getAllPaneIds(activeWorkspace.splitTree);
    if (!paneIds.includes(zoomedPaneId)) setZoomedPaneId(null);
  }, [zoomedPaneId, activeWorkspace]);

  useKeyboardShortcuts(focusedPaneId, setSettingsOpen, () => setBrowserOpen(o => !o), handleToggleNotifPanel, setFocusedPaneId, handleToggleZoom);

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
        onSettingsClick={() => setSettingsOpen(true)}
        notifications={notifications}
        workspaceNames={workspaceNames}
        notificationPanelOpen={notifPanelOpen}
        onToggleNotificationPanel={handleToggleNotifPanel}
        onNotificationJump={handleNotificationJump}
        onMarkAllNotificationsRead={() => markAllRead()}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {sidebarVisible ? (
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
        ) : (
          <div
            className="sidebar-expand-strip"
            onClick={toggleSidebar}
            onMouseDown={(e) => {
              // Allow drag-to-expand: start listening for mousemove
              e.preventDefault();
              const onMove = (ev: MouseEvent) => {
                if (ev.clientX > 20) {
                  toggleSidebar();
                  setSidebarWidth(Math.max(180, ev.clientX));
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                }
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
            title="Expand sidebar (Ctrl+B)"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/>
            </svg>
          </div>
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
                node={
                  ws.id === activeWorkspaceId && zoomedPaneId
                    ? (findLeaf(ws.splitTree, zoomedPaneId) ?? ws.splitTree)
                    : ws.splitTree
                }
                workspaceId={ws.id}
                focusedPaneId={ws.id === activeWorkspaceId ? focusedPaneId : null}
                onRatioChange={ws.id === activeWorkspaceId ? handleRatioChange : undefined}
                onPaneFocus={handlePaneFocus}
                surfaceDrag={ws.id === activeWorkspaceId ? surfaceDrag : null}
                onSurfaceDragStart={handleSurfaceDragStart}
                onSurfaceDragEnd={handleSurfaceDragEnd}
                onSurfaceDragPreviewTarget={handleSurfaceDragPreviewTarget}
                onClearSurfaceDragPreview={handleClearSurfaceDragPreview}
                onSurfaceDragCommit={handleSurfaceDragCommit}
              />
              {surfaceDragPreview?.workspaceId === ws.id && ws.id === activeWorkspaceId && (
                <SplitPreviewOverlay
                  tree={surfaceDragPreview.previewTree}
                  destinationPaneId={surfaceDragPreview.destinationPaneId}
                  draggedSurfaceId={surfaceDragPreview.surfaceId}
                  workspaceShell={ws.shell}
                />
              )}
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
                const startWidth = activeWorkspace?.browserWidth ?? browserWidth;
                setBrowserWidth(startWidth);
                let finalWidth = startWidth;
                const onMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  finalWidth = Math.max(250, Math.min(window.innerWidth - 400, startWidth + delta));
                  setBrowserWidth(finalWidth);
                };
                const onUp = () => {
                  setIsResizingBrowser(false);
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                  if (activeWorkspaceId) updateWorkspaceMetadata(activeWorkspaceId as any, { browserWidth: finalWidth });
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
            <div style={{ width: displayBrowserWidth, flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
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

      {cheatSheetOpen && <ShortcutCheatSheet onClose={() => setCheatSheetOpen(false)} />}

      {broadcastInputActive && (
        <div className="broadcast-input-banner" title="Typed input is sent to every terminal pane in this workspace">
          Broadcast input ON — typing goes to all panes (Ctrl+Alt+B to stop)
        </div>
      )}
    </div>
  );
}
