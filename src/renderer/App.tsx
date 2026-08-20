import React, { useEffect, useState, useCallback, useRef } from 'react';
import { v4 as uuid } from 'uuid';
import { useStore } from './store';
import { PaneId, SurfaceId, SurfaceRef, WorkspaceId, WorkspaceInfo, SplitNode } from '../shared/types';
import { cwdReportPatch } from '../shared/paths';
import SplitContainer from './components/SplitPane/SplitContainer';
import { updateRatio, getAllPaneIds, findLeaf, replaceSoleTerminalSurface, freezeSurfaceCwds } from './store/split-utils';
import { DEFAULT_DEV_PORTS, mergeDevPorts, matchDevPorts, firstNewDevPort } from './dev-ports';
import { aggregateProgress } from './store/progress-slice';
import { isDiffTabDismissed } from './store/surface-slice';
import Sidebar from './components/Sidebar/Sidebar';
import { applyPrCommand } from './pr-metadata';
import Titlebar from './components/Titlebar/Titlebar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import SettingsWindow from './components/Settings/SettingsWindow';
import CommandPalette from './components/CommandPalette/CommandPalette';
import ShortcutCheatSheet from './components/CheatSheet/ShortcutCheatSheet';
import ConfirmCloseDialog from './components/ConfirmCloseDialog';
import ConfirmCloseSurfaceDialog from './components/ConfirmCloseSurfaceDialog';
import BrowserPane from './components/Browser/BrowserPane';
import Tutorial from './components/Tutorial/Tutorial';
import SplitPreviewOverlay from './components/SplitPane/SplitPreviewOverlay';
import { initPipeBridge } from './pipe-bridge';
import { setKeyRemaps } from './key-remaps';
import { useUiTheme } from './hooks/useUiTheme';
import { useUiMode } from './hooks/useUiMode';
import type {
  SurfaceDragCommitOptions,
  SurfaceDragPayload,
  SurfaceDragPreview,
  SurfaceDragPreviewTarget,
} from './components/SplitPane/drag-preview-types';
import { buildSurfaceDragPreview } from './components/SplitPane/surface-drag-preview';
import { useT } from './i18n';
import type { TranslationKey } from './i18n';

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

// Effective runtime values — seeded from the built-in defaults, then widened/
// toggled by ~/.wmux/config.toml at startup and on `wmux reload-config`.
let activeDevPorts: number[] = DEFAULT_DEV_PORTS;
let autoOpenDevPort = true;

/**
 * Apply `~/.wmux/config.toml`'s `[browser]` section: dev-port detection + auto-open.
 * Resets to the built-in defaults first so `wmux reload-config` is idempotent —
 * deleting a key (or the whole section) from the file reverts its effect instead
 * of leaving the previous run's values sticky until restart.
 */
function applyUserConfigBrowser(browser: any): void {
  activeDevPorts = DEFAULT_DEV_PORTS;
  autoOpenDevPort = true;
  if (!browser) return;
  if (Array.isArray(browser.devPorts) && browser.devPorts.length) {
    activeDevPorts = mergeDevPorts(DEFAULT_DEV_PORTS, browser.devPorts);
  }
  if (typeof browser.autoOpen === 'boolean') autoOpenDevPort = browser.autoOpen;
}

type StoreAction = (...args: any[]) => void;
type T = (key: TranslationKey, fallback?: string) => string;
type MetaDeps = {
  updateWorkspaceMetadata: StoreAction;
  addNotification: StoreAction;
  runningStartTimes: React.MutableRefObject<Record<string, number>>;
  t: T;
};

type SetWidth = (width: number) => void;

/**
 * Rehydrate from the rolling auto-save (the file main writes every 30s + on quit).
 *
 * `'fresh'` is main saying "this window was opened during the run — come up
 * empty". It is distinct from `'none'` ("nothing saved for you") precisely
 * because the caller must NOT fall through to a named session in that case:
 * doing so cloned the session's workspace, pane and surface ids into a second
 * window, and PTY id is surface id, so the clone re-attached to live PTYs and
 * every id-based CLI lookup had two equally valid answers (issue #143).
 */
