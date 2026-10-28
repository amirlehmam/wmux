import { describe, it, expect } from 'vitest';
import { matchesBinding } from '../../src/renderer/hooks/useKeyboardShortcuts';
import { DEFAULT_SHORTCUTS, PRE_249_SURFACE_CYCLE } from '../../src/renderer/store/settings-slice';

// Ctrl+Shift+] / Ctrl+Shift+[ cycled tabs in the focused pane (the defaults
// through 2.13.x, still held by anyone who chose them — #249), and never fired.
// toLowerCase() rescues a Shift-uppercased LETTER ('N' -> 'n') but punctuation
// under Shift becomes a different character: ']' -> '}'. The stored binding is
// the unshifted form, so the compare could not succeed. e.code is stable under
// Shift, so BracketRight identifies the key whichever character it produced.
const ev = (o: Partial<KeyboardEvent>) =>
  ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent;

describe('unbound shortcuts', () => {
  it('never dispatches an explicitly cleared binding, even for an empty-key event', () => {
    expect(matchesBinding(ev({ key: 'd', ctrlKey: true }), { key: '' })).toBe(false);
    expect(matchesBinding(ev({}), { key: '' })).toBe(false);
  });
});

describe('matchesBinding with shifted punctuation', () => {
  it('matches Ctrl+Shift+] against the stored "]" binding', () => {
    expect(matchesBinding(
      ev({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true }),
      PRE_249_SURFACE_CYCLE.nextSurface!,
    )).toBe(true);
  });

  it('matches Ctrl+Shift+[ against the stored "[" binding', () => {
    expect(matchesBinding(
      ev({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }),
      PRE_249_SURFACE_CYCLE.prevSurface!,
    )).toBe(true);
  });

  it('still matches when the layout delivers the unshifted char directly', () => {
    expect(matchesBinding(
      ev({ key: ']', code: 'BracketRight', ctrlKey: true, shiftKey: true }),
      PRE_249_SURFACE_CYCLE.nextSurface!,
    )).toBe(true);
  });

  it('does not cross-match the two brackets', () => {
    expect(matchesBinding(
      ev({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }),
      PRE_249_SURFACE_CYCLE.nextSurface!,
    )).toBe(false);
  });

  it('does not fire without Shift held', () => {
    // The fallback is Shift-only; a bare Ctrl+] must not match a Shift binding.
    expect(matchesBinding(
      ev({ key: ']', code: 'BracketRight', ctrlKey: true }),
      PRE_249_SURFACE_CYCLE.nextSurface!,
    )).toBe(false);
  });

  it('leaves letter combos alone', () => {
    expect(matchesBinding(
      ev({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }),
      DEFAULT_SHORTCUTS.newWindow,
    )).toBe(true);
  });
});

describe('matchesBinding with the #249 Ctrl+Tab defaults', () => {
  const tab = { key: 'Tab', code: 'Tab', ctrlKey: true };

  it('matches Ctrl+Tab to nextSurface and Ctrl+Shift+Tab to prevSurface', () => {
    expect(matchesBinding(ev(tab), DEFAULT_SHORTCUTS.nextSurface)).toBe(true);
    expect(matchesBinding(ev({ ...tab, shiftKey: true }), DEFAULT_SHORTCUTS.prevSurface)).toBe(true);
  });

  it('does not cross-match the two directions', () => {
    expect(matchesBinding(ev({ ...tab, shiftKey: true }), DEFAULT_SHORTCUTS.nextSurface)).toBe(false);
    expect(matchesBinding(ev(tab), DEFAULT_SHORTCUTS.prevSurface)).toBe(false);
  });
});
