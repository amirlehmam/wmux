/**
 * user-config.ts — Loads `~/.wmux/config.toml` and maps it to partial
 * TerminalPrefs + named user color schemes.
 *
 * Shape (matches issue #4):
 *
 *   [terminal]
 *   font-family     = "Consolas"
 *   font-size       = 14
 *   cursor-style    = "block"       # block | underline | bar
 *   cursor-blink    = true
 *   scrollback-lines = 10000
 *
 *   [terminal.colors]
 *   default = "Dracula"
 *
 *   [terminal.colors.schemes.prod]
 *   background = "#2b0b0b"
 *   foreground = "#ffdddd"
 *   cursor     = "#ff5555"
 *
 *   [terminal.colors.schemes.dev]
 *   background = "#0b1f0b"
 *   foreground = "#ccffcc"
 *   palette    = ["#000", "#ff5555", ...] # optional, up to 16 entries
 *
 *   [appearance]
 *   ui-theme = "light"   # light | dark | system (issue #67)
 *
 *   [workspace]                # what a NEW workspace starts as (issue #212)
 *   panes  = 3                 # 1-8 terminal panes
 *   layout = "grid"            # grid | columns | rows | left | down | single
 *
 *   [browser]
 *   dev-ports = [8501, 4321]   # extra dev-server ports, merged with built-in defaults
 *   auto-open = true           # auto-navigate the browser to a newly-detected dev port
 *   default-url = "http://localhost:3000"   # start page for a workspace's browser panel
 *
 *   [remote]
 *   upload-on-paste = true     # scp a pasted image to the host an ssh pane is on
 *   upload-on-drop  = true     # same for a dropped file; hold Shift to invert per-drop
 *
 *   [keys]                     # remap what a key sends to the terminal (issue #146)
 *   "ctrl+k"     = "<C-k><Delete>"
 *   "ctrl+alt+r" = "clear<CR>"
 *
 * File-wins-at-startup, app-wins-at-runtime: this data seeds the store
 * on boot; users can still tweak via the Settings UI afterwards.
 * A `wmux reload-config` command re-applies the file over runtime state.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseToml, TomlTable, TomlValue } from './toml-parser';
import { parseKeyRemaps, KeyRemap } from '../shared/key-sequence';
import { WorkspaceLayout } from '../shared/types';

export interface UserColorScheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  palette?: string[];
}

export type UiTheme = 'light' | 'dark' | 'system';

export interface UserConfig {
  terminal?: {
    fontFamily?: string;
    fontSize?: number;
    theme?: string;
    cursorStyle?: 'block' | 'underline' | 'bar';
    cursorBlink?: boolean;
    scrollbackLines?: number;
    userColorSchemes?: Record<string, UserColorScheme>;
  };
  /** App UI theme (issue #67) — separate from the terminal color scheme. */
  appearance?: {
    uiTheme?: UiTheme;
  };
  /**
   * What a new workspace starts as (issue #212). Ranked below a saved default
   * layout, which carries per-pane shell/cwd/commands and so answers the same
   * question more completely.
   */
  workspace?: {
    /** Terminal panes in a new workspace, 1-8. */
    panes?: number;
    /** How those panes are arranged. `single` normalises to panes = 1. */
    layout?: WorkspaceLayout;
  };
  /** Browser surface behavior — dev-server port detection & auto-navigation. */
  browser?: {
    /** Extra ports (merged with the built-in defaults) that count as dev servers. */
    devPorts?: number[];
    /** Auto-navigate the workspace browser to a newly-detected dev port (default true). */
    autoOpen?: boolean;
    /**
     * Start page for a workspace's browser panel (issue #212). Distinct from
     * the search engine, which decides where a typed non-URL goes.
     */
    defaultUrl?: string;
  };
  /**
   * Remote file upload — what paste and drop do when the pane is inside ssh.
   * Both default to true; set either to false to keep the older behaviour of
   * inserting the local Windows path.
   */
  remote?: {
    uploadOnPaste?: boolean;
    uploadOnDrop?: boolean;
  };
  /**
   * User key remaps (issue #146) — chord → bytes the terminal should send.
   * Already parsed here so a malformed binding is reported once, at load, with
   * the rest of the config's errors, rather than failing silently per keypress.
   */
  keys?: KeyRemap[];
  /** Absolute path the config was read from (for diagnostics). */
  path?: string;
  /** Any parse or mapping errors — non-fatal, surfaced to the renderer. */
  errors?: string[];
}

