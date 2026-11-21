/**
 * exec-snapshot.ts — one shared, cheap look at a checkout on a remote host or in a
 * WSL distro, so that the pollers do not each ask the same questions again.
 *
 * The Git pane, the Diff tab and the explorer's +N/-N column each poll for
 * overlapping answers. Every consumer is wrapped in `cachedForPoll`, which
 *
 *  1. asks for the location's FINGERPRINT: one small spawn, shared by every consumer
 *     that asks within `SNAPSHOT_TTL_MS` and by every one that asks while it runs;
 *  2. serves the last answer if the fingerprint equals the one it was computed under,
 *     otherwise runs the consumer's own code and stores the result.
 *
 * The lane is the host (or distro) and the location the checkout in it
 * (`GitContext`, exec-location.ts).
 *
 * ## What is never optimised
 *
 *  - A request a person made (not `bg`, see exec-gate.ts) does not read the cache. It
 *    runs the consumer's code and drops the entry it would have used, so Refresh, a
 *    click and an agent's edit see the host as it is now.
 *  - A failure is never served: a failed fingerprint or answer is not stored, and an
 *    unreachable host is rethrown as the error it is. There is no stale "no changes".
 *  - A fingerprint that cannot be used falls back to the consumer's code, and the
 *    host is not asked again for `UNUSABLE_BACKOFF_MS`.
 *  - A write, create, rename or delete through wmux invalidates everything for the
 *    host (`invalidateSnapshots`), at its start and at its end.
 *
 * ## Backing off
 *
 * While the fingerprint stays unchanged for `QUIET_BEFORE_BACKOFF_MS` and nobody has
 * touched the host, each further unchanged fingerprint doubles how long the next one
 * is held back (from `SNAPSHOT_TTL_MS` up to `MAX_POLL_INTERVAL_MS`). Polls inside the
 * window are answered from the last result with no spawn. It starts over on a different
 * fingerprint, on any request a person made on the host (seen as a foreground spawn,
 * exec-gate.ts), on a write through wmux and on an agent hook edit signal
 * (`noteAgentEdit`). Hidden panes do not poll; the renderer checks that.
 *
 * ## The fingerprint, and what it cannot see
 *
 * The output of the `fingerprint` function in the batch script (exec-git-batch.ts): the
 * top level; every ref and its object; and for every worktree, `git status
 * --porcelain=v2 --branch -z -unormal` plus `stat` (size, mtime to the nanosecond) of
 * every modified or untracked file. It is hashed on the remote side into digests
 * (`parseFingerprint`), and equal output is an unchanged tree. A host with no hash
 * tool, awk or `mktemp -d`, no GNU/busybox `stat -c`, or more than 2000 modified or
 * untracked files in a worktree makes no usable fingerprint, and its polls run in full.
 *
 * Limits, all of which make it MISS a change rather than invent one:
 *
 *  - A file rewritten with the same size and a deliberately restored mtime
 *    (`touch -r`, rsync -t) is not noticed until something else changes.
 *  - A file name with a newline in it is split into two bogus names, so its stat line
 *    is lost.
 *  - Ignored files are not looked at (no view shows them either).
 *  - A change that lands inside the TTL after the fingerprint was taken is seen on the
 *    next one, at most `SNAPSHOT_TTL_MS` (more while backing off) late.
 */

import { setBounded, touch } from '../shared/bounded-map';
import { BatchSetupError, runGitBatch } from './exec-git-batch';
import { parseFingerprint, type RemoteFingerprint } from './exec-snapshot-fingerprint';
import { contextLaneKey, contextLocationKey, contextPath, type GitContext } from './exec-location';
import { currentSpawnPriority, observeForegroundSpawns } from './exec-gate';
import { SSH_UNREACHABLE_MESSAGE } from './ssh-git';

/** How long one fingerprint answers every consumer; just under the fastest poll (the Diff tab's 2 s). */
export const SNAPSHOT_TTL_MS = 1750;

/** How long a host must show no change and no interaction before its polls back off. */
export const QUIET_BEFORE_BACKOFF_MS = 30_000;

/** The longest a poll is held off a host that stays unchanged. */
export const MAX_POLL_INTERVAL_MS = 30_000;

