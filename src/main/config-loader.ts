import * as fs from 'fs';
import * as path from 'path';
import { ThemeConfig } from '../shared/types';
import { parseThemeFileContent, loadBundledThemes } from './theme-loader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeColor(color: string): string {
  if (!color) return '';
  const c = color.trim();
  if (c.startsWith('#')) return c;
  if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c}`;
  return c;
}

// ---------------------------------------------------------------------------
// Windows Terminal config parser
// ---------------------------------------------------------------------------

interface WTProfile {
  guid?: string;
  font?: { face?: string; size?: number };
  fontSize?: number;
  fontFace?: string;
  colorScheme?: string;
}

interface WTColorScheme {
  name?: string;
  background?: string;
  foreground?: string;
  cursorColor?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  // ANSI colors — named style
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  purple?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightPurple?: string;
  brightCyan?: string;
  brightWhite?: string;
  // Numbered style (color0 … color15)
  [key: string]: string | undefined;
}

interface WTSettings {
  defaultProfile?: string;
  profiles?: { list?: WTProfile[] } | WTProfile[];
  schemes?: WTColorScheme[];
}

function schemeToTheme(profile: WTProfile, scheme: WTColorScheme): ThemeConfig {
  const palette: string[] = [
    normalizeColor(scheme.black || scheme['color0'] || ''),
    normalizeColor(scheme.red || scheme['color1'] || ''),
    normalizeColor(scheme.green || scheme['color2'] || ''),
    normalizeColor(scheme.yellow || scheme['color3'] || ''),
    normalizeColor(scheme.blue || scheme['color4'] || ''),
    normalizeColor(scheme.purple || scheme['color5'] || ''),
    normalizeColor(scheme.cyan || scheme['color6'] || ''),
    normalizeColor(scheme.white || scheme['color7'] || ''),
    normalizeColor(scheme.brightBlack || scheme['color8'] || ''),
    normalizeColor(scheme.brightRed || scheme['color9'] || ''),
    normalizeColor(scheme.brightGreen || scheme['color10'] || ''),
    normalizeColor(scheme.brightYellow || scheme['color11'] || ''),
    normalizeColor(scheme.brightBlue || scheme['color12'] || ''),
    normalizeColor(scheme.brightPurple || scheme['color13'] || ''),
    normalizeColor(scheme.brightCyan || scheme['color14'] || ''),
    normalizeColor(scheme.brightWhite || scheme['color15'] || ''),
  ];

  const fontFace =
    (profile.font?.face) ||
    profile.fontFace ||
    'Cascadia Mono';
  const fontSize =
    profile.font?.size ||
    profile.fontSize ||
    13;

  return {
    name: scheme.name || 'Windows Terminal',
    background: normalizeColor(scheme.background || ''),
    foreground: normalizeColor(scheme.foreground || ''),
    cursor: normalizeColor(scheme.cursorColor || ''),
    cursorText: '',
    selectionBackground: normalizeColor(scheme.selectionBackground || ''),
    selectionForeground: normalizeColor(scheme.selectionForeground || ''),
    palette,
    fontFamily: fontFace,
    fontSize,
    backgroundOpacity: 1.0,
  };
}

/**
 * Parse a Windows Terminal settings JSON object directly.
 * Exposed as a named export so tests can call it without hitting the filesystem.
 */
export function parseWindowsTerminalSettingsJson(settings: WTSettings): ThemeConfig | null {
  try {
    const defaultGuid = settings.defaultProfile;

    // Normalise profiles list (can be object with .list or plain array)
    let profiles: WTProfile[] = [];
    if (Array.isArray(settings.profiles)) {
      profiles = settings.profiles;
    } else if (settings.profiles && Array.isArray(settings.profiles.list)) {
      profiles = settings.profiles.list;
    }

    // Find default profile
    let defaultProfile: WTProfile | undefined;
    if (defaultGuid) {
      defaultProfile = profiles.find(
        (p) => p.guid?.toLowerCase() === defaultGuid.toLowerCase(),
      );
    }
    if (!defaultProfile && profiles.length > 0) {
      defaultProfile = profiles[0];
    }
    if (!defaultProfile) defaultProfile = {};

    const schemes: WTColorScheme[] = settings.schemes || [];

    // Find matching color scheme
    let scheme: WTColorScheme | undefined;
    if (defaultProfile.colorScheme) {
      scheme = schemes.find((s) => s.name === defaultProfile!.colorScheme);
    }
    if (!scheme && schemes.length > 0) {
      scheme = schemes[0];
    }
    if (!scheme) scheme = {};

    return schemeToTheme(defaultProfile, scheme);
  } catch {
    return null;
  }
}

/**
 * Reads Windows Terminal settings.json from %LOCALAPPDATA% and returns a ThemeConfig.
 */
export function parseWindowsTerminalConfig(): ThemeConfig | null {
  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;

    const settingsPath = path.join(
      localAppData,
      'Packages',
      'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
      'LocalState',
      'settings.json',
    );

    if (!fs.existsSync(settingsPath)) return null;

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const settings: WTSettings = JSON.parse(raw);
    return parseWindowsTerminalSettingsJson(settings);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ghostty config parser
// ---------------------------------------------------------------------------

/**
 * Parse a Ghostty config string (not file) and return a ThemeConfig.
 * Exposed as a named export so tests can call it without touching the filesystem.
 */
export function parseGhosttyConfigString(
  text: string,
  themeMap?: Map<string, ThemeConfig>,
): ThemeConfig | null {
  try {
    const values: Record<string, string> = {};
    const palette: string[] = new Array(16).fill('');

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim();

      if (key === 'palette') {
        const innerEq = value.indexOf('=');
        if (innerEq !== -1) {
          const idx = parseInt(value.slice(0, innerEq).trim(), 10);
          const color = value.slice(innerEq + 1).trim();
          if (!isNaN(idx) && idx >= 0 && idx <= 15) {
            palette[idx] = normalizeColor(color);
          }
        }
      } else {
        values[key] = value;
      }
    }

    // If a theme is specified, try to load it and merge (config values override theme)
    let base: ThemeConfig | null = null;
    if (values['theme'] && themeMap) {
      base = themeMap.get(values['theme']) || null;
    }

    const background = normalizeColor(values['background'] || base?.background || '');
    const foreground = normalizeColor(values['foreground'] || base?.foreground || '');

    // Merge palette: config entries override theme palette
    const mergedPalette = base
      ? base.palette.map((c, i) => palette[i] || c)
      : palette;

    return {
      name: values['theme'] || 'Ghostty',
      background: background || '#000000',
      foreground: foreground || '#ffffff',
      cursor: normalizeColor(values['cursor-color'] || base?.cursor || ''),
      cursorText: '',
      selectionBackground: normalizeColor(
        values['selection-background'] || base?.selectionBackground || '',
      ),
      selectionForeground: normalizeColor(
        values['selection-foreground'] || base?.selectionForeground || '',
      ),
      palette: mergedPalette,
      fontFamily: values['font-family'] || base?.fontFamily || 'Cascadia Mono',
      fontSize: parseFloat(values['font-size'] || String(base?.fontSize ?? 13)) || 13,
      backgroundOpacity:
        parseFloat(values['background-opacity'] || String(base?.backgroundOpacity ?? 1)) || 1.0,
    };
  } catch {
    return null;
  }
}

/**
 * Reads ~/.config/ghostty/config and returns a ThemeConfig.
 */
export function parseGhosttyConfig(): ThemeConfig | null {
  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (!userProfile) return null;

    const configPath = path.join(userProfile, '.config', 'ghostty', 'config');
    if (!fs.existsSync(configPath)) return null;

    const text = fs.readFileSync(configPath, 'utf-8');

    // Load bundled themes so that a `theme = XYZ` directive can be resolved
    const themeMap = loadBundledThemes();
    return parseGhosttyConfigString(text, themeMap);
  } catch {
    return null;
  }
}

/**
 * Parse a Ghostty-format theme file string into a ThemeConfig.
 * Re-exported from theme-loader for convenience.
 */
export { parseThemeFileContent };
