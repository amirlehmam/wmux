import { StateCreator } from 'zustand';
import { QuickLaunchProfile } from '../../shared/types';
import { Language, detectDefaultLanguage } from '../i18n/core';

// ─── Persistence helpers (issue #12 + issue #15 + issue #19) ─────────────────
// Zustand has no persistence middleware here, so any pref that lives only in
// state resets on every launch — which made "Default shell" (issue #12) and
// theme/font/shortcut customizations (issue #15) feel broken.
//
// Settings used to live in renderer localStorage, but localStorage is scoped to
// the page origin. wmux ships as a portable zip extracted to a new folder per
// version, so the production `file://` origin changes between versions and
// Chromium buckets storage by that path — font/theme customizations appeared to
// reset on every update (issue #19). We now persist through the main process to
// %APPDATA%\wmux\settings.json (stable across updates), and migrate any existing
// localStorage values forward on first launch.

const STORAGE_KEYS = {
  workspacePrefs:    'wmux-workspace-prefs',
  terminalPrefs:     'wmux-terminal-prefs',
  sidebarPrefs:      'wmux-sidebar-prefs',
  notificationPrefs: 'wmux-notification-prefs',
  browserPrefs:      'wmux-browser-prefs',
  shortcuts:         'wmux-shortcuts',
  quickLaunchProfiles: 'wmux-quick-launch-profiles',
  language:          'wmux-language',
  appearancePrefs:   'wmux-appearance-prefs',
} as const;

// Read the whole settings file once at module load (synchronous IPC). The
// preload runs before this module, so window.wmux is already available. In
// non-Electron contexts (tests) this is absent and we fall back to localStorage.
function readFileSnapshot(): Record<string, any> {
  try {
    const snap = (globalThis as any).window?.wmux?.settings?.getAllSync?.();
    return snap && typeof snap === 'object' ? snap : {};
  } catch {
    return {};
  }
}

const FILE_SETTINGS = readFileSnapshot();

function loadPersisted<T>(key: string): Partial<T> {
  // File store is the source of truth; fall back to legacy localStorage and
  // migrate it forward so existing users keep their customizations.
  const fromFile = FILE_SETTINGS[key];
  if (fromFile && typeof fromFile === 'object') return fromFile as Partial<T>;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      try { (globalThis as any).window?.wmux?.settings?.set?.(key, parsed); } catch { /* no-op */ }
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

// Array-valued settings (e.g. quick-launch profiles) need their own loader:
// loadPersisted returns {} for a missing key, which isn't a usable array.
function loadPersistedArray<T>(key: string): T[] {
  const raw = FILE_SETTINGS[key];
  if (Array.isArray(raw)) return raw as T[];
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (ls) {
      const parsed = JSON.parse(ls);
      if (Array.isArray(parsed)) {
        try { (globalThis as any).window?.wmux?.settings?.set?.(key, parsed); } catch { /* no-op */ }
        return parsed as T[];
      }
    }
  } catch { /* fall through */ }
  return [];
}

// Scalar-valued settings (the UI language, issue #56) need their own loader:
// loadPersisted returns {} for a missing key, which isn't a usable string. Falls
// back to the OS/browser locale on first launch, then English.
function loadPersistedLanguage(): Language {
  const fromFile = FILE_SETTINGS[STORAGE_KEYS.language];
  let candidate = typeof fromFile === 'string' ? fromFile : '';
  if (!candidate) {
    try {
      const ls = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.language) : null;
      if (ls) {
        candidate = ls;
        try { (globalThis as any).window?.wmux?.settings?.set?.(STORAGE_KEYS.language, ls); } catch { /* no-op */ }
      }
    } catch { /* localStorage unavailable */ }
  }
  if (candidate === 'en' || candidate === 'fr' || candidate === 'zh') return candidate;
  return detectDefaultLanguage();
}

