import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

/**
 * Issue #310 — the CLI-side (TUI) half, session reporting first.
 *
 * The core is a plain ESM module under resources/opencode-plugin/ because that
 * is exactly what gets installed into OpenCode's config directory. It must not
 * import @opencode/plugin/tui or solid-js (the TUI host provides those at
 * runtime; the wmux test suite cannot resolve them), so everything worth
 * testing lives here and the entry file is only the reactive glue.
 */
const calls: Array<{ file: string; argv: string[]; opts: any }> = [];
const syncCalls: Array<{ file: string; argv: string[]; opts: any }> = [];

vi.mock('node:child_process', () => ({
  execFile: (file: string, argv: string[], opts: any, cb: any) => {
    calls.push({ file, argv, opts });
    if (typeof cb === 'function') cb(null, '', '');
  },
  execFileSync: (file: string, argv: string[], opts: any) => {
    syncCalls.push({ file, argv, opts });
  },
}));

const CORE = path.resolve(__dirname, '../../resources/opencode-plugin/wmux-tui-core.js');
const load = () => import(/* @vite-ignore */ CORE);

const SURFACE = 'surf-1';

beforeEach(() => {
  calls.length = 0;
  syncCalls.length = 0;
});

describe('planSessionReport (#310)', () => {
  it('reports the viewed session id', async () => {
    const { planSessionReport } = await load();
    expect(planSessionReport({ type: 'session', sessionID: 'ses_abc12345' }, (id: string) => id))
      .toBe('ses_abc12345');
  });

  it('accepts the loop session ids OpenCode 2 uses', async () => {
    const { planSessionReport } = await load();
    const id = 'ses_loop_964e1bb45a26f32c336b';
    expect(planSessionReport({ type: 'session', sessionID: id }, (value: string) => value)).toBe(id);
  });

  it('resolves a viewed subagent to its root — a child is not a resumable handle', async () => {
    const { planSessionReport } = await load();
    expect(planSessionReport(
      { type: 'session', sessionID: 'ses_child123' },
      () => 'ses_root1234',
    )).toBe('ses_root1234');
  });

  it('falls back to the viewed id when the root lookup throws or answers nothing', async () => {
    const { planSessionReport } = await load();
    const route = { type: 'session', sessionID: 'ses_abc12345' };
    expect(planSessionReport(route, () => { throw new Error('gone'); })).toBe('ses_abc12345');
    expect(planSessionReport(route, () => undefined)).toBe('ses_abc12345');
  });

  it('ignores every route that is not a session, and ids that fail the validator', async () => {
    const { planSessionReport } = await load();
    expect(planSessionReport({ type: 'home' }, (id: string) => id)).toBeNull();
    expect(planSessionReport(null, (id: string) => id)).toBeNull();
    expect(planSessionReport({ type: 'session' }, (id: string) => id)).toBeNull();
    expect(planSessionReport({ type: 'session', sessionID: 'not-a-session' }, (id: string) => id)).toBeNull();
  });
});