/** After an unusable fingerprint, how long a host is not asked for another. */
export const UNUSABLE_BACKOFF_MS = 5 * 60_000;

// ─── State, per host (lane) and per checkout (location) ──────────────────────

interface FingerprintState {
  fp: RemoteFingerprint | null;
  at: number;
  generation: number;
}

interface Entry {
  token: string;
  value: unknown;
  lane: string;
}

const generations = new Map<string, number>();
const fingerprints = new Map<string, FingerprintState & { lane: string }>();
const fingerprintsInFlight = new Map<string, Promise<RemoteFingerprint | null>>();
/**
 * The most answers kept. An entry can hold a whole file diff (up to 20 MB), so the count is
 * capped. The oldest goes first; a read keeps its entry young.
 */
export const SNAPSHOT_MAX_ENTRIES = 64;
const entries = new Map<string, Entry>();
const unusableUntil = new Map<string, number>();

let enabled = true;

/** Tests only: switch the whole mechanism off, so every consumer runs its own code. */
export function configureSnapshots(options: { enabled: boolean }): void {
  enabled = options.enabled;
}

/** Tests only: forget everything. */
export function resetSnapshots(): void {
  paces.clear();
  generations.clear();
  fingerprints.clear();
  fingerprintsInFlight.clear();
  entries.clear();
  unusableUntil.clear();
}

/** Tests only: how many answers are kept. */
export function snapshotEntryCount(): number {
  return entries.size;
}

const generationOf = (lane: string): number => generations.get(lane) ?? 0;

// ─── Backing off, per host ───────────────────────────────────────────────────

interface Pace {
  /** When the host last changed or somebody last used it. */
  activeAt: number;
  /** How many times the interval has doubled. */
  step: number;
  /** The hash of the last fingerprint seen, to tell a change. */
  lastAll: Map<string, string>;
}

const paces = new Map<string, Pace>();

function paceOf(lane: string): Pace {
  let pace = paces.get(lane);
  if (!pace) {
    pace = { activeAt: Date.now(), step: 0, lastAll: new Map() };
    paces.set(lane, pace);
  }
  return pace;
}

/** How long a poll may be answered from a fingerprint this old, right now. */
export function currentPollInterval(lane: string): number {
  return Math.min(MAX_POLL_INTERVAL_MS, SNAPSHOT_TTL_MS * 2 ** paceOf(lane).step);
}

/** Somebody used the host, or it changed: poll at full cadence again, starting with a new fingerprint. */
function wake(lane: string): void {
  const pace = paceOf(lane);
  pace.activeAt = Date.now();
  pace.step = 0;
  for (const [key, state] of fingerprints) if (state.lane === lane) fingerprints.delete(key);
}

/** An agent's hook says a file was edited: whichever host it was on, poll at full cadence. */
export function noteAgentEdit(): void {
  for (const lane of new Set([...paces.keys(), ...[...fingerprints.values()].map((s) => s.lane)])) wake(lane);
}

/** A fresh fingerprint for `location`: a change wakes the host, a repeat past the quiet window slows it. */
function observeFingerprint(lane: string, location: string, fp: RemoteFingerprint | null): void {
  const pace = paceOf(lane);
  const previous = pace.lastAll.get(location);
  const all = fp?.all ?? '';
  pace.lastAll.set(location, all);
  if (previous !== undefined && previous !== all) {
    pace.activeAt = Date.now();
    pace.step = 0;
  } else if (Date.now() - pace.activeAt >= QUIET_BEFORE_BACKOFF_MS) {
    pace.step = Math.min(pace.step + 1, Math.ceil(Math.log2(MAX_POLL_INTERVAL_MS / SNAPSHOT_TTL_MS)));
  }
}

observeForegroundSpawns((lane) => wake(lane));

/**
 * Forget every fingerprint and answer for a host, and keep anything that is
 * running from being stored: a change wmux itself made is not in them.
 */
export function invalidateSnapshots(lane: string): void {
  wake(lane);
  generations.set(lane, generationOf(lane) + 1);
  for (const [key, state] of fingerprints) if (state.lane === lane) fingerprints.delete(key);
  for (const [key, entry] of entries) if (entry.lane === lane) entries.delete(key);
  for (const key of [...fingerprintsInFlight.keys()]) if (key.startsWith(`${lane}\0`)) fingerprintsInFlight.delete(key);
}

