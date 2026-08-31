// ID types
export type WorkspaceId = `ws-${string}`;
export type PaneId = `pane-${string}`;
export type SurfaceId = `surf-${string}`;
export type WindowId = `win-${string}`;

// Split tree
export type SplitNode =
  | { type: 'leaf'; paneId: PaneId; surfaces: SurfaceRef[]; activeSurfaceIndex: number }
  | { type: 'branch'; direction: 'horizontal' | 'vertical'; ratio: number; children: [SplitNode, SplitNode] };

/**
 * `prompts` is the prompt outline (issue #207) as a pane rather than an overlay.
 *
 * The overlay it joins is not replaced: an overlay is right for a glance and
 * wrong for a panel you keep open, because it floats over the terminal it is
 * describing and takes rows away from it. As a surface it splits, resizes and
 * persists like anything else, which is what "keep it open next to the terminal"
 * actually requires. Both drive the same per-surface prompt log, so neither is a
 * second implementation of anything.
 */
export type SurfaceType = 'terminal' | 'browser' | 'markdown' | 'diff' | 'code' | 'prompts';

/**
 * Which engine backs a `browser` surface.
 *
 * `web`   — the Electron <webview>. The default, always, and what every
 *           browser surface was before agent-browser existed.
 * `agent` — vercel-labs/agent-browser: a real Chrome driven by the CLI, shown
 *           through its own dashboard.
 *
 * Absent means `web`, so an older saved session restores correctly with no
 * migration (session-persistence.ts superset rule, #145).
 */
export type BrowserEngine = 'web' | 'agent';

export interface SurfaceRef {
  id: SurfaceId;
  type: SurfaceType;
  customTitle?: string;
  /**
   * How this surface was ASKED to start: a bare executable, or a whole command
   * line such as `ssh user@host` (issue #78). Immutable once set — it is what
   * respawns the surface after a restart, so anything that overwrites it with
   * a resolved executable silently breaks restore for every spec that carries
   * arguments. The tab label wants the resolved value; that is `resolvedShell`.
   */
  shell?: string;
  /**
   * The executable `shell` actually resolved to, reported back by the PTY.
   * Display only — the tab caption uses it so a pane started with no spec at
   * all can still say "PowerShell" rather than "Terminal".
   */
  resolvedShell?: string;
  /** Per-surface color scheme override (bundled theme name or user-defined scheme name). */
  colorScheme?: string;
  /** Per-surface working directory override (quick-launch profiles — issue #32). */
  cwd?: string;
  /** Live working directory updated by shell integration on every prompt. */
  currentCwd?: string;
  /** Commands run once after the terminal PTY spawns (quick-launch profiles — issue #32). */
  startupCommands?: string[];
  /**
   * Claude Code session this terminal was running when the session was saved
   * (issue #186). Written only into the PERSISTED copy of the tree, by
   * `stampClaudeSessionIds` in the main process — a live surface never carries
   * one, so it cannot go stale in the store. On restore, and only when
   * `workspacePrefs.restoreClaudeSessions` is on, the pane spawns with
   * `claude --resume <id>` prepended to its startup commands.
   */
  claudeSessionId?: string;
  /** Initial URL for a browser surface created from a quick-launch profile (issue #32). */
  url?: string;
  /**
   * Which engine backs this browser surface. Absent ⇒ 'web'. Read through
   * `engineOf()` rather than directly, so an absent or corrupt value can only
   * ever degrade to the safe engine.
   */
  browserEngine?: BrowserEngine;
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
   *  survives a restart — and comes back still marked unsaved.
   *
   *  Read by the CODE surface too, despite the name. It is the one flag meaning
   *  "this surface has unsaved edits", and three places already act on it: the
   *  tab's `•`, the close confirmation, and the preview-tab recycler, which
   *  refuses to reuse a dirty tab for the next file. A second `codeDirty` would
   *  have had to be added to all three, and the one that got missed would have
   *  been the recycler — silently discarding the user's edits on their next
   *  click in the tree. */
  markdownDirty?: boolean;

  // ─── Code viewer surface ───────────────────────────────────────────────────
  // A read-only text view of a file the explorer opened. Deliberately its OWN
  // type rather than a flag on `markdown`: a .rs file in a surface labelled
  // markdown lies to `wmux markdown get`, to the tab icon, and to session
  // restore. Read-only is structural — CodePane has no editor — not a flag
  // every future feature has to remember to check.

