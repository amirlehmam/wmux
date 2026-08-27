import { StateCreator } from 'zustand';
import { QuickLaunchProfile, SavedLayout } from '../../shared/types';
import { INDEX_MODIFIER_CHOICES, IndexModifiers, reconcileIndexModifiers } from '../utils/index-shortcuts';
import {
  Language,
  applyUserLocales,
  detectDefaultLanguage,
  getLocaleRevision,
  isLanguage,
} from '../i18n/core';

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
  savedLayouts:      'wmux-saved-layouts',
  language:          'wmux-language',
  appearancePrefs:   'wmux-appearance-prefs',
  keyboardPrefs:     'wmux-keyboard-prefs',
  promptPrefs:       'wmux-prompt-prefs',
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
  // isLanguage() derives from the i18n registry: a newly shipped language is
  // accepted here automatically instead of silently resetting on next launch.
  if (isLanguage(candidate)) return candidate;
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
  | 'jumpToBlocked'
  | 'openAgentNavigator'
  | 'openHub'
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
  | 'toggleShortcutCheatSheet'
  // ─── issue #116 ───────────────────────────────────────────────────────────
  | 'toggleMarkdownSource'
  // ─── issue #175 ───────────────────────────────────────────────────────────
  | 'resetTerminal'
  // ─── issue #207: the prompt log and its four consumers ────────────────────
  | 'togglePromptOutline'
  | 'togglePinnedPrompt'
  | 'followOutput';

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
  // ─── issue #116 ─────────────────────────────────────────────────────────────
  // Ctrl+Shift+E was unbound. Shift-modified, so isSafeToIntercept lets it
  // through without touching SAFE_CTRL_KEYS; a no-op unless the focused pane's
  // active surface is markdown.
  toggleMarkdownSource:   { key: 'e', ctrl: true, shift: true },
  // ─── issue #175 ─────────────────────────────────────────────────────────────
  // Ctrl+Shift+R was unbound. Shift-modified like the #64 batch, so
  // isSafeToIntercept forwards bare Ctrl+R (reverse-search in every shell wmux
  // spawns) to the terminal untouched — which matters more here than usual,
  // since the users who need this binding are the ones already fighting their
  // shell.
  resetTerminal:          { key: 'r', ctrl: true, shift: true },
  // ─── Agent roster ───────────────────────────────────────────────────────────
  // Ctrl+Shift+B and Ctrl+Shift+A were both unbound. Shift-modified like every
  // batch above, so isSafeToIntercept keeps bare Ctrl+A (start-of-line in every
  // shell) and Ctrl+B (tmux prefix, for users running tmux inside a pane) going
  // to the terminal untouched.
  //
  // Bound by DEFAULT rather than shipped blank: the whole feature is "find the
  // stuck agent without hunting", and a keystroke the user must first discover
  // in Settings is one they will not have when they need it.
  jumpToBlocked:          { key: 'b', ctrl: true, shift: true },
  openAgentNavigator:     { key: 'a', ctrl: true, shift: true },
  // Ctrl+Shift+O was unbound (bare Ctrl+O already opens a folder).
  openHub:                { key: 'o', ctrl: true, shift: true },
  // ─── issue #207 ─────────────────────────────────────────────────────────────
  // Collision-checked against every binding above and against the two
  // number-row families in KeyboardPrefs: Ctrl+Shift+L, Ctrl+Shift+K and
  // Ctrl+Shift+End were all free. Ctrl+Shift+O was NOT — it is `openHub` — so
  // the outline took L (as in "list"), not O.
  //
  // Shift-modified like every batch above, which is what keeps the bare Ctrl
  // combos the terminal actually wants: Ctrl+L (clear screen in every shell
  // wmux spawns), Ctrl+K (kill-to-end-of-line in readline) and Ctrl+End
  // (scroll-to-bottom in xterm) all still reach the pane untouched, so
  // isSafeToIntercept needs no SAFE_CTRL_KEYS edit.
  //
  // Bound by default rather than left blank for the same reason as the agent
  // roster: these are "get back to what you asked for" gestures, wanted at the
  // moment you are already lost in output, which is the worst moment to go
  // discover a keystroke in Settings. The panel's hints read the LIVE binding
  // so a rebind stays honest.
  togglePromptOutline:    { key: 'l', ctrl: true, shift: true },
  togglePinnedPrompt:     { key: 'k', ctrl: true, shift: true },
  followOutput:           { key: 'End', ctrl: true, shift: true },
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
  /**
   * Directory new terminals start in when nothing else has said where (issue
   * #205). A FALLBACK, never an override: a split inherits its parent's
   * directory, "Open in wmux" and `--cwd` name one outright, and a restored
   * session carries the one it was frozen at — all of those still win. This
   * only fills the hole that was previously filled by wherever wmux.exe itself
   * was launched from, which for a taskbar/Start-menu launch is
   * C:\Windows\system32.
   *
   * Stored exactly as typed. `~` and `%VAR%` are expanded at spawn time by
   * resolveSpawnCwd, so a path stays portable across machines instead of being
   * frozen to whatever the picker resolved on the day it was set.
   */
  defaultCwd: string;
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
  /**
   * Read agent TUIs off the screen to infer blocked/working/idle for agents
   * that do not report state themselves (Codex, Gemini, Aider, …).
   *
   * On by default: it only ever fills a gap. Detection is ranked strictly below
   * declared state and can never override it, so a user whose agents all report
   * is unaffected — their panes are skipped without being scanned at all.
   *
   * The escape hatch matters anyway. This reads the terminal buffer several
   * times a second, and a user who does not want their screen contents pattern
   * matched — however locally — should be able to say so in one click.
   */
  detectAgentScreens: boolean;
  /**
   * Which `savedLayouts` entry (by id) new workspaces start with — Ctrl+N, the
   * sidebar "+" button, CLI `wmux new-workspace`, "Open folder as workspace",
   * and the first-launch/empty-session workspace all read this. `null` (the
   * default) means each entry point falls back to its OWN pre-existing
   * baseline, unchanged from before saved layouts existed: a single plain pane
   * for Ctrl+N/CLI/"Open folder", or wmux's classic 3-pane layout for the
   * sidebar "+" button and first launch. Dangling ids (the saved layout was
   * deleted) are treated the same as `null` by the one place that resolves
   * this (`resolveDefaultSplitTree` in workspace-slice.ts).
   */
  defaultLayoutId: string | null;
  /**
   * Re-launch each restored terminal's Claude Code session with
   * `claude --resume <id>` on workspace restore (issue #186).
   *
   * Opt-in, and the default must stay `false`: README has always promised that
   * wmux does not restore live process state, and flipping this on for everyone
   * would have every restored pane start an agent at once on the next launch —
   * a startup that spends real tokens without being asked. A pane only resumes
   * if it was running Claude when the session was saved AND the transcript is
   * still on disk.
   */
  restoreClaudeSessions: boolean;
}

