// ID types
export type WorkspaceId = `ws-${string}`;
export type PaneId = `pane-${string}`;
export type SurfaceId = `surf-${string}`;
export type WindowId = `win-${string}`;

// Split tree
export type SplitNode =
  | { type: 'leaf'; paneId: PaneId; surfaces: SurfaceRef[]; activeSurfaceIndex: number }
  | { type: 'branch'; direction: 'horizontal' | 'vertical'; ratio: number; children: [SplitNode, SplitNode] };

export type SurfaceType = 'terminal' | 'browser' | 'markdown' | 'diff';

export interface SurfaceRef {
  id: SurfaceId;
  type: SurfaceType;
  customTitle?: string;
  shell?: string;
  /** Per-surface color scheme override (bundled theme name or user-defined scheme name). */
  colorScheme?: string;
  /** Per-surface working directory override (quick-launch profiles — issue #32). */
  cwd?: string;
  /** Live working directory updated by shell integration on every prompt. */
  currentCwd?: string;
  /** Commands run once after the terminal PTY spawns (quick-launch profiles — issue #32). */
  startupCommands?: string[];
  /** Initial URL for a browser surface created from a quick-launch profile (issue #32). */
  url?: string;
  /** Rendered markdown content for a `markdown` surface (issue #54). Persisted so
   *  the content survives split-tree restructures that remount the pane. */
  markdownContent?: string;
  /** Basename of the file backing a `markdown` surface, shown as the tab label
   *  instead of the generic "Markdown" so multiple markdown tabs are
   *  distinguishable. Only set when the surface was populated from a file. */
  markdownFileName?: string;
  /** Absolute path of the file backing a `markdown` surface (issue #116). Shown
   *  in the pane toolbar, copyable, and what "reload from disk" re-reads.
   *  Deliberately absent for content pushed via `markdown.set_content` or an
   *  empty Ctrl+Shift+M scratch surface — pathless is a first-class state, not
   *  an error, since agent-pushed content is the original use case. */
  markdownFilePath?: string;
  /** Preview (rendered) vs source (raw, line-numbered) view of a `markdown`
   *  surface (issue #116). Persisted for the same reason as `markdownContent`:
   *  split-tree restructures remount the pane and would otherwise reset it. */
  markdownViewMode?: 'preview' | 'source';
  /** mtime of the backing file as of the last successful load or save (F3).
   *  Compared before overwriting so an agent rewriting the file under the pane
   *  is caught instead of silently losing to whoever saves last. */
  markdownFileMtime?: number;
  /** Buffer differs from what is on disk (F3). Shown as a `•` on the tab and
   *  confirmed before closing. Persisted with the content, so an unsaved edit
   *  survives a restart — and comes back still marked unsaved. */
  markdownDirty?: boolean;
}

/**
 * Quick-launch profile (issue #32): a one-click tab preset surfaced in the `+`
 * caret dropdown. Lets a user open a terminal that auto-`cd`s and runs startup
 * commands, picks a specific shell, or opens a browser tab at a fixed URL.
 * Two scopes: `global` (user settings) and `project` (committed `.wmux.json`).
 */
export interface QuickLaunchProfile {
  id: string;
  name: string;
  /** Short glyph/emoji shown in the dropdown (optional). */
  icon?: string;
  type: SurfaceType;
  /** Terminal: shell executable override (falls back to the workspace shell). */
  shell?: string;
  /** Terminal/browser: working directory. Relative paths resolve against the workspace cwd. */
  cwd?: string;
  /** Terminal: commands run once after the PTY spawns. */
  startupCommands?: string[];
  /** Browser: initial URL to open. */
  url?: string;
  /** Provenance, set at load time (not persisted in config). */
  source?: 'global' | 'project';
}