async function restoreAutoSaved(t: T, setWidth: SetWidth): Promise<'restored' | 'fresh' | 'none'> {
  try {
    const autoSaved = await window.wmux?.session?.loadAuto?.();
    if (autoSaved && Array.isArray(autoSaved.workspaces) && autoSaved.workspaces.length > 0) {
      useStore.getState().replaceAllWorkspaces(autoSaved.workspaces, autoSaved.activeIndex, t);
      if (autoSaved.sidebarWidth) setWidth(autoSaved.sidebarWidth);
      return 'restored';
    }
    return (autoSaved as { fresh?: boolean } | null | undefined)?.fresh ? 'fresh' : 'none';
  } catch {
    return 'none';
  }
}

/**
 * Fall back to the most recent manually-saved session. Returns whether it
 * restored one.
 *
 * This is also the post-update path (the version change clears the auto-session
 * and leaves an "Auto-backup vX" named session behind), so it has to restore
 * exactly what the Sessions menu's Load does — including terminalPrefs, which
 * it used to skip (issue #145).
 */
async function restoreNamedSession(t: T, setWidth: SetWidth): Promise<boolean> {
  try {
    const sessions = await window.wmux?.session?.list();
    const name = sessions?.[0]?.name;
    if (!name) return false;
    const session = await window.wmux?.session?.load(name);
    if (!session) return false;
    useStore.getState().replaceAllWorkspaces(session.workspaces, undefined, t);
    if (session.sidebarWidth) setWidth(session.sidebarWidth);
    if (session.terminalPrefs) useStore.getState().setTerminalPrefs(session.terminalPrefs);
    return true;
  } catch {
    return false;
  }
}

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

type HookActivityMap = Record<string, { lastTool: string; toolCount: number; lastSeen: number }>;

/**
 * Stop hook = the turn is over. Zero out lastSeen so the sidebar flips to
 * "Idle" immediately instead of waiting out the ACTIVITY_TTL window, and
 * upsert the entry so turns with zero tool uses (pure text generation) still
 * register as "Claude ran here and finished" — otherwise WorkspaceRow falls
 * back to the shell's perpetual "Running" while the TUI sits idle (issue #81).
 *
 * Keyed by SURFACE, not workspace: two Claude sessions split inside one
 * workspace must not zero each other's freshness. Only surfaceId-less legacy
 * events fall back to the active workspace's id as key.
 */
function markSessionIdleOnStop(
  surfaceId: string,
  setHookActivity: React.Dispatch<React.SetStateAction<HookActivityMap>>,
): void {
  const key = surfaceId || useStore.getState().activeWorkspaceId;
  if (!key) return;
  setHookActivity(prev => {
    const existing = prev[key] || { lastTool: '', toolCount: 0, lastSeen: 0 };
    return { ...prev, [key]: { ...existing, lastSeen: 0 } };
  });
}

/**
 * Auto-open a diff tab in the workspace's BOTTOM pane when Claude edits/writes
 * files. Opt-out via Settings → Workspace (issue #66): users who find the tab
 * popping up and stealing focus disruptive can turn it off entirely.
 */
function maybeAutoOpenDiffTab(tool: string, ownerWs: WorkspaceInfo): void {
  const state = useStore.getState();
  if ((tool !== 'Edit' && tool !== 'Write') || !state.workspacePrefs.autoOpenDiffTab) return;
  // A diff tab the user closed stays closed (issue #141). Without this, every
  // Edit/Write put it back minutes later with no user action — and on a large
  // repo its polling is what made typing lag, so "close it" was not a fix.
  if (isDiffTabDismissed(ownerWs.id)) return;
  const bottomPaneId = findBottomPane(ownerWs.splitTree);
  if (!bottomPaneId) return;
  const bottomLeaf = findLeafFromTree(ownerWs.splitTree, bottomPaneId);
  // Only add diff tab if bottom pane doesn't already have one
  if (bottomLeaf && !bottomLeaf.surfaces.some(s => s.type === 'diff')) {
    state.addSurface(ownerWs.id, bottomPaneId, 'diff', { auto: true });
  }
}