describe('createSessionReporter (#310)', () => {
  const reporterFor = async (overrides: { surface?: string; log?: any } = {}) => {
    const { createSessionReporter } = await load();
    const sent: string[][] = [];
    const reporter = createSessionReporter({
      surface: overrides.surface ?? SURFACE,
      callWmux: (argv: string[]) => sent.push(argv),
      log: overrides.log,
    });
    return { reporter, sent };
  };
  const route = (id: string) => ({ type: 'session', sessionID: id });
  const rootOf = (id: string) => id;

  it('reports once per session, with the pane attached', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe(route('ses_abc12345'), rootOf);
    reporter.observe(route('ses_abc12345'), rootOf);
    expect(sent).toEqual([['report-session', 'ses_abc12345', '--provider', 'opencode', '--surface', SURFACE]]);
  });

  it('follows navigation to a different session', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe(route('ses_abc12345'), rootOf);
    reporter.observe(route('ses_def67890'), rootOf);
    expect(sent.map((argv: string[]) => argv[1])).toEqual(['ses_abc12345', 'ses_def67890']);
  });

  it('tells the caller whether it actually sent a report, and whether it holds one', async () => {
    const { reporter } = await reporterFor();
    expect(reporter.hasSession()).toBe(false);
    expect(reporter.observe(route('ses_abc12345'), rootOf)).toBe(true);
    expect(reporter.hasSession()).toBe(true);
    expect(reporter.observe(route('ses_abc12345'), rootOf)).toBe(false);
    reporter.dispose();
    expect(reporter.hasSession()).toBe(false);
    expect(reporter.observe(route('ses_def67890'), rootOf)).toBe(false);
  });

  it('releases the last session on dispose, exactly once', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe(route('ses_abc12345'), rootOf);
    reporter.dispose();
    reporter.dispose();
    expect(sent).toEqual([
      ['report-session', 'ses_abc12345', '--provider', 'opencode', '--surface', SURFACE],
      ['release-agent', '--provider', 'opencode', '--session', 'ses_abc12345', '--surface', SURFACE],
    ]);
  });

  it('releases nothing when no session was ever viewed', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe({ type: 'home' }, rootOf);
    reporter.dispose();
    expect(sent).toEqual([]);
  });

  it('stops reporting after dispose — a disposed TUI must not resurrect a handle', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.dispose();
    reporter.observe(route('ses_abc12345'), rootOf);
    expect(sent).toEqual([]);
  });

  it('releases synchronously on process exit, not through the async sender', async () => {
    const { createSessionReporter } = await load();
    const sent: string[][] = [];
    const synced: string[][] = [];
    const reporter = createSessionReporter({
      surface: SURFACE,
      callWmux: (argv: string[]) => sent.push(argv),
      callWmuxSync: (argv: string[]) => synced.push(argv),
    });
    reporter.observe(route('ses_abc12345'), rootOf);

    expect(reporter.releaseOnExit()).toBe(true);
    expect(synced).toEqual([[
      'release-agent', '--provider', 'opencode', '--session', 'ses_abc12345', '--surface', SURFACE,
    ]]);
    expect(sent).toHaveLength(1); // only the report: no async release

    expect(reporter.releaseOnExit()).toBe(false);
    expect(synced).toHaveLength(1);
  });

  it('releases nothing on exit when no session was viewed', async () => {
    const { createSessionReporter } = await load();
    const synced: string[][] = [];
    const reporter = createSessionReporter({
      surface: SURFACE,
      callWmux: () => {},
      callWmuxSync: (argv: string[]) => synced.push(argv),
    });
    expect(reporter.releaseOnExit()).toBe(false);
    expect(synced).toEqual([]);
  });

  it('forgets only the deleted session it holds, and releases it', async () => {
    const { createSessionReporter } = await load();
    const sent: string[][] = [];
    const reporter = createSessionReporter({
      surface: SURFACE,
      callWmux: (argv: string[]) => sent.push(argv),
      callWmuxSync: () => {},
    });
    reporter.observe(route('ses_abc12345'), rootOf);

    expect(reporter.forget('ses_other999')).toBe(false);
    expect(reporter.hasSession()).toBe(true);
    expect(reporter.forget('ses_abc12345')).toBe(true);
    expect(reporter.hasSession()).toBe(false);

    expect(sent).toEqual([
      ['report-session', 'ses_abc12345', '--provider', 'opencode', '--surface', SURFACE],
      ['release-agent', '--provider', 'opencode', '--session', 'ses_abc12345', '--surface', SURFACE],
    ]);
    expect(reporter.forget('ses_abc12345')).toBe(false);
  });
});