export function getConfigPath(): string {
  const home = os.homedir();
  return path.join(home, '.wmux', 'config.toml');
}

/**
 * Complaints already made, so the log is not spammed. loadUserConfig() is called
 * on every WSL pane spawn (pty-manager.ts) as well as at startup and on reload —
 * without this a single bad file would warn once per pane for the life of the app.
 */
const warnedConfigProblems = new Set<string>();

/** Forget past complaints AND the memo, so `wmux reload-config` re-reads. */
export function resetConfigWarnings(): void {
  warnedConfigProblems.clear();
  // Belt and braces alongside the mtime check: an editor that rewrites the file
  // within the same millisecond, or a filesystem with coarse timestamps, could
  // otherwise leave a manual reload reading the memo it was meant to bypass.
  clearUserConfigCache();
}

// A read or parse failure discards the WHOLE file: every [terminal], [keys],
// [browser] and [appearance] section silently reverts to its default. The errors
// were always returned to the caller and printed by `wmux config show`, but
// nothing ever told you to go and look — so a typo presented as "my setting has
// no effect", with no way to tell a mis-set value from an unread file.
function warnConfig(filePath: string, problem: string): void {
  const key = `${filePath}\0${problem}`;
  if (warnedConfigProblems.has(key)) return;
  warnedConfigProblems.add(key);
  console.warn(`[wmux] ${filePath}: ${problem} — see \`wmux config show\``);
}

/**
 * Last parse, keyed by path + mtime.
 *
 * `loadUserConfig` reads, parses and maps the whole file on every call, and
 * it is called on paths where that cost is felt: once per WSL pane spawn (see
 * the note above) and, since remote upload, once per paste and per drop —
 * an interactive path, on the same thread that pumps PTY output. The file
 * changes only when the user edits it, so an mtime check replaces the whole
 * read+parse+map with one stat.
 */
let configCache: { path: string; mtimeMs: number; value: UserConfig } | null = null;

/** Drop the memo, so the next load re-reads from disk regardless of mtime. */
export function clearUserConfigCache(): void {
  configCache = null;
}

export function loadUserConfig(filePath: string = getConfigPath()): UserConfig {
  const errors: string[] = [];
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // Missing or unreadable — fall through to the existsSync path below.
  }
  if (mtimeMs !== null && configCache && configCache.path === filePath && configCache.mtimeMs === mtimeMs) {
    return configCache.value;
  }

  if (!fs.existsSync(filePath)) {
    return { path: filePath, errors };
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (e: any) {
    const problem = `read failed: ${e?.message || e}`;
    warnConfig(filePath, `${problem} — the entire config was ignored`);
    return { path: filePath, errors: [problem] };
  }

  let parsed: TomlTable;
  try {
    parsed = parseToml(text);
  } catch (e: any) {
    const problem = `parse failed: ${e?.message || e}`;
    warnConfig(filePath, `${problem} — the entire config was ignored`);
    return { path: filePath, errors: [problem] };
  }

  // Per-key mapping errors are survivable: the rest of the file still applies.
  // Still worth one line, or a skipped key looks like a wmux bug.
  const mapped = mapToConfig(parsed, errors);
  for (const err of errors) warnConfig(filePath, err);

  const value = { ...mapped, path: filePath, errors };
  if (mtimeMs !== null) configCache = { path: filePath, mtimeMs, value };
  return value;
}

// ---------------------------------------------------------------------------
// Mapping helpers — everything here is defensive: a bad key is skipped with
// a warning, not a throw.
// ---------------------------------------------------------------------------

function asTable(v: TomlValue | undefined): TomlTable | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as TomlTable;
}

