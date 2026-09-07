/**
 * wmux instance identity.
 *
 * Set WMUX_INSTANCE=<name> to run wmux as a separate, side-by-side instance:
 * the named pipe and APPDATA directory get a "-<name>" suffix, so a dev build
 * can run alongside an installed production wmux without colliding on the
 * pipe (Windows pipes are exclusive) or overwriting session.json.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

function suffix(): string {
  const name = process.env.WMUX_INSTANCE?.trim();
  return name ? `-${name}` : '';
}

export function getPipePath(): string {
  return `\\\\.\\pipe\\wmux${suffix()}`;
}

export function getAppDataDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, `wmux${suffix()}`);
}

/**
 * Windows taskbar identity. Carries the same suffix as the pipe and the
 * APPDATA dir, and for the same reason.
 *
 * Windows resolves an AppUserModelId to exactly ONE executable. A dev build
 * that keeps the production id therefore repoints `com.wmux.app` at its own
 * node_modules/electron/dist/electron.exe the moment it starts: from then on
 * the INSTALLED app's taskbar button borrows the dev binary's name and icon —
 * it reads "Electron" — and the user's pinned button is orphaned, because a
 * pin is keyed on that id (see build/installer.nsh). Neither heals when the
 * dev build exits; the association outlives it.
 *
 * That is the one identity WMUX_INSTANCE did not already isolate, which made
 * "run the dev build side by side" quietly destructive to a real install.
 */
export function getAppUserModelId(): string {
  return `com.wmux.app${suffix()}`;
}

/**
 * Path to the per-instance auth token used to authenticate privileged (V2)
 * pipe requests. Stored under the instance's APPDATA dir, which is only
 * readable by the current user — so only processes running as this user can
 * read the token and drive the pipe (preventing the unauthenticated local RCE
 * via agent.spawn / browser.eval / markdown.load_file).
 */
export function getPipeTokenPath(): string {
  return path.join(getAppDataDir(), 'pipe-token');
}

/**
 * Reads the auth token a CLI/hook client must send. Resolution order:
 *   1. WMUX_PIPE_TOKEN env var (injected by wmux into spawned shells)
 *   2. the token file in APPDATA (for clients launched outside a wmux shell)
 * Returns '' when none is available.
 */
export function readPipeToken(): string {
  const fromEnv = process.env.WMUX_PIPE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(getPipeTokenPath(), 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Loads the existing instance token or generates+persists a new one. Called by
 * the main process at startup. The file is written with 0600 so other users
 * on the machine cannot read it.
 */
export function ensurePipeToken(): string {
  const tokenPath = getPipeTokenPath();
  try {
    const existing = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // No token yet — fall through and create one.
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
    try { fs.chmodSync(tokenPath, 0o600); } catch { /* best-effort on Windows */ }
  } catch (err) {
    console.warn('[wmux] Failed to persist pipe token:', err);
  }
  return token;
}

/**
 * Timing-safe comparison of two tokens.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
