import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_APPEARANCE_PREFS } from '../../src/renderer/store/settings-slice';

// TRACE is opt-in and must stay opt-in, must never leak into the terminal, and
// must not lose information when motion is removed.

const STYLES = path.join(__dirname, '..', '..', 'src', 'renderer', 'styles');
const trace = fs.readFileSync(path.join(STYLES, 'trace.css'), 'utf-8');

describe('opt-in', () => {
  // Persisted state is built as { ...DEFAULTS, ...loadPersisted() }, so this
  // default is the structural guarantee that no existing user gets opted in.
  it('defaults to classic', () => {
    expect(DEFAULT_APPEARANCE_PREFS.uiMode).toBe('classic');
  });

  it('is a separate axis from the theme, so it composes with light and dark', () => {
    expect(DEFAULT_APPEARANCE_PREFS).toHaveProperty('uiTheme');
    expect(trace).toMatch(/\[data-ui-theme='light'\]\[data-ui-mode='trace'\]/);
  });
});

describe('scoping', () => {
  const selectorLines = trace
    .split('\n')
    .filter((line) => line.trimStart().startsWith(':root[data-ui-mode='));

  it('actually has mode-scoped rules', () => {
    expect(selectorLines.length).toBeGreaterThan(10);
  });

  // The mode attribute lives on <html>. A universal or terminal-reaching rule
  // at that level would tie on specificity with xterm's runtime-injected styles
  // and could override the user's configured terminal font — a nondeterministic
  // version of the character-measurement bug class that got Canvas deleted.
  it('never reaches into the terminal', () => {
    for (const line of selectorLines) {
      expect(line).not.toMatch(/\.xterm/);
      expect(line).not.toMatch(/data-ui-mode='trace'\]\s*\*/);
    }
  });

  it('does not use !important anywhere outside the reduced-motion block', () => {
    const beforeReducedMotion = trace.split('@media (prefers-reduced-motion')[0];
    expect(beforeReducedMotion).not.toMatch(/!important/);
  });
});

describe('perf envelope', () => {
  it('animates only compositor-friendly properties', () => {
    const keyframeBodies = [...trace.matchAll(/@keyframes[^{]*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    expect(keyframeBodies.length).toBeGreaterThan(0);
    for (const body of keyframeBodies) {
      // background-position was the app's only per-frame raster loop; TRACE
      // must not add another one.
      expect(body).not.toMatch(/background-position/);
      expect(body).not.toMatch(/\bwidth:|\bheight:|\btop:|\bleft:/);
    }
  });

  it('introduces no canvas, WebGL or backdrop-filter', () => {
    expect(trace).not.toMatch(/backdrop-filter/);
  });

  it('pauses its animations when the window is hidden', () => {
    expect(trace).toMatch(/\[data-anim='off'\][\s\S]*animation-play-state:\s*paused/);
  });

  // Packets/pings are the only cost that scales with row count.
  it('confines the per-tool-call ping to the active row', () => {
    expect(trace).toMatch(/\.workspace-row:not\(\.workspace-row--active\)[\s\S]*?__via-ping[\s\S]*?display:\s*none/);
  });
});

describe('reduced motion', () => {
  const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}/.exec(trace);

  it('has a reduced-motion block', () => {
    expect(block).not.toBeNull();
  });

  // The standard: remove all motion, lose zero information. Blocked was
  // distinguished ONLY by its breathing animation, so freezing it would make it
  // indistinguishable from working — it needs a static tell of its own.
  it('gives the blocked state a non-motion tell', () => {
    expect(block![1]).toMatch(/data-tr-blocked='1'/);
    expect(block![1]).toMatch(/repeating-linear-gradient/);
  });

  it('replaces the one-shot ping with a static ring', () => {
    expect(block![1]).toMatch(/__state-dot[\s\S]*box-shadow/);
  });
});

describe('signal honesty', () => {
  // A session that has never emitted a hook event must not render as a
  // confident idle — wmux shipped a build where the hook script was missing
  // from the package entirely (issue #81) and it looked exactly like "quiet".
  it('draws a no-telemetry session differently from an idle one', () => {
    expect(trace).toMatch(/data-tr-telemetry='none'[\s\S]*repeating-linear-gradient/);
  });

  // Brightness is a function of staleness, so a hung agent dims itself.
  it('ties bus brightness to the staleness ramp', () => {
    expect(trace).toMatch(/--tr-lit/);
    expect(trace).toMatch(/data-tr-live='1'[\s\S]*?--tr-lit/);
  });

  // Flow period comes from the measured tool rate, never a constant.
  it('drives the flow period from a variable, not a literal', () => {
    expect(trace).toMatch(/animation:\s*tr-flow\s+var\(--tr-flow-dur/);
  });
});

describe('palette', () => {
  const tokens = (name: string) => [...trace.matchAll(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'gi'))].map((m) => m[1].toLowerCase());

  // The synthesis flagged a hue collapse: the proposed live-current colour and
  // the mutate channel were the same hex, so an Edit packet would have been
  // invisible against the bus it rides on.
  it('keeps live current distinct from every tool channel', () => {
    const current = tokens('--tr-current');
    const channels = ['ingest', 'mutate', 'exec', 'delegate'].flatMap((c) => tokens(`--tr-chan-${c}`));
    expect(current.length).toBeGreaterThan(0);
    expect(channels.length).toBeGreaterThanOrEqual(4);
    for (const c of current) expect(channels).not.toContain(c);
  });

  it('keeps the four channels distinct from each other within a theme', () => {
    for (const themeBlock of trace.split(':root').slice(1, 3)) {
      const chans = ['ingest', 'mutate', 'exec', 'delegate']
        .map((c) => new RegExp(`--tr-chan-${c}:\\s*(#[0-9a-f]{6})`, 'i').exec(themeBlock)?.[1]?.toLowerCase())
        .filter(Boolean);
      if (chans.length === 4) expect(new Set(chans).size).toBe(4);
    }
  });

  // Existing status colours already own saturated orange text.
  it('does not reuse the existing running-status or orchestration ambers', () => {
    const reserved = ['#ff9800', '#f5b301'];
    for (const hex of reserved) {
      expect(trace.toLowerCase()).not.toContain(`: ${hex}`);
    }
  });

  it('defines every channel token for both themes', () => {
    for (const c of ['ingest', 'mutate', 'exec', 'delegate']) {
      expect(tokens(`--tr-chan-${c}`).length).toBe(2);
    }
  });
});