/** One spawn: the fingerprint of the checkout, or null when it cannot be made. */
export async function fetchFingerprint(context: GitContext): Promise<RemoteFingerprint | null> {
  let outcomes;
  try {
    outcomes = await runGitBatch(context, contextPath(context), [{ dir: 'f', args: [] }], 'git:fingerprint');
  } catch (err) {
    if (err instanceof BatchSetupError) return null;
    throw err;
  }
  if (!outcomes || outcomes[0].status !== 0) return null;
  return parseFingerprint(outcomes[0].stdout);
}

/**
 * The fingerprint no older than `maxAgeMs` (a poll passes `currentPollInterval`), from the one already in hand, the
 * one already being fetched, or a new spawn. A failure is thrown and leaves no
 * state behind.
 */
export function sharedFingerprint(context: GitContext, maxAgeMs: number): Promise<RemoteFingerprint | null> {
  const lane = contextLaneKey(context);
  const location = contextLocationKey(context);
  const generation = generationOf(lane);
  const have = fingerprints.get(location);
  if (have && have.generation === generation && Date.now() - have.at <= maxAgeMs) return Promise.resolve(have.fp);
  const flightKey = `${lane}\0${location}`;
  const running = fingerprintsInFlight.get(flightKey);
  if (running) return running;
  let started!: Promise<RemoteFingerprint | null>;
  started = (async () => {
    try {
      const fp = await fetchFingerprint(context);
      if (generation === generationOf(lane)) {
        observeFingerprint(lane, location, fp);
        fingerprints.set(location, { fp, at: Date.now(), generation, lane });
      }
      return fp;
    } catch (err) {
      fingerprints.delete(location);
      throw err;
    } finally {
      // Only its own entry: an invalidation may have started a newer fetch under the same key.
      if (fingerprintsInFlight.get(flightKey) === started) fingerprintsInFlight.delete(flightKey);
    }
  })();
  fingerprintsInFlight.set(flightKey, started);
  return started;
}

export interface CachedAnswer<T> {
  context: GitContext;
  /** What the question is, without the host (added here). */
  key: string;
  /** The token the answer is valid under, or null when this fingerprint cannot vouch for it. */
  token: (fp: RemoteFingerprint) => string | null;
  /** The consumer's own code, unchanged. */
  compute: () => Promise<T>;
  /** False for an answer that must not be kept (a fallback marker, say). */
  cacheable?: (value: T) => boolean;
}

/** `compute()`, answered from the last result when the host's fingerprint says nothing changed. See the header. */
export async function cachedForPoll<T>(request: CachedAnswer<T>): Promise<T> {
  const { context } = request;
  const lane = contextLaneKey(context);
  const entryKey = `${contextLocationKey(context)}\0${request.key}`;
  if (!enabled || currentSpawnPriority() !== 'bg') {
    // A person asked: the host as it is now, and no stale entry left for the next poll.
    const fresh = await request.compute();
    entries.delete(entryKey);
    return fresh;
  }
  if ((unusableUntil.get(lane) ?? 0) > Date.now()) return request.compute();
  let fp: RemoteFingerprint | null = null;
  try {
    fp = await sharedFingerprint(context, currentPollInterval(lane));
    // The host answered and cannot give a usable one: do not ask it again for a while.
    if (!fp) unusableUntil.set(lane, Date.now() + UNUSABLE_BACKOFF_MS);
  } catch (err) {
    // An unreachable host is an error. Anything else (a timeout) is the consumer's to find out.
    if (err instanceof Error && err.message === SSH_UNREACHABLE_MESSAGE) throw err;
  }
  if (!fp) return request.compute();
  const token = request.token(fp);
  if (token === null) return request.compute();
  const kept = entries.get(entryKey);
  if (kept && kept.token === token) {
    touch(entries, entryKey);
    return kept.value as T;
  }
  const generation = generationOf(lane);
  const value = await request.compute();
  if (generation === generationOf(lane) && (request.cacheable?.(value) ?? true)) {
    setBounded(entries, entryKey, { token, value, lane }, SNAPSHOT_MAX_ENTRIES);
  }
  return value;
}
