import { describe, it, expect } from 'vitest';
import { matchesBinding } from '../../src/renderer/hooks/useKeyboardShortcuts';
import { DEFAULT_SHORTCUTS } from '../../src/renderer/store/settings-slice';

// Ctrl+Shift+] / Ctrl+Shift+[ cycle tabs in the focused pane, and never fired.
// toLowerCase() rescues a Shift-uppercased LETTER ('N' -> 'n') but punctuation
// under Shift becomes a different character: ']' -> '}'. The stored binding is
// the unshifted form, so the compare could not succeed. e.code is stable under
// Shift, so BracketRight identifies the key whichever character it produced.
const ev = (o: Partial<KeyboardEvent>) =>
  ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent;

describe('matchesBinding with shifted punctuation', () => {
  it('matches Ctrl+Shift+] against the stored "]" binding', () => {
    expect(matchesBinding(
      ev({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true }),
      DEFAULT_SHORTCUTS.nextSurface,
    )).toBe(true);
  });

  it('matches Ctrl+Shift+[ against the stored "[" binding', () => {
    expect(matchesBinding(
      ev({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }),
      DEFAULT_SHORTCUTS.prevSurface,
    )).toBe(true);
  });

  it('still matches when the layout delivers the unshifted char directly', () => {
    expect(matchesBinding(
      ev({ key: ']', code: 'BracketRight', ctrlKey: true, shiftKey: true }),
      DEFAULT_SHORTCUTS.nextSurface,
    )).toBe(true);
  });

  it('does not cross-match the two brackets', () => {
    expect(matchesBinding(
      ev({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }),
      DEFAULT_SHORTCUTS.nextSurface,
    )).toBe(false);
  });

  it('does not fire without Shift held', () => {
    // The fallback is Shift-only; a bare Ctrl+] must not match a Shift binding.
    expect(matchesBinding(
      ev({ key: ']', code: 'BracketRight', ctrlKey: true }),
      DEFAULT_SHORTCUTS.nextSurface,
    )).toBe(false);
  });

  it('leaves letter combos alone', () => {
    expect(matchesBinding(
      ev({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }),
      DEFAULT_SHORTCUTS.newWindow,
    )).toBe(true);
  });
});
