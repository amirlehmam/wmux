import { describe, it, expect } from 'vitest';
import { guestShortcutAction } from '../../src/renderer/hooks/useKeyboardShortcuts';
import { DEFAULT_SHORTCUTS } from '../../src/renderer/store/settings-slice';
import type { GuestKey } from '../../src/shared/guest-key';

// A key pressed inside a browser pane's page reaches the desktop through main
// (shared/guest-key.ts) after the page already had it. Only the tab-level
// actions a browser reserves from pages may answer it (#432).

function key(overrides: Partial<GuestKey>): GuestKey {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    ...overrides,
  };
}

const ctrlW = key({ key: 'w', code: 'KeyW', ctrlKey: true });
const ctrlB = key({ key: 'b', code: 'KeyB', ctrlKey: true });

describe('guestShortcutAction', () => {
  it('closes the tab on Ctrl+W from a page', () => {
    expect(guestShortcutAction(ctrlW, DEFAULT_SHORTCUTS)).toBe('closeSurfaceOrPane');
  });

  it('ignores an auto-repeat, so a held Ctrl+W closes one tab', () => {
    expect(guestShortcutAction({ ...ctrlW, repeat: true }, DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('leaves Ctrl+B with the page instead of toggling the sidebar', () => {
    expect(DEFAULT_SHORTCUTS.toggleSidebar).toEqual({ key: 'b', ctrl: true });
    expect(guestShortcutAction(ctrlB, DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('follows a rebind of an in-page action to its new chord', () => {
    const shortcuts = { ...DEFAULT_SHORTCUTS, closeSurfaceOrPane: { key: 'q', ctrl: true, alt: true } };
    expect(guestShortcutAction(ctrlW, shortcuts)).toBeNull();
    expect(guestShortcutAction(key({ key: 'q', code: 'KeyQ', ctrlKey: true, altKey: true }), shortcuts))
      .toBe('closeSurfaceOrPane');
  });

  it('keeps a chord with the page once a non-page action takes it over', () => {
    // toggleSidebar rebound onto Ctrl+W: the first match is not GLOBAL_IN_PAGE,
    // so nothing answers, not even the in-page action sharing the chord.
    const shortcuts = { ...DEFAULT_SHORTCUTS, toggleSidebar: { key: 'w', ctrl: true } };
    expect(guestShortcutAction(ctrlW, shortcuts)).toBeNull();
  });

  it('never fires an unbound action', () => {
    const shortcuts = { ...DEFAULT_SHORTCUTS, closeSurfaceOrPane: { key: '' } };
    expect(guestShortcutAction(ctrlW, shortcuts)).toBeNull();
    expect(guestShortcutAction(key({}), shortcuts)).toBeNull();
  });
});
