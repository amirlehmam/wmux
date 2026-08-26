import { describe, it, expect } from 'vitest';
import { buildLayout, isBlocked } from '../../src/renderer/components/Hub/office-layout';
import type { OfficeLayout } from '../../src/renderer/components/Hub/office-layout';
import {
  createSim, stepSim, MAX_CHARACTERS, HANDOFF_WINDOW_MS,
} from '../../src/renderer/components/Hub/office-sim';
import type { SimRosterEntry, SimState } from '../../src/renderer/components/Hub/office-sim';
import { WorkspaceId } from '../../src/shared/types';

const rng = () => 0.5;
const wid = (s: string) => s as WorkspaceId;
const entry = (id: string, ws: string, over: Partial<SimRosterEntry> = {}): SimRosterEntry => ({
  surfaceId: id, workspaceId: ws, state: 'working', answerPending: false, dwellMs: 0, ...over,
});
const LAYOUT = buildLayout(
  [{ id: wid('ws-1'), title: 'Alpha' }, { id: wid('ws-2'), title: 'Beta' }],
  [
    { surfaceId: 'a', workspaceId: wid('ws-1') }, { surfaceId: 'b', workspaceId: wid('ws-1') },
    { surfaceId: 'c', workspaceId: wid('ws-2') },
  ],
);
/** Run the sim for `ms` in 100ms ticks with an unchanged roster and layout. */
const runWith = (state: SimState, roster: SimRosterEntry[], layout: OfficeLayout, ms: number): SimState => {
  for (let t = 0; t < ms; t += 100) state = stepSim(state, roster, layout, 100, rng);
  return state;
};
const run = (state: SimState, roster: SimRosterEntry[], ms: number): SimState =>
  runWith(state, roster, LAYOUT, ms);