// Workspace
export interface WorkspaceInfo {
  id: WorkspaceId;
  title: string;
  customColor?: string;
  pinned: boolean;
  shell: string;
  splitTree: SplitNode;
  unreadCount: number;
  gitBranch?: string;
  gitDirty?: boolean;
  cwd?: string;
  // The last POSIX/WSL directory known for this workspace, kept apart from
  // `cwd` because one workspace can hold panes in two filesystems at once.
  // `cwd` is whichever pane reported last, so a single pwsh/cmd pane rewrites
  // it to a Win32 path — and a WSL pane with no cwd of its own then falls back
  // to a path wsl.exe cannot open, so `--cd` degrades to `~` and the pane
  // silently lands in the WSL home instead of the project. Only POSIX reports
  // (and a POSIX folder at creation) write here, so the WSL fallback survives
  // a Win32 pane living in the same workspace.
  posixCwd?: string;
  prNumber?: number;
  prStatus?: 'open' | 'merged' | 'closed';
  prLabel?: string;
  // Which surface reported the currently-shown PR (issue #4 continued). Every
  // PowerShell pane in a workspace polls its own PR independently and all of
  // them write these same workspace-scoped fields, so without an owner a
  // `clear_pr` from one pane can wipe a PR a DIFFERENT pane just reported.
  // Gates `clear_pr` in `applyPrCommand` (pr-metadata.ts) and the badge's
  // teardown-on-close in `surface-slice.ts`.
  prSurfaceId?: SurfaceId;
  ports?: number[];
  notificationText?: string;
  shellState?: 'idle' | 'running' | 'interrupted';
  // Manual pin of the sidebar status indicator (issue #81). When set it wins
  // over all detection (shell integration, Claude observer/hooks); cleared
  // (undefined) means automatic.
  statusOverride?: 'running' | 'idle';
  browserUrl?: string;
  browserWidth?: number;
}

// Surface
export interface SurfaceInfo {
  id: SurfaceId;
  type: SurfaceType;
  title?: string;
}

// Pane
export interface PaneInfo {
  id: PaneId;
  surfaces: SurfaceInfo[];
  activeSurfaceId: SurfaceId;
}

// Window
export interface WindowInfo {
  id: WindowId;
  bounds: { x: number; y: number; width: number; height: number };
  workspaceIds: WorkspaceId[];
  activeWorkspaceId: WorkspaceId;
}

// Theme
export interface ThemeConfig {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  cursorText: string;
  selectionBackground: string;
  selectionForeground: string;
  palette: string[]; // 16 ANSI colors
  fontFamily: string;
  fontSize: number;
  backgroundOpacity: number;
}

// Notification
export interface NotificationInfo {
  id: string;
  surfaceId: SurfaceId;
  workspaceId: WorkspaceId;
  paneId?: PaneId;
  text: string;
  title?: string;
  timestamp: number;
  read: boolean;
}

// Agent system
export type AgentId = `agent-${string}`;

export interface AgentInfo {
  agentId: AgentId;
  surfaceId: SurfaceId;
  paneId: PaneId;
  workspaceId: WorkspaceId;
  label: string;
  cmd: string;
  status: 'spawning' | 'running' | 'exited';
  exitCode?: number;
  pid?: number;
  spawnTime: number;
}

export interface AgentSpawnParams {
  cmd: string;
  label: string;
  cwd?: string;
  env?: Record<string, string>;
  paneId?: PaneId;
  workspaceId?: WorkspaceId;
  /** Replace the target pane's sole idle default terminal tab instead of appending. */
  replaceTab?: boolean;
}

export interface AgentBatchParams {
  agents: AgentSpawnParams[];
  strategy: 'distribute' | 'stack' | 'split';
  workspaceId?: WorkspaceId;
}

// CDP Browser API
export interface CDPSnapshot {
  tree: string;
  refCount: number;
}

// Shell
export interface ShellInfo {
  name: string;
  command: string;
  args: string[];
  available: boolean;
}

// Sidebar metadata
export interface SidebarMetadata {
  gitBranch?: string;
  gitDirty?: boolean;
  cwd?: string;
  prNumber?: number;
  prStatus?: string;
  prLabel?: string;
  prSurfaceId?: SurfaceId;
  ports?: number[];
  notificationText?: string;
  shellState?: 'idle' | 'running' | 'interrupted';
  statusEntries?: Record<string, string>;
  progress?: { value: number; label?: string };
  logs?: Array<{ level: string; message: string; timestamp: number }>;
}

// Saved session (user-named layout snapshot)
export interface SavedSession {
  name: string;
  savedAt: number;
  workspaces: Array<{
    title: string;
    customColor?: string;
    shell: string;
    cwd: string;
    // The POSIX/WSL directory, kept apart from `cwd` because a pwsh pane's
    // report overwrites the latter with a Win32 path and strands every WSL pane
    // in the workspace on `--cd ~`. Optional: sessions saved before this field
    // existed recover via the isPosixPath(cwd) seed in replaceAllWorkspaces.
    posixCwd?: string;
    splitTree: SplitNode;
    browserUrl?: string;
    // Both written since 0.4x; declared here as of #145, which was caused by a
    // save path quietly dropping fields the type never mentioned.
    browserWidth?: number;
    pinned?: boolean;
  }>;
  sidebarWidth: number;
  // Optional for backward-compat with pre-0.7.6 sessions.
  terminalPrefs?: {
    fontFamily: string;
    fontSize: number;
    theme: string;
    cursorStyle: 'block' | 'underline' | 'bar';
    cursorBlink: boolean;
    scrollbackLines: number;
    userColorSchemes: Record<string, {
      background?: string;
      foreground?: string;
      cursor?: string;
      cursorText?: string;
      selectionBackground?: string;
      selectionForeground?: string;
      palette?: string[];
    }>;
  };
}

