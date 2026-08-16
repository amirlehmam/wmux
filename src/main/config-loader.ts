import * as fs from 'fs';
import * as path from 'path';
import { ThemeConfig, QuickLaunchProfile, SurfaceType } from '../shared/types';
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
  name?: string;
  commandline?: string;
  startingDirectory?: string;
  /** WT dynamic-profile source (e.g. "Windows.Terminal.PowershellCore"). */
  source?: string;
  hidden?: boolean;
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
// Quick-launch profiles (issue #32)
// ---------------------------------------------------------------------------

const VALID_SURFACE_TYPES: SurfaceType[] = ['terminal', 'browser', 'markdown'];

/** Coerce one raw config entry into a validated QuickLaunchProfile, or null. */
function sanitizeProfile(raw: any, index: number, source: 'global' | 'project'): QuickLaunchProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  const type: SurfaceType = VALID_SURFACE_TYPES.includes(raw.type) ? raw.type : 'terminal';
  const startupCommands = Array.isArray(raw.startupCommands)
    ? raw.startupCommands.filter((c: unknown): c is string => typeof c === 'string' && c.length > 0)
    : undefined;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${source}-${index}-${name}`,
    name,
    type,
    source,
    ...(typeof raw.icon === 'string' ? { icon: raw.icon } : {}),
    ...(typeof raw.shell === 'string' ? { shell: raw.shell } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...(startupCommands && startupCommands.length ? { startupCommands } : {}),
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
  };
}

/**
 * Read project-level quick-launch profiles from `<cwd>/.wmux.json` (mirrors
 * cmux's `cmux.json`). Shape: `{ "profiles": [ { name, type, cwd, startupCommands, ... } ] }`.
 * Returns [] when the file is absent or malformed — never throws.
 */
export function loadProjectProfiles(cwd: string): QuickLaunchProfile[] {
  try {
    if (!cwd || typeof cwd !== 'string') return [];
    const file = path.join(cwd, '.wmux.json');
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.profiles;
    if (!Array.isArray(list)) return [];
    return list
      .map((raw, i) => sanitizeProfile(raw, i, 'project'))
      .filter((p): p is QuickLaunchProfile => p !== null);
  } catch {
    return [];
  }
}

/**
 * WT's dynamic PowerShell Core profile ("PowerShell" / "PowerShell 7 Preview")
 * ships without a `commandline` — WT itself resolves it at launch. Without an
 * explicit mapping, the imported wmux profile ends up shell-less and silently
 * launches the default pwsh instead of the chosen (preview) build. Map it to
 * the App Execution Alias; at spawn time resolveShell verifies it and falls
 * back to the default if the aliases are absent.
 */
function shellForDynamicPowerShell(name: string): string {
  return /preview/i.test(name) ? 'pwsh-preview' : 'pwsh';
}

/**
 * Pure mapping of a Windows Terminal profile list to Quick-launch profiles.
 * A profile's `commandline` becomes its `shell`; dynamic PowerShell Core
 * profiles (no commandline) map to `pwsh`/`pwsh-preview` by name.
 */
export function mapWindowsTerminalProfiles(profiles: WTProfile[]): QuickLaunchProfile[] {
  return profiles
    .filter((p) => !p.hidden && (p.name || p.commandline))
    .map((p, i) => {
      const name = (p.name || p.commandline || `Profile ${i + 1}`).trim();
      const dynamicPs = !p.commandline && p.source === 'Windows.Terminal.PowershellCore';
      return {
        id: `wt-${p.guid || i}`,
        name,
        type: 'terminal' as SurfaceType,
        source: 'global' as const,
        ...(p.commandline ? { shell: p.commandline } : dynamicPs ? { shell: shellForDynamicPowerShell(name) } : {}),
        ...(p.startingDirectory ? { cwd: p.startingDirectory.replace(/%([^%]+)%/g, (_m, v) => process.env[v] || _m) } : {}),
      };
    });
}

/**
 * Import Windows Terminal profiles as quick-launch profiles, mapping each
 * non-hidden profile's `commandline` (→ shell) and `startingDirectory` (→ cwd).
 * This finishes the WT import that previously kept only the color scheme.
 */
export function importWindowsTerminalProfiles(): QuickLaunchProfile[] {
  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return [];
    const settingsPath = path.join(
      localAppData,
      'Packages',
      'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
      'LocalState',
      'settings.json',
    );
    if (!fs.existsSync(settingsPath)) return [];
    const settings: WTSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    let profiles: WTProfile[] = [];
    if (Array.isArray(settings.profiles)) {
      profiles = settings.profiles;
    } else if (settings.profiles && Array.isArray(settings.profiles.list)) {
      profiles = settings.profiles.list;
    }
    return mapWindowsTerminalProfiles(profiles);
  } catch {
    return [];
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