describe('startup session seeder (#310 follow-up)', () => {
  const seederFor = async (overrides: {
    reportCurrent?: () => boolean;
    delays?: number[];
    log?: (label: string, data?: unknown) => void;
  } = {}) => {
    const { createSessionSeeder } = await load();
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const cancelled: unknown[] = [];
    let calls = 0;
    const seeder = createSessionSeeder({
      reportCurrent: overrides.reportCurrent ?? (() => { calls++; return false; }),
      delays: overrides.delays ?? [250, 1000],
      schedule: (fn: () => void, ms: number) => {
        const timer = { fn, ms };
        scheduled.push(timer);
        return timer;
      },
      cancel: (timer: unknown) => { cancelled.push(timer); },
      log: overrides.log,
    });
    return { seeder, scheduled, cancelled, calls: () => calls };
  };

  it('reads immediately and stops as soon as a report succeeds', async () => {
    let reports = 0;
    const { seeder, scheduled } = await seederFor({
      reportCurrent: () => ++reports === 2,
    });
    seeder.start();
    expect(reports).toBe(1);
    expect(scheduled.map((s) => s.ms)).toEqual([250]);

    scheduled.shift()!.fn();
    expect(reports).toBe(2);
    expect(scheduled).toEqual([]);
  });

  it('keeps retrying on the declared schedule, then gives up', async () => {
    const { seeder, scheduled } = await seederFor({ delays: [250, 1000] });
    seeder.start();
    expect(scheduled.map((s) => s.ms)).toEqual([250]);

    scheduled.shift()!.fn();
    expect(scheduled.map((s) => s.ms)).toEqual([1000]);

    scheduled.shift()!.fn();
    expect(scheduled).toEqual([]);
  });

  it('stops the pending timer and a late timer cannot report', async () => {
    const { seeder, scheduled, cancelled, calls } = await seederFor();
    seeder.start();
    expect(calls()).toBe(1);
    const pending = scheduled[0];

    seeder.stop();
    expect(cancelled).toEqual([pending]);

    pending.fn(); // the timer raced the stop
    expect(calls()).toBe(1);
    seeder.stop(); // idempotent
    expect(cancelled).toHaveLength(1);
  });

  it('never lets a throwing route read escape into the TUI', async () => {
    let reads = 0;
    const { seeder, scheduled } = await seederFor({
      reportCurrent: () => {
        reads++;
        if (reads === 1) throw new Error('router not ready');
        return true;
      },
    });

    expect(() => seeder.start()).not.toThrow();
    expect(scheduled.map((s) => s.ms)).toEqual([250]);

    scheduled.shift()!.fn();
    expect(reads).toBe(2);
    expect(scheduled).toEqual([]);
  });
});

describe('prompt capture (#310 phase 2)', () => {
  // The event shape from OpenCode v2's schema:
  // session.inbox.enqueued { sessionID, inboxID, item }
  //   item = { type: "user" | "synthetic" | "compaction" | "move", payload, delivery }
  const enqueued = (overrides: any = {}) => ({
    sessionID: 'ses_abc12345',
    inboxID: 'msg_inbox1',
    item: { type: 'user', payload: { text: 'fix the flaky test' }, delivery: 'steer' },
    ...overrides,
  });

  it('takes the text of a user item, with the ids dedupe and attribution need', async () => {
    const { planPromptReport } = await load();
    expect(planPromptReport(enqueued())).toEqual({
      sessionID: 'ses_abc12345',
      inboxID: 'msg_inbox1',
      text: 'fix the flaky test',
    });
  });

  it('ignores synthetic, compaction and move items — never something a human typed', async () => {
    const { planPromptReport } = await load();
    for (const type of ['synthetic', 'compaction', 'move']) {
      expect(planPromptReport(enqueued({ item: { type, payload: { text: 'x' }, delivery: 'steer' } }))).toBeNull();
    }
  });

  it('ignores an empty prompt, a missing payload, and anything that is not an inbox event', async () => {
    const { planPromptReport } = await load();
    expect(planPromptReport(enqueued({ item: { type: 'user', payload: { text: '   ' }, delivery: 'steer' } }))).toBeNull();
    expect(planPromptReport(enqueued({ item: { type: 'user', payload: {}, delivery: 'steer' } }))).toBeNull();
    expect(planPromptReport(enqueued({ item: { type: 'user', delivery: 'steer' } }))).toBeNull();
    expect(planPromptReport(null)).toBeNull();
    expect(planPromptReport({})).toBeNull();
  });

  it('requires a session id that passes the same validator as everywhere else', async () => {
    const { planPromptReport } = await load();
    expect(planPromptReport(enqueued({ sessionID: 'not-a-session' }))).toBeNull();
  });

  it('knows which sessions this TUI hosts: the viewed one and its tabs', async () => {
    const { isHostedSession } = await load();
    expect(isHostedSession('ses_abc12345', { current: 'ses_abc12345', tabs: [] })).toBe(true);
    expect(isHostedSession('ses_def67890', { current: 'ses_abc12345', tabs: ['ses_def67890'] })).toBe(true);
    expect(isHostedSession('ses_other999', { current: 'ses_abc12345', tabs: ['ses_def67890'] })).toBe(false);
    expect(isHostedSession(undefined, { current: null, tabs: [] })).toBe(false);
  });

  it('extracts tab session ids defensively — the host shape is not ours to assume', async () => {
    const { tabSessionIds } = await load();
    expect(tabSessionIds([
      { sessionID: 'ses_a1234567' },
      { sessionId: 'ses_b1234567' },
      { id: 'ses_c1234567' },
      { nothing: true },
      null,
    ])).toEqual(['ses_a1234567', 'ses_b1234567', 'ses_c1234567']);
    expect(tabSessionIds(undefined)).toEqual([]);
  });

  it('reports a hosted prompt through the #305 event path, no --surface needed', async () => {
    const { createPromptReporter } = await load();
    const sent: string[][] = [];
    const reporter = createPromptReporter({ callWmux: (argv: string[]) => sent.push(argv) });
    reporter.observe(enqueued(), true);
    expect(sent).toEqual([['hook', '--event', 'UserPromptSubmit', '--prompt', 'fix the flaky test']]);
  });

  it('does not attribute a prompt from a session this TUI is not hosting', async () => {
    const { createPromptReporter } = await load();
    const sent: string[][] = [];
    const reporter = createPromptReporter({ callWmux: (argv: string[]) => sent.push(argv) });
    reporter.observe(enqueued(), false);
    expect(sent).toEqual([]);
  });

  it('reports one prompt per inbox id, however many replays arrive', async () => {
    const { createPromptReporter } = await load();
    const sent: string[][] = [];
    const reporter = createPromptReporter({ callWmux: (argv: string[]) => sent.push(argv) });
    reporter.observe(enqueued(), true);
    reporter.observe(enqueued(), true);
    expect(sent).toHaveLength(1);
  });

  it('caps a pasted prompt at the same 4000 chars the other producers use', async () => {
    const { createPromptReporter } = await load();
    const sent: string[][] = [];
    const reporter = createPromptReporter({ callWmux: (argv: string[]) => sent.push(argv) });
    reporter.observe(enqueued({ item: { type: 'user', payload: { text: 'x'.repeat(5000) }, delivery: 'steer' } }), true);
    expect(sent[0][4].length).toBe(4000);
  });
});

