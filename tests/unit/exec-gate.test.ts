import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentSpawnPriority,
  configureSpawnGate,
  MAX_CONCURRENT_SPAWNS,
  observeForegroundSpawns,
  runForPoll,
  runWithSpawnPriority,
  splitPollFlag,
  SLOTS_RESERVED_FOR_FOREGROUND,
  sshLaneKey,
  withSpawnSlot,
} from '../../src/main/exec-gate';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';

const target = (argv: string[], wslDistro?: string): SshTarget => {
  const parsed = parseSshTarget(argv, '/w/repo', wslDistro);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
};

/** A job that stays running until `release()`, and records when it started. */
function job(log: string[], name: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { release, run: () => { log.push(`start ${name}`); return gate.then(() => name); } };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => configureSpawnGate());

describe('sshLaneKey', () => {
  it('is one lane per destination, port and distro, whatever the checkout', () => {
    expect(sshLaneKey(target(['ssh', 'dev@box']))).toBe(sshLaneKey(target(['ssh', 'dev@box'])));
    expect(sshLaneKey(target(['ssh', 'dev@box']))).not.toBe(sshLaneKey(target(['ssh', 'dev@other'])));
    expect(sshLaneKey(target(['ssh', '-p', '2222', 'dev@box']))).not.toBe(sshLaneKey(target(['ssh', 'dev@box'])));
    expect(sshLaneKey(target(['ssh', 'dev@box'], 'Ubuntu'))).not.toBe(sshLaneKey(target(['ssh', 'dev@box'])));
  });
});