  /** Absolute path of the file. ALWAYS set: a code surface is never pathless,
   *  which is the difference from `markdownFilePath` that lets the buffer go
   *  unpersisted. */
  codeFilePath?: string;
  /** Basename, used as the tab label. */
  codeFileName?: string;
  /** Path relative to the surface's explorer root. Carried because a reload
   *  goes back through `code.read-file`, which takes a relPath — rebuilding one
   *  would mean re-deriving the root in the renderer, which is exactly what the
   *  jail exists to prevent. */
  codeRelPath?: string;
  /**
   * The TERMINAL surface whose explorer root this file was read under.
   *
   * Persisted, and the reason a restored code tab can refill itself: main
   * addresses a code read by (surfaceId, relPath) where the surfaceId must be
   * a live, owned terminal — the code surface's OWN id has no PTY and no
   * reported cwd, so reading with it always answers `no_root`. Surface ids
   * survive a restore verbatim (replaceAllWorkspaces takes the saved splitTree
   * as-is), so the terminal this points at is the same one after a restart.
   */
  codeRootSurfaceId?: SurfaceId;
  /**
   * The file's text. In-store only — STRIPPED by dropCodeContent before any
   * persistence, unlike markdownContent which is deliberately persisted.
   *
   * Two reasons, both concrete. dropEphemeralSurfaces promotes a leaf's only
   * clean ephemeral surface rather than dropping it, so a code preview tab
   * genuinely can reach session.json and a saved layout. And instantiateLayout
   * spreads every surface field through, so a persisted buffer would be reborn
   * as a stale ghost of a file in every workspace made from that layout — the
   * same failure workspace-slice.ts:276 describes for `ephemeral`.
   */
  codeContent?: string;
  /**
   * An explorer preview tab: the next single-click replaces it in place rather
   * than opening another tab. Cleared when the user promotes it (double-click,
   * Ctrl+click, or an edit). Never persisted — see the session mappers.
   */
  ephemeral?: boolean;
}

// ─── File explorer ───────────────────────────────────────────────────────────
// Directory ENUMERATION was the original capability here. MARKDOWN reads still
// go through markdown.readFile, which is unjailed by deliberate existing
// design; CODE reads go through code:read-file, which is jailed to the same
// root this enumeration uses and has no extension whitelist at all — the two
// are inverses of each other, and neither widens the other. Either way the
// renderer supplies no filesystem path at any point — only a surfaceId and a
// relative path, both of which main validates.

/**
 * Per-directory enumeration cap. Declared here rather than in explorer-fs.ts
 * because the renderer's "showing the first N entries" banner has to state the
 * same number, and a renderer may not import from src/main/.
 */
export const EXPLORER_MAX_ENTRIES = 2000;

export interface ExplorerEntry {
  name: string;
  kind: 'dir' | 'file' | 'symlink';
  size: number;
  mtimeMs: number;
  /**
   * Whether the tree offers this entry as clickable. A cheap NAME-based hint,
   * not a promise: the content sniff runs at open, so a viewable file can still
   * come back `binary`. Directories and symlinks are never viewable.
   */
  viewable: boolean;
}

export interface ExplorerListOk {
  /**
   * Absolute, realpath'd Windows root main resolved for this surface.
   *
   * NOT display-only: this is the ONLY spelling of the root the renderer may
   * build absolute paths from. The cwd a shell reports is not usable for that
   * — Git Bash reports `/c/Users/...`, and a PowerShell cwd can be a junction,
   * an 8.3 short name, or differently cased. Main normalizes and realpaths all
   * of those on the way in, so enumeration works either way, but a path the
   * renderer concatenates from the REPORTED cwd is a path `markdown.readFile`,
   * `markdown.reveal`, `markdown.openInApp` and the clipboard all choke on.
   */
  root: string;
  /** The listed directory relative to `root`, POSIX separators, '' for the root. */
  relPath: string;
  entries: ExplorerEntry[];
  /** Directory exceeded MAX_ENTRIES; `entries` is a prefix. */
  truncated: boolean;
}