// IPC channel names
export const IPC_CHANNELS = {
  // PTY
  PTY_CREATE: 'pty:create',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_HAS: 'pty:has',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  // Workspace
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_CLOSE: 'workspace:close',
  WORKSPACE_SELECT: 'workspace:select',
  WORKSPACE_RENAME: 'workspace:rename',
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_REORDER: 'workspace:reorder',
  WORKSPACE_MOVE_TO_WINDOW: 'workspace:moveToWindow',
  // Surface
  SURFACE_CREATE: 'surface:create',
  SURFACE_CLOSE: 'surface:close',
  SURFACE_FOCUS: 'surface:focus',
  SURFACE_LIST: 'surface:list',
  SURFACE_READ_TEXT: 'surface:readText',
  SURFACE_SEND_TEXT: 'surface:sendText',
  SURFACE_SEND_KEY: 'surface:sendKey',
  SURFACE_TRIGGER_FLASH: 'surface:triggerFlash',
  // Pane
  PANE_SPLIT: 'pane:split',
  PANE_CLOSE: 'pane:close',
  PANE_FOCUS: 'pane:focus',
  PANE_ZOOM: 'pane:zoom',
  PANE_LIST: 'pane:list',
  // Notification
  NOTIFICATION_FIRE: 'notification:fire',
  NOTIFICATION_LIST: 'notification:list',
  NOTIFICATION_CLEAR: 'notification:clear',
  NOTIFICATION_JUMP: 'notification:jump',
  // Settings
  AGENT_ANSWER: 'agent:answer',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_CHANGED: 'settings:changed',
  // Window
  WINDOW_CREATE: 'window:create',
  WINDOW_CLOSE: 'window:close',
  WINDOW_FOCUS: 'window:focus',
  WINDOW_LIST: 'window:list',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  WINDOW_SET_PROGRESS: 'window:setProgress',
  // Config
  CONFIG_GET_THEME: 'config:getTheme',
  CONFIG_GET_THEME_LIST: 'config:getThemeList',
  CONFIG_IMPORT_WT: 'config:importWindowsTerminal',
  CONFIG_IMPORT_GHOSTTY: 'config:importGhostty',
  CONFIG_GET_USER_CONFIG: 'config:getUserConfig',
  CONFIG_RELOAD_USER_CONFIG: 'config:reloadUserConfig',
  CONFIG_USER_CONFIG_UPDATED: 'config:userConfigUpdated',
  // System
  SYSTEM_GET_SHELLS: 'system:getShells',
  SYSTEM_GET_FONTS: 'system:getFonts',
  SYSTEM_OPEN_EXTERNAL: 'system:openExternal',
  SYSTEM_GET_VERSION: 'system:getVersion',
  SYSTEM_PICK_FOLDER: 'system:pickFolder',
  SYSTEM_GET_CONTEXT_MENU: 'system:getContextMenu',
  SYSTEM_SET_CONTEXT_MENU: 'system:setContextMenu',
  SYSTEM_GET_SHOULD_USE_DARK_COLORS: 'system:getShouldUseDarkColors',
  SYSTEM_NATIVE_THEME_UPDATED: 'system:nativeThemeUpdated',
  // Metadata events (main → renderer)
  METADATA_UPDATE: 'metadata:update',
  // Agent
  AGENT_SPAWN: 'agent:spawn',
  AGENT_SPAWN_BATCH: 'agent:spawn-batch',
  AGENT_STATUS: 'agent:status',
  AGENT_LIST: 'agent:list',
  AGENT_KILL: 'agent:kill',
  AGENT_UPDATE: 'agent:update',
  // CDP (browser.* pipe methods map to these internal IPC channels)
  CDP_ATTACH: 'cdp:attach',
  CDP_DETACH: 'cdp:detach',
  CDP_NAVIGATE: 'cdp:navigate',
  CDP_SNAPSHOT: 'cdp:snapshot',
  CDP_CLICK: 'cdp:click',
  CDP_TYPE: 'cdp:type',
  CDP_FILL: 'cdp:fill',
  CDP_SCREENSHOT: 'cdp:screenshot',
  CDP_GET_TEXT: 'cdp:get-text',
  CDP_EVAL: 'cdp:eval',
  CDP_WAIT: 'cdp:wait',
  // Active workspace query (renderer → main)
  GET_ACTIVE_WORKSPACE: 'get-active-workspace',
  // Hook events (Claude Code hooks → main → renderer)
  HOOK_EVENT: 'hook:event',
  // Claude Code activity (parsed from PTY output → renderer)
  CLAUDE_ACTIVITY: 'claude:activity',
  // Declared agent run state (pane.report_agent → main → renderer, issue #128)
  AGENT_STATE: 'agent:state',
  // Named sessions
  SESSION_SAVE_NAMED: 'session:save-named',
  SESSION_LOAD_NAMED: 'session:load-named',
  SESSION_LIST_NAMED: 'session:list-named',
  SESSION_DELETE_NAMED: 'session:delete-named',
  // Auto-saved session (the rolling 30s snapshot the main process writes)
  SESSION_LOAD_AUTO: 'session:load-auto',
  // Diff viewer
  DIFF_GET_FILES: 'diff:get-files',
  DIFF_GET_DIFF: 'diff:get-diff',
  DIFF_UPDATE: 'diff:update',
  // Markdown viewer (issue #54) — file picker for the manual "open markdown" UI
  MARKDOWN_OPEN_FILE: 'markdown:open-file',
  // Markdown viewer (issue #116) — path-aware surfaces: re-read a known file
  // (reload / drag-and-drop) plus the two read-only shell actions. All three go
  // through the guards in main/markdown-file.ts.
  MARKDOWN_READ_FILE: 'markdown:read-file',
  MARKDOWN_REVEAL: 'markdown:reveal',
  MARKDOWN_OPEN_IN_APP: 'markdown:open-in-app',
  // F3 (issue #116) — the first renderer→disk writes in this surface. Both go
  // through the grant set in ./markdown-grants; save-as is also what mints a
  // grant for a surface that had no backing file.
  MARKDOWN_SAVE_FILE: 'markdown:save-file',
  MARKDOWN_SAVE_AS: 'markdown:save-as',
  MARKDOWN_STAT_FILE: 'markdown:stat-file',
  // Orchestration (wmux-orchestrator plugin state broadcast)
  ORCHESTRATION_UPDATE: 'orchestration:update',
  ORCHESTRATION_CLEAR: 'orchestration:clear',
  // App update notification (GitHub releases polling — badge in the titlebar)
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_GET_LATEST: 'update:get-latest',
  UPDATE_OPEN_RELEASE: 'update:open-release',
  // In-app download/install driven by the badge (issue #125). UPDATE_INSTALL
  // starts (or confirms) the flow; UPDATE_STATE streams checking → downloading
  // → ready back to the badge.
  UPDATE_INSTALL: 'update:install',
  UPDATE_GET_STATE: 'update:get-state',
  UPDATE_STATE: 'update:state',
} as const;