export const DEFAULT_WORKSPACE_PREFS: WorkspacePrefs = {
  newWorkspacePlacement: 'afterCurrent',
  autoReorderOnNotification: false,
  defaultShell: '',
  defaultCwd: '',
  showWelcomeScreen: true,
  autoOpenDiffTab: true,
  confirmWorkspaceClose: false,
  defaultLayoutId: null,
  restoreClaudeSessions: false,
  detectAgentScreens: true,
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
  /**
   * Send clicked terminal/markdown links to the system default browser instead
   * of the wmux panel (issue #201). Ctrl/Cmd+click inverts whichever way this
   * is set, so the other destination is always one modifier away.
   *
   * Default false — the panel is what wmux is for, and flipping the default
   * would change behaviour for everyone on upgrade.
   */
  openLinksExternally: boolean;
}

export const DEFAULT_BROWSER_PREFS: BrowserPrefs = {
  searchEngine: 'google',
  devToolsIcon: 'default',
  openOnStartup: true,
  openLinksExternally: false,
};

// ─── Prompt settings (issue #207) ─────────────────────────────────────────────

/**
 * "Pin and highlight the original prompt in a pane" — four features, one
 * per-surface prompt log behind them, and therefore one preference block.
 *
 * They are separate toggles rather than one switch because they cost different
 * things. Highlighting and the outline are free until you look at them; the
 * sticky header permanently eats rows off a pane, and anchoring changes where
 * the viewport sits while output is still arriving — which is exactly the
 * behaviour a user who did NOT ask for it would call a scrolling bug. Hence the
 * defaults below: everything on except `pin`.
 *
 * `enabled` is the master switch and the one that matters for cost: with it off
 * nothing subscribes to the prompt log at all, so a user who wants none of this
 * pays nothing for it.
 */