function handlePortsUpdate(cmd: any, updateWorkspaceMetadata: StoreAction): void {
  try {
    const portsByPid = JSON.parse(cmd.args?.[0] || '{}');
    const allPorts = Object.values(portsByPid).flat() as number[];
    const devPorts = matchDevPorts(allPorts, activeDevPorts);
    if (devPorts.length > 0) {
      const currentWs = useStore.getState().activeWorkspaceId;
      const ws = useStore.getState().workspaces.find(w => w.id === currentWs);
      // Auto-navigate to a newly-appeared dev port — one this workspace hasn't seen
      // yet — rather than blindly devPorts[0]. Otherwise a freshly-started server
      // never opens when other recognized ports are already listening (netstat order
      // is arbitrary), and the guard permanently suppresses navigation thereafter.
      const newPort = firstNewDevPort(devPorts, ws?.ports || []);
      if (autoOpenDevPort && currentWs && newPort !== undefined) {
        window.wmux?.browser?.navigate?.(`browser-${currentWs}`, `http://localhost:${newPort}`);
      }
    }
    for (const ws of useStore.getState().workspaces) {
      updateWorkspaceMetadata(ws.id, { ports: devPorts.length > 0 ? devPorts : undefined });
    }
  } catch {}
}

/** `wmux notify <text>` — works even outside a pane (falls back to active workspace). */
function handleNotifyCommand(cmd: any, addNotification: StoreAction, t: T): void {
  const text = (cmd.args || []).join(' ').trim() || t('app.notificationDefault', 'Notification');
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

  // Round to whole seconds BEFORE splitting into minutes — rounding the
  // remainder independently yields "3m60s" for 239.6s elapsed.
  const totalSeconds = Math.round(elapsed);
  const duration = totalSeconds >= 60
    ? `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`
    : `${totalSeconds}s`;
  const msg = newState === 'interrupted'
    ? deps.t('app.interruptedIn', 'Interrupted in {workspace} ({duration})').replace('{workspace}', ws.title).replace('{duration}', duration)
    : deps.t('app.finishedIn', 'Finished in {workspace} ({duration})').replace('{workspace}', ws.title).replace('{duration}', duration);
  fireNotification(cmd.surfaceId, ws.id, msg, deps.addNotification);
}

/** Apply a patch to one surface of `ws`, wherever in the split tree it lives. */
function patchSurface(ws: WorkspaceInfo, surfaceId: SurfaceId, patch: Partial<SurfaceRef>): void {
  const { updateSurface } = useStore.getState();
  for (const paneId of getAllPaneIds(ws.splitTree)) {
    const leaf = findLeaf(ws.splitTree, paneId);
    if (leaf?.surfaces.some((s) => s.id === surfaceId)) {
      updateSurface(ws.id, paneId, surfaceId, patch);
      return;
    }
  }
}

/** Dispatch a surface-scoped metadata command to the owning workspace. */
function handleSurfaceMetadata(cmd: any, ws: WorkspaceInfo, deps: MetaDeps): void {
  switch (cmd.command) {
    case 'report_pwd': {
      const pwd = cmd.args?.[0];
      // Records the POSIX path separately so a pwsh report cannot erase the
      // WSL fallback its neighbours depend on — without this, the next WSL
      // pane in the workspace gets `--cd ~`.
      deps.updateWorkspaceMetadata(ws.id, cwdReportPatch(pwd));
      // Also store cwd at the surface level so the tab label can show the project folder.
      if (pwd && cmd.surfaceId) patchSurface(ws, cmd.surfaceId, { currentCwd: pwd });
      break;
    }
    case 'report_startup_command': {
      // A shell declares how to bring its own surface back after a restart —
      // a devcontainer shell reports the launcher that re-enters the container,
      // so a restored pane starts in WSL and runs it (issue #19). Reported per
      // surface, stored per surface: two containers in one pane restore to two
      // different containers. No argument clears it.
      //
      // The command must be cwd-independent (`cd '<path>' && …`): the restored
      // pane's shell is a fresh login shell whose rc files have had their say,
      // so nothing guarantees it starts where the reporting shell was.
      if (!cmd.surfaceId) break;
      const command = cmd.args?.[0];
      patchSurface(ws, cmd.surfaceId, { startupCommands: command ? [command] : undefined });
      break;
    }
    case 'report_git_branch':
      deps.updateWorkspaceMetadata(ws.id, { gitBranch: cmd.args?.[0], gitDirty: cmd.args?.[1] === 'dirty' });
      break;
    case 'clear_git_branch':
      deps.updateWorkspaceMetadata(ws.id, { gitBranch: undefined, gitDirty: undefined });
      break;
    case 'report_pr':
    case 'clear_pr': {
      // See pr-metadata.ts: `clear_pr` is gated on the surface that reported
      // the PR still being the one asking to clear it, so one pane's poller
      // can't wipe another pane's PR out of a shared workspace row.
      const patch = applyPrCommand(cmd, ws);
      if (patch) deps.updateWorkspaceMetadata(ws.id, patch);
      break;
    }
    case 'report_shell_state':
      applyShellState(cmd, ws, deps);
      break;
  }
}

