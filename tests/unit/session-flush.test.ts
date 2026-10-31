import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SessionFlushWaiters, SESSION_FLUSH_TIMEOUT_MS } from '../../src/main/session-flush';

afterEach(() => { vi.useRealTimers(); });

describe('correlated final session flush', () => {
  it('needs both successful layout publication and completed history attempts', async () => {
    const waiters = new SessionFlushWaiters();
    const result = waiters.wait(7, 'final');
    waiters.notifySaved(7, 'final', true);
    expect(waiters.pending(7)).toBe(1);
    waiters.notifyHistory(7, 'final', true);
    await expect(result).resolves.toBe(true);
    expect(waiters.pending(7)).toBe(0);
  });

  it('also accepts history completion before layout, but not as layout success', async () => {
    const waiters = new SessionFlushWaiters();
    const result = waiters.wait(7, 'final');
    waiters.notifyHistory(7, 'final', true);
    expect(waiters.pending(7)).toBe(1);
    waiters.notifySaved(7, 'final', false);
    await expect(result).resolves.toBe(false);
  });

  it('retains history failure while releasing the hold after both attempts settle', async () => {
    const waiters = new SessionFlushWaiters();
    const result = waiters.wait(7, 'final');
    waiters.notifySaved(7, 'final', true);
    waiters.notifyHistory(7, 'final', false);
    await expect(result).resolves.toBe(false);
  });

  it('does not let duplicate success replies overwrite an earlier branch failure', async () => {
    const waiters = new SessionFlushWaiters();
    const result = waiters.wait(7, 'final');
    waiters.notifyHistory(7, 'final', false);
    waiters.notifyHistory(7, 'final', true);
    waiters.notifySaved(7, 'final', true);
    await expect(result).resolves.toBe(false);
  });

  it('ignores wrong windows, old tokens, periodic and explicit layout-only replies', async () => {
    vi.useFakeTimers();
    const waiters = new SessionFlushWaiters();
    const result = waiters.wait(7, 'final');
    waiters.notifySaved(8, 'final', true);
    waiters.notifyHistory(8, 'final', true);
    waiters.notifySaved(7, undefined, true);
    waiters.notifyHistory(7, 'periodic', true);
    waiters.notifySaved(7, 'old-final', true);
    waiters.notifyHistory(7, 'old-final', true);
    expect(waiters.pending(7)).toBe(1);
    await vi.advanceTimersByTimeAsync(SESSION_FLUSH_TIMEOUT_MS);
    await expect(result).resolves.toBe(false);
  });

  it('never resets the overall budget between branches and ignores late replies', async () => {
    vi.useFakeTimers();
    const waiters = new SessionFlushWaiters();
    const result = waiters.wait(1, 'final');
    await vi.advanceTimersByTimeAsync(900);
    waiters.notifySaved(1, 'final', true);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(false);
    waiters.notifyHistory(1, 'final', true);
    expect(waiters.pending(1)).toBe(0);
  });

  it('correlates overlapping requests independently', async () => {
    const waiters = new SessionFlushWaiters();
    const first = waiters.wait(3, 'first');
    const second = waiters.wait(3, 'second');
    waiters.notifySaved(3, 'second', true);
    waiters.notifyHistory(3, 'first', true);
    expect(waiters.pending(3)).toBe(2);
    waiters.notifyHistory(3, 'second', true);
    await expect(second).resolves.toBe(true);
    waiters.notifySaved(3, 'first', true);
    await expect(first).resolves.toBe(true);
  });

  it('preserves the established one-second quit budget', () => {
    expect(SESSION_FLUSH_TIMEOUT_MS).toBe(1000);
  });
});

describe('lifecycle wiring', () => {
  const root = join(__dirname, '../..');
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8');
  const wm = readFileSync(join(root, 'src/main/window-manager.ts'), 'utf8');
  const dialog = readFileSync(join(root, 'src/renderer/components/SplitPane/StartupCommandDialog.tsx'), 'utf8');

  it('routes both correlated replies through the flush owner', () => {
    expect(index).toContain('sessionFlush.notifySaved(event.sender.id, token, saved)');
    expect(index).toContain('sessionFlush.notifyHistory(event.sender.id, token, success)');
  });

  it('closing the last window waits for its state', () => {
    expect(index).toMatch(/windowManager\.beforeClose\s*=/);
    expect(wm).toMatch(/this\.flushBeforeClose\(entry, event\)/);
  });

  it('before-quit holds the quit for the flush', () => {
    const body = index.slice(index.indexOf("app.on('before-quit'"));
    expect(body.slice(0, 1500)).toMatch(/event\.preventDefault\(\)/);
    expect(body.slice(0, 1500)).toMatch(/flushSessionFrom/);
  });

  it('saving a startup command writes session.json now', () => {
    expect(dialog).toMatch(/requestSessionSaveNow\(\)/);
  });
});
