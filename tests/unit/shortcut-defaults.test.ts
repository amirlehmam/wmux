import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  PRE_249_SURFACE_CYCLE,
  SHORTCUT_DEFAULT_REV,
} from '../../src/renderer/store/settings-slice';

// #249 moved nextSurface/prevSurface from Ctrl+Shift+] / [ to Ctrl+Tab /
// Ctrl+Shift+Tab. setShortcut persists the WHOLE table, so anyone who ever
// rebound any shortcut has the old surface defaults on disk and would never see
// the change without a promotion — and a promotion that ignored what they hold
// would overwrite bindings they chose.

const SHORTCUTS_KEY = 'wmux-shortcuts';
const REV_KEY = 'wmux-shortcut-defaults';

const OLD_NEXT = PRE_249_SURFACE_CYCLE.nextSurface!;
const OLD_PREV = PRE_249_SURFACE_CYCLE.prevSurface!;

// The settings file is read ONCE at module load, so stored state can only be
// injected by stubbing window before a fresh import of the slice.
async function loadWith(stored: Record<string, unknown> = {}) {
  const writes: Record<string, unknown> = {};
  vi.resetModules();
  vi.stubGlobal('window', {
    wmux: {
      settings: {
        getAllSync: () => stored,
        set: (key: string, value: unknown) => { writes[key] = value; },
      },
    },
  });
  const mod = await import('../../src/renderer/store/settings-slice');
  return { shortcuts: mod.loadShortcuts(), writes };
}

/** A pre-#249 table as setShortcut wrote it: every action, old defaults included. */
function legacyTable(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_SHORTCUTS, nextSurface: OLD_NEXT, prevSurface: OLD_PREV, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('shortcut default promotion (#249)', () => {
  it('gives a fresh install Ctrl+Tab and stamps the rev', async () => {
    const { shortcuts, writes } = await loadWith();
    expect(shortcuts.nextSurface).toEqual({ key: 'Tab', ctrl: true });
    expect(shortcuts.prevSurface).toEqual({ key: 'Tab', ctrl: true, shift: true });
    expect(writes[REV_KEY]).toEqual({ shortcutDefaultRev: SHORTCUT_DEFAULT_REV });
    // Nothing stored means nothing stale to rewrite.
    expect(writes[SHORTCUTS_KEY]).toBeUndefined();
  });

  it('promotes a user who still holds the old defaults, and writes it back', async () => {
    const { shortcuts, writes } = await loadWith({ [SHORTCUTS_KEY]: legacyTable() });
    expect(shortcuts.nextSurface).toEqual(DEFAULT_SHORTCUTS.nextSurface);
    expect(shortcuts.prevSurface).toEqual(DEFAULT_SHORTCUTS.prevSurface);
    expect((writes[SHORTCUTS_KEY] as typeof shortcuts).nextSurface).toEqual(DEFAULT_SHORTCUTS.nextSurface);
    expect(writes[REV_KEY]).toEqual({ shortcutDefaultRev: SHORTCUT_DEFAULT_REV });
  });

  it('recognises the old default however its key was cased or its modifiers spelled', async () => {
    // bindingsEqual is the one definition of "same combo": false vs absent
    // modifiers must not make a never-touched slot look chosen.
    const { shortcuts } = await loadWith({
      [SHORTCUTS_KEY]: legacyTable({ nextSurface: { key: ']', ctrl: true, shift: true, alt: false } }),
    });
    expect(shortcuts.nextSurface).toEqual(DEFAULT_SHORTCUTS.nextSurface);
  });

  it('never overwrites a binding the user chose', async () => {
    const mine = { key: 'j', ctrl: true, alt: true };
    const { shortcuts } = await loadWith({ [SHORTCUTS_KEY]: legacyTable({ nextSurface: mine }) });
    expect(shortcuts.nextSurface).toEqual(mine);
    // Each action is judged on its own: the untouched one still moves.
    expect(shortcuts.prevSurface).toEqual(DEFAULT_SHORTCUTS.prevSurface);
  });

  it('preserves an explicit unbind across reloads and default promotions', async () => {
    const { shortcuts, writes } = await loadWith({
      [SHORTCUTS_KEY]: legacyTable({ nextSurface: { key: '' }, splitRight: { key: '' } }),
    });
    expect(shortcuts.nextSurface).toEqual({ key: '' });
    expect(shortcuts.splitRight).toEqual({ key: '' });
    expect(shortcuts.prevSurface).toEqual(DEFAULT_SHORTCUTS.prevSurface);
    const reloaded = await loadWith(writes);
    expect(reloaded.shortcuts.nextSurface).toEqual({ key: '' });
    expect(reloaded.shortcuts.splitRight).toEqual({ key: '' });
  });

  it('keeps every other stored binding while promoting', async () => {
    const mine = { key: 'F6' };
    const { shortcuts } = await loadWith({ [SHORTCUTS_KEY]: legacyTable({ newWorkspace: mine }) });
    expect(shortcuts.newWorkspace).toEqual(mine);
  });

  it('does not promote onto a combo another action already holds', async () => {
    // Ctrl+Tab worked outside terminals before #249, so it could have been
    // bound to something else. Two actions on one key leaves one of them dead.
    const { shortcuts } = await loadWith({
      [SHORTCUTS_KEY]: legacyTable({ nextWorkspace: { key: 'Tab', ctrl: true } }),
    });
    expect(shortcuts.nextSurface).toEqual(OLD_NEXT);
    expect(shortcuts.nextWorkspace).toEqual({ key: 'Tab', ctrl: true });
    expect(shortcuts.prevSurface).toEqual(DEFAULT_SHORTCUTS.prevSurface);
  });

  it('runs once: a user who sets the old combo back after the promotion keeps it', async () => {
    const { shortcuts, writes } = await loadWith({
      [SHORTCUTS_KEY]: legacyTable(),
      [REV_KEY]: { shortcutDefaultRev: SHORTCUT_DEFAULT_REV },
    });
    expect(shortcuts.nextSurface).toEqual(OLD_NEXT);
    expect(shortcuts.prevSurface).toEqual(OLD_PREV);
    expect(writes).toEqual({});
  });

  it('stamps the rev even when nothing was eligible, so it never re-runs', async () => {
    const { writes } = await loadWith({
      [SHORTCUTS_KEY]: legacyTable({ nextSurface: { key: 'n', ctrl: true, alt: true }, prevSurface: { key: 'p', ctrl: true, alt: true } }),
    });
    expect(writes[REV_KEY]).toEqual({ shortcutDefaultRev: SHORTCUT_DEFAULT_REV });
  });
});
