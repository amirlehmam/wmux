/**
 * Character simulation for the agent office — pure, fixed-timestep, no DOM.
 *
 * One dumb state machine per agent: walk in, sit and type, wave a "!" bubble
 * when blocked, take a break when idle, walk out when the pane closes. Time
 * only ever comes in through `dtMs` (no Date.now), randomness through the
 * injected `rng`, so every behavior is unit-testable and deterministic.
 *
 * The handoff walk is a HEURISTIC and allowed to be wrong (spec §5): a
 * character that just stopped working visits a same-workspace character that
 * just started, chats briefly, then heads to the break room. It is cosmetic —
 * wmux has no real handoff signal.
 */
import { OfficeLayout, Point, isBlocked, nearestWalkable, pathCrossesBlocked, planPath } from './office-layout';

export interface SimRosterEntry {
  surfaceId: string;
  workspaceId: string;
  state: 'blocked' | 'working' | 'idle' | 'unknown';
  answerPending: boolean;
  dwellMs: number;
}

export type CharacterPhase =
  | 'walkingToDesk' | 'atDesk' | 'walkingToBreak' | 'resting'
  | 'walkingToPeer' | 'chatting' | 'leaving';

export type Bubble = 'none' | 'exclaim' | 'hourglass' | 'chat';

export interface Character {
  surfaceId: string;
  workspaceId: string;
  /** Tile coords, fractional while walking. */
  x: number;
  y: number;
  /** Remaining compressed waypoints (axis-aligned segments). */
  path: Point[];
  phase: CharacterPhase;
  facing: 'up' | 'down' | 'left' | 'right';
  rosterState: SimRosterEntry['state'];
  bubble: Bubble;
  dwellMs: number;
  /** ms, drives frame selection in the renderer. */
  animClock: number;
  /** simTime at which a chat ends. */
  chatUntil: number | null;
  peerId: string | null;
  breakSeat: Point | null;
}

interface HandoffMark {
  id: string;
  ws: string;
  at: number;
}

export interface SimState {
  /** ms since sim creation, accumulated from dtMs. */
  simTime: number;
  characters: Record<string, Character>;
  /** Roster entries beyond MAX_CHARACTERS. */
  overflow: number;
  /** working→idle transitions, pruned past HANDOFF_WINDOW_MS. */
  handoffIdlers: HandoffMark[];
  /** not-working→working transitions, pruned past HANDOFF_WINDOW_MS. */
  handoffStarters: HandoffMark[];
}

// 128 characters cost the sim and canvas nothing measurable; the old layout
// bound (one desk row per table) is gone since desks wrap at 6 per row.
export const MAX_CHARACTERS = 128;
export const SPEED_TILES_PER_SEC = 4;
export const HANDOFF_WINDOW_MS = 5000;
export const CHAT_DURATION_MS = 2000;

const DESKBOUND: ReadonlySet<SimRosterEntry['state']> = new Set(['blocked', 'working', 'unknown']);

export function createSim(): SimState {
  return { simTime: 0, characters: {}, overflow: 0, handoffIdlers: [], handoffStarters: [] };
}

function pickBreakSeat(layout: OfficeLayout, rng: () => number): Point | null {
  const seats = layout.breakSeats;
  if (!seats.length) return null;
  return seats[Math.min(seats.length - 1, Math.floor(rng() * seats.length))];
}

function pathTo(layout: OfficeLayout, ch: Character, to: Point | null): Point[] {
  if (!to) return [];
  return planPath(layout, { x: Math.round(ch.x), y: Math.round(ch.y) }, to);
}

/** Where a deskbound character should be sitting; door as a last resort. */
function chairFor(layout: OfficeLayout, ch: Character): Point {
  return layout.chairBySurface[ch.surfaceId] ?? layout.door;
}

/** The end of the current walk, if any. */
function pathTarget(ch: Character): Point | null {
  return ch.path.length ? ch.path[ch.path.length - 1] : null;
}

