import { describe, it, expect } from 'vitest';
import {
  MODIFIER_KEYS,
  normalizeKey,
  bindingsEqual,
  bindingFromEvent,
  isSafeToIntercept,
  claimsKeyEvent,
} from '../../src/renderer/utils/shortcut-binding';
import { DEFAULT_SHORTCUTS, DEFAULT_KEYBOARD_PREFS } from '../../src/renderer/store/settings-slice';

// bindingsEqual is what both the recorder's conflict detection and the
// Settings shortcut-filter capture rely on to agree with what actually fires
// at dispatch time (useKeyboardShortcuts.ts's matchesBinding). These pin the
// exact regression a naive comparator would miss: Shift uppercases e.key on
// Windows, so a recorded Ctrl+Shift+N combo persists `key: 'N'` while
// DEFAULT_SHORTCUTS' newWindow is `key: 'n'` — they must still compare equal.

describe('normalizeKey', () => {
  it('lowercases single-character keys', () => {
    expect(normalizeKey('N')).toBe('n');
    expect(normalizeKey('n')).toBe('n');
  });

  it('leaves named keys verbatim (case-sensitive)', () => {
    expect(normalizeKey('ArrowLeft')).toBe('ArrowLeft');
    expect(normalizeKey('F3')).toBe('F3');
    expect(normalizeKey('PageDown')).toBe('PageDown');
  });
});

describe('bindingsEqual', () => {
  it('treats a shift-uppercased single key as equal to its lowercase binding', () => {
    expect(bindingsEqual({ key: 'N', ctrl: true, shift: true }, { key: 'n', ctrl: true, shift: true })).toBe(true);
  });

  it('treats undefined and false modifiers as equal', () => {
    expect(bindingsEqual({ key: 'n', ctrl: true }, { key: 'n', ctrl: true, shift: false, alt: false })).toBe(true);
  });

  it('is false when any modifier differs', () => {
    expect(bindingsEqual({ key: 'n', ctrl: true }, { key: 'n', ctrl: true, shift: true })).toBe(false);
    expect(bindingsEqual({ key: 'n', ctrl: true }, { key: 'n', alt: true })).toBe(false);
  });

  it('is false when the key differs', () => {
    expect(bindingsEqual({ key: 'n', ctrl: true }, { key: 'w', ctrl: true })).toBe(false);
  });

  it('compares named keys case-sensitively', () => {
    expect(bindingsEqual({ key: 'ArrowLeft' }, { key: 'arrowleft' })).toBe(false);
  });

  it('matches the real newWindow default against its recorded (uppercased) form', () => {
    expect(bindingsEqual(DEFAULT_SHORTCUTS.newWindow, { key: 'N', ctrl: true, shift: true })).toBe(true);
  });

  it('does not confuse newWindow with the unrelated newWorkspace default', () => {
    expect(bindingsEqual(DEFAULT_SHORTCUTS.newWindow, DEFAULT_SHORTCUTS.newWorkspace)).toBe(false);
  });
});

describe('bindingFromEvent', () => {
  it('returns null for a bare modifier press', () => {
    for (const key of MODIFIER_KEYS) {
      expect(bindingFromEvent({ key, ctrlKey: false, shiftKey: false, altKey: false })).toBeNull();
    }
  });

  it('builds a binding from a real key, omitting absent modifiers rather than false-ing them', () => {
    const binding = bindingFromEvent({ key: 'n', ctrlKey: true, shiftKey: false, altKey: false });
    expect(binding).toEqual({ key: 'n', ctrl: true, shift: undefined, alt: undefined });
  });

  it('carries every held modifier', () => {
    const binding = bindingFromEvent({ key: 'Z', ctrlKey: true, shiftKey: true, altKey: true });
    expect(binding).toEqual({ key: 'Z', ctrl: true, shift: true, alt: true });
  });
});


// ─── claimsKeyEvent (Ctrl+N dead while a terminal has focus) ─────────────────
// xterm's _keyDown ends a key it handles with cancel(event, true), which
// stopPropagation()s it off the document — so every global binding built on a
// bare Ctrl+<letter> silently did nothing while a terminal was focused, and
// looked like it "started working" once focus moved elsewhere. useTerminal's
// custom key handler now asks claimsKeyEvent whether to let the event bubble.
//
// The invariant these pin, for the ShortcutAction table: claimsKeyEvent must be
// TRUE for exactly the keys the document listener will go on to act on. Release
// a key it later declines and the keystroke reaches nothing at all — worse than
// the bug being fixed. (find/copyMode are the one caveat: useKeyboardShortcuts
// defers them to PaneWrapper, whose listener is attached only while its pane is
// focused, so that pair is claimed on the ShortcutAction table's behalf.)