export interface PromptPrefs {
  /** Master switch. With this off, none of the four consumers run. */
  enabled: boolean;
  /** Tint the rows the user's own prompt occupies, so it stands out of the scrollback. */
  highlight: boolean;
  /** '#rrggbb'. Fed to an `<input type="color">`, which emits nothing else. */
  highlightColor: string;
  /** Also mark each prompt on the scrollbar's overview ruler. */
  ruler: boolean;
  /** Keep the last prompt visible as a sticky header above the pane. */
  pin: boolean;
  /**
   * How many rows of prompt text the sticky header shows. Clamped to 1..5 in
   * `setPromptPrefs` — settings.json is hand-editable and a header taller than
   * the pane is not a preference, it is a broken pane.
   */
  pinLines: number;
  /** Hold the view at the start of an answer instead of following the output. */
  anchor: boolean;
  /**
   * Which prompts anchoring applies to.
   *
   * `'agent'` — only prompts an in-pane agent reported. `'all'` — shell command
   * lines as well.
   *
   * This one exists because the two cases are not the same request, even though
   * they share a mechanism. Issue #207 asks for anchoring so the START OF AN
   * AGENT'S ANSWER can be read while the agent is still writing; a terminal that
   * follows its output is not a problem there, it is the problem. A SHELL that
   * follows its output is not a problem at all — it is what every terminal has
   * done for forty years, and silently stopping `npm run build` from streaming
   * reads as a freeze, not as a feature.
   *
   * So the default is the narrow one. Anyone who wants it everywhere says so.
   */
  anchorScope: 'agent' | 'all';
  /**
   * Whether the prompt outline is AVAILABLE. It is inert until opened, so this
   * gates the shortcut and the command, not a always-on panel.
   */
  outline: boolean;
  outlineSide: 'right' | 'left';
  /** Which generation of these defaults this blob has been reconciled against. */
  promptDefaultRev: number;
}

/**
 * Bumped whenever we change what a user who never opened this panel gets.
 *
 * The mechanism exists from day one rather than being retrofitted, because
 * retrofitting it does not work: `setPromptPrefs` persists the WHOLE merged
 * object, so the moment a user flips any one of these toggles every other field
 * is on disk too, and `{ ...DEFAULTS, ...stored }` lets the stored value win
 * forever. A later default change would then reach only users who had never
 * touched the panel at all — which is to say, almost nobody who cares. Starting
 * the counter at 0 costs nothing and means the first real default change is a
 * bump plus an entry in PROMPT_PROMOTIONS instead of a migration written under
 * pressure.
 *
 * 0 — 2.4.0, as shipped. No promotion has ever run.
 */
export const PROMPT_DEFAULT_REV = 0;

export const DEFAULT_PROMPT_PREFS: PromptPrefs = {
  enabled: true,
  highlight: true,
  // A wmux blue, but deliberately NOT the accent (#0091ff / --ui-accent), for
  // two reasons that happen to agree.
  //
  // Design: the accent already means "focused" in this app — the pane ring, the
  // active tab, the active workspace rail. A prompt highlight means "this is
  // what you asked", which is a different claim, and painting the two the same
  // colour makes a scrolled-back prompt read as the focused pane.
  //
  // Mechanical: tests/unit/accent-token.test.ts pins the accent literal to
  // theme-vars.css alone. It exists because the accent once lived in 53
  // hardcoded copies and the light palette shipped a 2.6:1 contrast bug as a
  // result. This value cannot come from the token either — it is fed to an
  // `<input type="color">` and handed to xterm's overview ruler, neither of
  // which accepts `var(...)` — so a literal it is, and it must be its own.
  //
  // Not a terminal-palette colour either: the highlight has to read as chrome
  // the terminal did not print, on every bundled colour scheme.
  highlightColor: '#6ea8ff',
  ruler: true,
  // The only one off by default — see the block comment on PromptPrefs.
  pin: false,
  pinLines: 2,
  anchor: true,
  // Agent prompts only — the narrow reading of issue #207, and the one that
  // leaves every existing shell behaving exactly as it always has.
  anchorScope: 'agent',
  outline: true,
  outlineSide: 'right',
  promptDefaultRev: PROMPT_DEFAULT_REV,
};

