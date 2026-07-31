import { describe, it, expect } from 'vitest';
import {
  MODIFIER_KEYS,
  normalizeKey,
  bindingsEqual,
  bindingFromEvent,
} from '../../src/renderer/utils/shortcut-binding';
import { DEFAULT_SHORTCUTS } from '../../src/renderer/store/settings-slice';

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
