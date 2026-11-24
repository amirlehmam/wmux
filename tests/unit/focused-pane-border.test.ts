import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_FOCUSED_PANE_BORDER_PCT,
  MAX_FOCUSED_PANE_BORDER_PCT,
  focusedPaneBorderPct,
  scaledRingAccent,
} from '../../src/shared/focused-pane-border';
import { DEFAULT_APPEARANCE_PREFS } from '../../src/renderer/store/settings-slice';
import { loadUserConfig } from '../../src/main/user-config';

const STYLES = path.join(__dirname, '../../src/renderer/styles');

describe('focusedPaneBorderPct (issue #471)', () => {
  it('defaults to the ratio the border has always shipped with', () => {
    // 55% was hard-coded in splitpane.css before this became a setting; anyone
    // who never touches it must see no change.
    expect(DEFAULT_APPEARANCE_PREFS.focusedPaneBorder).toBe(DEFAULT_FOCUSED_PANE_BORDER_PCT);
    expect(focusedPaneBorderPct(DEFAULT_FOCUSED_PANE_BORDER_PCT)).toBe(55);
  });

  it('keeps 0, the value that hides the ring', () => {
    expect(focusedPaneBorderPct(0)).toBe(0);
  });

  it('clamps to the range the setting offers', () => {
    expect(focusedPaneBorderPct(-5)).toBe(0);
    expect(focusedPaneBorderPct(250)).toBe(MAX_FOCUSED_PANE_BORDER_PCT);
  });

  it('falls back to the default for a missing or junk value', () => {
    // settings.json is user-editable, and a pref saved before this release has no such key.
    expect(focusedPaneBorderPct(undefined)).toBe(55);
    expect(focusedPaneBorderPct(Number.NaN)).toBe(55);
  });
});

describe('scaledRingAccent: the transparent window follows the same setting', () => {
  it('leaves the transparent ring at its own ratio by default', () => {
    expect(scaledRingAccent(0.3, undefined)).toBeCloseTo(0.3);
    expect(scaledRingAccent(0.3, DEFAULT_FOCUSED_PANE_BORDER_PCT)).toBeCloseTo(0.3);
  });

  it('mixes in no accent at 0 and never more than plain accent', () => {
    expect(scaledRingAccent(0.3, 0)).toBe(0);
    expect(scaledRingAccent(0.3, 100)).toBeCloseTo(0.3 * 100 / 55);
    expect(scaledRingAccent(0.9, 100)).toBe(1);
  });
});

describe('the stylesheet reads the setting', () => {
  const css = fs.readFileSync(path.join(STYLES, 'splitpane.css'), 'utf-8');

  it('mixes the published percentage, with the old ratio as the fallback', () => {
    expect(css).toMatch(
      /\.pane-wrapper--focused \{[^}]*color-mix\(in srgb, var\(--ui-accent\) var\(--wmux-focus-ring, 55%\), var\(--ui-border\)\)/,
    );
  });

  it('gives a transparent window the unfocused gutter when the ring is off', () => {
    // The transparent ring is an opaque mix; at 0% that would still be an
    // opaque line around a translucent pane, which is a ring.
    expect(css).toMatch(
      /html\.wmux-transparent\.wmux-no-focus-ring \.pane-wrapper--focused \{\s*border-color: var\(--wmux-pane-gutter, var\(--ui-bg-2\)\);/,
    );
  });
});

describe('[appearance] focused-pane-border', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { force: true });
    tmp = undefined;
  });
  function write(body: string): string {
    const p = path.join(os.tmpdir(), `wmux-focus-border-${process.pid}-${Date.now()}.toml`);
    fs.writeFileSync(p, body, 'utf8');
    return p;
  }

  it('reads 0 as "no ring", not as absent', () => {
    tmp = write('[appearance]\nfocused-pane-border = 0\n');
    const out = loadUserConfig(tmp);
    expect(out.errors).toEqual([]);
    expect(out.appearance?.focusedPaneBorder).toBe(0);
  });

  it('reads the camelCase spelling and sits beside inactive-pane-dim', () => {
    tmp = write('[appearance]\ninactive-pane-dim = 10\nfocusedPaneBorder = 100\n');
    expect(loadUserConfig(tmp).appearance).toEqual({ inactivePaneDim: 10, focusedPaneBorder: 100 });
  });

  it('rejects a 0..1 fraction and an out-of-range value, naming the key', () => {
    tmp = write('[appearance]\nfocused-pane-border = 0.5\n');
    let out = loadUserConfig(tmp);
    expect(out.appearance?.focusedPaneBorder).toBeUndefined();
    expect((out.errors ?? []).join('\n')).toMatch(/appearance\.focused-pane-border: 0\.5 is a percent.*write 50/);
    fs.rmSync(tmp, { force: true });

    tmp = write('[appearance]\nfocused-pane-border = 140\n');
    out = loadUserConfig(tmp);
    expect(out.appearance?.focusedPaneBorder).toBeUndefined();
    expect((out.errors ?? []).join('\n')).toMatch(/appearance\.focused-pane-border: 140 not between 0 and 100/);
  });
});