/**
 * One entry per default we have changed under existing users, exactly as
 * APPEARANCE_PROMOTIONS above. Empty today because no default has changed since
 * 2.4.0 shipped.
 *
 * Add to it when — and only when — you change a value in DEFAULT_PROMPT_PREFS
 * and want the change to reach users who already have a `wmux-prompt-prefs`
 * blob on disk. An entry bumps PROMPT_DEFAULT_REV, sets the field AND stamps
 * the new rev in the same closure, so "promoted the value but forgot the rev"
 * — which re-promotes on every launch, overriding the user's own choice
 * forever — cannot be written.
 */
interface PromptPromotion {
  rev: 'promptDefaultRev';
  current: number;
  apply: (prefs: PromptPrefs) => void;
}

const PROMPT_PROMOTIONS: ReadonlyArray<PromptPromotion> = [];

/**
 * Which promotions a stored blob has not seen yet.
 *
 * Takes the list as an argument rather than closing over PROMPT_PROMOTIONS so
 * the rule itself can be exercised with a non-empty list — the list ships empty,
 * and a predicate that has never once run on real input is a migration nobody
 * can trust the first time it matters.
 *
 * `stored` is the RAW blob, never the merged one: the defaults carry the
 * current rev, so merging first makes every legacy blob look already-migrated
 * and no promotion ever fires. That is the bug to look for if a migration seems
 * to do nothing.
 */
function duePromptPromotions(
  stored: Partial<PromptPrefs>,
  promotions: ReadonlyArray<PromptPromotion>,
): PromptPromotion[] {
  return promotions.filter((p) => (stored[p.rev] ?? 0) < p.current);
}

export function loadPromptPrefs(): PromptPrefs {
  const stored = loadPersisted<PromptPrefs>(STORAGE_KEYS.promptPrefs);
  // Clamped on load as well as on write, for the same reason keyboardPrefs is
  // reconciled on load: settings.json is hand-editable, and a `pinLines: 400`
  // would bury the pane under its own header long before anyone reached
  // Settings to correct it.
  const merged = { ...DEFAULT_PROMPT_PREFS, ...stored, pinLines: clampPinLines(stored.pinLines ?? DEFAULT_PROMPT_PREFS.pinLines) };

  const due = duePromptPromotions(stored, PROMPT_PROMOTIONS);
  if (due.length === 0) return merged;

  const promoted: PromptPrefs = { ...merged };
  for (const p of due) p.apply(promoted);
  // Written back now rather than at the next settings edit: the rev has to be
  // on disk for this to stay a ONE-time promotion. Without the write, a user
  // who switches the field back and never opens Settings again is re-promoted
  // on every launch — worse than never changing the default.
  persist(STORAGE_KEYS.promptPrefs, promoted);
  return promoted;
}

/**
 * The sticky header's height, kept sane. `Number()` on an emptied number input
 * yields NaN and a hand-edited settings.json can hold anything at all, so the
 * non-finite case falls back to the default rather than propagating.
 */
function clampPinLines(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PROMPT_PREFS.pinLines;
  return Math.min(5, Math.max(1, Math.round(value)));
}

// ─── Keyboard settings (issue #202) ───────────────────────────────────────────

/**
 * The two numeric-index shortcut families, which are NOT `ShortcutAction`s.
 *
 * `Ctrl+1…9` and `Ctrl+Alt+1…9` were hardcoded listeners because nine
 * remappable entries apiece would have put eighteen rows in Settings. Modelling
 * them as one modifier choice per family keeps that to two rows while still
 * covering every request in the issue: rebind either family, swap the two, or
 * switch either one off so the digits reach the terminal untouched.
 *
 * The invariant — the two families never hold the same combo — is enforced in
 * `setKeyboardPrefs` via `reconcileIndexModifiers`, not by the UI, so the CLI
 * or a hand-edited settings.json can't produce a binding with two owners.
 */
export interface KeyboardPrefs {
  /** Modifiers that make the digit row select a workspace by index. */
  workspaceIndexModifiers: IndexModifiers;
  /** Modifiers that make the digit row select a tab in the focused pane. */
  surfaceIndexModifiers: IndexModifiers;
}

export const DEFAULT_KEYBOARD_PREFS: KeyboardPrefs = {
  // Both defaults reproduce the pre-1.14.0 hardcoded listeners exactly — this
  // issue asked for the ability to change them, not for different ones.
  workspaceIndexModifiers: 'ctrl',
  surfaceIndexModifiers: 'ctrl-alt',
};

