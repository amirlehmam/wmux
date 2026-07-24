import { describe, it, expect } from 'vitest';
import {
  FLOW_FASTEST_MS,
  FLOW_SLOWEST_MS,
  FRESH_MS,
  STALE_MS,
  flowDurationMs,
  liveness,
  toolChannel,
  traceState,
} from '../../src/renderer/components/Sidebar/trace-signals';

// TRACE mode's core claim is that its motion carries information. These tests
// pin the rules that make that true — especially the ones that stop it from
// showing confident activity when it doesn't actually know anything.

describe('toolChannel', () => {
  it('separates reading from writing', () => {
    expect(toolChannel('Read')).toBe('ingest');
    expect(toolChannel('Grep')).toBe('ingest');
    expect(toolChannel('Edit')).toBe('mutate');
    expect(toolChannel('Write')).toBe('mutate');
  });

  it('classifies execution and delegation', () => {
    expect(toolChannel('Bash')).toBe('exec');
    expect(toolChannel('Task')).toBe('delegate');
    expect(toolChannel('Skill')).toBe('delegate');
  });

  it('is case-insensitive', () => {
    expect(toolChannel('bash')).toBe('exec');
    expect(toolChannel('BASH')).toBe('exec');
  });

  it('routes MCP tools to delegate, by prefix and by inner name', () => {
    expect(toolChannel('mcp__playwright__browser_click')).toBe('delegate');
    expect(toolChannel('mcp__ctx__read')).toBe('ingest');
  });

  // A future tool name must render as "working, channel unknown" rather than
  // being silently miscoloured as a harmless read.
  it('returns null for unknown tools instead of guessing', () => {
    expect(toolChannel('SomeToolShippedNextYear')).toBeNull();
    expect(toolChannel(null)).toBeNull();
    expect(toolChannel('')).toBeNull();
  });
});

describe('liveness', () => {
  it('is full while the signal is fresh', () => {
    expect(liveness(1000, 1000)).toBe(1);
    expect(liveness(1000, 1000 + FRESH_MS)).toBe(1);
  });

  it('decays to zero as the signal goes stale', () => {
    expect(liveness(0 + 1, 1 + STALE_MS)).toBe(0);
    const mid = liveness(1, 1 + (FRESH_MS + STALE_MS) / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('decreases monotonically', () => {
    const samples = [6_000, 15_000, 25_000, 40_000].map((age) => liveness(1, 1 + age));
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
    }
  });

  it('is zero when nothing was ever seen', () => {
    expect(liveness(0, 50_000)).toBe(0);
  });
});

describe('flowDurationMs', () => {
  it('speeds up as the tool rate rises', () => {
    expect(flowDurationMs(4)).toBeLessThan(flowDurationMs(1));
  });

  it('clamps to the fast bound', () => {
    expect(flowDurationMs(1000)).toBe(FLOW_FASTEST_MS);
  });

  // PostToolUse fires after a tool COMPLETES, so a 3-minute `npm test` emits
  // zero events while genuinely working. The bus must not go dark for it.
  it('never returns faster-than-stopped for a zero rate', () => {
    expect(flowDurationMs(0)).toBe(FLOW_SLOWEST_MS);
    expect(flowDurationMs(-1)).toBe(FLOW_SLOWEST_MS);
    expect(flowDurationMs(NaN)).toBe(FLOW_SLOWEST_MS);
  });
});

describe('traceState', () => {
  const base = { working: true, tool: 'Edit', toolCount: 10, lastSeen: 1000, now: 1000 };

  it('declares an idle session completely dead — no motion at all', () => {
    const state = traceState({ ...base, working: false });
    expect(state.live).toBe(false);
    expect(state.lit).toBe(0);
    expect(state.channel).toBeNull();
  });

  it('reports the channel of the running tool', () => {
    expect(traceState(base).channel).toBe('mutate');
    expect(traceState({ ...base, tool: 'Bash' }).channel).toBe('exec');
  });

  it('derives flow period from the tool delta between samples', () => {
    const fast = traceState({ ...base, toolCount: 20, prev: { toolCount: 10, at: 0 } });
    const slow = traceState({ ...base, toolCount: 11, prev: { toolCount: 10, at: 0 } });
    expect(fast.flowMs).toBeLessThan(slow.flowMs);
  });

  it('falls back to the slowest live flow when no tools completed since the last sample', () => {
    const state = traceState({ ...base, prev: { toolCount: 10, at: 0 } });
    expect(state.live).toBe(true);
    expect(state.flowMs).toBe(FLOW_SLOWEST_MS);
  });

  // A working-but-stuck agent must visibly differ from a working-and-busy one.
  it('dims a working session whose signal has gone stale', () => {
    const stuck = traceState({ ...base, now: 1000 + STALE_MS });
    expect(stuck.live).toBe(true);
    expect(stuck.lit).toBe(0);
  });

  it('ranks blocked above working — it is the state only the user can clear', () => {
    const state = traceState({ ...base, blockedSince: 500 });
    expect(state.blocked).toBe(true);
    expect(state.live).toBe(true);
    expect(state.lit).toBe(1);
  });

  it('still reports blocked for a session that is not otherwise working', () => {
    expect(traceState({ ...base, working: false, blockedSince: 500 }).blocked).toBe(true);
  });

  // wmux shipped a build where the hook script was missing from the package
  // (issue #81). A broken install must not render as a confident idle session.
  it('flags a session that has never produced telemetry', () => {
    expect(traceState({ ...base, working: false, toolCount: 0, lastSeen: 0 }).noTelemetry).toBe(true);
  });

  it('does not flag no-telemetry once any hook event has landed', () => {
    expect(traceState({ ...base, toolCount: 1, lastSeen: 900 }).noTelemetry).toBe(false);
  });
});
