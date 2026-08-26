import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_APPEARANCE_PREFS,
  HUB_DEFAULT_REV,
  UI_MODE_DEFAULT_REV,
} from '../../src/renderer/store/settings-slice';

// The agent office is on for everyone since 2.3.0. It shipped in 2.2.0 as an
// off-by-default easter egg, so this is a second promotion through the same
// block that TRACE went through in 1.5.0 — and the two must not interfere.

const APPEARANCE_KEY = 'wmux-appearance-prefs';

// The settings file is read ONCE at module load, so a stored blob can only be
// injected by stubbing window before a fresh import of the slice.
async function loadWith(stored?: Record<string, unknown>) {
  const writes: Record<string, unknown> = {};
  vi.resetModules();
  vi.stubGlobal('window', {
    wmux: {
      settings: {
        getAllSync: () => (stored ? { [APPEARANCE_KEY]: stored } : {}),
        set: (key: string, value: unknown) => { writes[key] = value; },
      },
    },
  });
  const mod = await import('../../src/renderer/store/settings-slice');
  return { prefs: mod.loadAppearancePrefs(), writes };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('agent office default', () => {
  it('ships on', () => {
    expect(DEFAULT_APPEARANCE_PREFS.hubEnabled).toBe(true);
  });

  it('gives a fresh install the office', async () => {
    const { prefs } = await loadWith();
    expect(prefs.hubEnabled).toBe(true);
  });

  // The whole point of the rev: a plain default change reaches nobody, because
  // setAppearancePrefs persists the entire block and the stored false wins.
  it('promotes a 2.2.0 user whose blob predates the rev', async () => {
    const { prefs, writes } = await loadWith({
      uiTheme: 'light',
      hubEnabled: false,
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
    });
    expect(prefs.hubEnabled).toBe(true);
    expect(prefs.hubDefaultRev).toBe(HUB_DEFAULT_REV);
    // Promotion must be recorded on disk immediately, or it repeats every launch.
    expect((writes[APPEARANCE_KEY] as { hubDefaultRev: number }).hubDefaultRev)
      .toBe(HUB_DEFAULT_REV);
  });

  it('keeps every other stored preference while promoting', async () => {
    const { prefs } = await loadWith({
      uiTheme: 'light',
      terminalBgOpacity: 40,
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
    });
    expect(prefs.uiTheme).toBe('light');
    expect(prefs.terminalBgOpacity).toBe(40);
  });

  // The promotion is one-time, so switching it back off has to stick.
  it('leaves a post-promotion opt-out alone', async () => {
    const { prefs, writes } = await loadWith({
      hubEnabled: false,
      hubDefaultRev: HUB_DEFAULT_REV,
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
    });
    expect(prefs.hubEnabled).toBe(false);
    expect(writes[APPEARANCE_KEY]).toBeUndefined();
  });
});

describe('promotion independence', () => {
  // The reason hubDefaultRev is its own counter instead of a bump of
  // UI_MODE_DEFAULT_REV. A shared rev would re-promote uiMode here and drag a
  // deliberate classic choice back to TRACE.
  it('does not disturb a settled classic choice while enabling the office', async () => {
    const { prefs } = await loadWith({
      uiMode: 'classic',
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
      hubEnabled: false,
    });
    expect(prefs.uiMode).toBe('classic');
    expect(prefs.hubEnabled).toBe(true);
  });

  // The mirror case: a pre-1.5.0 blob is due BOTH promotions in one load.
  it('applies both promotions to a legacy blob and stamps both revs', async () => {
    const { prefs, writes } = await loadWith({ uiTheme: 'dark', uiMode: 'classic', hubEnabled: false });
    expect(prefs.uiMode).toBe('trace');
    expect(prefs.hubEnabled).toBe(true);
    const written = writes[APPEARANCE_KEY] as Record<string, number>;
    expect(written.uiModeDefaultRev).toBe(UI_MODE_DEFAULT_REV);
    expect(written.hubDefaultRev).toBe(HUB_DEFAULT_REV);
  });

  // A blob already reconciled against both revs must not be rewritten at all —
  // a write on every launch would mean the promotion never actually settled.
  it('is a no-op once every rev is current', async () => {
    const { writes } = await loadWith({
      uiMode: 'classic',
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
      hubEnabled: false,
      hubDefaultRev: HUB_DEFAULT_REV,
    });
    expect(writes[APPEARANCE_KEY]).toBeUndefined();
  });
});
