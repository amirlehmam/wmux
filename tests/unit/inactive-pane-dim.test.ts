import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INACTIVE_PANE_DIM_PCT,
  MAX_INACTIVE_PANE_DIM_PCT,
  inactivePaneDimAlpha,
} from '../../src/shared/inactive-pane-dim';
import { DEFAULT_APPEARANCE_PREFS } from '../../src/renderer/store/settings-slice';

describe('inactivePaneDimAlpha', () => {
  it('defaults to the overlay strength wmux has always shipped', () => {
    // 0.2 was the hard-coded rgba alpha before this became a setting; anyone
    // who never touches it must see no change.
    expect(DEFAULT_APPEARANCE_PREFS.inactivePaneDim).toBe(DEFAULT_INACTIVE_PANE_DIM_PCT);
    expect(inactivePaneDimAlpha(DEFAULT_INACTIVE_PANE_DIM_PCT)).toBeCloseTo(0.2);
  });

  it('turns dimming off at 0', () => {
    expect(inactivePaneDimAlpha(0)).toBe(0);
  });

  it('clamps to the range the setting offers', () => {
    expect(inactivePaneDimAlpha(-10)).toBe(0);
    expect(inactivePaneDimAlpha(100)).toBeCloseTo(MAX_INACTIVE_PANE_DIM_PCT / 100);
  });

  it('stays below focus mode, which is the deliberate stronger dim', () => {
    // Focus mode paints the same overlay at 0.62; the everyday setting must not
    // be able to out-dim the mode that exists to dim harder.
    expect(MAX_INACTIVE_PANE_DIM_PCT / 100).toBeLessThan(0.62);
  });

  it('falls back to the default for a missing or junk value', () => {
    // settings.json is user-editable, so the stored value is not trusted.
    expect(inactivePaneDimAlpha(undefined)).toBeCloseTo(0.2);
    expect(inactivePaneDimAlpha(Number.NaN)).toBeCloseTo(0.2);
  });
});