/** Merge stored keyboard prefs over the defaults, then enforce the invariant. */
export function loadKeyboardPrefs(): KeyboardPrefs {
  const stored = loadPersisted<KeyboardPrefs>(STORAGE_KEYS.keyboardPrefs);
  const merged: KeyboardPrefs = {
    workspaceIndexModifiers: coerceIndexModifiers(stored.workspaceIndexModifiers, DEFAULT_KEYBOARD_PREFS.workspaceIndexModifiers),
    surfaceIndexModifiers: coerceIndexModifiers(stored.surfaceIndexModifiers, DEFAULT_KEYBOARD_PREFS.surfaceIndexModifiers),
  };
  return applyIndexModifiers(merged, {});
}

/**
 * Keep an unknown stored value from reaching the Settings dropdown, which would
 * render blank and silently rewrite the pref on the next unrelated change.
 * settings.json is hand-editable, so this is a real input, not a formality.
 */
function coerceIndexModifiers(value: unknown, fallback: IndexModifiers): IndexModifiers {
  return INDEX_MODIFIER_CHOICES.includes(value as IndexModifiers) ? (value as IndexModifiers) : fallback;
}

/**
 * The one place a `KeyboardPrefs` value is produced. Translates between the
 * pref field names and the family names `reconcileIndexModifiers` speaks, so
 * the collision rule itself stays a pure, testable function.
 */
function applyIndexModifiers(base: KeyboardPrefs, patch: Partial<KeyboardPrefs>): KeyboardPrefs {
  const next = reconcileIndexModifiers(
    { workspace: base.workspaceIndexModifiers, surface: base.surfaceIndexModifiers },
    {
      workspace: patch.workspaceIndexModifiers,
      surface: patch.surfaceIndexModifiers,
    },
  );
  return { workspaceIndexModifiers: next.workspace, surfaceIndexModifiers: next.surface };
}

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
  /** 15–100 (%), floored by MIN_TERMINAL_OPACITY_PCT on read. How opaque the terminal theme background stays over whatever is behind it. */
  terminalBgOpacity: number;
  /**
   * Real window transparency (issue: terminal opacity). Where `customBackground`
   * paints a layer INSIDE the window, this makes the window itself translucent
   * so the actual desktop shows through the terminal, blurred by a Windows 11
   * backdrop material.
   *
   * The two are independent and compose: with both on, the custom background
   * layer sits over the blurred desktop. Either one alone is enough to put
   * `terminalBgOpacity` into effect — see `bgAlpha` in useTerminal.ts.
   *
   * Plain alpha ('clear') works on any DWM-composited Windows; the blur
   * materials need Windows 11 (build 22000+), where the DWM API behind
   * `setBackgroundMaterial` exists.
   */
  windowTransparency: boolean;
  /**
   * How the desktop comes through.
   *
   * 'clear' is plain per-pixel alpha — what you can read a browser through, and
   * what Windows Terminal's `opacity` does with `useAcrylic` off. 'acrylic' and
   * 'mica' are Win11 backdrops, which BLUR what is behind them by definition,
   * so neither can ever produce that. 'clear' is the default for exactly that
   * reason: it is what people mean by a transparent terminal.
   */
  windowMaterial: 'clear' | 'acrylic' | 'mica';
  /**
   * Sidebar presentation mode. 'classic' is the stock list; 'trace' is the
   * opt-in live view that renders each Claude session as a tap on a copper bus,
   * with motion driven by real hook traffic.
   *
   * A separate axis from `uiTheme` on purpose — TRACE composes with both dark
   * and light rather than being a third theme.
   */
  uiMode: 'classic' | 'trace';
  /**
   * Which generation of the `uiMode` default this blob has been reconciled
   * against — see UI_MODE_DEFAULT_REV.
   */
  uiModeDefaultRev: number;
  /**
   * The agent office. On by default since 2.3.0 — it shipped in 2.2.0 as a
   * quiet easter egg (no titlebar button, inert shortcut until the toggle was
   * found) and is now surfaced for everyone. Turning it off restores exactly
   * that quiet state, so the toggle is still the whole feature flag: titlebar
   * button, Ctrl+Shift+O, command palette entry and cheat-sheet row all read it.
   */
  hubEnabled: boolean;
  /**
   * Which generation of the `hubEnabled` default this blob has been reconciled
   * against — see HUB_DEFAULT_REV.
   */
  hubDefaultRev: number;
}

