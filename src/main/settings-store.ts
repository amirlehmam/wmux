import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';

// User settings (issue #19). Previously these lived only in renderer
// localStorage, which is scoped to the page origin. Because wmux ships as a
// portable zip that users extract to a *new folder per version*, the
// production `file://` origin changes between versions and Chromium buckets
// localStorage by that path — so font/theme/shortcut customizations appeared
// to reset on every update. We now persist settings to a JSON file in the
// stable %APPDATA%\wmux directory (the same place session.json lives, and
// which handleVersionChange never touches), so they survive updates.

const SETTINGS_FILE = path.join(getAppDataDir(), 'settings.json');

type SettingsMap = Record<string, unknown>;

export function loadSettings(): SettingsMap {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as SettingsMap) : {};
  } catch {
    return {};
  }
}

export function saveSetting(key: string, value: unknown): boolean {
  try {
    const dir = getAppDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const current = loadSettings();
    current[key] = value;
    // A failed replacement must leave the last persisted preference intact.
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf-8');
    fs.renameSync(tmp, SETTINGS_FILE);
    return true;
  } catch (err) {
    console.error('Failed to save setting:', err);
    return false;
  }
}

export function getSettingsPath(): string {
  return SETTINGS_FILE;
}
