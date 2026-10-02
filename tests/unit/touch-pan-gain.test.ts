import { describe, it, expect } from 'vitest';
import {
  normalizeTouchPanGain,
  touchPanReports,
  wheelForward,
  TOUCH_PAN_GAIN_MAX,
  TOUCH_PAN_GAIN_MIN,
} from '../../src/renderer/utils/wheel-forward';
import { DEFAULT_TERMINAL_PREFS } from '../../src/renderer/store/settings-slice';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUserConfigCache, loadUserConfig } from '../../src/main/user-config';

// Issue #267. A touch pan sends one SGR report per cell crossed, which tracks
// the finger only where the app moves one row per report. opencode moves 3, so
// the screen outran the finger, and no `scroll_speed` serves both the wheel
// (3 rows per detent is right) and the finger (1 row per cell is right).

/** Drag `lines` one line per event, the way a slow pan arrives. */
function drag(lines: number, gain: number): number {
  let carry = 0;
  let sent = 0;
  for (let i = 0; i < Math.abs(lines); i++) {
    const r = touchPanReports(Math.sign(lines), gain, carry);
    carry = r.carry;
    sent += r.reports;
  }
  return sent;
}

describe('touch pan gain (#267)', () => {
  it('defaults to 1: one report per cell, exactly what shipped before', () => {
    expect(DEFAULT_TERMINAL_PREFS.touchPanGain).toBe(1);
    expect(touchPanReports(6, 1, 0)).toEqual({ reports: 6, carry: 0 });
    expect(drag(30, 1)).toBe(30);
  });

  it('at 1/3, thirty cells of finger travel are ten reports — 30 rows at scroll_speed 3', () => {
    expect(drag(30, 1 / 3)).toBe(10);
    expect(drag(-30, 1 / 3)).toBe(-10);
  });

  it('carries the fraction, so a slow drag still moves instead of rounding to nothing', () => {
    const a = touchPanReports(1, 0.4, 0);
    expect(a.reports).toBe(0);
    const b = touchPanReports(1, 0.4, a.carry);
    expect(b.reports).toBe(0);
    const c = touchPanReports(1, 0.4, b.carry);
    expect(c.reports).toBe(1);
    expect(c.carry).toBeCloseTo(0.2);
  });

  it('reversing direction spends the carry before it sends the other way', () => {
    const up = touchPanReports(2, 0.4, 0); // 0.8 carried
    const down = touchPanReports(-1, 0.4, up.carry);
    expect(down.reports).toBe(0);
    expect(down.carry).toBeCloseTo(0.4);
  });

  it('a gain above 1 serves an app whose multiplier is below 1', () => {
    expect(drag(5, 4)).toBe(20);
  });

  it('refuses a gain that would make a finger inert or absurd', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, undefined]) {
      expect(normalizeTouchPanGain(bad)).toBe(1);
    }
    expect(normalizeTouchPanGain(0.001)).toBe(TOUCH_PAN_GAIN_MIN);
    expect(normalizeTouchPanGain(99)).toBe(TOUCH_PAN_GAIN_MAX);
    expect(normalizeTouchPanGain(0.33)).toBe(0.33);
  });
});

describe('the fling is its own source, so the gain cannot shorten the glide (#267)', () => {
  const base = { mouseTracking: true, col: 40, row: 12 } as const;

  it('reports one per line, like the pan it continues', () => {
    expect(wheelForward({ ...base, lines: 5, source: 'fling' })).toEqual({ seq: '\x1b[<65;40;12M', repeats: 5 });
    expect(wheelForward({ ...base, lines: -5, source: 'fling' })?.repeats).toBe(5);
  });

  it('a real wheel is still one report per event', () => {
    expect(wheelForward({ ...base, lines: 5, source: 'wheel' })?.repeats).toBe(1);
  });
});

describe('config.toml: [terminal] touch-pan-gain (#267)', () => {
  const load = (toml: string) => {
    const file = path.join(os.tmpdir(), `wmux-touch-gain-${process.pid}-${Date.now()}.toml`);
    fs.writeFileSync(file, toml);
    try {
      clearUserConfigCache();
      return loadUserConfig(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  };

  it('reads the kebab-case key', () => {
    const out = load(['[terminal]', 'touch-pan-gain = 0.33', ''].join('\n'));
    expect(out.terminal?.touchPanGain).toBe(0.33);
    expect(out.errors).toEqual([]);
  });

  it('reports a non-positive gain instead of applying it', () => {
    const out = load(['[terminal]', 'touch-pan-gain = 0', ''].join('\n'));
    expect(out.terminal?.touchPanGain).toBeUndefined();
    expect((out.errors ?? []).join(' ')).toContain('touch-pan-gain');
  });
});