/**
 * Bumped whenever we change what `uiMode` a user lands on without choosing.
 *
 * A plain default change would not have reached anybody: `setAppearancePrefs`
 * persists the WHOLE merged object, so every user who had ever touched a theme,
 * a background or the opacity slider already had `uiMode: 'classic'` on disk,
 * and `{ ...DEFAULTS, ...loadPersisted() }` lets the stored value win. This rev
 * is what makes the change land — a blob carrying an older rev is promoted
 * exactly once, and the promotion stamps the current rev so a user who then
 * picks classic back keeps it forever.
 *
 * 1 — 1.5.0, TRACE becomes the default sidebar for everyone.
 */
export const UI_MODE_DEFAULT_REV = 1;

/**
 * Same mechanism as UI_MODE_DEFAULT_REV, for `hubEnabled` — and deliberately a
 * SEPARATE counter rather than a bump of that one.
 *
 * They share a persisted block but not a decision. Bumping the uiMode rev to
 * promote the office would re-promote `uiMode` at the same time, dragging back
 * to TRACE every user who deliberately picked classic after 1.5.0 — the exact
 * thing `loadAppearancePrefs` promises not to do. One rev per migrated default
 * keeps each promotion independent and each post-promotion choice sticky.
 *
 * 1 — 2.3.0, the agent office is on for everyone. Note this cannot tell "found
 * the 2.2.0 toggle and switched it off" from "never touched it": both are
 * `hubEnabled: false` on disk. The egg was only discoverable for one release,
 * so the promotion is accepted as overriding that small set once; anyone who
 * turns it off after the promotion keeps it off.
 */
export const HUB_DEFAULT_REV = 1;

export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  // Defaults to 'dark' rather than 'system' — wmux shipped dark-only up to
  // 0.14.0, so existing users' chrome must not change color on first launch
  // after upgrading. New users can switch to 'system'/'light' in Settings.
  uiTheme: 'dark',
  customBackgroundEnabled: false,
  customBackground: '',
  terminalBgOpacity: 88,
  windowTransparency: false,
  windowMaterial: 'clear',
  uiMode: 'trace',
  uiModeDefaultRev: UI_MODE_DEFAULT_REV,
  hubEnabled: true,
  hubDefaultRev: HUB_DEFAULT_REV,
};

/**
 * appearancePrefs needs a loader of its own because it is the block whose
 * defaults have been changed under existing users (TRACE in 1.5.0, the agent
 * office in 2.3.0).
 *
 * Every rev is read off the RAW stored blob, deliberately not off the merged
 * one: the defaults carry the current revs, so merging first would make every
 * legacy blob look already-migrated and no promotion would ever fire. This is
 * the bug to look for if a migration seems to do nothing.
 *
 * Promotions are INDEPENDENT — one rev per migrated field, each evaluated and
 * stamped on its own. A user can be due the office promotion while their uiMode
 * choice is already settled, and promoting the one must not disturb the other.
 */
const APPEARANCE_PROMOTIONS: ReadonlyArray<{
  rev: 'uiModeDefaultRev' | 'hubDefaultRev';
  current: number;
  /**
   * Applied in place on the merged blob. The field and its rev are stamped
   * together here on purpose: keeping them in one typed closure makes
   * "promoted the value but forgot the rev" — which re-promotes on every launch
   * forever — unrepresentable rather than merely discouraged.
   */
  apply: (prefs: AppearancePrefs) => void;
}> = [
  {
    rev: 'uiModeDefaultRev',
    current: UI_MODE_DEFAULT_REV,
    apply: (prefs) => {
      prefs.uiMode = DEFAULT_APPEARANCE_PREFS.uiMode;
      prefs.uiModeDefaultRev = UI_MODE_DEFAULT_REV;
    },
  },
  {
    rev: 'hubDefaultRev',
    current: HUB_DEFAULT_REV,
    apply: (prefs) => {
      prefs.hubEnabled = DEFAULT_APPEARANCE_PREFS.hubEnabled;
      prefs.hubDefaultRev = HUB_DEFAULT_REV;
    },
  },
];

