import { describe, it, expect } from 'vitest';
import { planQuit, PTY_EXIT_DRAIN_MS } from '../../src/main/quit-sequence';
import { correlateShutdown } from '../../src/cli/wmux';

// ─────────────────────────────────────────────────────────────────────────────
// Issue #214 — the 0xc0000409 abort is a SHUTDOWN race, not a runtime crash.
//
// Six aborts at an identical fault offset, reported as a 2.6.0 file-explorer
// regression. Every one of the six sits on a `will-quit` line in the reporter's
// own main.log, to the second: the process reached shutdown, wrote the line,
// and aborted inside the handler. `killAll()` fires N node-pty ConPTY exit
// callbacks at once and the process then walks straight into Node's environment
// teardown; a napi call that loses that race throws off the top of the stack
// and the CRT calls __fastfail(7).
//
// So quit holds itself open long enough for those callbacks to land, and then
// leaves via app.exit() so anything still outstanding never sees the teardown
// at all.
// ─────────────────────────────────────────────────────────────────────────────

describe('planQuit', () => {
  const base = { ptysAtQuit: 0, agentBrowserPending: false, alreadyDeferred: false };

  it('does not defer, and does not exit hard, when nothing is outstanding', () => {
    // A hard exit skips Chromium's own shutdown. That is a treatment for a
    // specific condition, not a new way of quitting — a quit with no PTYs
    // cannot hit the race, so it takes the ordinary path.
    expect(planQuit(base)).toEqual({
      defer: false, drainMs: 0, hardExit: false, reason: 'nothing-outstanding',
    });
  });

  it('drains and exits hard when PTYs were live at quit', () => {
    const plan = planQuit({ ...base, ptysAtQuit: 5 });
    expect(plan.defer).toBe(true);
    expect(plan.hardExit).toBe(true);
    expect(plan.drainMs).toBe(PTY_EXIT_DRAIN_MS);
  });

  it('drains for a single PTY — the race needs one callback, not a crowd', () => {
    // The reported crashes span 2 to 7 live PTYs, so there is no count below
    // which this is safe to skip.
    expect(planQuit({ ...base, ptysAtQuit: 1 }).drainMs).toBe(PTY_EXIT_DRAIN_MS);
  });

  it('defers for agent-browser teardown with no drain, since it has no PTY callbacks', () => {
    const plan = planQuit({ ...base, agentBrowserPending: true });
    expect(plan.defer).toBe(true);
    expect(plan.hardExit).toBe(true);
    expect(plan.drainMs).toBe(0);
  });

  it('holds a second pass without restarting or shortening the first', () => {
    // `window-all-closed` fires app.quit() again while the drain timer is
    // pending. Re-entering must not exit early — cutting the drain short is
    // precisely the failure this exists to prevent.
    const plan = planQuit({ ptysAtQuit: 6, agentBrowserPending: true, alreadyDeferred: true });
    expect(plan.defer).toBe(true);       // preventDefault, so Electron does not unwind
    expect(plan.hardExit).toBe(false);   // but do nothing else; a sequence is in flight
    expect(plan.reason).toBe('in-flight');
  });
});

describe('correlateShutdown', () => {
  // Event Log times carry a LOCAL offset; main.log's carry Z. Comparing them as
  // text is how the six crashes in #214 stayed invisible — they must be parsed
  // to instants first. These are the reporter's real values.
  const log = [
    '2026-08-31T21:26:05.097Z pid=20284 start version=2.6.0 electron=43.0.0 guard=true',
    '2026-08-31T23:39:03.990Z pid=20284 will-quit ptys=7 guard=true',
    '2026-08-31T23:47:28.307Z pid=17852 start version=2.6.0 electron=43.0.0 guard=true',
  ];

  it('matches a crash across the timezone difference', () => {
    const hit = correlateShutdown('2026-08-31T18:39:06.5144083-05:00', log);
    expect(hit).not.toBeNull();
    expect(hit!.event).toBe('will-quit');
    expect(hit!.deltaMs).toBeGreaterThanOrEqual(0);
    expect(hit!.deltaMs).toBeLessThan(30_000);
  });

  it('does not claim a will-quit that came AFTER the crash', () => {
    // That one belongs to a later run and says nothing about this crash.
    expect(correlateShutdown('2026-08-31T18:00:00.0000000-05:00', log)).toBeNull();
  });

  it('does not claim a shutdown that is merely the nearest one hours away', () => {
    expect(correlateShutdown('2026-09-01T14:00:00.0000000-05:00', log)).toBeNull();
  });

  it('is silent rather than wrong on an unparseable time or an empty log', () => {
    expect(correlateShutdown('not a date', log)).toBeNull();
    expect(correlateShutdown('2026-08-31T18:39:06.5144083-05:00', [])).toBeNull();
    expect(correlateShutdown('2026-08-31T18:39:06.5144083-05:00', ['garbage'])).toBeNull();
  });

  it('ignores lifecycle lines that are not a shutdown', () => {
    // A `start` line one second before a crash is a relaunch, not a cause.
    expect(correlateShutdown('2026-08-31T18:47:29.0000000-05:00', [
      '2026-08-31T23:47:28.307Z pid=17852 start version=2.6.0 electron=43.0.0 guard=true',
    ])).toBeNull();
  });
});
