/**
 * exec-gate.ts — a small cap on how many remote spawns run at once per host.
 *
 * Every remote operation is a `wsl.exe` + `ssh` process pair. A view that wakes
 * up fires many at the same moment (an explorer with a dozen expanded folders,
 * a Git pane's queries beside the Diff tab's poll), and on the WSL route a cold
 * shared connection means each of them that starts before the first has opened
 * the master opens a connection of its own. A cap of a few keeps the burst from
 * stampeding wsl.exe and the host's sshd, and lets the later spawns ride the
 * connection the first ones opened. Spawns beyond the cap wait; none is dropped.
 * Within one priority they start in arrival order.
 *
 * Two priorities (`SpawnPriority`): a click's spawn goes before any poll's and
 * may use every slot, a poll's never takes the last free one, so a click never
 * queues behind polls.
 *
 * A lane is a host: the same destination, port and WSL distro share a
 * connection whatever checkout they ask about.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { SshTarget } from './ssh-targets';

/** Concurrent remote spawns per host. */
export const MAX_CONCURRENT_SPAWNS = 3;

/**
 * Slots a background spawn may never take: with the default cap, a poll can
 * hold two of the three, so the last one is always free for a click.
 */
export const SLOTS_RESERVED_FOR_FOREGROUND = 1;

/**
 * Who asked. `fg` is a person waiting for the answer (the explorer's list,
 * read, write, create, rename and delete, opening and saving a file, a Git
 * view request that a click or a tab opening made). `bg` is a poll nobody is
 * waiting for (the Diff tab's, the Git pane's tick, the +N/-N column's, the
 * sidebar's branch refresh). A foreground spawn starts before any waiting
 * background one and may use every slot; a background one may use all but
 * `SLOTS_RESERVED_FOR_FOREGROUND` of them.
 */
export type SpawnPriority = 'fg' | 'bg';

/** What a spawn learns when its slot opens: its priority, and how long it queued. */
export interface SpawnSlot {
  prio: SpawnPriority;
  /** Milliseconds between asking for the slot and getting it; 0 when it was free. */
  waitMs: number;
}

const priorityStore = new AsyncLocalStorage<SpawnPriority>();

type ForegroundObserver = (lane: string) => void;
let foregroundObserver: ForegroundObserver | undefined;

/**
 * Called with the lane whenever a person's spawn is asked for, before it
 * queues. exec-snapshot.ts uses it to treat any click on a host as a reason to
 * stop backing its polls off. One observer; setting another replaces it.
 */
export function observeForegroundSpawns(observer: ForegroundObserver | undefined): void {
  foregroundObserver = observer;
}

/**
 * Run `fn` with every remote spawn inside it asked for at `priority`. The call
 * site of a poll says so once, at the top; the spawns below it need no
 * parameter. Anything not run inside this is foreground, so a caller that
 * forgot to say is never delayed behind a poll.
 */
export function runWithSpawnPriority<T>(priority: SpawnPriority, fn: () => T): T {
  return priorityStore.run(priority, fn);
}

/**
 * `fn` as background work when a renderer said its request was a poll
 * (`poll: true`, exactly), otherwise as it was. The flag only lowers a
 * request's priority, so a renderer cannot use it to jump the queue.
 */
export function runForPoll<T>(poll: unknown, fn: () => T): T {
  return poll === true ? priorityStore.run('bg', fn) : fn();
}

/** A request without its `poll` flag, and the flag, so that the flag is never part of a cache or in-flight key. */
export function splitPollFlag<T>(sent: T): { request: T; poll: boolean } {
  if (!sent || typeof sent !== 'object' || !('poll' in sent)) return { request: sent, poll: false };
  const { poll, ...rest } = sent as T & { poll?: unknown };
  return { request: rest as T, poll: poll === true };
}

export function currentSpawnPriority(): SpawnPriority {
  return priorityStore.getStore() ?? 'fg';
}

interface Waiter {
  start: () => void;
}

interface Lane {
  active: number;
  fg: Waiter[];
  bg: Waiter[];
}

const lanes = new Map<string, Lane>();

let maxConcurrent = MAX_CONCURRENT_SPAWNS;

/** Tests only: how many spawns a host may run at once. Passing nothing restores the default. */
export function configureSpawnGate(options: { limit?: number } = {}): void {
  maxConcurrent = options.limit ?? MAX_CONCURRENT_SPAWNS;
}

/** The lane a target's spawns share: one per host connection. */
export function sshLaneKey(target: SshTarget): string {
  const { destination, port } = target.session;
  return `${target.wslDistro ?? ''}\0${destination}\0${port ?? ''}`;
}

/** The most a background spawn may have running at once, for a lane that allows `limit`. */
function backgroundLimit(limit: number): number {
  // A one-slot lane has nothing to spare: reserving it would starve polls for good.
  return limit > 1 ? Math.max(1, limit - SLOTS_RESERVED_FOR_FOREGROUND) : limit;
}

/** Start every waiter a free slot allows: foreground first, in arrival order, then background. */
function pump(lane: Lane, limit: number): void {
  for (;;) {
    let next: Waiter | undefined;
    if (lane.active < limit && lane.fg.length > 0) next = lane.fg.shift();
    else if (lane.active < backgroundLimit(limit) && lane.bg.length > 0) next = lane.bg.shift();
    if (!next) return;
    lane.active++;
    next.start();
  }
}

/**
 * Run `work` when the host's lane has a free slot for its priority. The slot
 * is released when `work` settles, however it settles, and handed straight to
 * the next waiter. `priority` defaults to the one `runWithSpawnPriority` set.
 */
export async function withSpawnSlot<T>(
  lane: string,
  work: (slot: SpawnSlot) => Promise<T>,
  priority: SpawnPriority = currentSpawnPriority(),
): Promise<T> {
  const limit = maxConcurrent;
  let state = lanes.get(lane);
  if (!state) {
    state = { active: 0, fg: [], bg: [] };
    lanes.set(lane, state);
  }
  const mine = state;
  const asked = Date.now();
  if (priority === 'fg') foregroundObserver?.(lane);
  const canStartNow = priority === 'fg'
    ? mine.active < limit && mine.fg.length === 0
    : mine.active < backgroundLimit(limit) && mine.fg.length === 0 && mine.bg.length === 0;
  if (canStartNow) mine.active++;
  else await new Promise<void>((resolve) => (priority === 'fg' ? mine.fg : mine.bg).push({ start: resolve }));
  try {
    return await work({ prio: priority, waitMs: Date.now() - asked });
  } finally {
    mine.active--;
    pump(mine, limit);
    if (mine.active === 0 && mine.fg.length === 0 && mine.bg.length === 0 && lanes.get(lane) === mine) lanes.delete(lane);
  }
}