const key = (k: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; code: string }> = {}) => ({
  key: k,
  code: mods.code,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('isSafeToIntercept', () => {
  it('claims the whitelisted bare-Ctrl keys', () => {
    for (const k of ['b', 'd', 'n', 't', 'w', 'f', ',']) {
      expect(isSafeToIntercept(key(k, { ctrl: true }))).toBe(true);
    }
  });

  it('leaves the shell its line-editing keys', () => {
    // Ctrl+A/E/R/U/K are muscle memory — a global binding must never eat them.
    for (const k of ['a', 'e', 'r', 'u', 'k', 'c', 'v']) {
      expect(isSafeToIntercept(key(k, { ctrl: true }))).toBe(false);
    }
  });

  it('treats Ctrl+Shift+* and Ctrl+Alt+* as free', () => {
    expect(isSafeToIntercept(key('a', { ctrl: true, shift: true }))).toBe(true);
    expect(isSafeToIntercept(key('a', { ctrl: true, alt: true }))).toBe(true);
  });

  it('claims the named-key and font-size exceptions', () => {
    for (const k of ['PageDown', 'PageUp', 'F2', 'F12', '=', '-', '0']) {
      expect(isSafeToIntercept(key(k, { ctrl: true }))).toBe(true);
    }
  });

  it('is unconditionally true without Ctrl', () => {
    expect(isSafeToIntercept(key('a'))).toBe(true);
    expect(isSafeToIntercept(key('Enter', { shift: true }))).toBe(true);
  });
});

describe('claimsKeyEvent', () => {
  const claims = (e: ReturnType<typeof key>) =>
    claimsKeyEvent(e, DEFAULT_SHORTCUTS, DEFAULT_KEYBOARD_PREFS);

  it('claims the combos that regressed (the reported bug)', () => {
    expect(claims(key('n', { ctrl: true }))).toBe(true); // newWorkspace
    expect(claims(key('t', { ctrl: true }))).toBe(true); // newSurface
    expect(claims(key('w', { ctrl: true }))).toBe(true); // closeSurfaceOrPane
    expect(claims(key('d', { ctrl: true }))).toBe(true); // splitRight
    expect(claims(key('b', { ctrl: true }))).toBe(true); // toggleSidebar
    expect(claims(key('f', { ctrl: true }))).toBe(true); // find (PaneWrapper)
  });

  it('claims the combo that always worked, unchanged', () => {
    expect(claims(key('P', { ctrl: true, shift: true }))).toBe(true); // commandPalette
  });

  it('passes ordinary typing and shell control keys to the terminal', () => {
    expect(claims(key('a'))).toBe(false);
    expect(claims(key('a', { ctrl: true }))).toBe(false);
    expect(claims(key('r', { ctrl: true }))).toBe(false); // reverse-i-search
    expect(claims(key('c', { ctrl: true }))).toBe(false); // SIGINT
    expect(claims(key('Enter'))).toBe(false);
  });

  it('claims the bare function keys that are bound', () => {
    // F1 opens the cheat sheet — the screen that documents every other key — so
    // it has to work from a terminal, which is where you are when you need it.
    // The cost is accepted knowingly: F1 no longer reaches a TUI's own help.
    expect(claims(key('F1'))).toBe(true);
    expect(claims(key('F3'))).toBe(true);
    expect(claims(key('F3', { shift: true }))).toBe(true);
    expect(claims(key('F4', { alt: true }))).toBe(true); // closeWindow
  });

  it('never steals a bare printable key, even if one is bound to it', () => {
    // useKeyCapture records a bare letter as a binding with no modifier and no
    // warning. Claiming it would swallow every press of that letter in the
    // shell, which makes the terminal unusable — far worse than the shortcut
    // simply not firing from a focused pane.
    const rebound = { ...DEFAULT_SHORTCUTS, newWorkspace: { key: 'a' } };
    expect(claimsKeyEvent(key('a'), rebound, DEFAULT_KEYBOARD_PREFS)).toBe(false);
    expect(claimsKeyEvent(key('A', { shift: true }), rebound, DEFAULT_KEYBOARD_PREFS)).toBe(false);
    // ...but the same action on a named key is still claimed.
    const named = { ...DEFAULT_SHORTCUTS, newWorkspace: { key: 'F6' } };
    expect(claimsKeyEvent(key('F6'), named, DEFAULT_KEYBOARD_PREFS)).toBe(true);
  });

  it('still ignores function keys that are NOT bound', () => {
    expect(claims(key('F5'))).toBe(false);
    expect(claims(key('F7'))).toBe(false);
  });

  it('does not claim Ctrl+O — openFolder is not in SAFE_CTRL_KEYS', () => {
    // Pre-existing gap, preserved on purpose: the document listener declines
    // Ctrl+O too, so nothing is swallowed. Adding 'o' to SAFE_CTRL_KEYS is the
    // maintainer's call, not this fix's.
    expect(claims(key('o', { ctrl: true }))).toBe(false);
  });

  it('never claims a bare modifier press', () => {
    for (const k of ['Control', 'Alt', 'Shift', 'Meta']) {
      expect(claims(key(k, { ctrl: true }))).toBe(false);
    }
  });

  it('claims the digit row, including digits isSafeToIntercept rejects', () => {
    // Ctrl+2…8 are exactly the digits xterm turns into control codes, so they
    // are the ones that were broken; '3' is not a "safe" bare-Ctrl key, but the
    // index listener preventDefaults it regardless, so it must still be claimed.
    expect(claims(key('3', { ctrl: true, code: 'Digit3' }))).toBe(true);
    expect(claims(key('1', { ctrl: true, code: 'Digit1' }))).toBe(true);
    expect(claims(key('&', { ctrl: true, code: 'Digit1' }))).toBe(true); // AZERTY
    expect(claims(key('3', { ctrl: true, alt: true, code: 'Digit3' }))).toBe(true); // surface
  });

  it('leaves the digit row alone when both families are off', () => {
    const off = { workspaceIndexModifiers: 'off', surfaceIndexModifiers: 'off' } as const;
    expect(claimsKeyEvent(key('3', { ctrl: true, code: 'Digit3' }), DEFAULT_SHORTCUTS, off)).toBe(false);
  });

  it('follows a rebound shortcut rather than the default', () => {
    const rebound = { ...DEFAULT_SHORTCUTS, newWorkspace: { key: 'n', ctrl: true, shift: true } };
    expect(claimsKeyEvent(key('N', { ctrl: true, shift: true }), rebound, DEFAULT_KEYBOARD_PREFS)).toBe(true);
  });
});