function samePoint(a: Point | null, b: Point | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

/**
 * Send a character walking to its chair (or seat it if already there).
 * Compared on the ROUNDED tile: a character interrupted mid-walk can sit at a
 * fractional position on the chair's own tile, from which BFS plans an empty
 * path — without the snap it would hover off-grid beside its seat forever.
 */
function toDesk(layout: OfficeLayout, ch: Character): Character {
  const chair = chairFor(layout, ch);
  if (Math.round(ch.x) === chair.x && Math.round(ch.y) === chair.y) {
    return { ...ch, x: chair.x, y: chair.y, phase: 'atDesk', path: [], facing: 'up', chatUntil: null, peerId: null };
  }
  return { ...ch, phase: 'walkingToDesk', path: pathTo(layout, ch, chair), chatUntil: null, peerId: null };
}

/** Send a character walking to (or keep it at) its break seat. */
function toBreak(layout: OfficeLayout, ch: Character, rng: () => number): Character {
  let seat = ch.breakSeat;
  const seatValid = !!seat && layout.breakSeats.some((s) => s.x === seat!.x && s.y === seat!.y);
  if (!seatValid) seat = pickBreakSeat(layout, rng);
  if (!seat) return { ...ch, phase: 'resting', path: [], chatUntil: null, peerId: null };
  // Rounded-tile comparison + snap, same reasoning as toDesk.
  if (Math.round(ch.x) === seat.x && Math.round(ch.y) === seat.y) {
    return { ...ch, x: seat.x, y: seat.y, phase: 'resting', path: [], breakSeat: seat, facing: 'down', chatUntil: null, peerId: null };
  }
  return { ...ch, phase: 'walkingToBreak', path: pathTo(layout, ch, seat), breakSeat: seat, chatUntil: null, peerId: null };
}

/**
 * Advance along the waypoint path; returns the moved character and arrival
 * flag. Moves one axis at a time (dominant first) and only consumes a
 * waypoint once BOTH axes have arrived — a character that starts off-grid
 * (mid-segment replan) walks the off-axis remainder instead of teleporting.
 */
function advance(ch: Character, dtMs: number): { ch: Character; arrived: boolean } {
  if (!ch.path.length) return { ch, arrived: true };
  let remaining = (SPEED_TILES_PER_SEC * dtMs) / 1000;
  let { x, y, facing } = ch;
  const path = ch.path.slice();
  while (remaining > 0 && path.length) {
    const target = path[0];
    const dx = target.x - x;
    const dy = target.y - y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
      x = target.x;
      y = target.y;
      path.shift();
      continue;
    }
    if (Math.abs(dx) >= Math.abs(dy)) {
      facing = dx >= 0 ? 'right' : 'left';
      const step = Math.min(remaining, Math.abs(dx));
      x += Math.sign(dx) * step;
      remaining -= step;
    } else {
      facing = dy >= 0 ? 'down' : 'up';
      const step = Math.min(remaining, Math.abs(dy));
      y += Math.sign(dy) * step;
      remaining -= step;
    }
  }
  return { ch: { ...ch, x, y, facing, path }, arrived: path.length === 0 };
}

function spawn(entry: SimRosterEntry, layout: OfficeLayout): Character {
  const base: Character = {
    surfaceId: entry.surfaceId,
    workspaceId: entry.workspaceId,
    x: layout.door.x,
    y: layout.door.y,
    path: [],
    phase: 'walkingToDesk',
    facing: 'up',
    rosterState: entry.state,
    bubble: 'none',
    dwellMs: entry.dwellMs,
    animClock: 0,
    chatUntil: null,
    peerId: null,
    breakSeat: null,
  };
  return { ...base, path: pathTo(layout, base, chairFor(layout, base)) };
}

/**
 * One fixed-timestep tick. Never mutates `prev` or `roster` — every changed
 * character is a fresh object, so React refs and tests can hold snapshots.
 */