describe('withSpawnSlot', () => {
  it('runs at most the limit at once and starts the rest in arrival order as slots free up', async () => {
    const log: string[] = [];
    const jobs = ['a', 'b', 'c', 'd', 'e'].map((n) => job(log, n));
    const done = jobs.map((j) => withSpawnSlot('lane', j.run));
    await tick();
    expect(MAX_CONCURRENT_SPAWNS).toBe(3);
    expect(log).toEqual(['start a', 'start b', 'start c']);
    jobs[1].release();
    await tick();
    expect(log).toEqual(['start a', 'start b', 'start c', 'start d']);
    jobs[0].release();
    await tick();
    expect(log.slice(4)).toEqual(['start e']);
    for (const j of jobs) j.release();
    expect(await Promise.all(done)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps hosts apart', async () => {
    configureSpawnGate({ limit: 1 });
    const log: string[] = [];
    const one = job(log, 'one');
    const two = job(log, 'two');
    const first = withSpawnSlot('host-1', one.run);
    const second = withSpawnSlot('host-2', two.run);
    await tick();
    expect(log).toEqual(['start one', 'start two']);
    one.release();
    two.release();
    await Promise.all([first, second]);
  });

  it('frees its slot when the work throws, and passes the failure on', async () => {
    configureSpawnGate({ limit: 1 });
    const failing = withSpawnSlot('lane-throw', async () => { throw new Error('boom'); });
    const next = withSpawnSlot('lane-throw', async () => 'ran');
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('ran');
  });

  it('forgets an idle lane, so a new one starts from zero', async () => {
    configureSpawnGate({ limit: 1 });
    expect(await withSpawnSlot('lane-idle', async () => 1)).toBe(1);
    expect(await withSpawnSlot('lane-idle', async () => 2)).toBe(2);
  });
});

describe('foreground and background priority', () => {
  it('a poll never takes the last free slot: two background jobs run, the third waits, a click starts at once', async () => {
    const log: string[] = [];
    const polls = ['p1', 'p2', 'p3'].map((n) => job(log, n));
    const click = job(log, 'click');
    const done = polls.map((j) => withSpawnSlot('lane-prio-1', j.run, 'bg'));
    await tick();
    expect(SLOTS_RESERVED_FOR_FOREGROUND).toBe(1);
    expect(log).toEqual(['start p1', 'start p2']);
    const clicked = withSpawnSlot('lane-prio-1', click.run, 'fg');
    await tick();
    expect(log).toEqual(['start p1', 'start p2', 'start click']);
    click.release();
    await tick();
    // The slot the click used is the reserved one: the third poll still waits.
    expect(log).toEqual(['start p1', 'start p2', 'start click']);
    polls[0].release();
    await tick();
    expect(log.at(-1)).toBe('start p3');
    for (const j of polls) j.release();
    await Promise.all([...done, clicked]);
  });

  it('a waiting click starts before a waiting poll, whichever asked first', async () => {
    const log: string[] = [];
    const fill = ['a', 'b', 'c'].map((n) => job(log, n));
    const poll = job(log, 'poll');
    const clickOne = job(log, 'click-1');
    const clickTwo = job(log, 'click-2');
    const all = fill.map((j) => withSpawnSlot('lane-prio-2', j.run, 'fg'));
    all.push(withSpawnSlot('lane-prio-2', poll.run, 'bg'));
    all.push(withSpawnSlot('lane-prio-2', clickOne.run, 'fg'));
    all.push(withSpawnSlot('lane-prio-2', clickTwo.run, 'fg'));
    await tick();
    expect(log).toEqual(['start a', 'start b', 'start c']);
    fill[0].release();
    await tick();
    expect(log.at(-1)).toBe('start click-1');
    fill[1].release();
    await tick();
    expect(log.at(-1)).toBe('start click-2');
    fill[2].release();
    await tick();
    // Active is now the two clicks; a poll may run while fewer than two are active.
    expect(log).not.toContain('start poll');
    clickOne.release();
    await tick();
    expect(log.at(-1)).toBe('start poll');
    clickTwo.release();
    poll.release();
    await Promise.all(all);
  });

  it('background jobs of one host start in arrival order', async () => {
    const log: string[] = [];
    const hold = [job(log, 'x'), job(log, 'y')];
    const queued = ['q1', 'q2'].map((n) => job(log, n));
    const done = [
      ...hold.map((j) => withSpawnSlot('lane-prio-3', j.run, 'bg')),
      ...queued.map((j) => withSpawnSlot('lane-prio-3', j.run, 'bg')),
    ];
    await tick();
    hold[0].release();
    await tick();
    expect(log).toEqual(['start x', 'start y', 'start q1']);
    hold[1].release();
    await tick();
    expect(log.at(-1)).toBe('start q2');
    queued.forEach((j) => j.release());
    await Promise.all(done);
  });

  it('a lane with one slot still runs background work (nothing is reserved out of it)', async () => {
    configureSpawnGate({ limit: 1 });
    expect(await withSpawnSlot('lane-prio-4', async () => 'ran', 'bg')).toBe('ran');
    const log: string[] = [];
    const first = job(log, 'first');
    const second = job(log, 'second');
    const done = [
      withSpawnSlot('lane-prio-4', first.run, 'bg'),
      withSpawnSlot('lane-prio-4', second.run, 'bg'),
    ];
    await tick();
    expect(log).toEqual(['start first']);
    first.release();
    await tick();
    expect(log).toEqual(['start first', 'start second']);
    second.release();
    await Promise.all(done);
  });

  it('tells the work its priority and how long it queued', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const holders = ['a', 'b', 'c'].map((n) => job(log, n));
      const held = holders.map((j) => withSpawnSlot('lane-prio-5', j.run, 'fg'));
      const seen: unknown[] = [];
      const late = withSpawnSlot('lane-prio-5', async (slot) => { seen.push(slot); }, 'bg');
      await vi.advanceTimersByTimeAsync(750);
      holders.forEach((j) => j.release());
      await Promise.all([...held, late]);
      expect(seen).toEqual([{ prio: 'bg', waitMs: 750 }]);
      let free: unknown;
      await withSpawnSlot('lane-prio-5', async (slot) => { free = slot; });
      expect(free).toEqual({ prio: 'fg', waitMs: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runWithSpawnPriority sets the default for the spawns below it, and nothing else is background', async () => {
    expect(currentSpawnPriority()).toBe('fg');
    const seen = await runWithSpawnPriority('bg', async () => {
      await tick();
      return withSpawnSlot('lane-prio-6', async (slot) => slot.prio);
    });
    expect(seen).toBe('bg');
    expect(await withSpawnSlot('lane-prio-6', async (slot) => slot.prio)).toBe('fg');
    expect(runWithSpawnPriority('bg', () => currentSpawnPriority())).toBe('bg');
    expect(currentSpawnPriority()).toBe('fg');
  });
});

describe('the poll flag a renderer sends', () => {
  it('runForPoll makes the work background only for exactly true', async () => {
    const prio = () => withSpawnSlot('lane-poll-1', async (slot) => slot.prio);
    expect(await runForPoll(true, prio)).toBe('bg');
    for (const notAPoll of [false, undefined, null, 1, 'true', {}]) {
      expect(await runForPoll(notAPoll, prio)).toBe('fg');
    }
  });

  it('splitPollFlag takes the flag off a request and leaves everything else as it was', () => {
    const request = { op: 'repo', cwd: '/x', surfaceId: 's', poll: true };
    expect(splitPollFlag(request)).toEqual({ request: { op: 'repo', cwd: '/x', surfaceId: 's' }, poll: true });
    expect('poll' in splitPollFlag(request).request).toBe(false);
    const plain = { op: 'repo', cwd: '/x' };
    expect(splitPollFlag(plain).request).toBe(plain);
    expect(splitPollFlag(plain).poll).toBe(false);
    expect(splitPollFlag({ op: 'repo', poll: 'yes' })).toEqual({ request: { op: 'repo' }, poll: false });
    expect(splitPollFlag(null)).toEqual({ request: null, poll: false });
    expect(splitPollFlag('nope')).toEqual({ request: 'nope', poll: false });
  });
});

describe('the foreground observer', () => {
  it('is told the lane of every foreground spawn and of no background one', async () => {
    const seen: string[] = [];
    observeForegroundSpawns((lane) => seen.push(lane));
    try {
      await withSpawnSlot('lane-obs', async () => 1, 'fg');
      await withSpawnSlot('lane-obs', async () => 1, 'bg');
      await withSpawnSlot('lane-obs-2', async () => 1);
      await runWithSpawnPriority('bg', () => withSpawnSlot('lane-obs-3', async () => 1));
      expect(seen).toEqual(['lane-obs', 'lane-obs-2']);
    } finally {
      observeForegroundSpawns(undefined);
    }
    await withSpawnSlot('lane-obs', async () => 1);
    expect(seen).toHaveLength(2);
  });
});
