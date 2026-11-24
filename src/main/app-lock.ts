/**
 * app-lock.ts — the password that opens wmux (issue #473).
 *
 * A person sets a password in Settings. From then on wmux starts LOCKED: the
 * window shows only the lock screen, the app behind it is not mounted (no
 * session restore, no shell is started), and the pipe refuses the CLI. "Lock
 * now" does the same to a running wmux, whose shells and agents keep running
 * behind the lock screen.
 *
 * ## What it is, and what it is not
 *
 * It keeps a person at this keyboard out of wmux. It is NOT encryption:
 * session.json, the scrollback history and everything else under
 * %APPDATA%\wmux stay readable to the Windows account, and that account can
 * delete the password file. Which is also the recovery for a forgotten
 * password: delete `app-lock.json` and start wmux again. Settings says so next
 * to the field; nothing may describe this as protecting data at rest.
 *
 * ## Rules for code outside this module
 *
 * - **Main owns the answer.** `locked` lives here and nowhere else. A renderer
 *   asks (`appLock.getState`) and is told (`onStateChange`); it never keeps a
 *   copy that could say "unlocked" after a reload. A reloaded or new window
 *   asks again and gets the lock screen.
 * - **The password never leaves the IPC call that carries it.** It is not
 *   logged, not put in an error message, not kept. Only the scrypt hash is
 *   stored, with its salt and parameters, so a later change of parameters can
 *   still verify an old file.
 * - **No pipe method takes a password.** `app.lock` locks; nothing unlocks
 *   over the pipe, where the password would sit in a command line and in the
 *   shell history. Unlocking is the lock screen's job.
 * - **A file that exists but cannot be read is a lock, not an open door.**
 *   Malformed JSON, a missing field or an unknown version all count as
 *   "configured, and no password matches": the file must be deleted on
 *   purpose, never ignored by accident.
 * - **Wrong passwords are slowed down**, in memory: after `FREE_ATTEMPTS`
 *   misses each further one must wait, doubling up to `MAX_DELAY_MS`.
 *   Restarting wmux resets it, and costs more than the delay it skips.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';
import type { AppLockError, AppLockResult, AppLockState } from '../shared/types';

export const APP_LOCK_FILE_NAME = 'app-lock.json';

/** Short enough not to lecture anyone, long enough that an empty field is not a password. */
export const MIN_PASSWORD_LENGTH = 4;
/** A paste of a whole file must not become a scrypt input. */
export const MAX_PASSWORD_LENGTH = 1024;

const FREE_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

/** scrypt at N=2^15, r=8 needs 32 MiB, one byte over Node's default `maxmem`. */
const KDF = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 } as const;

interface StoredLock {
  version: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

/** What is on disk: nothing, a record that can verify a password, or a file that cannot. */
type Stored = { kind: 'none' } | { kind: 'ok'; record: StoredLock } | { kind: 'unreadable' };

const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/** A record read back from disk, or null when any field is not what `setPassword` writes. */
export function parseStoredLock(raw: unknown): StoredLock | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || o.kdf !== 'scrypt') return null;
  if (!isPositiveInt(o.N) || !isPositiveInt(o.r) || !isPositiveInt(o.p)) return null;
  // A file is not a way to ask main for gigabytes: nothing here ever wrote more than KDF.
  if (o.N > KDF.N || o.r > KDF.r || o.p > KDF.p) return null;
  if (typeof o.salt !== 'string' || typeof o.hash !== 'string') return null;
  if (Buffer.from(o.salt, 'base64').length < 16 || Buffer.from(o.hash, 'base64').length !== KDF.keylen) return null;
  return { version: 1, kdf: 'scrypt', N: o.N, r: o.r, p: o.p, salt: o.salt, hash: o.hash };
}

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KDF.keylen, { ...params, maxmem: KDF.maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** How long the next attempt must wait after `failures` wrong passwords in a row. */
export function throttleDelayMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS));
}

export interface AppLockOptions {
  /** The password file. Tests pass a temp path. */
  file: string;
  now?: () => number;
}

export class AppLock {
  private readonly file: string;
  private readonly now: () => number;
  private locked: boolean;
  private failures = 0;
  private lastFailureAt = 0;
  private readonly listeners = new Set<(state: AppLockState) => void>();

