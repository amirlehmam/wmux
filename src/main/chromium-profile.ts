// Where Electron's own profile lives — Chromium's data and the single-instance
// lock — and the one-time move that put it there (#282).
//
// Until 2.22.0 Electron's userData was `%APPDATA%\wmux`: the default for a
// productName of "wmux", and therefore ALSO the default of openwong2kim/wmux,
// a different Electron app with the same name. Electron keys its single-
// instance lock (`requestSingleInstanceLock`) on the userData directory, so
// with both installed whichever started first owned the lock and the other got
// `gotLock false` and quit on launch — handing its command line to the WRONG
// app as a `second-instance`. Reproduced in a standalone Electron 43 harness:
// with the shared directory the second app's `gotLock` was `false`; after the
// move both got `true`. They also shared one Chromium
// profile: one Local Storage (where wmux keeps most of its settings), one
// cookie jar for both browser panels.
//
// wmux's own files (settings.json, sessions, pipe-token, logs, agent-detection…)
// stay exactly where they are, in getAppDataDir() — the CLI, the hooks and
// `wmux crash-report` all read them there, and so may an older wmux after a
// downgrade. Only Electron's profile moves, to a subdirectory
// (`%APPDATA%\wmux\chromium`): a different directory is a different lock, and a
// profile nobody else opens. So wmux's own files must NEVER be reached through
// `app.getPath('userData')` — that is this profile now, not wmux's data dir.
// `user-manifests.ts` did, and was moved to getAppDataDir().
//
// Other collisions with that app are handled elsewhere: `wmux-hook.js` exits
// when `WMUX_SURFACE_ID` comes with none of our markers (`WMUX=1`, `WMUX_PIPE`,
// `WMUX_REMOTE`), because theirs exports the same name; and the agent-context
// block no longer reads a non-`pong` bare `wmux` as absence, since theirs puts
// its own `wmux.cmd` on the user PATH.
//
// The state worth keeping is COPIED, never moved: an older wmux (a downgrade)
// and the other app may both still be reading the old location, and a copy
// that fails half way leaves nothing broken behind it.

import * as fs from 'fs';
import * as path from 'path';

/** Electron's userData for this instance: a subdirectory of wmux's own data dir. */
export function chromiumDataDir(appDataDir: string): string {
  return path.join(appDataDir, 'chromium');
}

/**
 * The profile entries carried over. Local Storage is where the renderer keeps
 * most preferences; Network + Local State are the browser panel's cookies and
 * the key they are encrypted with (one is useless without the other); the rest
 * is site storage a signed-in panel page relies on. Caches are left behind —
 * Chromium rebuilds them, and they are most of the size.
 */
export const MIGRATED_ENTRIES = ['Local Storage', 'IndexedDB', 'Network', 'Local State', 'Preferences', 'WebStorage'] as const;

/** The entry without which a migration is not worth switching to. */
const CRITICAL_ENTRY = 'Local Storage';

/** Written last, so its presence means the copy finished. */
export const MIGRATION_MARKER = '.migrated';

/**
 * LevelDB's LOCK and Chromium's own lockfile are held open exclusively by a
 * running profile — the other app's, if it is up — and carry no data: a fresh
 * profile recreates both. Skipping them is what lets the copy succeed while
 * that app is running.
 */
function isLockFile(name: string): boolean {
  return name === 'LOCK' || name === 'lockfile';
}

export type MigrationResult =
  | { status: 'already' }
  | { status: 'fresh' }
  | { status: 'migrated'; copied: string[] }
  | { status: 'failed'; error: string };

type CopyFile = (from: string, to: string) => void;

function copyTree(from: string, to: string, errors: string[], copyFile: CopyFile): void {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (isLockFile(name)) continue;
      copyTree(path.join(from, name), path.join(to, name), errors, copyFile);
    }
    return;
  }
  try {
    copyFile(from, to);
  } catch (err) {
    errors.push(`${from}: ${(err as Error).message}`);
  }
}

/**
 * Carry the profile from `oldDir` (the old userData) into `newDir`, once.
 *
 *   - `already`  — `newDir` has finished a migration before: nothing to do.
 *   - `fresh`    — nothing to carry (a new install): start clean.
 *   - `migrated` — copied; `newDir` is ready.
 *   - `failed`   — Local Storage could not be copied whole. The caller must
 *                  keep using `oldDir` this launch rather than open a profile
 *                  without the user's settings; the next launch tries again,
 *                  from scratch, because the marker was never written.
 */
export function migrateChromiumProfile(
  oldDir: string,
  newDir: string,
  copyFile: CopyFile = fs.copyFileSync,
): MigrationResult {
  if (fs.existsSync(path.join(newDir, MIGRATION_MARKER))) return { status: 'already' };
  const present = MIGRATED_ENTRIES.filter((name) => fs.existsSync(path.join(oldDir, name)));
  try {
    fs.mkdirSync(newDir, { recursive: true });
    if (present.length === 0) {
      fs.writeFileSync(path.join(newDir, MIGRATION_MARKER), '');
      return { status: 'fresh' };
    }
    const criticalErrors: string[] = [];
    for (const name of present) {
      const errors: string[] = [];
      copyTree(path.join(oldDir, name), path.join(newDir, name), errors, copyFile);
      if (name === CRITICAL_ENTRY) criticalErrors.push(...errors);
    }
    if (criticalErrors.length > 0) {
      // Remove the partial copy so the retry starts clean and Chromium never
      // opens a half-copied LevelDB.
      fs.rmSync(path.join(newDir, CRITICAL_ENTRY), { recursive: true, force: true });
      return { status: 'failed', error: criticalErrors[0] };
    }
    fs.writeFileSync(path.join(newDir, MIGRATION_MARKER), '');
    return { status: 'migrated', copied: present };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}

/**
 * Which directory Electron should use as userData this launch: the new one
 * unless a migration that had something to carry could not carry it.
 */
export function resolveUserDataDir(appDataDir: string, migrate = migrateChromiumProfile): { dir: string; result: MigrationResult } {
  const target = chromiumDataDir(appDataDir);
  const result = migrate(appDataDir, target);
  return { dir: result.status === 'failed' ? appDataDir : target, result };
}
