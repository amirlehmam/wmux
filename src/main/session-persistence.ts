import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';

const APPDATA_DIR = getAppDataDir();
const SESSIONS_DIR = path.join(APPDATA_DIR, 'sessions');
const SESSION_FILE = path.join(SESSIONS_DIR, 'session.json');
const VERSION_FILE = path.join(APPDATA_DIR, 'app-version.txt');
const SAVED_DIR = path.join(APPDATA_DIR, 'sessions', 'saved');
const LAST_SESSION_FILE = path.join(APPDATA_DIR, 'sessions', 'last-session.txt');

export interface SessionData {
  version: 1;
  windows: Array<{
    bounds: { x: number; y: number; width: number; height: number };
    maximized?: boolean; // restore full-size state on relaunch (issue #57)
    sidebarWidth: number;
    activeWorkspaceId: string | null;
    workspaces: Array<{
      id: string;
      title: string;
      customColor?: string;
      pinned: boolean;
      shell: string;
      cwd?: string; // last reported working dir — restored so new terminals reopen here (issue #20)
      splitTree: any; // SplitNode serialized
    }>;
  }>;
}

export function ensureDirectories(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

export function saveSession(data: SessionData): void {
  ensureDirectories();
  // Atomic write: write to temp file, then rename
  const tmpFile = SESSION_FILE + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    // On Windows, rename won't overwrite, so remove first
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
    fs.renameSync(tmpFile, SESSION_FILE);
  } catch (err) {
    // Clean up temp file if it exists
    try { fs.unlinkSync(tmpFile); } catch {}
    console.error('Failed to save session:', err);
  }
}

export function loadSession(): SessionData | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    const data = JSON.parse(raw) as SessionData;
    if (data.version !== 1) return null;
    return data;
  } catch {
    // Corrupted file — fall back to default
    return null;
  }
}

export function getSessionPath(): string {
  return SESSION_FILE;
}

// Auto-backups created by handleVersionChange share this name prefix so they
// can be recognized and pruned without touching user-named sessions.
const AUTO_BACKUP_PREFIX = 'Auto-backup';
const AUTO_BACKUP_KEEP = 3;

/**
 * Archive the volatile auto-session as a *named* session before it is cleared
 * on a version change (issue #113: a user lost 20+ renamed tabs by updating
 * without hitting Save). The auto-session's PTYs died with the old process,
 * but its layout — titles, colors, splits, cwds — is exactly what a named
 * session stores, and loading a named session re-spawns fresh PTYs. Because
 * the post-update startup path already auto-restores the most recent named
 * session when no auto-session exists, this backup brings the user's tabs
 * back on the first launch of the new version with zero action on their part.
 */
function backupAutoSession(previousVersion: string): void {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as SessionData;
    const win = data?.windows?.[0];
    if (!win || !Array.isArray(win.workspaces) || win.workspaces.length === 0) return;

    const backup = {
      name: previousVersion ? `${AUTO_BACKUP_PREFIX} v${previousVersion}` : AUTO_BACKUP_PREFIX,
      savedAt: Date.now(),
      workspaces: win.workspaces.map(w => ({
        title: w.title,
        customColor: w.customColor,
        shell: w.shell,
        cwd: w.cwd || '',
        splitTree: w.splitTree,
      })),
      sidebarWidth: win.sidebarWidth ?? 260,
    };

    // Write directly instead of via saveNamedSession: a safety net must not
    // hijack the user's last-session pointer.
    if (!fs.existsSync(SAVED_DIR)) fs.mkdirSync(SAVED_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(SAVED_DIR, sanitizeName(backup.name) + '.json'),
      JSON.stringify(backup, null, 2),
      'utf-8'
    );
    pruneAutoBackups();
  } catch {
    /* best-effort — never block startup on a backup failure */
  }
}

/** Keep only the newest AUTO_BACKUP_KEEP auto-backups so updates don't pile up clutter. */
function pruneAutoBackups(): void {
  try {
    const backups = fs.readdirSync(SAVED_DIR)
      .filter(f => f.startsWith(AUTO_BACKUP_PREFIX) && f.endsWith('.json'))
      .map(f => {
        const full = path.join(SAVED_DIR, f);
        try { return { full, savedAt: Number(JSON.parse(fs.readFileSync(full, 'utf-8')).savedAt) || 0 }; }
        catch { return { full, savedAt: 0 }; }
      })
      .sort((a, b) => b.savedAt - a.savedAt);
    for (const stale of backups.slice(AUTO_BACKUP_KEEP)) {
      try { fs.unlinkSync(stale.full); } catch {}
    }
  } catch {}
}

/**
 * Returns true if the app version changed (or first launch).
 *
 * Clears only the *auto-restored* session (`session.json`) so the user gets a
 * clean Session 1 on the first launch of a new version — that file can hold a
 * live layout whose PTYs died with the previous process. Its layout is first
 * archived as an "Auto-backup vX.Y.Z" named session (issue #113) so nothing
 * the user arranged is ever lost to an update. Explicitly **named** saved
 * sessions (issue #35) are layout-only snapshots that the user chose to
 * keep, so they MUST survive updates; loading one always re-spawns fresh PTYs
 * (useTerminal calls pty.create when pty.has(surfaceId) is false), so there are
 * no stale handles to freeze. The last-session pointer is preserved too, so the
 * user can reload their last named session after an update.
 */
export function handleVersionChange(currentVersion: string): boolean {
  ensureDirectories();
  try {
    const saved = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf-8').trim() : '';
    if (saved === currentVersion) return false;
    // Archive, then reset, only the volatile auto-session. Named sessions
    // (SAVED_DIR) and the last-session pointer are intentionally preserved.
    backupAutoSession(saved);
    try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch {}
    fs.writeFileSync(VERSION_FILE, currentVersion, 'utf-8');
    return true;
  } catch { return false; }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, '_').substring(0, 100);
}

export function saveNamedSession(session: import('../shared/types').SavedSession): void {
  if (!fs.existsSync(SAVED_DIR)) fs.mkdirSync(SAVED_DIR, { recursive: true });
  const filePath = path.join(SAVED_DIR, sanitizeName(session.name) + '.json');
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  setLastSessionName(session.name);
}

export function loadNamedSession(name: string): import('../shared/types').SavedSession | null {
  try {
    const filePath = path.join(SAVED_DIR, sanitizeName(name) + '.json');
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

export function listNamedSessions(): Array<{ name: string; savedAt: number; workspaceCount: number }> {
  if (!fs.existsSync(SAVED_DIR)) return [];
  try {
    return fs.readdirSync(SAVED_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SAVED_DIR, f), 'utf-8'));
          return { name: data.name, savedAt: data.savedAt, workspaceCount: data.workspaces?.length || 0 };
        } catch { return null; }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch { return []; }
}

export function deleteNamedSession(name: string): boolean {
  try {
    const filePath = path.join(SAVED_DIR, sanitizeName(name) + '.json');
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
    return false;
  } catch { return false; }
}

export function getLastSessionName(): string | null {
  try {
    if (!fs.existsSync(LAST_SESSION_FILE)) return null;
    return fs.readFileSync(LAST_SESSION_FILE, 'utf-8').trim() || null;
  } catch { return null; }
}

export function setLastSessionName(name: string): void {
  if (!fs.existsSync(SAVED_DIR)) fs.mkdirSync(SAVED_DIR, { recursive: true });
  fs.writeFileSync(LAST_SESSION_FILE, name, 'utf-8');
}
