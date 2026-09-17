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
      // The POSIX/WSL directory. `cwd` is last-writer-wins across both
      // filesystems, so a pwsh pane leaves a Win32 path there and restored WSL
      // panes get `--cd ~`; this one is only ever written by a POSIX report.
      posixCwd?: string;
      splitTree: any; // SplitNode serialized
      // The renderer has always written these two; the interface omitting them
      // is what let backupAutoSession drop them without tsc noticing (#145).
      browserUrl?: string;
      browserWidth?: number;
      // Same lifecycle as browserWidth: written by the renderer, and dropped
      // by backupAutoSession until the interface named it (#145).
      explorerOpen?: boolean;
      explorerWidth?: number;
      explorerExpanded?: Record<string, string[]>;
      explorerShowHidden?: boolean;
    }>;
  }>;
}

export function ensureDirectories(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/**
 * Write the auto-session, leaving a readable file at every instant (issue #214).
 *
 * This was described as an atomic write and was not one. It wrote a temp file,
 * then `unlink`ed the live `session.json`, then renamed — so between those last
 * two calls there was no session file on disk at all. Die in that window and
 * the next launch finds nothing to restore: it falls back to a fresh Session 1
 * or to an older named session, which re-mints every pane and surface id and so
 * loses the tab names the user gave them. That is #214's "surfaces come back
 * with new ids and lose their customTitle", and it needs no explanation beyond
 * a process that aborts at an unpredictable moment — which is the rest of #214.
 *
 * The window was never necessary. The `unlink` is there for a comment that says
 * "on Windows, rename won't overwrite", and that is true of the Win32
 * `MoveFileW` but not of Node: libuv's `uv_fs_rename` calls `MoveFileExW` with
 * `MOVEFILE_REPLACE_EXISTING`, so a plain `renameSync` over an existing file is
 * both legal and atomic. The old two-step survives only as a FALLBACK, for the
 * one thing that genuinely can fail the single-step form — a transient sharing
 * violation from antivirus or a sync client holding the target open, which on a
 * path under OneDrive is not hypothetical.
 */
export function saveSession(data: SessionData): void {
  ensureDirectories();
  const tmpFile = SESSION_FILE + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    try {
      // One step: the old file is replaced, never absent.
      fs.renameSync(tmpFile, SESSION_FILE);
    } catch {
      // Target locked. Now — and only now — is the unlink worth its window,
      // because the alternative is not saving at all.
      try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch { /* the rename below reports */ }
      fs.renameSync(tmpFile, SESSION_FILE);
    }
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
 *
 * Fidelity is the whole contract (issue #145): this file is what the user gets
 * restored after an update, so it must carry everything a manual Save does. It
 * previously copied a subset — no browserUrl, browserWidth or pinned — and only
 * ever looked at windows[0]. Users experienced that as "the autobackup does its
 * own thing": browsers back on the default page, pinned tabs unpinned, and a
 * second window's workspaces simply gone.
 */
function backupAutoSession(previousVersion: string): void {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as SessionData;
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    // Every window's workspaces, in window order. A named session restores into
    // a single window, so a multi-window layout comes back flattened — losing
    // the window split is a far smaller surprise than losing the tabs.
    const workspaces = windows.flatMap(w => (Array.isArray(w?.workspaces) ? w.workspaces : []));
    if (workspaces.length === 0) return;

    const backup = {
      name: previousVersion ? `${AUTO_BACKUP_PREFIX} v${previousVersion}` : AUTO_BACKUP_PREFIX,
      savedAt: Date.now(),
      workspaces: workspaces.map(w => ({
        title: w.title,
        customColor: w.customColor,
        pinned: !!w.pinned,
        shell: w.shell,
        cwd: w.cwd || '',
        posixCwd: w.posixCwd || '',
        splitTree: w.splitTree,
        browserUrl: w.browserUrl || '',
        browserWidth: w.browserWidth,
        explorerOpen: w.explorerOpen,
        explorerWidth: w.explorerWidth,
        explorerExpanded: w.explorerExpanded,
        explorerShowHidden: w.explorerShowHidden,
      })),
      sidebarWidth: windows[0]?.sidebarWidth ?? 260,
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

/**
 * Keep only the newest `keep` sessions whose name starts with `prefix`, so a
 * family of automatic saves stays a ring instead of a pile.
 *
 * Shared by the version-change backups and the scheduled snapshots (#238).
 * The two prefixes do not collide, and sharing the pruner is what keeps them
 * from drifting into two subtly different definitions of "newest".
 */
function pruneByPrefix(prefix: string, keep: number): void {
  try {
    const backups = fs.readdirSync(SAVED_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .map(f => {
        const full = path.join(SAVED_DIR, f);
        try { return { full, savedAt: Number(JSON.parse(fs.readFileSync(full, 'utf-8')).savedAt) || 0 }; }
        catch { return { full, savedAt: 0 }; }
      })
      .sort((a, b) => b.savedAt - a.savedAt);
    for (const stale of backups.slice(keep)) {
      try { fs.unlinkSync(stale.full); } catch {}
    }
  } catch {}
}

/** Keep only the newest AUTO_BACKUP_KEEP auto-backups so updates don't pile up clutter. */
function pruneAutoBackups(): void {
  pruneByPrefix(AUTO_BACKUP_PREFIX, AUTO_BACKUP_KEEP);
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
/**
 * The version that last ran on this machine, '' on a fresh install. Read it
 * BEFORE `handleVersionChange`, which overwrites the file — the stale-icon
 * notice (#226) needs "was this an upgrade" and that is the only record.
 */
export function savedVersion(): string {
  try {
    return fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf-8').trim() : '';
  } catch { return ''; }
}

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

// ─── Scheduled snapshots (issue #238) ────────────────────────────────────────

/**
 * Periodic snapshots of the live layout, kept as named sessions (issue #238).
 *
 * `session.json` is rewritten in place every 30 seconds, so it only ever holds
 * the CURRENT state. That is the right thing for a restore-on-launch file and
 * the wrong thing for a mistake: the reporter asked an agent to clean up orphan
 * pwsh processes, lost 28 browser panes to it, and recovered what they could —
 * from an *older* file, which is the only reason there was anything to recover.
 * An "Auto-backup" existed already but only fires on a version change, so
 * between two updates there is nothing behind the live file at all.
 *
 * Three decisions, each of which the obvious implementation gets wrong:
 *
 * **It is a ring, not one entry.** The request was for a single snapshot
 * overwritten every few minutes, to avoid a list of thousands. A single slot
 * bounds the clutter and also bounds the recovery to "whatever the state was up
 * to five minutes ago" — which, in the incident that prompted this, is the state
 * *after* the panes were destroyed. Three keeps the clutter at three and keeps
 * the depth that actually did the saving.
 *
 * **Only a CHANGED layout is snapshotted.** Otherwise a lunch break rotates
 * three identical copies into the ring and destroys every distinct state behind
 * them — the clock would be quietly deleting exactly what this feature exists to
 * hold. With the fingerprint, the ring holds the last three layouts that were
 * actually different, so an idle machine keeps its history indefinitely.
 *
 * **It never touches the last-session pointer.** `saveNamedSession` sets it,
 * because a person choosing Save means "this is the one". A safety net that
 * silently became the session your next launch restores would be a second way to
 * lose a layout.
 */
const AUTO_SNAPSHOT_PREFIX = 'Auto-save';
const AUTO_SNAPSHOT_KEEP = 3;

/** Default cadence, and the floor a hand-edited pref is clamped to. */
export const DEFAULT_SNAPSHOT_MINUTES = 5;
export const MIN_SNAPSHOT_MINUTES = 1;
export const MAX_SNAPSHOT_MINUTES = 240;

/**
 * What a snapshot decision is made of. All of it is passed in so the rule is
 * testable without a clock, a filesystem or a settings file.
 */
export interface SnapshotDecisionInput {
  now: number;
  /** When the last snapshot was taken, or 0 if none has been this run. */
  lastAt: number;
  /** The `sessionSnapshotMinutes` pref; 0 or less means the feature is off. */
  intervalMinutes: number;
  /** Fingerprint of the layout being considered. */
  fingerprint: string;
  /** Fingerprint of what the last snapshot holds, or '' if none. */
  lastFingerprint: string;
}

/**
 * Whether to write a snapshot now.
 *
 * Both gates have to pass, and they fail for different reasons: the clock stops
 * this running on every 30-second auto-save tick, and the fingerprint stops an
 * idle machine from rotating its own history out of the ring.
 */
export function shouldSnapshot(input: SnapshotDecisionInput): boolean {
  // Number.isFinite first, and not `<= 0`: the pref comes out of a JSON file a
  // user may hand-edit, and NaN compares false against every bound — so the
  // tidier inverted form would read a garbled value as "on, at the floor".
  if (!Number.isFinite(input.intervalMinutes) || input.intervalMinutes <= 0) return false;
  if (!input.fingerprint) return false;
  if (input.fingerprint === input.lastFingerprint) return false;
  const minutes = Math.min(Math.max(input.intervalMinutes, MIN_SNAPSHOT_MINUTES), MAX_SNAPSHOT_MINUTES);
  return input.lastAt === 0 || input.now - input.lastAt >= minutes * 60_000;
}

/**
 * What "the layout changed" means, as one string.
 *
 * Deliberately NOT the whole session blob. `bounds` moves when the window is
 * nudged, `sidebarWidth` on a drag, and `cwd` every time a shell cds — none of
 * which is a layout worth spending a ring slot on, and all of which would make
 * the fingerprint differ on essentially every tick, i.e. no gate at all. What is
 * here is what a person would call losing something: which workspaces exist,
 * what they are called, and the shape and contents of their split trees.
 */
export function layoutFingerprint(data: SessionData | null | undefined): string {
  const windows = Array.isArray(data?.windows) ? data!.windows : [];
  const workspaces = windows.flatMap(w => (Array.isArray(w?.workspaces) ? w.workspaces : []));
  if (workspaces.length === 0) return '';
  try {
    return JSON.stringify(workspaces.map(w => [w.id, w.title, w.pinned, w.splitTree]));
  } catch {
    // A cyclic or otherwise unserialisable tree. Returning '' means "do not
    // snapshot" rather than "snapshot every tick", which is the safe way round:
    // this is a best-effort safety net and must never become a write loop.
    return '';
  }
}

/** `2026-09-17 05-21` — sortable, and free of the characters sanitizeName eats. */
function snapshotStamp(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

/**
 * Write one snapshot of the live layout as a named session, and prune the ring.
 *
 * Carries exactly what a manual Save carries — the fidelity rule #145 set for
 * `backupAutoSession`, for the same reason: this is what the user gets restored,
 * so a snapshot that quietly drops `browserUrl` or `pinned` is a restore that
 * loses them. Returns the name written, or null if there was nothing to write.
 */
export function writeSessionSnapshot(data: SessionData, at: number = Date.now()): string | null {
  try {
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    // Every window's workspaces, in window order — a named session restores into
    // one window, and losing the window split is a far smaller surprise than
    // losing a second window's tabs entirely (#145).
    const workspaces = windows.flatMap(w => (Array.isArray(w?.workspaces) ? w.workspaces : []));
    if (workspaces.length === 0) return null;

    const name = `${AUTO_SNAPSHOT_PREFIX} ${snapshotStamp(at)}`;
    const snapshot = {
      name,
      savedAt: at,
      workspaces: workspaces.map(w => ({
        title: w.title,
        customColor: w.customColor,
        pinned: !!w.pinned,
        shell: w.shell,
        cwd: w.cwd || '',
        posixCwd: w.posixCwd || '',
        splitTree: w.splitTree,
        browserUrl: w.browserUrl || '',
        browserWidth: w.browserWidth,
        explorerOpen: w.explorerOpen,
        explorerWidth: w.explorerWidth,
        explorerExpanded: w.explorerExpanded,
        explorerShowHidden: w.explorerShowHidden,
      })),
      sidebarWidth: windows[0]?.sidebarWidth ?? 260,
    };

    if (!fs.existsSync(SAVED_DIR)) fs.mkdirSync(SAVED_DIR, { recursive: true });
    // Written directly rather than through saveNamedSession: a safety net must
    // not hijack the user's last-session pointer.
    fs.writeFileSync(
      path.join(SAVED_DIR, sanitizeName(name) + '.json'),
      JSON.stringify(snapshot, null, 2),
      'utf-8'
    );
    pruneByPrefix(AUTO_SNAPSHOT_PREFIX, AUTO_SNAPSHOT_KEEP);
    return name;
  } catch {
    // Best-effort by definition — a failed snapshot must never disturb the save
    // that triggered it, which is the thing that actually protects the user.
    return null;
  }
}