export function loadAppearancePrefs(): AppearancePrefs {
  const stored = loadPersisted<AppearancePrefs>(STORAGE_KEYS.appearancePrefs);
  const merged = { ...DEFAULT_APPEARANCE_PREFS, ...stored };

  const due = APPEARANCE_PROMOTIONS.filter(
    (p) => ((stored[p.rev] as number | undefined) ?? 0) < p.current,
  );
  if (due.length === 0) return merged;

  const promoted: AppearancePrefs = { ...merged };
  for (const p of due) p.apply(promoted);
  // Write it back now rather than waiting for the next settings edit: the rev
  // has to be on disk for this to stay a ONE-time promotion. Without the write,
  // a user who switches the field back and never opens Settings again would be
  // re-promoted on every launch — worse than never changing the default.
  persist(STORAGE_KEYS.appearancePrefs, promoted);
  return promoted;
}

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface SettingsSlice {
  shortcuts: Record<ShortcutAction, ShortcutBinding>;
  sidebarVisible: boolean;
  sidebarPrefs: SidebarPrefs;
  workspacePrefs: WorkspacePrefs;
  terminalPrefs: TerminalPrefs;
  notificationPrefs: NotificationPrefs;
  browserPrefs: BrowserPrefs;
  /** Numeric index-shortcut modifiers, one choice per family (issue #202). */
  keyboardPrefs: KeyboardPrefs;
  /** App UI theme — sidebar/tabbar/titlebar/pane chrome (issue #67). */
  appearancePrefs: AppearancePrefs;
  /** Prompt highlight / pin / anchor / outline (issue #207). */
  promptPrefs: PromptPrefs;
  /** Global quick-launch profiles surfaced in the `+` caret dropdown (issue #32). */
  quickLaunchProfiles: QuickLaunchProfile[];
  savedLayouts: SavedLayout[];
  /** Selected UI language (issue #56). */
  language: Language;
  /**
   * Bumped when ~/.wmux/locales is re-read (issue #147). Runtime-only: it
   * exists so `useT` has something to subscribe to, since swapping the
   * dictionaries in place changes no other store value and React would
   * otherwise keep the stale strings on screen until the next unrelated render.
   */
  localeRevision: number;
  /**
   * Broadcast-input mode (issue #64, tmux `synchronize-panes`): when on, typed
   * input + Enter fan out to every terminal pane in the workspace. Runtime-only
   * (deliberately not persisted) — it's a transient "drive all agents at once"
   * mode, dangerous to restore silently on the next launch.
   */
  broadcastInputActive: boolean;

  /**
   * Whether the transparency setting on screen is ahead of the window on
   * screen — true after switching into or out of plain-alpha mode, which
   * Electron fixes at window construction. Runtime-only: it describes this
   * window's state, not a preference, and is false again once it restarts.
   *
   * Lives here rather than in useWindowTransparency's own state because
   * Settings renders inside the same tree as App; a second call to the hook
   * would apply every backdrop change twice.
   */
  transparencyNeedsRestart: boolean;

  /** Result line for the last config import, and the undo it armed. */
  importStatus: string | null;
  importUndo: ImportUndo | null;

  setShortcut(action: ShortcutAction, binding: ShortcutBinding): void;
  resetShortcuts(): void;
  toggleSidebar(): void;
  setTransparencyNeedsRestart(value: boolean): void;
  setImportStatus(status: string | null): void;
  setImportUndo(undo: ImportUndo | null): void;
  setSidebarPrefs(prefs: Partial<SidebarPrefs>): void;
  setWorkspacePrefs(prefs: Partial<WorkspacePrefs>): void;
  setTerminalPrefs(prefs: Partial<TerminalPrefs>): void;
  setNotificationPrefs(prefs: Partial<NotificationPrefs>): void;
  setBrowserPrefs(prefs: Partial<BrowserPrefs>): void;
  setKeyboardPrefs(prefs: Partial<KeyboardPrefs>): void;
  setAppearancePrefs(prefs: Partial<AppearancePrefs>): void;
  setPromptPrefs(prefs: Partial<PromptPrefs>): void;
  setQuickLaunchProfiles(profiles: QuickLaunchProfile[]): void;
  setSavedLayouts(layouts: SavedLayout[]): void;
  setLanguage(language: Language): void;
  /** Re-read ~/.wmux/locales into the i18n registry and repaint (issue #147). */
  reloadUserLocales(payload: unknown): void;
  toggleBroadcastInput(): void;
}