function persist<T>(key: string, value: T): void {
  try { (globalThis as any).window?.wmux?.settings?.set?.(key, value); } catch { /* no-op */ }
  // Keep a localStorage mirror as a harmless dev/non-Electron fallback.
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // localStorage unavailable (private mode, quota exceeded) — ignore
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ShortcutBinding {
  key: string; // e.g., 'n', 'd', 'w', 'b', 'PageDown'
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type ShortcutAction =
  | 'newWorkspace'
  | 'newWindow'
  | 'closeWorkspace'
  | 'closeWindow'
  | 'openFolder'
  | 'toggleSidebar'
  | 'nextWorkspace'
  | 'prevWorkspace'
  | 'renameSurface'
  | 'renameWorkspace'
  | 'splitRight'
  | 'splitDown'
  | 'splitBrowserRight'
  | 'splitBrowserDown'
  | 'toggleZoom'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'closeSurfaceOrPane'
  | 'newSurface'
  | 'nextSurface'
  | 'prevSurface'
  | 'jumpToUnread'
  | 'showNotifications'
  | 'flashFocused'
  | 'openBrowser'
  | 'browserDevTools'
  | 'browserConsole'
  | 'find'
  | 'copyMode'
  | 'copy'
  | 'paste'
  | 'fontSizeIncrease'
  | 'fontSizeDecrease'
  | 'fontSizeReset'
  | 'openSettings'
  | 'commandPalette'
  | 'openMarkdownPanel'
  | 'openDiffPanel'
  // ─── issue #64: high-value additions ──────────────────────────────────────
  | 'reopenClosedSurface'
  | 'findNext'
  | 'findPrevious'
  | 'resizePaneLeft'
  | 'resizePaneRight'
  | 'resizePaneUp'
  | 'resizePaneDown'
  | 'broadcastInput'
  | 'togglePinWorkspace'
  | 'markWorkspaceRead'
  | 'toggleShortcutCheatSheet';

// ─── Default shortcuts ────────────────────────────────────────────────────────

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, ShortcutBinding> = {
  newWorkspace:      { key: 'n', ctrl: true },
  newWindow:         { key: 'n', ctrl: true, shift: true },
  closeWorkspace:    { key: 'w', ctrl: true, shift: true },
  closeWindow:       { key: 'F4', alt: true },
  openFolder:        { key: 'o', ctrl: true },
  toggleSidebar:     { key: 'b', ctrl: true },
  nextWorkspace:     { key: 'PageDown', ctrl: true },
  prevWorkspace:     { key: 'PageUp', ctrl: true },
  renameSurface:     { key: 'F2', ctrl: true },
  renameWorkspace:   { key: 'F2', ctrl: true, shift: true },
  splitRight:        { key: 'd', ctrl: true },
  splitDown:         { key: 'd', ctrl: true, shift: true },
  splitBrowserRight: { key: 'd', ctrl: true, alt: true },
  splitBrowserDown:  { key: 'd', ctrl: true, alt: true, shift: true },
  toggleZoom:        { key: 'Enter', ctrl: true, shift: true },
  focusLeft:         { key: 'ArrowLeft', ctrl: true, alt: true },
  focusRight:        { key: 'ArrowRight', ctrl: true, alt: true },
  focusUp:           { key: 'ArrowUp', ctrl: true, alt: true },
  focusDown:         { key: 'ArrowDown', ctrl: true, alt: true },
  closeSurfaceOrPane:{ key: 'w', ctrl: true },
  newSurface:        { key: 't', ctrl: true },
  nextSurface:       { key: ']', ctrl: true, shift: true },
  prevSurface:       { key: '[', ctrl: true, shift: true },
  jumpToUnread:      { key: 'u', ctrl: true, shift: true },
  showNotifications: { key: 'n', ctrl: true, alt: true },
  flashFocused:      { key: 'f', ctrl: true, alt: true },
  openBrowser:       { key: 'i', ctrl: true, shift: true },
  browserDevTools:   { key: 'F12', ctrl: true },
  browserConsole:    { key: 'j', ctrl: true, shift: true },
  find:              { key: 'f', ctrl: true },
  copyMode:          { key: '[', ctrl: true, alt: true },
  copy:              { key: 'c', ctrl: true, shift: true },
  paste:             { key: 'v', ctrl: true, shift: true },
  fontSizeIncrease:  { key: '=', ctrl: true },
  fontSizeDecrease:  { key: '-', ctrl: true },
  fontSizeReset:     { key: '0', ctrl: true },
  openSettings:      { key: ',', ctrl: true },
  commandPalette:    { key: 'p', ctrl: true, shift: true },
  openMarkdownPanel: { key: 'm', ctrl: true, shift: true },
  openDiffPanel:     { key: 'g', ctrl: true, shift: true },
  // ─── issue #64 ──────────────────────────────────────────────────────────────
  // Defaults collision-checked against the bindings above. All use Shift/Alt or
  // function keys, so isSafeToIntercept() forwards bare-Ctrl combos to the
  // terminal unchanged (no SAFE_CTRL_KEYS edit needed).
  reopenClosedSurface:    { key: 't', ctrl: true, shift: true },
  findNext:               { key: 'F3' },
  findPrevious:           { key: 'F3', shift: true },
  resizePaneLeft:         { key: 'ArrowLeft', ctrl: true, shift: true },
  resizePaneRight:        { key: 'ArrowRight', ctrl: true, shift: true },
  resizePaneUp:           { key: 'ArrowUp', ctrl: true, shift: true },
  resizePaneDown:         { key: 'ArrowDown', ctrl: true, shift: true },
  broadcastInput:         { key: 'b', ctrl: true, alt: true },
  togglePinWorkspace:     { key: 'p', ctrl: true, alt: true },
  markWorkspaceRead:      { key: 'r', ctrl: true, alt: true },
  toggleShortcutCheatSheet: { key: 'F1' },
};

// ─── Sidebar settings ─────────────────────────────────────────────────────────

export interface SidebarPrefs {
  showGitBranch: boolean;
  showWorkingDir: boolean;
  showPR: boolean;
  showPorts: boolean;
  showNotificationMessage: boolean;
  hideAllDetails: boolean;
  activeTabIndicator: 'leftRail' | 'solidFill';
  backgroundOpacity: number; // 0–100
}

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = {
  showGitBranch: true,
  showWorkingDir: true,
  showPR: true,
  showPorts: true,
  showNotificationMessage: true,
  hideAllDetails: false,
  activeTabIndicator: 'leftRail',
  backgroundOpacity: 100,
};

// ─── Workspace settings ───────────────────────────────────────────────────────

export interface WorkspacePrefs {
  newWorkspacePlacement: 'afterCurrent' | 'top' | 'end';
  autoReorderOnNotification: boolean;
  defaultShell: string;
  /** Show the welcome/tutorial screen on first launch (issue #22). */
  showWelcomeScreen: boolean;
  /**
   * Auto-open a diff tab in the bottom pane when an in-pane agent (Claude Code)
   * edits/writes files (issue #63). Some users find the tab popping up — and
   * stealing tab focus — disruptive and want it off entirely (issue #66), so this
   * is an opt-out. Defaults on to preserve the shipped behaviour.
   */
  autoOpenDiffTab: boolean;
  /**
   * Ask before closing a session (issue #90): an accidental × click or
   * Ctrl+Shift+W kills every PTY in the workspace, including agents that
   * haven't persisted their state yet. Opt-in — off by default so the
   * one-click flow stays untouched for users who never asked for a guard.
   * Programmatic closes (CLI/agents via the pipe) never prompt.
   */
  confirmWorkspaceClose: boolean;
}

export const DEFAULT_WORKSPACE_PREFS: WorkspacePrefs = {
  newWorkspacePlacement: 'afterCurrent',
  autoReorderOnNotification: false,
  defaultShell: '',
  showWelcomeScreen: true,
  autoOpenDiffTab: true,
  confirmWorkspaceClose: false,
};

// ─── Terminal settings ────────────────────────────────────────────────────────

/**
 * A user-defined color scheme. Partial: only specified fields override the
 * base theme (so users can tweak just `background` + `foreground` if they want).
 * Mirrors the shape requested in issue #4.
 */
export interface UserColorScheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  palette?: string[]; // up to 16 ANSI entries
}

export interface TerminalPrefs {
  fontFamily: string;
  fontSize: number;
  /** Global default color scheme name (bundled theme or userColorSchemes key). */
  theme: string;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollbackLines: number;
  /** User-defined color schemes, addressable by name in per-pane overrides. */
  userColorSchemes: Record<string, UserColorScheme>;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontFamily: 'Consolas, Menlo, Monaco, monospace',
  fontSize: 13,
  theme: 'Monokai',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollbackLines: 5000,
  userColorSchemes: {},
};

// ─── Notification settings ────────────────────────────────────────────────────

export interface NotificationPrefs {
  toast: boolean;
  taskbarFlash: boolean;
  paneRing: boolean;
  paneFlashAnimation: boolean;
  sound: 'default' | 'chime' | 'ping' | 'marimba' | 'pop' | 'none';
  /** Notify when an in-pane agent (Claude Code) needs input/permission (issue #53). */
  agentInputNotify: boolean;
  /** Notify when an in-pane agent (Claude Code) finishes its turn / Stop hook (issue #53). */
  agentStopNotify: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  toast: true,
  taskbarFlash: true,
  paneRing: true,
  paneFlashAnimation: true,
  sound: 'default',
  agentInputNotify: true,
  agentStopNotify: true,
};

// ─── Browser settings ─────────────────────────────────────────────────────────

export interface BrowserPrefs {
  searchEngine: 'google' | 'duckduckgo' | 'bing' | 'brave';
  devToolsIcon: 'default' | 'compact' | 'hidden';
  /** Open the browser panel automatically on startup (issue #22). */
  openOnStartup: boolean;
}

export const DEFAULT_BROWSER_PREFS: BrowserPrefs = {
  searchEngine: 'google',
  devToolsIcon: 'default',
  openOnStartup: true,
};

// ─── Appearance settings (issue #67) ──────────────────────────────────────────

/**
 * App UI theme, independent of terminal pane color schemes. 'system' follows
 * the Windows light/dark setting (nativeTheme, pushed live on change).
 */
export interface AppearancePrefs {
  uiTheme: 'system' | 'dark' | 'light';
  /**
   * Custom background parallel to theming (issue #89, Wave-style `bg`).
   * Any CSS `background` shorthand: gradients, colors, url(...) images.
   * Rendered as a layer behind the terminal area; terminal color-scheme
   * backgrounds get `terminalBgOpacity` alpha so it shows through.
   */
  customBackgroundEnabled: boolean;
  customBackground: string;
  /** 30–100 (%). How opaque the terminal theme background stays over the custom background. */
  terminalBgOpacity: number;
}

export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  // Defaults to 'dark' rather than 'system' — wmux shipped dark-only up to
  // 0.14.0, so existing users' chrome must not change color on first launch
  // after upgrading. New users can switch to 'system'/'light' in Settings.
  uiTheme: 'dark',
  customBackgroundEnabled: false,
  customBackground: '',
  terminalBgOpacity: 88,
};

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface SettingsSlice {
  shortcuts: Record<ShortcutAction, ShortcutBinding>;
  sidebarVisible: boolean;
  sidebarPrefs: SidebarPrefs;
  workspacePrefs: WorkspacePrefs;
  terminalPrefs: TerminalPrefs;
  notificationPrefs: NotificationPrefs;
  browserPrefs: BrowserPrefs;
  /** App UI theme — sidebar/tabbar/titlebar/pane chrome (issue #67). */
  appearancePrefs: AppearancePrefs;
  /** Global quick-launch profiles surfaced in the `+` caret dropdown (issue #32). */
  quickLaunchProfiles: QuickLaunchProfile[];
  /** Selected UI language (issue #56). */
  language: Language;
  /**
   * Broadcast-input mode (issue #64, tmux `synchronize-panes`): when on, typed
   * input + Enter fan out to every terminal pane in the workspace. Runtime-only
   * (deliberately not persisted) — it's a transient "drive all agents at once"
   * mode, dangerous to restore silently on the next launch.
   */
  broadcastInputActive: boolean;

  setShortcut(action: ShortcutAction, binding: ShortcutBinding): void;
  resetShortcuts(): void;
  toggleSidebar(): void;
  setSidebarPrefs(prefs: Partial<SidebarPrefs>): void;
  setWorkspacePrefs(prefs: Partial<WorkspacePrefs>): void;
  setTerminalPrefs(prefs: Partial<TerminalPrefs>): void;
  setNotificationPrefs(prefs: Partial<NotificationPrefs>): void;
  setBrowserPrefs(prefs: Partial<BrowserPrefs>): void;
  setAppearancePrefs(prefs: Partial<AppearancePrefs>): void;
  setQuickLaunchProfiles(profiles: QuickLaunchProfile[]): void;
  setLanguage(language: Language): void;
  toggleBroadcastInput(): void;
}