export type ExplorerErrorCode =
  | 'no_root'         // surface has reported no cwd yet
  | 'remote'          // surface is inside ssh; its cwd is not a local path
  | 'invalid_path'    // relPath failed the Windows path policy
  | 'outside_root'    // escaped the jail
  | 'not_found'
  | 'not_a_directory'
  | 'binary'          // deny-listed extension, or the content sniff rejected it
  | 'executable'      // a shell action refused to launch a program or script
  | 'too_large'       // exceeds MAX_CODE_BYTES
  | 'denied'          // EACCES/EPERM
  | 'read_failed'
  // ─── Write-side codes ──────────────────────────────────────────────────────
  | 'not_granted'     // never opened into a live pane in this window — see file-grants.ts
  | 'conflict'        // changed on disk since it was read; the save was REFUSED, not merged
  | 'write_failed';

/** `error` stays English for main-process callers; `code` is what the renderer
 *  maps to a translation key. Same split as MarkdownReadError (commit 82a779f). */
export interface ExplorerListError { error: string; code: ExplorerErrorCode }

export type ExplorerListResult = ExplorerListOk | ExplorerListError;

/**
 * One changed file, as the explorer's +N/-N column consumes it.
 *
 * Structurally the `ChangedFile` main/diff-provider.ts already produces — named
 * separately here only because `shared/` may not import from `main/`. The two
 * are pinned together by a test rather than by a comment, so a field added on
 * one side cannot silently go missing on the other.
 *
 * `path` is POSIX-separated and relative to the root, matching both git's own
 * output and what `listDir` puts on the wire. Every consumer keys on that one
 * spelling; nothing downstream re-derives it with `path.sep`.
 */