/**
 * What an import overwrote, held so it can be handed back.
 *
 * Lives in the store rather than in TerminalSettings' own state because the
 * panel is mounted conditionally — `{activeTab === 'Terminal' && ...}` — so
 * component state dies the moment the user clicks over to General. Which is
 * exactly where an import sends them: it turns window transparency on and
 * raises the restart banner, and the natural next move is to go look at it.
 *
 * Deliberately NOT persisted. An undo that outlived the session would sit
 * there offering to revert a font size or an opacity the user had since
 * changed on purpose, and silently undoing deliberate work is worse than
 * offering no undo at all. Windows Terminal scopes its Discard Changes the
 * same way — only until you save — and cmux, which reads Ghostty's config in
 * place instead of copying it, has nothing to undo in the first place.
 */
export interface ImportUndo {
  terminal: Partial<TerminalPrefs>;
  appearance: Partial<AppearancePrefs>;
  /** What it would take back. The button on its own says nothing. */
  label: string;
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
  // Reconciled on load as well as on write: settings.json is user-editable, and
  // two families holding the same combo would leave one of them dead.
  keyboardPrefs:     loadKeyboardPrefs(),
  appearancePrefs:   loadAppearancePrefs(),
  promptPrefs:       loadPromptPrefs(),
  quickLaunchProfiles: loadPersistedArray<QuickLaunchProfile>(STORAGE_KEYS.quickLaunchProfiles),
  savedLayouts:      loadPersistedArray<SavedLayout>(STORAGE_KEYS.savedLayouts),
  language:          loadPersistedLanguage(),
  localeRevision:    getLocaleRevision(),
  broadcastInputActive: false,
  transparencyNeedsRestart: false,
  importStatus: null,
  importUndo: null,

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

  setKeyboardPrefs(prefs: Partial<KeyboardPrefs>): void {
    set((state) => {
      const merged = applyIndexModifiers(state.keyboardPrefs, prefs);
      persist(STORAGE_KEYS.keyboardPrefs, merged);
      return { keyboardPrefs: merged };
    });
  },

  setAppearancePrefs(prefs: Partial<AppearancePrefs>): void {
    set((state) => {
      const merged = { ...state.appearancePrefs, ...prefs };
      persist(STORAGE_KEYS.appearancePrefs, merged);
      return { appearancePrefs: merged };
    });
  },

  setPromptPrefs(prefs: Partial<PromptPrefs>): void {
    set((state) => {
      const candidate = { ...state.promptPrefs, ...prefs };
      // Clamped here rather than in the panel: the number input is not the only
      // writer — a settings.json edit and any future CLI both land here too.
      const merged = { ...candidate, pinLines: clampPinLines(candidate.pinLines) };
      persist(STORAGE_KEYS.promptPrefs, merged);
      return { promptPrefs: merged };
    });
  },

  setQuickLaunchProfiles(profiles: QuickLaunchProfile[]): void {
    persist(STORAGE_KEYS.quickLaunchProfiles, profiles);
    set({ quickLaunchProfiles: profiles });
  },

  setSavedLayouts(layouts: SavedLayout[]): void {
    persist(STORAGE_KEYS.savedLayouts, layouts);
    set({ savedLayouts: layouts });
  },

  setLanguage(language: Language): void {
    persist(STORAGE_KEYS.language, language);
    set({ language });
  },

  reloadUserLocales(payload: unknown): void {
    applyUserLocales(payload);
    set((state) => ({
      localeRevision: getLocaleRevision(),
      // The active language can vanish mid-session if the user deletes the file
      // that defined it. isLanguage() re-checks against the rebuilt registry, so
      // we fall back to a real language instead of rendering raw keys.
      language: isLanguage(state.language) ? state.language : detectDefaultLanguage(),
    }));
  },

  toggleBroadcastInput(): void {
    set((state) => ({ broadcastInputActive: !state.broadcastInputActive }));
  },

  setTransparencyNeedsRestart(value: boolean): void {
    set({ transparencyNeedsRestart: value });
  },

  setImportStatus(status: string | null): void {
    set({ importStatus: status });
  },

  setImportUndo(undo: ImportUndo | null): void {
    set({ importUndo: undo });
  },
});