describe('routeFromTabs (#310 follow-up)', () => {
  it('keeps the router session when there is one', async () => {
    const { routeFromTabs } = await load();
    const route = { type: 'session', sessionID: 'ses_abc12345' };
    expect(routeFromTabs(route, [{ sessionID: 'ses_other999' }])).toBe(route);
  });

  it('uses the only open tab when the router answers home', async () => {
    const { routeFromTabs } = await load();
    expect(routeFromTabs({ type: 'home' }, [{ sessionID: 'ses_abc12345' }]))
      .toEqual({ type: 'session', sessionID: 'ses_abc12345' });
    expect(routeFromTabs(null, [{ sessionID: 'ses_abc12345' }]))
      .toEqual({ type: 'session', sessionID: 'ses_abc12345' });
  });

  it('does not guess between several tabs', async () => {
    const { routeFromTabs } = await load();
    const home = { type: 'home' };
    expect(routeFromTabs(home, [
      { sessionID: 'ses_a1234567' },
      { sessionID: 'ses_b1234567' },
    ])).toBe(home);
    expect(routeFromTabs(null, [])).toBeNull();
    expect(routeFromTabs(null, undefined)).toBeNull();
  });
});

describe('blocked state (#310 phase 3a)', () => {
  const reporterFor = async () => {
    const { createBlockedReporter } = await load();
    const sent: string[][] = [];
    const reporter = createBlockedReporter({ surface: SURFACE, callWmux: (argv: string[]) => sent.push(argv) });
    return { reporter, sent };
  };
  const asked = (over: any = {}) => ({
    id: 'per_1',
    sessionID: 'ses_abc12345',
    action: 'bash',
    resources: ['rm -rf build'],
    ...over,
  });

  it('reports a permission ask as blocked, preferring the human-readable message', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked({ message: 'Run rm -rf build?' }), true);
    expect(sent).toEqual([['report-agent', '--surface', SURFACE, '--blocked', 'Run rm -rf build?']]);
  });

  it('falls back to the action, then to a generic reason', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked(), true);
    expect(sent[0][4]).toBe('bash');
    reporter.observe('permission.replied', { requestID: 'per_1' }, true);
    reporter.observe('permission.asked', asked({ id: 'per_2', action: '' }), true);
    expect(sent[2][4]).toBe('Permission requested');
  });

  it('reports a form as blocked with its title', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('form.created', { form: { id: 'frm_1', sessionID: 'ses_abc12345', title: 'Which database?' } }, true);
    expect(sent).toEqual([['report-agent', '--surface', SURFACE, '--blocked', 'Which database?']]);
  });

  it('dedupes a replayed ask by its id — one "Needs you", not one per replay', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked(), true);
    reporter.observe('permission.asked', asked(), true);
    reporter.observe('form.created', { form: { id: 'frm_1', sessionID: 'ses_abc12345', title: 'Q' } }, true);
    reporter.observe('form.created', { form: { id: 'frm_1', sessionID: 'ses_abc12345', title: 'Q' } }, true);
    expect(sent).toHaveLength(2);
  });

  it('unblocks on a reply, a form reply/cancel, or a turn-ending failure — once', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked(), true);
    reporter.observe('permission.replied', { requestID: 'per_1', reply: 'once' }, true);
    reporter.observe('permission.replied', { requestID: 'per_1', reply: 'once' }, true);
    expect(sent.map((argv: string[]) => argv[3])).toEqual(['--blocked', '--unblocked']);

    reporter.observe('form.created', { form: { id: 'frm_2', sessionID: 'ses_abc12345', title: 'Q' } }, true);
    reporter.observe('form.cancelled', { id: 'frm_2' }, true);
    reporter.observe('permission.asked', asked({ id: 'per_3' }), true);
    reporter.observe('session.execution.failed', { sessionID: 'ses_abc12345', error: {} }, true);
    expect(sent.map((argv: string[]) => argv[3])).toEqual([
      '--blocked', '--unblocked', '--blocked', '--unblocked', '--blocked', '--unblocked',
    ]);
  });

  it('does nothing on an unhosted session, or when there was nothing blocked', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked(), false);
    reporter.observe('permission.replied', { requestID: 'per_1' }, false);
    reporter.observe('permission.replied', { requestID: 'per_1' }, true);
    expect(sent).toEqual([]);
  });

  it('needs every overlapping ask answered before it unblocks', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked(), true);
    reporter.observe('form.created', { form: { id: 'frm_1', sessionID: 'ses_abc12345', title: 'Q' } }, true);
    reporter.observe('permission.replied', { requestID: 'per_1' }, true);
    expect(sent.map((argv: string[]) => argv[3])).toEqual(['--blocked', '--blocked']);
    reporter.observe('form.replied', { id: 'frm_1' }, true);
    expect(sent.at(-1)?.[3]).toBe('--unblocked');
  });

  it('takes the reply to its own ask after the session left the screen', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked(), true);
    reporter.observe('permission.replied', { requestID: 'per_1' }, false);
    expect(sent.at(-1)?.[3]).toBe('--unblocked');
  });

  it('does not raise "Needs you" again for a replay of an answered ask', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked(), true);
    reporter.observe('permission.replied', { requestID: 'per_1' }, true);
    reporter.observe('permission.asked', asked(), true);
    expect(sent).toHaveLength(2);
  });

  it('clears only the failed session\'s asks', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked(), true);
    reporter.observe('permission.asked', asked({ id: 'per_2', sessionID: 'ses_other999' }), true);
    reporter.observe('session.execution.failed', { sessionID: 'ses_abc12345' }, true);
    expect(sent.at(-1)?.[3]).toBe('--blocked');
    reporter.observe('session.execution.interrupted', { sessionID: 'ses_other999' }, false);
    expect(sent.at(-1)?.[3]).toBe('--unblocked');
  });

  it('caps the reason at 200 chars, the same bound the server half applies', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('permission.asked', asked({ message: 'x'.repeat(500) }), true);
    expect(sent[0][4].length).toBe(200);
  });

  it('knows where each event keeps its session id', async () => {
    const { eventSessionID } = await load();
    expect(eventSessionID('permission.asked', asked())).toBe('ses_abc12345');
    expect(eventSessionID('form.created', { form: { sessionID: 'ses_abc12345' } })).toBe('ses_abc12345');
    expect(eventSessionID('session.execution.started', { sessionID: 'ses_abc12345' })).toBe('ses_abc12345');
    expect(eventSessionID('session.deleted', { sessionID: 'ses_abc12345' })).toBe('ses_abc12345');
    expect(eventSessionID('session.deleted', { info: { id: 'ses_def67890' } })).toBe('ses_def67890');
    expect(eventSessionID('session.deleted', {})).toBeNull();
    expect(eventSessionID('form.created', {})).toBeNull();
    expect(eventSessionID('permission.asked', null)).toBeNull();
  });
});