export interface ExplorerDiffEntry {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface ExplorerDiffOk {
  root: string;
  files: ExplorerDiffEntry[];
  /**
   * Which baseline produced these numbers, so the panel can say so rather than
   * leaving the user to guess whether `+55` means "since my last commit" or
   * "since I opened wmux". They are genuinely different questions and the
   * provider picks between them on its own.
   */
  baseline: 'git' | 'snapshot';
}

export type ExplorerDiffResult = ExplorerDiffOk | ExplorerListError;

/**
 * A user-saved pane layout: geometry plus whatever each pane's surface was
 * already running (shell/cwd/startupCommands) at the moment it was captured
 * from a live workspace. Multiple can be saved; one may be marked the default
 * applied to every new workspace (`WorkspacePrefs.defaultLayoutId`), and any
 * of them can also be applied on demand.
 *
 * `splitTree`'s pane/surface ids are stale the instant this is saved — always
 * pass it through `instantiateLayout()` before handing it to a workspace, so
 * two workspaces never share a pane/surface id (breaks PTY re-attachment).
 */
export interface SavedLayout {
  id: string;
  name: string;
  splitTree: SplitNode;
  createdAt: number;
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
  explorerOpen?: boolean;
  explorerWidth?: number;
  /** Expanded dirs by root path, POSIX separators. Capped at 8 roots, LRU. */
  explorerExpanded?: Record<string, string[]>;
  /**
   * Whether the explorer lists dotfiles and filtered names. Per-workspace, the
   * same scope as `explorerOpen` and `explorerWidth` — the panel is a view onto
   * one workspace's tree, so a repo where `.github/` matters does not drag a
   * repo where it is noise along with it.
   */
  explorerShowHidden?: boolean;
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
    // Declared here for the same reason browserWidth is: #145 was a save path
    // quietly dropping fields the type never mentioned.
    explorerOpen?: boolean;
    explorerWidth?: number;
    explorerExpanded?: Record<string, string[]>;
    explorerShowHidden?: boolean;
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

/**
 * What main decided a paste or drop should type into the terminal.
 *
 * The renderer only inserts `text` and reports `failure`; every decision —
 * is this pane remote, is upload enabled, did scp work — was already made.
 */
export interface InsertionResult {
  /** Text to type, or null when nothing should be inserted. */
  text: string | null;
  /**
   * Set when an upload failed. Carried in pieces rather than as a finished
   * sentence so the renderer can translate it.
   */
  failure?: { destination: string; detail: string };
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
  // Remote file upload (ssh panes) — main resolves the whole paste/drop
  REMOTE_RESOLVE_PASTE: 'remote:resolve-paste',
  REMOTE_RESOLVE_DROP: 'remote:resolve-drop',
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
  /** Bootstrap for AGENT_STATE, which is delta-only — a new window starts blind. */
  AGENT_STATE_LIST: 'agent:state-list',
  /**
   * Which agent a surface is running: `{ surfaceId, kind, source }`.
   *
   * A separate channel from AGENT_STATE because it answers a different question
   * (WHO, not HOW) and has a different source of truth. Carries the derived
   * agent KIND only — never the command line it was derived from, which is the
   * user's full typed input and routinely holds credentials.
   */
  AGENT_IDENTITY: 'agent:identity',
  AGENT_IDENTITY_LIST: 'agent:identity-list',
  /**
   * Renderer → main mirror of what the detection loop decided, so the CLI and
   * the pipe can answer without interrupting the thread that draws terminals.
   * Carries the VERDICT, never the screen text it was read from.
   */
  AGENT_DETECTION: 'agent:detection',
  /** Main → renderer: bundled manifests with user overrides applied. */
  AGENT_DETECTION_MANIFESTS: 'agent:detection-manifests',
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
  /** Flash this window's taskbar button — an agent started waiting on the user. */
  WINDOW_FLASH: 'window:flash',
  WINDOW_SET_BACKDROP: 'window:setBackdrop',
  WINDOW_SUPPORTS_BACKDROP: 'window:supportsBackdrop',
  WINDOW_CLOSE_SELF: 'window:closeSelf',
  WINDOW_IS_FRAMELESS: 'window:isFrameless',
  WINDOW_RELAUNCH: 'window:relaunch',
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
  /**
   * agent-browser engine control for ONE browser surface (renderer → main).
   *
   * Distinct from the `browser.*`/CDP channels above, which run a verb against
   * whichever engine a surface already has: these change WHICH engine it has,
   * plus the install flow that makes `agent` reachable at all. The renderer
   * cannot do any of it itself — the binary, the session registry and the
   * dashboard refcount all live in main.
   *
   * `CURRENT_URL` and `OPEN` are the two exceptions to that framing, and they
   * exist because the pane's address bar was lying. In agent mode the bar can
   * only show the last URL the PANE asked for, while the agent navigates the
   * real Chrome independently — so the two drift and the bar reports a page
   * nobody is on. `CURRENT_URL` reads where the session actually is.
   * `OPEN` is its counterpart: the pane used to reuse `ENABLE` to mean
   * "navigate", which re-acquired the dashboard and re-bound the stream on
   * every address-bar Enter.
   */
  AGENT_BROWSER_ENABLE: 'agent-browser:enable',
  AGENT_BROWSER_DISABLE: 'agent-browser:disable',
  AGENT_BROWSER_STATUS: 'agent-browser:status',
  AGENT_BROWSER_INSTALL: 'agent-browser:install',
  AGENT_BROWSER_CURRENT_URL: 'agent-browser:current-url',
  AGENT_BROWSER_OPEN: 'agent-browser:open',
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
  // File explorer: directory enumeration, jailed to the surface's root in main.
  EXPLORER_LIST_DIR: 'explorer:list-dir',
  // Per-file change counts for the tree's +N/-N column. Takes a surfaceId and
  // NOT a cwd: `diff:get-files` above answers the same question from an
  // absolute path the renderer supplies, which predates the explorer's jail and
  // is exactly the pattern it exists to reject. Both call the same
  // diff-provider, so the two views can never disagree about what changed.
  EXPLORER_DIFF_STATS: 'explorer:diff-stats',
  // Code viewer: read one text file, jailed to the same root list-dir uses.
  CODE_READ_FILE: 'code:read-file',
  // Write it back. Jail + grant set + mtime guard — see main/file-grants.ts for
  // why a jail alone is not the whole answer.
  CODE_WRITE_FILE: 'code:write-file',
  // A markdown read that goes THROUGH the jail, and therefore mints a grant.
  // Distinct from MARKDOWN_READ_FILE, which takes a renderer-supplied absolute
  // path and mints nothing.
  EXPLORER_READ_MARKDOWN: 'explorer:read-markdown',
  // Shell actions on a listed entry, jailed the same way. Their own channels
  // rather than the markdown ones, whose extension whitelist silently rejects
  // every ordinary source file the tree now offers.
  EXPLORER_REVEAL: 'explorer:reveal',
  EXPLORER_OPEN_IN_APP: 'explorer:open-in-app',
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

/**
 * The engine a surface actually runs on. Never trust the raw field: it is
 * persisted to a user-editable session file, and every unknown value must
 * degrade to `web` — the engine that needs no external binary and so can
 * always be rendered.
 */
export function engineOf(surface: { type: SurfaceType; browserEngine?: BrowserEngine }): BrowserEngine {
  if (surface.type !== 'browser') return 'web';
  return surface.browserEngine === 'agent' ? 'agent' : 'web';
}
