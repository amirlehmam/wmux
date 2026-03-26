// ID types
export type WorkspaceId = `ws-${string}`;
export type PaneId = `pane-${string}`;
export type SurfaceId = `surf-${string}`;
export type WindowId = `win-${string}`;

// Split tree
export type SplitNode =
  | { type: 'leaf'; paneId: PaneId; surfaces: SurfaceRef[]; activeSurfaceIndex: number }
  | { type: 'branch'; direction: 'horizontal' | 'vertical'; ratio: number; children: [SplitNode, SplitNode] };

export interface SurfaceRef {
  id: SurfaceId;
  type: 'terminal' | 'browser' | 'markdown';
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
  prNumber?: number;
  prStatus?: 'open' | 'merged' | 'closed';
  prLabel?: string;
  ports?: number[];
  notificationText?: string;
  shellState?: 'idle' | 'running' | 'interrupted';
}

// Surface
export interface SurfaceInfo {
  id: SurfaceId;
  type: 'terminal' | 'browser' | 'markdown';
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
  ports?: number[];
  notificationText?: string;
  shellState?: 'idle' | 'running' | 'interrupted';
  statusEntries?: Record<string, string>;
  progress?: { value: number; label?: string };
  logs?: Array<{ level: string; message: string; timestamp: number }>;
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
  // Config
  CONFIG_GET_THEME: 'config:getTheme',
  CONFIG_GET_THEME_LIST: 'config:getThemeList',
  CONFIG_IMPORT_WT: 'config:importWindowsTerminal',
  CONFIG_IMPORT_GHOSTTY: 'config:importGhostty',
  // System
  SYSTEM_GET_SHELLS: 'system:getShells',
  SYSTEM_OPEN_EXTERNAL: 'system:openExternal',
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
} as const;
