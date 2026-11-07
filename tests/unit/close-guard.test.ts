import { describe, it, expect } from 'vitest';
import { decideClose, closeDialogCopy } from '../../src/main/close-guard';

// ─────────────────────────────────────────────────────────────────────────────
// Issue #227 — an accidental click on the window's × ended every session, and
// the reporter's machine was loaded enough that the click was not even aimed.
// Opt-in guard, decided in main (the renderer may be the unresponsive part).
// ─────────────────────────────────────────────────────────────────────────────

const base = {
  enabled: true, bypass: false, confirmed: false, pending: false,
  toTray: false, lastVisibleWindow: true,
};

describe('decideClose', () => {
  it('asks when the guard is on and nothing else is going on', () => {
    expect(decideClose(base)).toBe('ask');
  });

  it('is inert when the pref is off — the default, so the one-click quit is untouched', () => {
    expect(decideClose({ ...base, enabled: false })).toBe('allow');
  });

  it('lets the close through once the user has answered it', () => {
    // The dialog's "yes" re-issues win.close(); that second close must not ask again.
    expect(decideClose({ ...base, confirmed: true })).toBe('allow');
  });

  it('never blocks a programmatic quit', () => {
    // An update installing, a relaunch for transparency, Windows ending the
    // session: the user already chose, or cannot be asked, and a modal there
    // would hold up an update or a shutdown.
    expect(decideClose({ ...base, bypass: true })).toBe('allow');
    expect(decideClose({ ...base, bypass: true, pending: true })).toBe('allow');
  });

  it('swallows a repeat close while the dialog is up, rather than stacking dialogs', () => {
    expect(decideClose({ ...base, pending: true })).toBe('swallow');
  });

  it('ranks confirmed above pending', () => {
    // Belt and braces: the confirmed close is issued from inside the dialog's
    // own callback, after pending has been cleared — but if the order ever
    // slips, the answer the user just gave must still win.
    expect(decideClose({ ...base, confirmed: true, pending: true })).toBe('allow');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #442 — close to tray: the × hides the last visible window and every
// PTY keeps running; a real quit still goes through the #227 bypass.
// ─────────────────────────────────────────────────────────────────────────────

describe('decideClose — close to tray', () => {
  const tray = { ...base, enabled: false, toTray: true };

  it('hides the last visible window instead of closing it', () => {
    expect(decideClose(tray)).toBe('hide');
  });

  it('is inert when the pref is off — the default', () => {
    expect(decideClose({ ...tray, toTray: false })).toBe('allow');
  });

  it('closes one of several visible windows normally', () => {
    expect(decideClose({ ...tray, lastVisibleWindow: false })).toBe('allow');
    // ...and with the #227 guard on too, it asks as it always did.
    expect(decideClose({ ...tray, enabled: true, lastVisibleWindow: false })).toBe('ask');
  });

  it('wins over the confirm dialog: hiding ends nothing, so nothing is asked', () => {
    expect(decideClose({ ...tray, enabled: true })).toBe('hide');
  });

  it('never hides a real quit — tray Quit, update, relaunch, Windows shutdown', () => {
    // Tray "Quit wmux" is app.quit(), which before-quit turns into `bypass`.
    expect(decideClose({ ...tray, bypass: true })).toBe('allow');
    expect(decideClose({ ...tray, enabled: true, bypass: true })).toBe('allow');
  });

  it('never hides a programmatic close (wmux close-window, another window)', () => {
    expect(decideClose({ ...tray, confirmed: true })).toBe('allow');
  });

  it('does not hide a window under a dialog it is still showing', () => {
    expect(decideClose({ ...tray, enabled: true, pending: true })).toBe('swallow');
  });
});

describe('closeDialogCopy', () => {
  it('says "quit" for the last window and names the cost', () => {
    const copy = closeDialogCopy({ lastWindow: true, ptyCount: 4 });
    expect(copy.message).toBe('Quit wmux?');
    expect(copy.detail).toContain('4 terminal sessions');
    expect(copy.confirmLabel).toBe('Quit wmux');
  });

  it('singularises one session', () => {
    expect(closeDialogCopy({ lastWindow: true, ptyCount: 1 }).detail).toContain('1 terminal session ');
  });

  it('does not threaten a cost that is not there', () => {
    const copy = closeDialogCopy({ lastWindow: true, ptyCount: 0 });
    expect(copy.detail).not.toMatch(/terminated/);
  });

  it('says "close" for a secondary window and names no count it cannot know', () => {
    // Main does not track PTYs per window; a wrong number is worse than none.
    const copy = closeDialogCopy({ lastWindow: false, ptyCount: 9 });
    expect(copy.message).toBe('Close this window?');
    expect(copy.detail).not.toContain('9');
    expect(copy.detail).toContain('Other wmux windows stay open');
    expect(copy.confirmLabel).toBe('Close window');
  });
});