// ─── Slice creator ────────────────────────────────────────────────────────────

export const createSettingsSlice: StateCreator<SettingsSlice> = (set) => ({
  shortcuts:         { ...DEFAULT_SHORTCUTS,         ...loadPersisted<Record<ShortcutAction, ShortcutBinding>>(STORAGE_KEYS.shortcuts) },
  sidebarVisible:    true,
  sidebarPrefs:      { ...DEFAULT_SIDEBAR_PREFS,      ...loadPersisted<SidebarPrefs>(STORAGE_KEYS.sidebarPrefs) },
  workspacePrefs:    { ...DEFAULT_WORKSPACE_PREFS,    ...loadPersisted<WorkspacePrefs>(STORAGE_KEYS.workspacePrefs) },
  terminalPrefs:     { ...DEFAULT_TERMINAL_PREFS,     ...loadPersisted<TerminalPrefs>(STORAGE_KEYS.terminalPrefs) },
  notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, ...loadPersisted<NotificationPrefs>(STORAGE_KEYS.notificationPrefs) },
  browserPrefs:      { ...DEFAULT_BROWSER_PREFS,      ...loadPersisted<BrowserPrefs>(STORAGE_KEYS.browserPrefs) },
  appearancePrefs:   { ...DEFAULT_APPEARANCE_PREFS,   ...loadPersisted<AppearancePrefs>(STORAGE_KEYS.appearancePrefs) },
  quickLaunchProfiles: loadPersistedArray<QuickLaunchProfile>(STORAGE_KEYS.quickLaunchProfiles),
  language:          loadPersistedLanguage(),
  broadcastInputActive: false,

  setShortcut(action: ShortcutAction, binding: ShortcutBinding): void {
    set((state) => {
      const merged = { ...state.shortcuts, [action]: binding };
      persist(STORAGE_KEYS.shortcuts, merged);
      return { shortcuts: merged };
    });
  },

  resetShortcuts(): void {
    persist(STORAGE_KEYS.shortcuts, DEFAULT_SHORTCUTS);
    set({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  },

  toggleSidebar(): void {
    set((state) => ({ sidebarVisible: !state.sidebarVisible }));
  },

  setSidebarPrefs(prefs: Partial<SidebarPrefs>): void {
    set((state) => {
      const merged = { ...state.sidebarPrefs, ...prefs };
      persist(STORAGE_KEYS.sidebarPrefs, merged);
      return { sidebarPrefs: merged };
    });
  },

  setWorkspacePrefs(prefs: Partial<WorkspacePrefs>): void {
    set((state) => {
      const merged = { ...state.workspacePrefs, ...prefs };
      persist(STORAGE_KEYS.workspacePrefs, merged);
      return { workspacePrefs: merged };
    });
  },

  setTerminalPrefs(prefs: Partial<TerminalPrefs>): void {
    set((state) => {
      const merged = { ...state.terminalPrefs, ...prefs };
      persist(STORAGE_KEYS.terminalPrefs, merged);
      return { terminalPrefs: merged };
    });
  },

  setNotificationPrefs(prefs: Partial<NotificationPrefs>): void {
    set((state) => {
      const merged = { ...state.notificationPrefs, ...prefs };
      persist(STORAGE_KEYS.notificationPrefs, merged);
      return { notificationPrefs: merged };
    });
  },

  setBrowserPrefs(prefs: Partial<BrowserPrefs>): void {
    set((state) => {
      const merged = { ...state.browserPrefs, ...prefs };
      persist(STORAGE_KEYS.browserPrefs, merged);
      return { browserPrefs: merged };
    });
  },

  setAppearancePrefs(prefs: Partial<AppearancePrefs>): void {
    set((state) => {
      const merged = { ...state.appearancePrefs, ...prefs };
      persist(STORAGE_KEYS.appearancePrefs, merged);
      return { appearancePrefs: merged };
    });
  },

  setQuickLaunchProfiles(profiles: QuickLaunchProfile[]): void {
    persist(STORAGE_KEYS.quickLaunchProfiles, profiles);
    set({ quickLaunchProfiles: profiles });
  },

  setLanguage(language: Language): void {
    persist(STORAGE_KEYS.language, language);
    set({ language });
  },

  toggleBroadcastInput(): void {
    set((state) => ({ broadcastInputActive: !state.broadcastInputActive }));
  },
});