// ─── Orchestration state (wmux-orchestrator plugin) ────────────────────────
// Mirrors the shape written by the plugin into {TMPDIR}/wmux-orch-*/state.json.

export type OrchAgentStatus = 'pending' | 'running' | 'exited' | 'failed';
export type OrchWaveStatus = 'pending' | 'running' | 'complete' | 'failed';
export type OrchRunStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface OrchestrationAgent {
  id: string;
  label: string;
  subtask?: string;
  files?: string[];
  excludeFiles?: string[];
  paneId?: string | null;
  surfaceId?: string | null;
  status: OrchAgentStatus;
  exitCode?: number | null;
  toolUses?: number;
  resultFile?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastTool?: string;
}

export interface OrchestrationWave {
  index: number;
  status: OrchWaveStatus;
  blockedBy?: number[];
  agents: OrchestrationAgent[];
}

export interface OrchestrationReviewer {
  status: OrchRunStatus;
  agentId?: string | null;
  reportFile?: string;
}

export interface OrchestrationState {
  id: string;
  task: string;
  status: OrchRunStatus;
  startedAt: string;
  finishedAt?: string;
  cwd?: string;
  workspaceId?: string | null;
  dashboardSurfaceId?: string | null;
  useWorktrees?: boolean;
  waves: OrchestrationWave[];
  reviewer?: OrchestrationReviewer;
  // Client-side only — populated by the watcher so the renderer knows where to dismiss from.
  _orchDir?: string;
}