describe('stepSim', () => {
  it('spawns new roster entries at the door walking to their desk (rule 1)', () => {
    const s = stepSim(createSim(), [entry('a', 'ws-1')], LAYOUT, 100, rng);
    const ch = s.characters['a'];
    expect(ch).toBeDefined();
    expect(ch.phase).toBe('walkingToDesk');
    expect(Math.round(ch.x)).toBe(LAYOUT.door.x);
    expect(ch.path.length).toBeGreaterThan(0);
  });

  it('walks to the chair and sits facing up with no bubble while working (rules 3-5)', () => {
    const s = run(createSim(), [entry('a', 'ws-1')], 30_000);
    const ch = s.characters['a'];
    expect(ch.phase).toBe('atDesk');
    expect({ x: ch.x, y: ch.y }).toEqual(LAYOUT.chairBySurface['a']);
    expect(ch.facing).toBe('up');
    expect(ch.bubble).toBe('none');
  });

  it('shows exclaim when blocked, hourglass when answerPending (rule 4)', () => {
    let s = run(createSim(), [entry('a', 'ws-1')], 30_000);
    s = stepSim(s, [entry('a', 'ws-1', { state: 'blocked' })], LAYOUT, 100, rng);
    expect(s.characters['a'].bubble).toBe('exclaim');
    s = stepSim(s, [entry('a', 'ws-1', { state: 'blocked', answerPending: true })], LAYOUT, 100, rng);
    expect(s.characters['a'].bubble).toBe('hourglass');
  });

  it('idle sends the character to a break seat (rule 3)', () => {
    let s = run(createSim(), [entry('a', 'ws-1')], 30_000);
    s = run(s, [entry('a', 'ws-1', { state: 'idle' })], 30_000);
    const ch = s.characters['a'];
    expect(ch.phase).toBe('resting');
    expect(LAYOUT.breakSeats).toContainEqual({ x: ch.x, y: ch.y });
  });

  it('removes a character after it walks out (rule 2)', () => {
    let s = run(createSim(), [entry('a', 'ws-1')], 30_000);
    s = stepSim(s, [], LAYOUT, 100, rng);
    expect(s.characters['a'].phase).toBe('leaving');
    s = run(s, [], 60_000);
    expect(s.characters['a']).toBeUndefined();
  });

  it('handoff: idler visits the same-workspace starter, both chat, then idler rests (rule 6)', () => {
    let s = run(createSim(), [entry('a', 'ws-1'), entry('b', 'ws-1', { state: 'idle' })], 60_000);
    const next = [entry('a', 'ws-1', { state: 'idle' }), entry('b', 'ws-1', { state: 'working' })];
    s = stepSim(s, next, LAYOUT, 100, rng);
    expect(s.characters['a'].phase).toBe('walkingToPeer');
    expect(s.characters['a'].peerId).toBe('b');
    s = run(s, next, 30_000);
    expect(s.characters['a'].phase).toBe('resting');
  });

  it('no handoff across workspaces (rule 6)', () => {
    let s = run(createSim(), [entry('a', 'ws-1'), entry('c', 'ws-2', { state: 'idle' })], 60_000);
    s = stepSim(s, [entry('a', 'ws-1', { state: 'idle' }), entry('c', 'ws-2', { state: 'working' })], LAYOUT, 100, rng);
    expect(s.characters['a'].phase).toBe('walkingToBreak');
  });

  it('handoff window expires (rule 6)', () => {
    let s = run(createSim(), [entry('a', 'ws-1'), entry('b', 'ws-1', { state: 'idle' })], 60_000);
    const idled = [entry('a', 'ws-1', { state: 'idle' }), entry('b', 'ws-1', { state: 'idle' })];
    s = run(s, idled, HANDOFF_WINDOW_MS + 1000);
    s = stepSim(s, [entry('a', 'ws-1', { state: 'idle' }), entry('b', 'ws-1', { state: 'working' })], LAYOUT, 100, rng);
    expect(s.characters['a'].phase).not.toBe('walkingToPeer');
  });

  it('caps characters at MAX_CHARACTERS and reports overflow (rule 8)', () => {
    const big = Array.from({ length: MAX_CHARACTERS + 5 }, (_, i) => entry(`s${i}`, 'ws-1'));
    const bigLayout = buildLayout(
      [{ id: 'ws-1', title: 'Alpha' }],
      big.map((e) => ({ surfaceId: e.surfaceId, workspaceId: e.workspaceId })),
    );
    const s = stepSim(createSim(), big, bigLayout, 100, rng);
    expect(Object.keys(s.characters)).toHaveLength(MAX_CHARACTERS);
    expect(s.overflow).toBe(5);
  });

  it('walks a seated character to its new chair when the layout reassigns it (rule 7)', () => {
    const wsA = [{ id: wid('ws-1'), title: 'Alpha' }];
    const layoutA = buildLayout(wsA, [{ surfaceId: 'a', workspaceId: wid('ws-1') }]);
    let s = runWith(createSim(), [entry('a', 'ws-1')], layoutA, 30_000);
    expect({ x: s.characters['a'].x, y: s.characters['a'].y }).toEqual(layoutA.chairBySurface['a']);
    // A new agent inserted before 'a' in roster order shifts a's chair.
    const layoutB = buildLayout(wsA, [
      { surfaceId: 'z', workspaceId: wid('ws-1') },
      { surfaceId: 'a', workspaceId: wid('ws-1') },
    ]);
    expect(layoutB.chairBySurface['a']).not.toEqual(layoutA.chairBySurface['a']);
    s = runWith(s, [entry('z', 'ws-1'), entry('a', 'ws-1')], layoutB, 30_000);
    expect(s.characters['a'].phase).toBe('atDesk');
    expect({ x: s.characters['a'].x, y: s.characters['a'].y }).toEqual(layoutB.chairBySurface['a']);
  });

  it('rescues a leaver whose roster entry reappears within a tick (flicker)', () => {
    let s = run(createSim(), [entry('a', 'ws-1')], 30_000);
    s = stepSim(s, [], LAYOUT, 100, rng);
    expect(s.characters['a'].phase).toBe('leaving');
    s = stepSim(s, [entry('a', 'ws-1')], LAYOUT, 100, rng);
    expect(s.characters['a'].phase).not.toBe('leaving');
    s = run(s, [entry('a', 'ws-1')], 30_000);
    expect(s.characters['a'].phase).toBe('atDesk');
    expect({ x: s.characters['a'].x, y: s.characters['a'].y }).toEqual(LAYOUT.chairBySurface['a']);
  });

  it('never stands on furniture after the layout regenerates mid-walk', () => {
    const wsA = [{ id: wid('ws-1'), title: 'Alpha' }];
    const layoutA = buildLayout(wsA, [{ surfaceId: 'a', workspaceId: wid('ws-1') }]);
    // Mid-walk: spawned at the door, a second of walking, still en route.
    let s = runWith(createSim(), [entry('a', 'ws-1')], layoutA, 1_000);
    expect(s.characters['a'].phase).toBe('walkingToDesk');
    // The office regenerates larger; old coordinates now carry other furniture.
    const wsB = [...wsA, { id: wid('ws-2'), title: 'Beta' }];
    const layoutB = buildLayout(wsB, [
      { surfaceId: 'a', workspaceId: wid('ws-1') },
      ...Array.from({ length: 6 }, (_, i) => ({ surfaceId: `x${i}`, workspaceId: wid('ws-2') })),
    ]);
    const roster = [entry('a', 'ws-1'), ...Array.from({ length: 6 }, (_, i) => entry(`x${i}`, 'ws-2'))];
    for (let t = 0; t < 60_000; t += 100) {
      s = stepSim(s, roster, layoutB, 100, rng);
      const ch = s.characters['a'];
      expect(isBlocked(layoutB, Math.round(ch.x), Math.round(ch.y)), `tick ${t}: at ${ch.x},${ch.y}`).toBe(false);
    }
    expect(s.characters['a'].phase).toBe('atDesk');
    expect({ x: s.characters['a'].x, y: s.characters['a'].y }).toEqual(layoutB.chairBySurface['a']);
  });

  it('does not mutate previous state (rule 9)', () => {
    const s0 = stepSim(createSim(), [entry('a', 'ws-1')], LAYOUT, 100, rng);
    const frozen = JSON.stringify(s0);
    stepSim(s0, [entry('a', 'ws-1', { state: 'blocked' })], LAYOUT, 100, rng);
    expect(JSON.stringify(s0)).toBe(frozen);
  });
});