function asString(v: TomlValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: TomlValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function asBool(v: TomlValue | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asStringArray(v: TomlValue | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
  }
  return out.length ? out : undefined;
}

function asNumberArray(v: TomlValue | undefined): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const item of v) {
    if (typeof item === 'number' && Number.isFinite(item)) out.push(item);
  }
  return out.length ? out : undefined;
}

function mapColorScheme(schemeTable: TomlTable): UserColorScheme {
  const scheme: UserColorScheme = {};
  const bg = asString(schemeTable.background);
  if (bg) scheme.background = bg;
  const fg = asString(schemeTable.foreground);
  if (fg) scheme.foreground = fg;
  const cursor = asString(schemeTable.cursor ?? schemeTable['cursor-color']);
  if (cursor) scheme.cursor = cursor;
  const cursorText = asString(schemeTable['cursor-text'] ?? schemeTable.cursorText);
  if (cursorText) scheme.cursorText = cursorText;
  const selBg = asString(schemeTable['selection-background'] ?? schemeTable.selectionBackground);
  if (selBg) scheme.selectionBackground = selBg;
  const selFg = asString(schemeTable['selection-foreground'] ?? schemeTable.selectionForeground);
  if (selFg) scheme.selectionForeground = selFg;
  const palette = asStringArray(schemeTable.palette);
  if (palette) scheme.palette = palette.slice(0, 16);
  return scheme;
}

function mapUserColorSchemes(schemes: TomlTable, errors: string[]): Record<string, UserColorScheme> | undefined {
  const userSchemes: Record<string, UserColorScheme> = {};
  for (const [name, value] of Object.entries(schemes)) {
    const schemeTable = asTable(value);
    if (!schemeTable) {
      errors.push(`terminal.colors.schemes.${name}: expected table`);
      continue;
    }
    const scheme = mapColorScheme(schemeTable);
    if (Object.keys(scheme).length) userSchemes[name] = scheme;
  }
  return Object.keys(userSchemes).length ? userSchemes : undefined;
}

function mapTerminalColors(t: NonNullable<UserConfig['terminal']>, colors: TomlTable, errors: string[]): void {
  const defaultName = asString(colors.default ?? colors.theme);
  if (defaultName) t.theme = defaultName;

  const schemes = asTable(colors.schemes);
  if (!schemes) return;
  const userSchemes = mapUserColorSchemes(schemes, errors);
  if (userSchemes) t.userColorSchemes = userSchemes;
}

function mapTerminalSection(root: TomlTable, errors: string[]): NonNullable<UserConfig['terminal']> | undefined {
  const terminal = asTable(root.terminal);
  if (!terminal) return undefined;

  const t: NonNullable<UserConfig['terminal']> = {};

  const fontFamily = asString(terminal['font-family'] ?? terminal.fontFamily);
  if (fontFamily !== undefined) t.fontFamily = fontFamily;

  const fontSize = asNumber(terminal['font-size'] ?? terminal.fontSize);
  if (fontSize !== undefined) t.fontSize = fontSize;

  const cursorStyleRaw = asString(terminal['cursor-style'] ?? terminal.cursorStyle);
  if (cursorStyleRaw) {
    if (cursorStyleRaw === 'block' || cursorStyleRaw === 'underline' || cursorStyleRaw === 'bar') {
      t.cursorStyle = cursorStyleRaw;
    } else {
      errors.push(`terminal.cursor-style: "${cursorStyleRaw}" not one of block|underline|bar`);
    }
  }

  const cursorBlink = asBool(terminal['cursor-blink'] ?? terminal.cursorBlink);
  if (cursorBlink !== undefined) t.cursorBlink = cursorBlink;

  const scrollbackLines = asNumber(terminal['scrollback-lines'] ?? terminal.scrollbackLines);
  if (scrollbackLines !== undefined) t.scrollbackLines = scrollbackLines;

  const colors = asTable(terminal.colors);
  if (colors) mapTerminalColors(t, colors, errors);

  return Object.keys(t).length ? t : undefined;
}