/** Claude Code Notification (needs input) / Stop (turn finished) hook events. */
function handleAgentLifecycleEvent(event: any, addNotification: StoreAction, t: T): void {
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
    text = event.message || t('app.claudeNeedsInput', 'Claude Code needs your input');
  } else {
    text = wsTitle
      ? t('app.claudeFinishedIn', 'Claude Code finished in {workspace}').replace('{workspace}', wsTitle)
      : t('app.claudeFinished', 'Claude Code finished');
  }
  fireNotification(sid, wsId, text, addNotification);
}

/**
 * --replace-tab agent spawn (PR #85): swap the pane's sole idle default
 * terminal for the agent surface instead of appending, so orchestration panes
 * don't keep an unused shell tab. Guards: exactly one surface, terminal type
 * (enforced in replaceSoleTerminalSurface), and not itself an agent surface.
 * Returns true when the spawn was handled via replacement.
 */
export function tryReplaceTabSpawn(event: any, ws: WorkspaceInfo, setAgentMeta: (surfaceId: any, meta: any) => void): boolean {
  if (!event.replaceTab) return false;
  const state = useStore.getState();
  const leaf = findLeaf(ws.splitTree, event.paneId);
  const sole = leaf?.surfaces.length === 1 ? leaf.surfaces[0] : undefined;
  if (!sole || state.agentMeta.get(sole.id)) return false;
  const { tree, replacedSurfaceId } = replaceSoleTerminalSurface(
    ws.splitTree, event.paneId, { id: event.surfaceId, type: 'terminal' },
  );
  if (!replacedSurfaceId) return false;
  state.updateSplitTree(event.workspaceId, tree);
  setAgentMeta(event.surfaceId, { agentId: event.agentId, label: event.label, status: 'running' });
  // Intentionally not pushed onto the reopen-closed stack — the replaced
  // surface is an idle default shell, not user work.
  window.wmux?.pty?.kill(replacedSurfaceId);
  // This kills the PTY directly instead of routing through closeSurface, so
  // it must run the same ownership-gated PR-badge clear closeSurface would
  // have run — otherwise a replaced tab that happened to hold the PR badge
  // leaves `prSurfaceId` pointing at a surface that no longer exists, and
  // since clear_pr is only honoured from its owner (see pr-metadata.ts), the
  // badge becomes unclearable by anything, ever.
  state.clearPrIfSurfaceOwner(event.workspaceId, [replacedSurfaceId]);
  return true;
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
    requestCloseWorkspace,
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
  useUiMode();
  const t = useT();

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
  // Custom background parallel to theming (issue #89): rendered as a layer
  // behind the split tree; terminals show it through their alpha'd theme bg.
  const appearancePrefs = useStore((s) => s.appearancePrefs);
  const customBgActive = appearancePrefs.customBackgroundEnabled && !!appearancePrefs.customBackground.trim();
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
  // surfaceId → declared agent state (blocked / working / idle), issue #128.
  const [agentStates, setAgentStates] = useState<Record<string, any>>({});
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
  // Session writes read the width through this ref, not the state value.
  // As a dependency, `sidebarWidth` re-subscribed the auto-save listener and
  // rebuilt the save callback on every intermediate value of a drag; the ref
  // keeps those stable, so only the settled width matters (issue 07).
  const sidebarWidthRef = useRef(sidebarWidth);
  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);

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
      const outcome = await restoreAutoSaved(t, setSidebarWidth);
      if (outcome === 'restored') return;
      // 'fresh' means main deliberately wants this window empty — a named
      // session must not be cloned into it (issue #143).
      if (outcome !== 'fresh' && await restoreNamedSession(t, setSidebarWidth)) return;
      // Nothing to restore — create the default workspace.
      if (useStore.getState().workspaces.length === 0) {
        createWorkspace({
          title: t('app.firstSessionTitle', 'Session 1'),
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
      applyUserConfigBrowser(result?.browser);
      // `[keys]` remaps (issue #146) — main has already parsed and validated
      // them, so this is a straight hand-off to the terminal key handler.
      setKeyRemaps(result?.keys);

      // App UI theme override (issue #67): `[appearance] ui-theme = "..."`.
      const uiTheme = result?.appearance?.uiTheme;
      if (uiTheme) state.setAppearancePrefs({ uiTheme });

      // Community translations from ~/.wmux/locales (issue #147) ride the same
      // reload so `wmux reload-config` refreshes everything under ~/.wmux, not
      // just config.toml. Absent on the startup read — the registry already
      // loaded them synchronously before the store existed.
      if (result?.locales) state.reloadUserLocales(result.locales);
    };

    cfg.getUserConfig().then(apply).catch(() => { /* no-op */ });
    const unsub = cfg.onUserConfigUpdated?.(apply);
    return () => { try { unsub?.(); } catch { /* no-op */ } };
  }, []);

  // Listen for agent spawn events from main process
  useEffect(() => {
    if (!window.wmux?.agent?.onUpdate) return;
    const unsub = window.wmux.agent.onUpdate((event: any) => {
      if (event.type === 'exited') {
        // Flip the sidebar agent line to done; no-op for unknown surfaces.
        const existing = useStore.getState().agentMeta.get(event.surfaceId);
        if (existing && existing.status !== 'exited') {
          setAgentMeta(event.surfaceId, { ...existing, status: 'exited', exitCode: event.exitCode });
        }
        return;
      }
      if (event.type === 'spawned') {
        const { surfaceId, paneId, workspaceId, label } = event;
        const state = useStore.getState();
        const ws = state.workspaces.find((w) => w.id === workspaceId);
        if (!ws) return;

        if (tryReplaceTabSpawn(event, ws, setAgentMeta)) return;

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
    const deps: MetaDeps = { updateWorkspaceMetadata, addNotification, runningStartTimes, t };
    const unsub = window.wmux.metadata.onUpdate((cmd: any) => {
      if (!cmd) return;
      // ports_update and notify have no (required) surfaceId — handle globally.
      if (cmd.command === 'ports_update') { handlePortsUpdate(cmd, updateWorkspaceMetadata); return; }
      if (cmd.command === 'notify') { handleNotifyCommand(cmd, addNotification, t); return; }
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
        handleAgentLifecycleEvent(event, addNotification, t);
        if (event.event === 'Stop') markSessionIdleOnStop(event.surfaceId, setHookActivity);
        return;
      }
      if (!event?.tool) return;
      const state = useStore.getState();
      // Key hook activity by SURFACE when the event carries one — each Claude
      // session (pane) tracks its own freshness, so two sessions in the same
      // workspace can't clobber each other into a stuck "Running"/false "Idle".
      // Legacy events without surfaceId fall back to the active workspace id.
      const key = event.surfaceId || state.activeWorkspaceId;
      if (!key) return;

      // PreToolUse says the same tool is STARTING (issue #151). It refreshes the
      // label and the freshness stamp — that is the whole point, a three-minute
      // Bash used to show nothing until it ended — but it must not touch the
      // counter: `toolCount` is TRACE mode's odometer of completed tool calls,
      // and counting each tool at both ends would double every reading.
      const starting = event.event === 'PreToolUse';
      setHookActivity(prev => {
        const existing = prev[key] || { lastTool: '', toolCount: 0, lastSeen: 0 };
        return {
          ...prev,
          [key]: {
            lastTool: event.tool,
            toolCount: existing.toolCount + (starting ? 0 : 1),
            lastSeen: Date.now(),
          },
        };
      });
      if (starting) return;

      // Diff tab opens in the workspace that OWNS the pane (issue #63). A
      // surfaceId that doesn't resolve here belongs to another window —
      // opening a diff tab in whatever workspace is focused would misfire.
      const ownerWs = event.surfaceId
        ? workspaceForSurface(event.surfaceId)
        : state.workspaces.find(w => w.id === state.activeWorkspaceId);
      if (ownerWs) maybeAutoOpenDiffTab(event.tool, ownerWs);
    });
    return unsub;
  }, []);

  // NOTE: hookActivity entries are intentionally kept forever (not cleaned up).
  // Keys are surface ids (per Claude session) or workspace ids (legacy events).
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

  // Declared agent state pushed by the agent itself (issue #128). Unlike the
  // scraped/heuristic signals above this is authoritative, so it is kept in its
  // own map and given precedence in claude-session-view.
  useEffect(() => {
    if (!window.wmux?.agentState?.onUpdate) return;
    const unsub = window.wmux.agentState.onUpdate((data: any) => {
      if (!data?.surfaceId) return;
      setAgentStates(prev => ({ ...prev, [data.surfaceId]: data }));
    });
    return unsub;
  }, []);

  // ── Windows taskbar progress (OSC 9;4) ──────────────────────────────────
  // Fold every surface's progress into one value for this window's taskbar
  // button — the same convention Windows Terminal follows for the sequence.
  const surfaceProgress = useStore((s) => s.surfaceProgress);
  useEffect(() => {
    const api = window.wmux?.window;
    if (!api?.setProgress) return;
    const agg = aggregateProgress(Object.values(surfaceProgress));
    if (!agg) {
      api.setProgress(-1, 'none');
      return;
    }
    const MODES: Record<number, string> = { 1: 'normal', 2: 'error', 3: 'indeterminate', 4: 'paused' };
    const value = agg.state === 3 ? 1 : Math.min(1, Math.max(0, agg.value / 100));
    api.setProgress(value, MODES[agg.state]);
  }, [surfaceProgress]);

  // Respond to main process auto-save requests (30s timer + on quit)
  useEffect(() => {
    if (!window.wmux?.session?.onAutoSaveRequest) return;
    const unsub = window.wmux.session.onAutoSaveRequest(() => {
      const state = useStore.getState();
      const data = {
        version: 1,
        windows: [{
          bounds: { x: 0, y: 0, width: 0, height: 0 }, // main process fills real bounds
          sidebarWidth: sidebarWidthRef.current,
          activeWorkspaceId: state.activeWorkspaceId,
          workspaces: state.workspaces.map(ws => ({
            id: ws.id,
            title: ws.title,
            customColor: ws.customColor,
            pinned: ws.pinned,
            shell: ws.shell,
            cwd: ws.cwd, // issue #20 — restore so new terminals reopen in the workspace folder
            // The WSL half of that: ws.cwd is whichever pane reported last, so a
            // pwsh pane leaves a Win32 path behind and every restored WSL pane
            // falls through to `--cd ~`. Persist the POSIX one alongside it.
            posixCwd: ws.posixCwd,
            // Per-tab directories, frozen at save time (issue #134): ws.cwd above
            // is a single value for the whole workspace, so on its own it sends
            // every restored terminal to the same place.
            splitTree: freezeSurfaceCwds(ws.splitTree),
            browserUrl: ws.browserUrl,
            browserWidth: ws.browserWidth,
          })),
        }],
      };
      window.wmux.session.pushAutoSave(data);
    });
    return unsub;
  }, []);

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
      title: t('app.sessionTitle', 'Session {n}').replace('{n}', String(wsCount + 1)),
      splitTree: buildDefaultSplitTree(),
    });
    selectWorkspace(newId);
  }, [createWorkspace, selectWorkspace, t]);

  const handleSaveSession = useCallback(async (name: string) => {
    const state = useStore.getState();
    const session = {
      name,
      savedAt: Date.now(),
      workspaces: state.workspaces.map(ws => ({
        title: ws.title,
        customColor: ws.customColor,
        // Pinning is part of the layout the user arranged — the auto-save has
        // always kept it, so a named save must too (issue #145).
        pinned: ws.pinned,
        shell: ws.shell,
        cwd: ws.cwd || '',
        posixCwd: ws.posixCwd || '',
        // See the auto-save path below — a named session is the case #134
        // reported, where losing a worktree's drive makes the session
        // unidentifiable after a restore.
        splitTree: freezeSurfaceCwds(ws.splitTree),
        browserUrl: ws.browserUrl || '',
        browserWidth: ws.browserWidth,
      })),
      sidebarWidth: sidebarWidthRef.current,
      terminalPrefs: { ...state.terminalPrefs },
    };
    await window.wmux?.session?.save(session);
    window.wmux?.notification?.fire({ surfaceId: '', text: t('app.sessionSaved', 'Session "{name}" saved').replace('{name}', name), title: 'wmux' });
    // sidebarWidth is read through sidebarWidthRef (PR #131), so it is
    // deliberately not a dependency — a drag must not rebuild this callback.
  }, [t]);

  const handleLoadSession = useCallback(async (name: string) => {
    const session = await window.wmux?.session?.load(name);
    if (!session) return;
    const { replaceAllWorkspaces, setTerminalPrefs } = useStore.getState();
    replaceAllWorkspaces(session.workspaces, undefined, t);
    if (session.sidebarWidth) setSidebarWidth(session.sidebarWidth);
    if (session.terminalPrefs) setTerminalPrefs(session.terminalPrefs);
  }, [t]);

  const handleUpdateMetadata = useCallback(
    (id: WorkspaceId, partial: Partial<WorkspaceInfo>) => {
      updateWorkspaceMetadata(id, partial);
    },
    [updateWorkspaceMetadata],
  );

  const handlePaletteClose = useCallback(() => {
    setCommandPaletteOpen(false);
  }, []);

  // The palette's Actions category has always been a stub that logs and closes
  // — every entry is listed, none of them run. Fixing that wholesale means
  // hoisting useKeyboardShortcuts' handler table out of its effect, which is a
  // bigger change than #175 justifies and would put 40 untested paths into a
  // patch release.
  //
  // resetTerminal is wired anyway, because it is a *recovery* command: the
  // pane it exists for is one where the mouse is dead and the keyboard may be
  // going somewhere unexpected, and "open the palette and pick it" is the one
  // route that still works when the shortcut itself is what the user cannot
  // remember. Listing it and not running it would be worse than not listing it.
  const handlePaletteAction = useCallback((action: string) => {
    if (action === 'resetTerminal') {
      const ws = workspaces.find((w) => w.id === activeWorkspaceId);
      const leaf = ws && focusedPaneId ? findLeaf(ws.splitTree, focusedPaneId) : undefined;
      const surface = leaf?.surfaces[leaf.activeSurfaceIndex];
      if (surface?.type === 'terminal') {
        document.dispatchEvent(new CustomEvent('wmux:reset-terminal', { detail: { surfaceId: surface.id } }));
      }
    } else {
      console.log(`[wmux] Command palette action: ${action}`);
    }
    setCommandPaletteOpen(false);
  }, [workspaces, activeWorkspaceId, focusedPaneId]);

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
            onClose={requestCloseWorkspace}
            onCreate={handleCreateWorkspace}
            onRename={renameWorkspace}
            onReorder={reorderWorkspaces}
            onUpdateMetadata={handleUpdateMetadata}
            hookActivity={hookActivity}
            claudeActivity={claudeActivity}
            agentStates={agentStates}
            onSaveSession={handleSaveSession}
            onLoadSession={handleLoadSession}
            onCollapse={toggleSidebar}
            onFocusAgentPane={(wsId, paneId) => {
              selectWorkspace(wsId);
              setFocusedPaneId(paneId);
            }}
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
            title={t('app.expandSidebar', 'Expand sidebar (Ctrl+B)')}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/>
            </svg>
          </div>
        )}

        {/* Middle: terminals — ALL workspaces stay mounted, only active is visible */}
        {/* This keeps PTYs alive when switching sessions (Claude Code etc. keep running) */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minWidth: 0 }}>
          {customBgActive && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                background: appearancePrefs.customBackground,
                pointerEvents: 'none',
              }}
            />
          )}
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
                title={t('app.closeBrowserPanel', 'Close browser panel')}
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

      <ConfirmCloseDialog />
      <ConfirmCloseSurfaceDialog />

      {broadcastInputActive && (
        <div className="broadcast-input-banner" title={t('app.broadcastInputTooltip', 'Typed input is sent to every terminal pane in this workspace')}>
          {t('app.broadcastInputBanner', 'Broadcast input ON — typing goes to all panes (Ctrl+Alt+B to stop)')}
        </div>
      )}
    </div>
  );
}