describe('working/idle (#310 phase 3b)', () => {
  const reporterFor = async () => {
    const { createActivityReporter } = await load();
    const sent: string[][] = [];
    const reporter = createActivityReporter({
      surface: SURFACE,
      callWmux: (argv: string[], done?: () => void) => { sent.push(argv); done?.(); },
    });
    return { reporter, sent };
  };
  const ev = (sessionID: string, over: any = {}) => ({ sessionID, ...over });

  const depths = (sent: string[][]) => sent.map((argv) => argv[4]);

  it('marks a hosted turn as working with an ABSOLUTE depth — never --run-start', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('session.execution.started', ev('ses_abc12345'), true);
    expect(sent).toEqual([['report-agent', '--surface', SURFACE, '--run-depth', '1']]);
  });

  it('returns to idle when the turn ends, deduping replays of the same transition', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('session.execution.started', ev('ses_abc12345'), true);
    reporter.observe('session.execution.started', ev('ses_abc12345'), true);
    reporter.observe('session.execution.succeeded', ev('ses_abc12345'), true);
    reporter.observe('session.execution.succeeded', ev('ses_abc12345'), true);
    expect(depths(sent)).toEqual(['1', '0']);
  });

  it('also ends on a failed or interrupted execution', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('session.execution.started', ev('ses_abc12345'), true);
    reporter.observe('session.execution.interrupted', ev('ses_abc12345'), true);
    reporter.observe('session.execution.started', ev('ses_abc12345'), true);
    reporter.observe('session.execution.failed', ev('ses_abc12345', { error: {} }), true);
    expect(depths(sent)).toEqual(['1', '0', '1', '0']);
  });

  it('clears the turn even after the view moved away — an end is not gated on hosting', async () => {
    // The class of bug 01df550 fixed for replies: a turn this pane started must
    // stop counting when it ends, whatever tab is on screen now.
    const { reporter, sent } = await reporterFor();
    reporter.observe('session.execution.started', ev('ses_abc12345'), true);
    reporter.observe('session.execution.succeeded', ev('ses_abc12345'), false);
    expect(depths(sent)).toEqual(['1', '0']);
  });

  it('ignores a turn in a session this TUI does not host', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('session.execution.started', ev('ses_other999'), false);
    reporter.observe('session.execution.succeeded', ev('ses_other999'), false);
    expect(sent).toEqual([]);
  });

  it('stays working until the LAST running session ends', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('session.execution.started', ev('ses_abc12345'), true);
    reporter.observe('session.execution.started', ev('ses_def67890'), true);
    reporter.observe('session.execution.succeeded', ev('ses_abc12345'), true);
    reporter.observe('session.execution.succeeded', ev('ses_def67890'), true);
    expect(depths(sent)).toEqual(['1', '0']);
  });

  it('an end for a session that never started here reports nothing', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('session.execution.succeeded', ev('ses_abc12345'), true);
    expect(sent).toEqual([]);
  });

  it('never emits a refcount flag — two producers must converge, not inflate', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('session.execution.started', ev('ses_abc12345'), true);
    reporter.observe('session.execution.succeeded', ev('ses_abc12345'), true);
    for (const argv of sent) {
      expect(argv).not.toContain('--run-start');
      expect(argv).not.toContain('--run-end');
    }
  });

  it('ignores events without a session id', async () => {
    const { reporter, sent } = await reporterFor();
    reporter.observe('session.execution.started', {}, true);
    reporter.observe('session.execution.started', null, true);
    expect(sent).toEqual([]);
  });

  // Each report is its own CLI process; two spawned ms apart race to the pipe,
  // and a `0` landing before its `1` reads "working" for 15 minutes (#151).
  it('never has two reports in flight — the next waits for the previous call', async () => {
    const { createActivityReporter } = await load();
    const sent: string[][] = [];
    const pending: Array<() => void> = [];
    const reporter = createActivityReporter({
      surface: SURFACE,
      callWmux: (argv: string[], done: () => void) => { sent.push(argv); pending.push(done); },
    });
    reporter.observe('session.execution.started', ev('ses_abc12345'), true);
    reporter.observe('session.execution.succeeded', ev('ses_abc12345'), true);
    expect(depths(sent)).toEqual(['1']);
    pending.shift()!();
    expect(depths(sent)).toEqual(['1', '0']);
  });

  it('collapses changes made while a call is in flight into the latest depth', async () => {
    const { createActivityReporter } = await load();
    const sent: string[][] = [];
    const pending: Array<() => void> = [];
    const reporter = createActivityReporter({
      surface: SURFACE,
      callWmux: (argv: string[], done: () => void) => { sent.push(argv); pending.push(done); },
    });
    reporter.observe('session.execution.started', ev('ses_a1234567'), true);
    reporter.observe('session.execution.succeeded', ev('ses_a1234567'), true);
    reporter.observe('session.execution.started', ev('ses_b1234567'), true);
    pending.shift()!();
    // Back at working before the first call returned: nothing more to say.
    expect(depths(sent)).toEqual(['1']);
    expect(pending).toEqual([]);
  });
});

