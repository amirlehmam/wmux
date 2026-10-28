/**
 * The Windows shell icon cache, and wmux's stale-icon story (issues #137, #226).
 *
 * wmux installs to the same path on every update, and Explorer caches shell
 * icons per path in %LocalAppData%\Microsoft\Windows\Explorer\iconcache_*.db.
 * After an update that changed the artwork, the taskbar button, a pinned
 * shortcut and the Start-menu entry keep drawing the icon of the version they
 * replaced, while the app's own window icon and its notifications — loaded
 * from disk at runtime — are already correct. #137 and #226 are that split,
 * reported twice by the same person across two rebrands.
 *
 * Nothing an installer can do fixes it, and 1.5.1 measured that: `ie4uinit`
 * in both spellings left every cache file untouched, and
 * `SHChangeNotify(SHCNE_ASSOCCHANGED)` reaches Explorer windows and the Start
 * menu but NOT a pinned taskbar button, whose bitmap lives in the taskband
 * store keyed on the AppUserModelId (see build/installer.nsh). The cache
 * databases are memory-mapped by the running explorer.exe and flushed only when
 * it exits, so the one thing that works is restarting Explorer with the files
 * deleted in between. An installer must not do that silently — but the user
 * can ask for it, from a button that says exactly what it costs.
 *
 * Two pieces:
 *
 * 1. `iconNoticeDue` — did the shipped icon change since this machine last ran
 *    wmux? Decided from a fingerprint of the .ico stored under wmux's own
 *    APPDATA dir, so the user is told ONCE — one bell notification the
 *    renderer posts on the first launch after the update that changed it —
 *    that the taskbar may lag and where the button is. Reading a bug report
 *    two rebrands apart is the alternative.
 *
 * 2. `refreshShellIconCache` — the Explorer restart, from Settings → General →
 *    *Refresh taskbar icons*, behind a native confirm in ipc-handlers.ts that
 *    says File Explorer windows will close. Absolute System32 paths
 *    throughout: a writeable PATH dir must not get to shadow `powershell.exe`
 *    for a command wmux runs on the user's behalf (the rule `win32-process.ts`
 *    and `system32.ts` already state).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { getAppDataDir } from '../shared/instance';
import { powershellPath } from './system32';

/** Where the last-seen icon fingerprint lives: inside wmux's own dir (#132). */
export function iconRevisionFile(): string {
  return path.join(getAppDataDir(), 'icon-rev');
}

/** sha256 of the shipped icon, or null when it cannot be read. */
export function iconFingerprint(iconPath: string | undefined, readFile: (p: string) => Buffer = fs.readFileSync): string | null {
  if (!iconPath) return null;
  try {
    return createHash('sha256').update(readFile(iconPath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Whether to tell the user the icon changed. Pure, and the rules are the point:
 *
 * - no current fingerprint (dev tree without the .ico, unreadable file): never —
 *   there is nothing to compare, and a false notice is worse than none;
 * - no PREVIOUS fingerprint: only on an UPGRADE. A fresh install has no stale
 *   cache to warn about, but a machine coming from a version that did not yet
 *   record the fingerprint (everything before 2.10.2) is exactly the #226
 *   reporter, and gets told once;
 * - otherwise: when the fingerprint moved.
 */
export function iconNoticeDue(input: {
  previousFingerprint: string | null;
  currentFingerprint: string | null;
  upgraded: boolean;
}): boolean {
  if (!input.currentFingerprint) return false;
  if (!input.previousFingerprint) return input.upgraded;
  return input.previousFingerprint !== input.currentFingerprint;
}

let noticePending = false;

/**
 * Record this run's icon and decide whether a notice is owed. Called once at
 * startup, BEFORE the renderer can ask (`takeIconChangeNotice`), so the answer
 * is never raced by the page loading after main has already spoken.
 *
 * `upgraded` must come from the version saved by the PREVIOUS run: index.ts
 * reads `savedVersion()` before `handleVersionChange` overwrites it.
 */
export function noteIconRevision(opts: { iconPath: string | undefined; upgraded: boolean }): boolean {
  const file = iconRevisionFile();
  let previous: string | null = null;
  try { previous = fs.readFileSync(file, 'utf-8').trim() || null; } catch { /* first run */ }
  const current = iconFingerprint(opts.iconPath);
  const due = iconNoticeDue({ previousFingerprint: previous, currentFingerprint: current, upgraded: opts.upgraded });
  if (current && current !== previous) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, current, 'utf-8');
    } catch { /* a notice that repeats once is the worst case */ }
  }
  noticePending = due;
  return due;
}

/** The renderer collects the notice exactly once per process. */
export function takeIconChangeNotice(): boolean {
  const due = noticePending;
  noticePending = false;
  return due;
}

/**
 * The PowerShell that does the refresh. A single string so it can be pinned by
 * a test; PowerShell rather than cmd.exe because the cache path carries the
 * user's profile dir and cmd's quoting is the trap #154 documents. Every step
 * tolerates the previous one having half-worked: Explorer may already have
 * restarted itself (Windows does that after some kills), so `Start-Process`
 * runs only when no explorer.exe is left.
 */
export function iconCacheRefreshScript(): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Stop-Process -Name explorer -Force',
    'Start-Sleep -Milliseconds 700',
    "Remove-Item -Force -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Explorer\\iconcache*')",
    'Start-Sleep -Milliseconds 300',
    'if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process -FilePath (Join-Path $env:SystemRoot \'explorer.exe\') }',
  ].join('; ');
}

/**
 * Restart Explorer with the icon cache cleared. Detached and unref'd: the
 * refresh must not depend on wmux staying alive, and wmux must not wait on it.
 * Only ever called after the user confirmed a dialog that spells out that File
 * Explorer windows will close.
 */
export function refreshShellIconCache(spawnImpl: typeof spawn = spawn): void {
  const child = spawnImpl(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-Command', iconCacheRefreshScript()],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
}