// App UI theme (issue #67): `[appearance] ui-theme = "light" | "dark" | "system"`.
function mapAppearanceSection(root: TomlTable, errors: string[]): NonNullable<UserConfig['appearance']> | undefined {
  const appearance = asTable(root.appearance);
  if (!appearance) return undefined;

  const uiThemeRaw = asString(appearance['ui-theme'] ?? appearance.uiTheme);
  if (!uiThemeRaw) return undefined;

  if (uiThemeRaw === 'light' || uiThemeRaw === 'dark' || uiThemeRaw === 'system') {
    return { uiTheme: uiThemeRaw };
  }
  errors.push(`appearance.ui-theme: "${uiThemeRaw}" not one of light|dark|system`);
  return undefined;
}

/**
 * New-workspace shape: `[workspace] panes = N`, `layout = "..."` (issue #212).
 *
 * `single` is accepted and normalised to `panes = 1` — it is the word the issue
 * used, and refusing it would make the setting look broken to the person who
 * asked for it. It is normalised HERE rather than carried through, so the
 * renderer's builder has exactly one representation of "one pane".
 *
 * A count outside 1-8 is an error the user gets told about, and is then clamped
 * rather than dropped: `panes = 40` is a typo, and both silently opening one
 * pane and dutifully spawning forty shells are worse answers than eight.
 */
const WORKSPACE_LAYOUTS: readonly WorkspaceLayout[] = ['grid', 'columns', 'rows', 'left', 'down'];
const MAX_CONFIG_PANES = 8;

function mapWorkspaceSection(root: TomlTable, errors: string[]): NonNullable<UserConfig['workspace']> | undefined {
  const workspace = asTable(root.workspace);
  if (!workspace) return undefined;

  const out: NonNullable<UserConfig['workspace']> = {};

  const layoutRaw = asString(workspace.layout);
  if (layoutRaw === 'single') {
    out.panes = 1;
  } else if (layoutRaw !== undefined) {
    if ((WORKSPACE_LAYOUTS as readonly string[]).includes(layoutRaw)) {
      out.layout = layoutRaw as WorkspaceLayout;
    } else {
      errors.push(`workspace.layout: "${layoutRaw}" not one of ${WORKSPACE_LAYOUTS.join('|')}|single`);
    }
  }

  const panesRaw = workspace.panes;
  if (panesRaw !== undefined) {
    const panes = asNumber(panesRaw);
    if (panes === undefined || !Number.isFinite(panes)) {
      errors.push('workspace.panes: expected a number');
    } else {
      const clamped = Math.min(Math.max(Math.round(panes), 1), MAX_CONFIG_PANES);
      if (clamped !== panes) {
        errors.push(`workspace.panes: ${panes} is outside 1-${MAX_CONFIG_PANES}, using ${clamped}`);
      }
      // An explicit count wins over `layout = "single"`, which is only a
      // shorthand for one — writing both means the user meant the number.
      out.panes = clamped;
    }
  }

  return Object.keys(out).length ? out : undefined;
}

// Browser dev-port detection: `[browser] dev-ports = [...]`, `auto-open = bool`,
// plus the panel's start page `default-url` (issue #212).
function mapBrowserSection(root: TomlTable, errors: string[]): NonNullable<UserConfig['browser']> | undefined {
  const browser = asTable(root.browser);
  if (!browser) return undefined;

  const out: NonNullable<UserConfig['browser']> = {};

  const devPortsRaw = browser['dev-ports'] ?? browser.devPorts;
  if (devPortsRaw !== undefined) {
    const nums = asNumberArray(devPortsRaw);
    if (nums) {
      // Keep integer ports in the valid TCP range; drop the rest with a warning.
      const valid = nums.filter(p => Number.isInteger(p) && p >= 1 && p <= 65535);
      if (valid.length) out.devPorts = valid;
      if (valid.length !== nums.length) {
        errors.push('browser.dev-ports: dropped entries outside 1-65535 or non-integer');
      }
    } else {
      errors.push('browser.dev-ports: expected an array of port numbers');
    }
  }

  const autoOpen = asBool(browser['auto-open'] ?? browser.autoOpen);
  if (autoOpen !== undefined) out.autoOpen = autoOpen;

  const defaultUrl = mapDefaultUrl(browser['default-url'] ?? browser.defaultUrl, errors);
  if (defaultUrl !== undefined) out.defaultUrl = defaultUrl;

  return Object.keys(out).length ? out : undefined;
}

