import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AppLock,
  applyLockToWindow,
  LOCKED_PIPE_MESSAGE,
  MIN_PASSWORD_LENGTH,
  parseStoredLock,
  refusedWhileLocked,
  throttleDelayMs,
  V2_METHODS_WHILE_LOCKED,
} from '../../src/main/app-lock';
import { lockMethod } from '../../src/cli/wmux';
import { passwordChangeErrorKey, retrySeconds, unlockErrorKey } from '../../src/renderer/utils/app-lock';

describe('the password that opens wmux (#473)', () => {
  let dir: string;
  let file: string;
  let clock: number;
  const make = (): AppLock => new AppLock({ file, now: () => clock });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-app-lock-'));
    file = path.join(dir, 'app-lock.json');
    clock = 1_000_000;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('without a password: not configured, not locked, and lock() refuses instead of locking', () => {
    const lock = make();
    expect(lock.getState()).toEqual({ configured: false, locked: false });
    expect(lock.lock()).toMatchObject({ ok: false, error: 'not_configured' });
    expect(lock.isLocked()).toBe(false);
  });

  it('setting a password stores a hash, never the password, and does not lock the running app', async () => {
    const lock = make();
    const seen: unknown[] = [];
    lock.onStateChange((state) => seen.push(state));
    expect(await lock.setPassword(null, 'correct horse')).toEqual({ ok: true, state: { configured: true, locked: false } });
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toContain('correct horse');
    expect(parseStoredLock(JSON.parse(text))).not.toBeNull();
    expect(seen).toEqual([{ configured: true, locked: false }]);
  });

  it('a wmux that starts with a password file starts locked, and only the password opens it', async () => {
    await make().setPassword(null, 'correct horse');
    const lock = make();
    expect(lock.getState()).toEqual({ configured: true, locked: true });
    expect(await lock.unlock('wrong')).toMatchObject({ ok: false, error: 'wrong_password' });
    expect(lock.isLocked()).toBe(true);
    for (const notAPassword of [undefined, null, 42, '', { length: 13 }]) {
      expect((await lock.unlock(notAPassword)).ok).toBe(false);
    }
    expect(lock.isLocked()).toBe(true);
  });

  it('unlocks with the password, tells its listeners, and can be locked again', async () => {
    await make().setPassword(null, 'correct horse');
    const lock = make();
    const seen: boolean[] = [];
    lock.onStateChange((state) => seen.push(state.locked));
    expect(await lock.unlock('correct horse')).toEqual({ ok: true, state: { configured: true, locked: false } });
    expect(lock.lock().ok).toBe(true);
    lock.lock(); // already locked: no second event
    expect(seen).toEqual([false, true]);
  });

  it('replacing or removing the password needs the current one', async () => {
    const lock = make();
    await lock.setPassword(null, 'first-one');
    expect(await lock.setPassword('nope', 'second-one')).toMatchObject({ ok: false, error: 'wrong_password' });
    expect(await lock.setPassword(null, 'second-one')).toMatchObject({ ok: false, error: 'wrong_password' });
    expect(await lock.removePassword('nope')).toMatchObject({ ok: false, error: 'wrong_password' });
    expect(fs.existsSync(file)).toBe(true);

    expect((await lock.setPassword('first-one', 'second-one')).ok).toBe(true);
    const restarted = make();
    expect((await restarted.unlock('first-one')).ok).toBe(false);
    expect((await restarted.unlock('second-one')).ok).toBe(true);

    expect(await restarted.removePassword('second-one')).toEqual({ ok: true, state: { configured: false, locked: false } });
    expect(fs.existsSync(file)).toBe(false);
    expect(make().getState()).toEqual({ configured: false, locked: false });
  });

  it('refuses a password that is too short or absurdly long, and writes nothing', async () => {
    const lock = make();
    expect(await lock.setPassword(null, 'x'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatchObject({ ok: false, error: 'too_short' });
    expect(await lock.setPassword(null, 12345678)).toMatchObject({ ok: false, error: 'too_short' });
    expect(await lock.setPassword(null, 'x'.repeat(5000))).toMatchObject({ ok: false, error: 'too_long' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a password file that cannot be read is a lock no password opens, never an open door', async () => {
    for (const content of ['', 'not json', '{}', JSON.stringify({ version: 2, kdf: 'scrypt' }),
      JSON.stringify({ version: 1, kdf: 'scrypt', N: 2 ** 30, r: 8, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'x' })]) {
      fs.writeFileSync(file, content);
      const lock = make();
      expect(lock.getState()).toEqual({ configured: true, locked: true });
      expect((await lock.unlock('anything')).ok).toBe(false);
      expect(lock.isLocked()).toBe(true);
    }
  });

  it('slows down repeated wrong passwords, and the right one does not skip the wait', async () => {
    expect([0, 4, 5, 6, 7, 20].map(throttleDelayMs)).toEqual([0, 0, 1000, 2000, 4000, 60_000]);
    await make().setPassword(null, 'correct horse');
    const lock = make();
    for (let i = 0; i < 4; i++) expect(await lock.unlock('wrong')).toMatchObject({ error: 'wrong_password' });
    // The fifth miss starts the first wait.
    expect(await lock.unlock('wrong')).toMatchObject({ error: 'wrong_password', retryAfterMs: 1000 });
    expect(await lock.unlock('correct horse')).toMatchObject({ ok: false, error: 'throttled' });
    expect(lock.isLocked()).toBe(true);
    clock += 999;
    expect(await lock.unlock('correct horse')).toMatchObject({ ok: false, error: 'throttled', retryAfterMs: 1 });
    clock += 1;
    expect((await lock.unlock('correct horse')).ok).toBe(true);
    // A success clears the count.
    lock.lock();
    expect(await lock.unlock('wrong')).toMatchObject({ error: 'wrong_password' });
    expect((await lock.unlock('correct horse')).ok).toBe(true);
  });

  it('a listener that throws does not stop the others or the unlock', async () => {
    await make().setPassword(null, 'correct horse');
    const lock = make();
    const second = vi.fn();
    lock.onStateChange(() => { throw new Error('window gone'); });
    const off = lock.onStateChange(second);
    expect((await lock.unlock('correct horse')).ok).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    off();
    lock.lock();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('the pipe while wmux is locked (#473)', () => {
  it('refuses everything that reads or drives a pane, and nothing while unlocked', () => {
    for (const method of ['surface.read_text', 'surface.send_text', 'surface.send_key', 'pane.answer_agent', 'browser.eval',
      'workspace.list', 'system.tree', 'agent.spawn', 'markdown.get_content', 'remote.status', 'no.such.method']) {
      expect(refusedWhileLocked(method, true), method).toBe(true);
      expect(refusedWhileLocked(method, false), method).toBe(false);
    }
  });

  it('still answers who-are-you, locking, and an agent reporting its own state', () => {
    expect([...V2_METHODS_WHILE_LOCKED].sort()).toEqual(
      ['app.lock', 'app.lock_state', 'hook.event', 'pane.agent_state', 'system.capabilities', 'system.identify'],
    );
    for (const method of V2_METHODS_WHILE_LOCKED) expect(refusedWhileLocked(method, true)).toBe(false);
    // No method takes a password: nothing unlocks over the pipe.
    expect([...V2_METHODS_WHILE_LOCKED].some((m) => /unlock|password/i.test(m))).toBe(false);
    expect(LOCKED_PIPE_MESSAGE).toMatch(/locked/);
  });

  it('`wmux lock` asks to lock, and `--status` only reads the state', () => {
    expect(lockMethod(['lock'])).toBe('app.lock');
    expect(lockMethod(['lock', '--status'])).toBe('app.lock_state');
  });
});

describe('a window while wmux is locked (#473)', () => {
  const fakeWindow = (devTools: boolean, destroyed = false) => {
    const webContents = {
      setIgnoreMenuShortcuts: vi.fn(),
      isDevToolsOpened: vi.fn(() => devTools),
      closeDevTools: vi.fn(),
    };
    return { isDestroyed: () => destroyed, webContents };
  };

  it('ignores the menu accelerators while locked and takes them back when unlocked', () => {
    const win = fakeWindow(false);
    applyLockToWindow(win, true, true);
    applyLockToWindow(win, false, true);
    expect(win.webContents.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
    expect(win.webContents.closeDevTools).not.toHaveBeenCalled();
  });

  it('closes DevTools on a locked packaged window, and leaves a dev run and an unlocked window alone', () => {
    const packaged = fakeWindow(true);
    applyLockToWindow(packaged, true, true);
    expect(packaged.webContents.closeDevTools).toHaveBeenCalledTimes(1);

    const dev = fakeWindow(true);
    applyLockToWindow(dev, true, false);
    expect(dev.webContents.closeDevTools).not.toHaveBeenCalled();

    const unlocked = fakeWindow(true);
    applyLockToWindow(unlocked, false, true);
    expect(unlocked.webContents.closeDevTools).not.toHaveBeenCalled();
  });

  it('does not touch a destroyed window', () => {
    const win = fakeWindow(true, true);
    applyLockToWindow(win, true, true);
    expect(win.webContents.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });
});

describe('what the lock screen and Settings say (#473)', () => {
  it('names the wait whenever a wrong password started one', () => {
    expect(unlockErrorKey('wrong_password', undefined)).toBe('appLock.wrongPassword');
    expect(unlockErrorKey('wrong_password', 2000)).toBe('appLock.wrongPasswordWait');
    expect(unlockErrorKey('throttled', 500)).toBe('appLock.throttled');
    expect(unlockErrorKey('failed', undefined)).toBe('appLock.failed');
    expect(unlockErrorKey(undefined, undefined)).toBe('appLock.failed');
  });

  it('rounds a wait up, so a wait that is not over never reads 0 s', () => {
    expect([undefined, 0, -5, 1, 1000, 1001].map(retrySeconds)).toEqual([0, 0, 0, 1, 1, 2]);
  });

  it('maps each refusal of a password change to its own sentence', () => {
    expect(passwordChangeErrorKey('wrong_password')).toBe('settings.general.lockWrongCurrent');
    expect(passwordChangeErrorKey('too_short')).toBe('settings.general.lockTooShort');
    expect(passwordChangeErrorKey('throttled')).toBe('appLock.throttled');
    expect(passwordChangeErrorKey('too_long')).toBe('settings.general.lockSaveFailed');
    expect(passwordChangeErrorKey('failed')).toBe('settings.general.lockSaveFailed');
  });
});