export function stepSim(
  prev: SimState,
  roster: SimRosterEntry[],
  layout: OfficeLayout,
  dtMs: number,
  rng: () => number,
): SimState {
  const simTime = prev.simTime + dtMs;
  const capped = roster.slice(0, MAX_CHARACTERS);
  const overflow = Math.max(0, roster.length - MAX_CHARACTERS);
  const byId = new Map(capped.map((e) => [e.surfaceId, e]));

  const idlers = prev.handoffIdlers.filter((m) => m.at > simTime - HANDOFF_WINDOW_MS).slice();
  const starters = prev.handoffStarters.filter((m) => m.at > simTime - HANDOFF_WINDOW_MS).slice();

  // ── Reconcile the roster: spawn, leave, record transitions, refresh facts ──
  const chars: Record<string, Character> = {};
  for (const entry of capped) {
    const existing = prev.characters[entry.surfaceId];
    if (!existing) {
      chars[entry.surfaceId] = spawn(entry, layout);
      continue;
    }
    if (existing.rosterState === 'working' && entry.state === 'idle') {
      idlers.push({ id: entry.surfaceId, ws: entry.workspaceId, at: simTime });
    }
    if (existing.rosterState !== 'working' && entry.state === 'working') {
      starters.push({ id: entry.surfaceId, ws: entry.workspaceId, at: simTime });
    }
    // A leaver whose entry reappeared (one-tick roster flicker) is rescued
    // rather than completing the walk-out and respawning from the door: reset
    // to an empty-path desk walk and let the goal check route it properly.
    chars[entry.surfaceId] = existing.phase === 'leaving'
      ? { ...existing, rosterState: entry.state, dwellMs: entry.dwellMs, phase: 'walkingToDesk', path: [] }
      : { ...existing, rosterState: entry.state, dwellMs: entry.dwellMs };
  }
  for (const [id, ch] of Object.entries(prev.characters)) {
    if (byId.has(id)) continue;
    chars[id] = ch.phase === 'leaving'
      ? { ...ch }
      : { ...ch, phase: 'leaving', path: pathTo(layout, ch, layout.door), chatUntil: null, peerId: null };
  }

  // ── Rescue + stale-path check: the layout can regenerate under a walker ────
  // Paths are planned against the layout of the tick they were created in. A
  // workspace growing can put a desk on a tile a planned path crosses, or on
  // the tile a character is standing on (from which BFS can plan nothing).
  for (const [id, ch] of Object.entries(chars)) {
    const tile = { x: Math.round(ch.x), y: Math.round(ch.y) };
    if (isBlocked(layout, tile.x, tile.y)) {
      const safe = nearestWalkable(layout, tile);
      if (safe) chars[id] = { ...ch, x: safe.x, y: safe.y, path: [] };
    }
  }
  for (const [id, ch] of Object.entries(chars)) {
    if (!ch.path.length) continue;
    const start = { x: Math.round(ch.x), y: Math.round(ch.y) };
    if (!pathCrossesBlocked(layout, start, ch.path)) continue;
    if (ch.phase === 'walkingToDesk') chars[id] = toDesk(layout, ch);
    else if (ch.phase === 'walkingToBreak') chars[id] = toBreak(layout, ch, rng);
    else if (ch.phase === 'walkingToPeer') chars[id] = toBreak(layout, ch, rng); // cancel the handoff
    else if (ch.phase === 'leaving') chars[id] = { ...ch, path: pathTo(layout, ch, layout.door) };
  }

  // ── Goal check: make each character's walk match its roster state ──────────
  for (const [id, ch] of Object.entries(chars)) {
    if (ch.phase === 'leaving') continue;
    if (DESKBOUND.has(ch.rosterState)) {
      const chair = chairFor(layout, ch);
      const deskbound = ch.phase === 'walkingToDesk' || ch.phase === 'atDesk';
      const wrongSeat = ch.phase === 'atDesk' && !(ch.x === chair.x && ch.y === chair.y);
      const wrongTarget = ch.phase === 'walkingToDesk' && !samePoint(pathTarget(ch), chair);
      if (!deskbound || wrongSeat || wrongTarget) chars[id] = toDesk(layout, ch);
    } else {
      // idle → break room, unless mid-handoff (walkingToPeer / chatting keep going)
      if (ch.phase === 'walkingToDesk' || ch.phase === 'atDesk') chars[id] = toBreak(layout, ch, rng);
      else if (ch.phase === 'walkingToBreak' || ch.phase === 'resting') {
        const seat = ch.breakSeat;
        const seatValid = !!seat && layout.breakSeats.some((s) => s.x === seat.x && s.y === seat.y);
        if (!seatValid) chars[id] = toBreak(layout, ch, rng);
      }
    }
  }

  // ── Handoff matching: pair fresh idlers with fresh same-workspace starters ─
  for (let i = idlers.length - 1; i >= 0; i--) {
    const idler = idlers[i];
    const ch = chars[idler.id];
    if (!ch || ch.phase !== 'walkingToBreak') { continue; }
    let best = -1;
    for (let j = starters.length - 1; j >= 0; j--) {
      const st = starters[j];
      if (st.ws !== idler.ws || st.id === idler.id || !chars[st.id]) continue;
      if (best === -1 || st.at > starters[best].at) best = j;
    }
    if (best === -1) continue;
    const starter = starters[best];
    const chair = chairFor(layout, chars[starter.id]);
    // Other agents' chairs are excluded — chatting while standing inside a
    // seated colleague is a step too far even for a cosmetic heuristic.
    const occupied = new Set(
      Object.entries(layout.chairBySurface)
        .filter(([sid]) => sid !== starter.id)
        .map(([, p]) => `${p.x},${p.y}`),
    );
    const neighbours: Point[] = [
      { x: chair.x, y: chair.y + 1 },
      { x: chair.x - 1, y: chair.y },
      { x: chair.x + 1, y: chair.y },
      { x: chair.x, y: chair.y - 1 },
    ];
    let matched = false;
    for (const spot of neighbours) {
      if (isBlocked(layout, spot.x, spot.y)) continue;
      if (occupied.has(`${spot.x},${spot.y}`)) continue;
      if (ch.x === spot.x && ch.y === spot.y) {
        chars[idler.id] = { ...ch, phase: 'chatting', path: [], peerId: starter.id, chatUntil: simTime + CHAT_DURATION_MS };
        matched = true;
        break;
      }
      const path = pathTo(layout, ch, spot);
      if (path.length) {
        chars[idler.id] = { ...ch, phase: 'walkingToPeer', path, peerId: starter.id, chatUntil: null };
        matched = true;
        break;
      }
    }
    if (matched) {
      idlers.splice(i, 1);
      starters.splice(best, 1);
    }
  }

  // ── Movement and arrivals ──────────────────────────────────────────────────
  const gone: string[] = [];
  for (const [id, ch0] of Object.entries(chars)) {
    let ch = { ...ch0, animClock: ch0.animClock + dtMs };
    const walking = ch.phase === 'walkingToDesk' || ch.phase === 'walkingToBreak'
      || ch.phase === 'walkingToPeer' || ch.phase === 'leaving';
    if (walking) {
      const moved = advance(ch, dtMs);
      ch = moved.ch;
      if (moved.arrived) {
        if (ch.phase === 'walkingToDesk') ch = { ...ch, phase: 'atDesk', facing: 'up' };
        else if (ch.phase === 'walkingToBreak') ch = { ...ch, phase: 'resting', facing: 'down' };
        else if (ch.phase === 'walkingToPeer') ch = { ...ch, phase: 'chatting', chatUntil: simTime + CHAT_DURATION_MS };
        else if (ch.phase === 'leaving') { gone.push(id); }
      }
    } else if (ch.phase === 'chatting') {
      const peerAlive = !!ch.peerId && !!chars[ch.peerId];
      if (!peerAlive || (ch.chatUntil !== null && simTime >= ch.chatUntil)) {
        ch = toBreak(layout, ch, rng);
      } else if (ch.peerId) {
        const peer = chars[ch.peerId];
        const dx = peer.x - ch.x;
        ch = { ...ch, facing: dx > 0.25 ? 'right' : dx < -0.25 ? 'left' : 'down' };
      }
    }
    chars[id] = ch;
  }
  for (const id of gone) delete chars[id];

  // ── Bubbles: desk states first, then chat overrides for both partners ──────
  for (const [id, ch] of Object.entries(chars)) {
    let bubble: Bubble = 'none';
    if (ch.phase === 'atDesk' && ch.rosterState === 'blocked') {
      bubble = byId.get(id)?.answerPending ? 'hourglass' : 'exclaim';
    }
    if (ch.bubble !== bubble) chars[id] = { ...ch, bubble };
  }
  for (const ch of Object.values(chars)) {
    if (ch.phase !== 'chatting') continue;
    if (ch.bubble !== 'chat') chars[ch.surfaceId] = { ...chars[ch.surfaceId], bubble: 'chat' };
    const peer = ch.peerId ? chars[ch.peerId] : null;
    if (peer && peer.bubble !== 'chat') chars[peer.surfaceId] = { ...peer, bubble: 'chat' };
  }

  return { simTime, characters: chars, overflow, handoffIdlers: idlers, handoffStarters: starters };
}
