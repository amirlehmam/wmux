import * as fs from 'fs';
import * as path from 'path';
import { ThemeConfig } from '../shared/types';

/**
 * Parse a Ghostty-style theme file (key = value pairs) into a ThemeConfig.
 * Returns null if the content cannot be meaningfully parsed.
 */
export function parseThemeFileContent(name: string, content: string): ThemeConfig | null {
  const values: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    values[key] = value;
  }

  // Parse palette entries: "palette = N=RRGGBB" or "palette = N=#RRGGBB"
  const palette: string[] = new Array(16).fill('');

  // Re-iterate to handle multiple "palette" keys
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key === 'palette') {
      // Format: N=color or N=#color
      const innerEq = value.indexOf('=');
      if (innerEq !== -1) {
        const idx = parseInt(value.slice(0, innerEq).trim(), 10);
        const color = value.slice(innerEq + 1).trim();
        if (!isNaN(idx) && idx >= 0 && idx <= 15) {
          palette[idx] = normalizeColor(color);
        }
      }
    }
  }

  // Fill missing palette entries with empty string (caller can fill defaults)
  const background = normalizeColor(values['background'] || '');
  const foreground = normalizeColor(values['foreground'] || '');

  if (!background && !foreground) return null;

  return {
    name,
    background: background || '#000000',
    foreground: foreground || '#ffffff',
    cursor: normalizeColor(values['cursor-color'] || values['cursor'] || foreground || '#ffffff'),
    cursorText: normalizeColor(values['cursor-text'] || ''),
    selectionBackground: normalizeColor(values['selection-background'] || ''),
    selectionForeground: normalizeColor(values['selection-foreground'] || ''),
    palette,
    fontFamily: values['font-family'] || 'Cascadia Mono',
    fontSize: parseFloat(values['font-size'] || '13') || 13,
    backgroundOpacity: parseFloat(values['background-opacity'] || '1') || 1.0,
  };
}

function normalizeColor(color: string): string {
  if (!color) return '';
  const c = color.trim();
  if (c.startsWith('#')) return c;
  // Bare hex like 272822
  if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c}`;
  return c;
}

/**
 * Scans resources/themes/ for Ghostty-format theme files and returns a Map
 * of theme name → ThemeConfig.
 */
function getThemesDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'themes');
    }
  } catch {
    // Not running in Electron (e.g., during tests)
  }
  return path.join(__dirname, '../../resources/themes');
}

export function loadBundledThemes(): Map<string, ThemeConfig> {
  const result = new Map<string, ThemeConfig>();
  const themesDir = getThemesDir();

  let entries: string[];
  try {
    entries = fs.readdirSync(themesDir);
  } catch {
    return result; // Directory doesn't exist or isn't readable
  }

  for (const entry of entries) {
    const filePath = path.join(themesDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const themeName = path.parse(entry).name;
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const theme = parseThemeFileContent(themeName, content);
    if (theme) {
      result.set(themeName, theme);
    }
  }

  return result;
}

/**
 * Resolve a theme by name. Tries bundled themes first, then falls back to
 * the built-in Monokai default. Name lookup is case-insensitive.
 */
export function getThemeByName(name: string | undefined | null): ThemeConfig {
  if (!name) return getDefaultTheme();
  const bundled = loadBundledThemes();
  // Exact match
  const direct = bundled.get(name);
  if (direct) return direct;
  // Case-insensitive match
  const target = name.toLowerCase();
  for (const [key, theme] of bundled) {
    if (key.toLowerCase() === target) return theme;
  }
  return getDefaultTheme();
}

/**
 * Returns the built-in Monokai default theme.
 */
export function getDefaultTheme(): ThemeConfig {
  return {
    name: 'Monokai',
    background: '#272822',
    foreground: '#fdfff1',
    cursor: '#c0c1b5',
    cursorText: '',
    selectionBackground: '#57584f',
    selectionForeground: '#fdfff1',
    palette: [
      '#272822', // 0  black
      '#f92672', // 1  red
      '#a6e22e', // 2  green
      '#f4bf75', // 3  yellow
      '#66d9ef', // 4  blue
      '#ae81ff', // 5  magenta
      '#a1efe4', // 6  cyan
      '#f8f8f2', // 7  white
      '#75715e', // 8  bright black
      '#f92672', // 9  bright red
      '#a6e22e', // 10 bright green
      '#f4bf75', // 11 bright yellow
      '#66d9ef', // 12 bright blue
      '#ae81ff', // 13 bright magenta
      '#a1efe4', // 14 bright cyan
      '#f9f8f5', // 15 bright white
    ],
    fontFamily: 'Cascadia Mono',
    fontSize: 13,
    backgroundOpacity: 1.0,
  };
}