describe('callWmux (#310)', () => {
  const runtimeNode = { file: ':node:', electron: false };

  it('runs the shipped CLI on the resolved JS runtime, argv untouched', async () => {
    const { callWmux } = await load();
    const env = { WMUX_CLI: 'C:\\wmux\\resources\\cli\\wmux.js' };
    callWmux(runtimeNode, ['report-session', 'ses_abc12345'], () => {}, env);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(':node:');
    expect(calls[0].argv).toEqual(['C:\\wmux\\resources\\cli\\wmux.js', 'report-session', 'ses_abc12345']);
    expect(calls[0].opts.env).toBeUndefined();
  });

  it('marks wmux\'s own Electron binary as Node, or a second wmux window opens', async () => {
    const { callWmux } = await load();
    const env = { WMUX_CLI: 'wmux.js' };
    callWmux({ file: 'wmux.exe', electron: true }, ['x'], () => {}, env);
    expect(calls[0].opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('skips on Windows without WMUX_CLI — execFile cannot spawn the .cmd shim', async () => {
    const { callWmux } = await load();
    callWmux(runtimeNode, ['x'], () => {}, {}, 'win32');
    expect(calls).toEqual([]);
  });

  it('reports completion on every path, the skip included', async () => {
    const { callWmux } = await load();
    const done = vi.fn();
    callWmux(runtimeNode, ['x'], () => {}, { WMUX_CLI: 'wmux.js' }, 'linux', done);
    callWmux(runtimeNode, ['x'], () => {}, {}, 'win32', done);
    expect(done).toHaveBeenCalledTimes(2);
  });

  it('bounds every call — a hung CLI must not hold the activity reporter in flight forever', async () => {
    const { callWmux } = await load();
    callWmux(runtimeNode, ['x'], () => {}, { WMUX_CLI: 'wmux.js' }, 'linux');
    callWmux(runtimeNode, ['x'], () => {}, {}, 'linux');
    for (const call of calls) {
      expect(call.opts.timeout).toBeGreaterThan(0);
      expect(Number.isFinite(call.opts.timeout)).toBe(true);
    }
  });

  it('falls back to `wmux` on PATH elsewhere', async () => {
    const { callWmux } = await load();
    callWmux(runtimeNode, ['x'], () => {}, {}, 'linux');
    expect(calls[0]).toMatchObject({ file: 'wmux', argv: ['x'] });
  });

  it('runs the exit release synchronously and bounded', async () => {
    const { callWmuxSync } = await load();
    callWmuxSync(
      runtimeNode,
      ['release-agent', '--session', 'ses_abc12345'],
      () => {},
      { WMUX_CLI: 'wmux.js' },
    );
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].file).toBe(':node:');
    expect(syncCalls[0].argv).toEqual(['wmux.js', 'release-agent', '--session', 'ses_abc12345']);
    expect(syncCalls[0].opts.timeout).toBeGreaterThan(0);
    expect(syncCalls[0].opts.stdio).toBe('ignore');
  });

  it('skips the synchronous path on Windows without WMUX_CLI', async () => {
    const { callWmuxSync } = await load();
    expect(callWmuxSync(runtimeNode, ['x'], () => {}, {}, 'win32')).toBe(false);
    expect(syncCalls).toEqual([]);
  });
});