/** `[browser] default-url` (issue #212). Returns undefined when nothing valid was set. */
function mapDefaultUrl(raw: TomlValue | undefined, errors: string[]): string | undefined {
  if (raw === undefined) return undefined;
  const url = asString(raw)?.trim();
  if (url === undefined) {
    errors.push('browser.default-url: expected a string');
    return undefined;
  }
  // Explicitly empty is a valid answer — "no start page of my own". Carried
  // rather than dropped so `wmux reload-config` can UNSET it; dropping it would
  // leave the previous value in place until restart.
  if (url === '') return '';
  // A bare `localhost:3000` or `example.com` is the likeliest thing to type
  // here, and a webview handed one loads nothing and says nothing. Naming a
  // scheme is the whole fix, so say that rather than just refusing.
  //
  // The `//` is load-bearing, not decoration: `localhost:3000` satisfies a
  // scheme-shaped `^[a-z][a-z0-9+.-]*:` perfectly — `localhost` IS a legal
  // scheme name — so a check without it accepts exactly the mistake it was
  // written to catch. `about:` is allowed beside it because `about:blank` is a
  // reasonable thing to want and is the one common URL with no authority.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^about:/i.test(url)) {
    errors.push(`browser.default-url: "${url}" has no scheme — write http:// or https://`);
    return undefined;
  }
  return url;
}

/**
 * Remote upload: `[remote] upload-on-paste = bool`, `upload-on-drop = bool`.
 *
 * Present so the behaviour can be turned off wholesale. Application-initiated
 * scp is the kind of thing corporate endpoint policy flags, and a user who
 * cannot allow it still needs paste to work — falling back to the local path.
 */
function mapRemoteSection(root: TomlTable, errors: string[]): NonNullable<UserConfig['remote']> | undefined {
  const remote = asTable(root.remote);
  if (!remote) return undefined;

  const out: NonNullable<UserConfig['remote']> = {};
  const onPasteRaw = remote['upload-on-paste'] ?? remote.uploadOnPaste;
  const onPaste = asBool(onPasteRaw);
  if (onPaste !== undefined) out.uploadOnPaste = onPaste;
  else if (onPasteRaw !== undefined) errors.push('remote.upload-on-paste: expected boolean');
  const onDropRaw = remote['upload-on-drop'] ?? remote.uploadOnDrop;
  const onDrop = asBool(onDropRaw);
  if (onDrop !== undefined) out.uploadOnDrop = onDrop;
  else if (onDropRaw !== undefined) errors.push('remote.upload-on-drop: expected boolean');

  return Object.keys(out).length ? out : undefined;
}

/**
 * Key remaps: `[keys] "ctrl+k" = "<C-k><Delete>"` (issue #146).
 *
 * Parsing happens here rather than in the renderer so the errors land in the
 * same place as every other config mistake — and so the renderer receives a
 * plain, already-validated array it can match against without re-parsing on
 * every keystroke.
 */
function mapKeysSection(root: TomlTable, errors: string[]): KeyRemap[] | undefined {
  const keys = asTable(root.keys);
  if (!keys) return undefined;
  const remaps = parseKeyRemaps(keys, errors);
  return remaps.length ? remaps : undefined;
}

function mapToConfig(root: TomlTable, errors: string[]): UserConfig {
  const out: UserConfig = {};

  const terminal = mapTerminalSection(root, errors);
  if (terminal) out.terminal = terminal;

  const appearance = mapAppearanceSection(root, errors);
  if (appearance) out.appearance = appearance;

  const workspace = mapWorkspaceSection(root, errors);
  if (workspace) out.workspace = workspace;

  const browser = mapBrowserSection(root, errors);
  if (browser) out.browser = browser;

  const remote = mapRemoteSection(root, errors);
  if (remote) out.remote = remote;

  const keys = mapKeysSection(root, errors);
  if (keys) out.keys = keys;

  return out;
}