  constructor(options: AppLockOptions) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    // wmux starts locked whenever a password file exists, readable or not.
    this.locked = this.read().kind !== 'none';
  }

  getState(): AppLockState {
    return { configured: this.read().kind !== 'none', locked: this.locked };
  }

  isLocked(): boolean {
    return this.locked;
  }

  onStateChange(listener: (state: AppLockState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lock a running wmux. Nothing to do, and no error, without a password. */
  lock(): AppLockResult {
    if (this.read().kind === 'none') return this.fail('not_configured');
    if (!this.locked) {
      this.locked = true;
      this.emit();
    }
    return this.done();
  }

  async unlock(password: unknown): Promise<AppLockResult> {
    if (!this.locked) return this.done();
    const refused = await this.check(password);
    if (refused) return refused;
    this.locked = false;
    this.emit();
    return this.done();
  }

  /** Set the first password, or replace it: replacing needs the current one. */
  async setPassword(current: unknown, next: unknown): Promise<AppLockResult> {
    if (this.read().kind !== 'none') {
      const refused = await this.check(current);
      if (refused) return refused;
    }
    if (typeof next !== 'string' || next.length < MIN_PASSWORD_LENGTH) return this.fail('too_short');
    if (next.length > MAX_PASSWORD_LENGTH) return this.fail('too_long');
    try {
      const salt = randomBytes(16);
      const hash = await derive(next, salt, KDF);
      const record: StoredLock = {
        version: 1, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p,
        salt: salt.toString('base64'), hash: hash.toString('base64'),
      };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // A failed replacement must leave the last password in place, never half a file.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      return this.fail('failed');
    }
    // Setting a password does not lock the wmux it was typed into.
    this.emit();
    return this.done();
  }

  async removePassword(current: unknown): Promise<AppLockResult> {
    if (this.read().kind === 'none') return this.done();
    const refused = await this.check(current);
    if (refused) return refused;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      return this.fail('failed');
    }
    this.locked = false;
    this.emit();
    return this.done();
  }

  /** Undefined when `password` is the stored one; otherwise the refusal to return. */
  private async check(password: unknown): Promise<AppLockResult | undefined> {
    const wait = this.lastFailureAt + throttleDelayMs(this.failures) - this.now();
    if (wait > 0) return this.fail('throttled', wait);
    const stored = this.read();
    if (stored.kind === 'none') return this.fail('not_configured');
    let matches = false;
    if (stored.kind === 'ok' && typeof password === 'string' && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH) {
      try {
        const expected = Buffer.from(stored.record.hash, 'base64');
        const actual = await derive(password, Buffer.from(stored.record.salt, 'base64'), stored.record);
        matches = actual.length === expected.length && timingSafeEqual(actual, expected);
      } catch {
        matches = false;
      }
    }
    if (matches) {
      this.failures = 0;
      return undefined;
    }
    this.failures += 1;
    this.lastFailureAt = this.now();
    return this.fail('wrong_password', throttleDelayMs(this.failures));
  }

  private read(): Stored {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      // Only "there is no file" means no password. A file that cannot be opened is still a lock.
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable' };
    }
    try {
      const record = parseStoredLock(JSON.parse(text));
      return record ? { kind: 'ok', record } : { kind: 'unreadable' };
    } catch {
      return { kind: 'unreadable' };
    }
  }

  private done(): AppLockResult {
    return { ok: true, state: this.getState() };
  }

  private fail(error: AppLockError, retryAfterMs = 0): AppLockResult {
    return { ok: false, error, ...(retryAfterMs > 0 ? { retryAfterMs } : {}), state: this.getState() };
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* one window's failure is not the lock's */ }
    }
  }
}

let instance: AppLock | null = null;

/** The one lock of this process. Its file is wmux's own, so it lives in `getAppDataDir()`. */
export function getAppLock(): AppLock {
  instance ??= new AppLock({ file: path.join(getAppDataDir(), APP_LOCK_FILE_NAME) });
  return instance;
}

// ─── The pipe while locked ───────────────────────────────────────────────────

/**
 * The V2 methods that still answer while wmux is locked. Everything else is
 * refused before it is routed, because the CLI is the other way into a
 * terminal: `surface.read_text` reads a screen and `surface.send_text` types
 * into one.
 *
 * Allowed: who-are-you (public already), locking, and the two reports a running
 * agent makes about itself (its hook events and its declared state), so the
 * sidebar is true again the moment the lock opens. They write state only, and
 * read nothing back. `pane.answer_agent` is not here: it types into a PTY.
 */
export const V2_METHODS_WHILE_LOCKED: ReadonlySet<string> = new Set([
  'system.identify',
  'system.capabilities',
  'app.lock',
  'app.lock_state',
  'hook.event',
  'pane.agent_state',
]);

export const LOCKED_PIPE_MESSAGE = 'wmux is locked. Unlock it in its window first.';

/** True when `method` must be refused because wmux is locked. */
export function refusedWhileLocked(method: string, locked: boolean): boolean {
  return locked && !V2_METHODS_WHILE_LOCKED.has(method);
}

// ─── The window while locked ─────────────────────────────────────────────────

/** What `applyLockToWindow` needs of a BrowserWindow. */
export interface LockableWindow {
  isDestroyed(): boolean;
  webContents: {
    setIgnoreMenuShortcuts(ignore: boolean): void;
    isDevToolsOpened(): boolean;
    closeDevTools(): void;
  };
}

/**
 * Electron's default menu is hidden but its accelerators are live (see
 * webview-menu-shortcuts.ts): Reload, Close, and Toggle Developer Tools, which
 * would let a person delete the lock screen from the DOM. While locked the
 * window ignores them, and a packaged build closes DevTools. A dev run keeps
 * its DevTools: window-manager.ts opens them on purpose there.
 */
export function applyLockToWindow(win: LockableWindow, locked: boolean, packaged: boolean): void {
  if (win.isDestroyed()) return;
  win.webContents.setIgnoreMenuShortcuts(locked);
  if (locked && packaged && win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
}
