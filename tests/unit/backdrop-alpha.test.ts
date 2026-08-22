import { describe, it, expect } from 'vitest';
import {
  MIN_TERMINAL_OPACITY_PCT,
  opacityToAlpha,
  hasBackdrop,
  terminalBgAlpha,
  customBgLayerAlpha,
} from '../../src/renderer/store/backdrop';
import { DEFAULT_APPEARANCE_PREFS } from '../../src/renderer/store/settings-slice';
import type { AppearancePrefs } from '../../src/renderer/store/settings-slice';

const prefs = (over: Partial<AppearancePrefs> = {}): AppearancePrefs => ({
  ...DEFAULT_APPEARANCE_PREFS,
  ...over,
});

describe('opacityToAlpha', () => {
  it('floors at the minimum rather than reaching 0', () => {
    // 0 leaves text on the desktop with nothing behind it in Clear mode.
    expect(opacityToAlpha(0)).toBeCloseTo(MIN_TERMINAL_OPACITY_PCT / 100);
    expect(opacityToAlpha(5)).toBeCloseTo(MIN_TERMINAL_OPACITY_PCT / 100);
  });

  it('passes through values above the floor', () => {
    expect(opacityToAlpha(80)).toBeCloseTo(0.8);
    expect(opacityToAlpha(100)).toBe(1);
  });

  it('clamps above 100 and survives a missing or junk value', () => {
    expect(opacityToAlpha(140)).toBe(1);
    expect(opacityToAlpha(undefined)).toBeCloseTo(0.88);
    expect(opacityToAlpha(Number.NaN)).toBeCloseTo(0.88);
  });
});

describe('hasBackdrop', () => {
  it('is true for a custom background, or a transparent window', () => {
    expect(hasBackdrop(prefs({ customBackgroundEnabled: true, customBackground: '#123' }), false)).toBe(true);
    expect(hasBackdrop(prefs({ windowTransparency: true }), false)).toBe(true);
  });

  it('ignores a custom background that is enabled but blank', () => {
    expect(hasBackdrop(prefs({ customBackgroundEnabled: true, customBackground: '   ' }), false)).toBe(false);
  });

  it('is false while a transparency restart is pending', () => {
    // The window is still opaque until it is rebuilt, so alpha would only
    // reveal its flat backgroundColor.
    expect(hasBackdrop(prefs({ windowTransparency: true }), true)).toBe(false);
  });
});

describe('terminalBgAlpha', () => {
  it('is fully opaque with nothing behind the terminal', () => {
    expect(terminalBgAlpha(prefs(), false)).toBe(1);
  });

  it('applies the floored opacity once there is a backdrop', () => {
    expect(terminalBgAlpha(prefs({ windowTransparency: true, terminalBgOpacity: 0 }), false))
      .toBeCloseTo(MIN_TERMINAL_OPACITY_PCT / 100);
    expect(terminalBgAlpha(prefs({ windowTransparency: true, terminalBgOpacity: 70 }), false))
      .toBeCloseTo(0.7);
  });
});

describe('customBgLayerAlpha', () => {
  it('stays opaque when the custom background IS the backdrop', () => {
    // Nothing behind it but --ui-bg-1; fading it would reveal app chrome.
    const p = prefs({ customBackgroundEnabled: true, customBackground: '#123', terminalBgOpacity: 40 });
    expect(customBgLayerAlpha(p, false)).toBe(1);
  });

  it('fades with the slider once a transparent window is behind it', () => {
    const p = prefs({
      customBackgroundEnabled: true,
      customBackground: '#123',
      windowTransparency: true,
      terminalBgOpacity: 40,
    });
    expect(customBgLayerAlpha(p, false)).toBeCloseTo(0.4);
  });

  it('stays opaque while a restart is pending', () => {
    const p = prefs({ windowTransparency: true, terminalBgOpacity: 40 });
    expect(customBgLayerAlpha(p, true)).toBe(1);
  });
});
