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
 *   [browser]
 *   dev-ports = [8501, 4321]   # extra dev-server ports, merged with built-in defaults
 *   auto-open = true           # auto-navigate the browser to a newly-detected dev port
 *
 * File-wins-at-startup, app-wins-at-runtime: this data seeds the store
 * on boot; users can still tweak via the Settings UI afterwards.
 * A `wmux reload-config` command re-applies the file over runtime state.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseToml, TomlTable, TomlValue } from './toml-parser';

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
  /** Browser surface behavior — dev-server port detection & auto-navigation. */
  browser?: {
    /** Extra ports (merged with the built-in defaults) that count as dev servers. */
    devPorts?: number[];
    /** Auto-navigate the workspace browser to a newly-detected dev port (default true). */
    autoOpen?: boolean;
  };
  /** Absolute path the config was read from (for diagnostics). */
  path?: string;
  /** Any parse or mapping errors — non-fatal, surfaced to the renderer. */
  errors?: string[];
}

export function getConfigPath(): string {
  const home = os.homedir();
  return path.join(home, '.wmux', 'config.toml');
}

export function loadUserConfig(filePath: string = getConfigPath()): UserConfig {
  const errors: string[] = [];
  if (!fs.existsSync(filePath)) {
    return { path: filePath, errors };
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (e: any) {
    return { path: filePath, errors: [`read failed: ${e?.message || e}`] };
  }

  let parsed: TomlTable;
  try {
    parsed = parseToml(text);
  } catch (e: any) {
    return { path: filePath, errors: [`parse failed: ${e?.message || e}`] };
  }

  return { ...mapToConfig(parsed, errors), path: filePath, errors };
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

// Browser dev-port detection: `[browser] dev-ports = [...]`, `auto-open = bool`.
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

  return Object.keys(out).length ? out : undefined;
}

function mapToConfig(root: TomlTable, errors: string[]): UserConfig {
  const out: UserConfig = {};

  const terminal = mapTerminalSection(root, errors);
  if (terminal) out.terminal = terminal;

  const appearance = mapAppearanceSection(root, errors);
  if (appearance) out.appearance = appearance;

  const browser = mapBrowserSection(root, errors);
  if (browser) out.browser = browser;

  return out;
}
