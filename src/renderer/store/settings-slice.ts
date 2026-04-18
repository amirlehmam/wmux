import { StateCreator } from 'zustand';

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
  | 'openMarkdownPanel';

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
}

export const DEFAULT_WORKSPACE_PREFS: WorkspacePrefs = {
  newWorkspacePlacement: 'afterCurrent',
  autoReorderOnNotification: false,
  defaultShell: '',
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
  sound: 'default' | 'none';
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  toast: true,
  taskbarFlash: true,
  paneRing: true,
  paneFlashAnimation: true,
  sound: 'default',
};

// ─── Browser settings ─────────────────────────────────────────────────────────

export interface BrowserPrefs {
  searchEngine: 'google' | 'duckduckgo' | 'bing' | 'brave';
  devToolsIcon: 'default' | 'compact' | 'hidden';
}

export const DEFAULT_BROWSER_PREFS: BrowserPrefs = {
  searchEngine: 'google',
  devToolsIcon: 'default',
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

  setShortcut(action: ShortcutAction, binding: ShortcutBinding): void;
  resetShortcuts(): void;
  toggleSidebar(): void;
  setSidebarPrefs(prefs: Partial<SidebarPrefs>): void;
  setWorkspacePrefs(prefs: Partial<WorkspacePrefs>): void;
  setTerminalPrefs(prefs: Partial<TerminalPrefs>): void;
  setNotificationPrefs(prefs: Partial<NotificationPrefs>): void;
  setBrowserPrefs(prefs: Partial<BrowserPrefs>): void;
}

// ─── Slice creator ────────────────────────────────────────────────────────────

export const createSettingsSlice: StateCreator<SettingsSlice> = (set) => ({
  shortcuts: { ...DEFAULT_SHORTCUTS },
  sidebarVisible: true,
  sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS },
  workspacePrefs: { ...DEFAULT_WORKSPACE_PREFS },
  terminalPrefs: { ...DEFAULT_TERMINAL_PREFS },
  notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
  browserPrefs: { ...DEFAULT_BROWSER_PREFS },

  setShortcut(action: ShortcutAction, binding: ShortcutBinding): void {
    set((state) => ({
      shortcuts: { ...state.shortcuts, [action]: binding },
    }));
  },

  resetShortcuts(): void {
    set({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  },

  toggleSidebar(): void {
    set((state) => ({ sidebarVisible: !state.sidebarVisible }));
  },

  setSidebarPrefs(prefs: Partial<SidebarPrefs>): void {
    set((state) => ({ sidebarPrefs: { ...state.sidebarPrefs, ...prefs } }));
  },

  setWorkspacePrefs(prefs: Partial<WorkspacePrefs>): void {
    set((state) => ({ workspacePrefs: { ...state.workspacePrefs, ...prefs } }));
  },

  setTerminalPrefs(prefs: Partial<TerminalPrefs>): void {
    set((state) => ({ terminalPrefs: { ...state.terminalPrefs, ...prefs } }));
  },

  setNotificationPrefs(prefs: Partial<NotificationPrefs>): void {
    set((state) => ({ notificationPrefs: { ...state.notificationPrefs, ...prefs } }));
  },

  setBrowserPrefs(prefs: Partial<BrowserPrefs>): void {
    set((state) => ({ browserPrefs: { ...state.browserPrefs, ...prefs } }));
  },
});
