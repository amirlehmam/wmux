# Agent Office Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-window overlay that renders every agent in the window as a pixel-art character in a tiny office: one table per workspace, characters work/block/rest/leave based on declared agent state, with hover stats, click-to-focus, and answer-from-hub.

**Architecture:** Pure logic (layout generator, character simulation, sprite data) in three testable modules under `src/renderer/components/Hub/`; one React component (`HubView.tsx`) owns the canvas, rAF loop and DOM tooltip/popover; wiring follows the AgentNavigator overlay pattern (App.tsx mount + CustomEvent + shortcut) and the `diff.refresh` CLI pattern (`wmux hub`).

**Tech Stack:** TypeScript strict, React 19, Zustand (read-only consumption), Canvas 2D, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-agent-office-hub-design.md`

## Global Constraints

- No new npm dependencies. No PixiJS, no sprite PNG files: sprites are string pixel maps in TS.
- The hub costs nothing while closed: component unmounted, no timers, no rAF.
- Immutable update patterns; no mutation of store data. Files under ~800 lines.
- No `console.log` in production code.
- Data source is `rollupAgents` only (declared state, issue #128). Never invent agent state.
- Answering uses `window.wmux.agentState.answer`; answering never clears blocked (the agent confirms).
- i18n: every user-visible string via `useT()` with English fallback; add keys to `en.ts` only (other locales fall back).
- All tests via `npx vitest run <file>`; full suite `npm test`; typecheck via `npm run build:main` + `npx vite build`.
- Commit style: Conventional Commits, single line, no co-author.

---

### Task 1: Sprite data + rasterizer (`sprites.ts`)

**Files:**
- Create: `src/renderer/components/Hub/sprites.ts`
- Test: `tests/unit/hub-sprites.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SpriteMap { w: number; h: number; rows: string[] }` — `rows.length === h`, every row `length === w`, chars are palette roles or `'.'` (transparent).
  - `const BODY_FRAMES: Record<BodyKind, Record<FrameName, string[]>>` where `type BodyKind = 'human' | 'cat'` and `type FrameName = 'stand-down' | 'stand-up' | 'stand-side' | 'walk-down-0' | 'walk-down-1' | 'walk-up-0' | 'walk-up-1' | 'walk-side-0' | 'walk-side-1' | 'sit-up-0' | 'sit-up-1' | 'sit-still' | 'rest-0' | 'rest-1'`.
  - `const FURNITURE: Record<'desk' | 'chair' | 'couch' | 'coffee' | 'door' | 'plant', string[]>` — couch is 32 wide (2 tiles), everything else 16x16.
  - `const VARIANTS: Array<{ body: BodyKind; palette: Record<string, string> }>` — at least 8 variants (>=6 human palettes, >=2 cat palettes).
  - `function frameSize(rows: string[]): { w: number; h: number }`
  - `function validateFrame(rows: string[], palette: Record<string, string>): string | null` — returns an error message or null; checks non-empty, rectangular, every non-`.` char present in palette.
  - `function variantFor(surfaceId: string): number` — FNV-1a hash of the id modulo `VARIANTS.length` (stable across sessions).
  - `function rasterize(rows: string[], palette: Record<string, string>): HTMLCanvasElement` — 1 canvas px per pixel; ONLY function touching the DOM, never imported by tests.

Human frames are 10 wide x 14 tall; cat frames are 12 wide x 10 tall. Palette roles used by body frames: `o` outline, `s` skin/fur, `h` hair/ears, `t` top/torso, `l` legs, `f` feet, `e` eye. Furniture uses its own literal-color palette `FURNITURE_PALETTE` with roles `w` wood, `d` wood-dark, `m` metal, `c` cushion, `x` accent, `g` glass, `k` dark.

Example frame, exact format (human `stand-down`):

```ts
const HUMAN_STAND_DOWN = [
  '...hhhh...',
  '..hhhhhh..',
  '..hssssh..',
  '..sesse s.'.replace(' ', 's'), // NOTE: write rows as plain strings; this line is literally '..sessess.'
  '..ssssss..',
  '...ssss...',
  '..tttttt..',
  '.sttttttts',
  '.sttttttts',
  '..tttttt..',
  '...llll...',
  '...l..l...',
  '...l..l...',
  '..ff..ff..',
];
```

(The `.replace` above is illustrative of what NOT to do — author every row as a plain literal string. The eye row is `'..sessess.'` style: two `e` pixels inside the face.)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/hub-sprites.test.ts
import { describe, it, expect } from 'vitest';
import {
  BODY_FRAMES, FURNITURE, VARIANTS, FURNITURE_PALETTE,
  frameSize, validateFrame, variantFor,
} from '../../src/renderer/components/Hub/sprites';

const FRAME_NAMES = [
  'stand-down', 'stand-up', 'stand-side',
  'walk-down-0', 'walk-down-1', 'walk-up-0', 'walk-up-1', 'walk-side-0', 'walk-side-1',
  'sit-up-0', 'sit-up-1', 'sit-still', 'rest-0', 'rest-1',
] as const;

describe('sprite data integrity', () => {
  it('every body ships every required frame', () => {
    for (const body of ['human', 'cat'] as const) {
      for (const name of FRAME_NAMES) {
        expect(BODY_FRAMES[body][name], `${body}/${name}`).toBeDefined();
      }
    }
  });

  it('every frame is rectangular and uses only palette roles', () => {
    for (const variant of VARIANTS) {
      for (const name of FRAME_NAMES) {
        const rows = BODY_FRAMES[variant.body][name];
        expect(validateFrame(rows, variant.palette), `${variant.body}/${name}`).toBeNull();
      }
    }
  });

  it('bodies have consistent dimensions across frames', () => {
    for (const body of ['human', 'cat'] as const) {
      const sizes = new Set(FRAME_NAMES.map((n) => JSON.stringify(frameSize(BODY_FRAMES[body][n]))));
      expect(sizes.size, body).toBe(1);
    }
  });

  it('furniture validates against the furniture palette and is tile-sized', () => {
    for (const [name, rows] of Object.entries(FURNITURE)) {
      expect(validateFrame(rows, FURNITURE_PALETTE), name).toBeNull();
      const { w, h } = frameSize(rows);
      expect(h, name).toBe(16);
      expect(w % 16, name).toBe(0);
    }
  });

  it('has at least 8 variants and both bodies', () => {
    expect(VARIANTS.length).toBeGreaterThanOrEqual(8);
    expect(VARIANTS.some((v) => v.body === 'cat')).toBe(true);
  });

  it('variantFor is stable and in range', () => {
    const a = variantFor('surf-1234');
    expect(a).toBe(variantFor('surf-1234'));
    for (const id of ['a', 'surf-x', 'surf-00000000-0000-0000-0000-000000000000']) {
      const v = variantFor(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(VARIANTS.length);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/hub-sprites.test.ts`
Expected: FAIL — cannot resolve `../../src/renderer/components/Hub/sprites`.

- [ ] **Step 3: Implement `sprites.ts`**

Implement the interfaces above. Helper functions:

```ts
export function frameSize(rows: string[]): { w: number; h: number } {
  return { w: rows[0]?.length ?? 0, h: rows.length };
}

export function validateFrame(rows: string[], palette: Record<string, string>): string | null {
  if (!rows.length || !rows[0].length) return 'empty frame';
  const w = rows[0].length;
  for (let y = 0; y < rows.length; y++) {
    if (rows[y].length !== w) return `row ${y} width ${rows[y].length} != ${w}`;
    for (const ch of rows[y]) {
      if (ch !== '.' && !(ch in palette)) return `unknown role '${ch}' in row ${y}`;
    }
  }
  return null;
}

export function variantFor(surfaceId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < surfaceId.length; i++) {
    h ^= surfaceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % VARIANTS.length;
}

export function rasterize(rows: string[], palette: Record<string, string>): HTMLCanvasElement {
  const { w, h } = frameSize(rows);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      if (ch === '.') continue;
      ctx.fillStyle = palette[ch];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}
```

Author the pixel art: human body 10x14 (all 14 frames — walk frames alternate leg positions, `sit-up-*` are back views with arms on the desk edge alternating, `sit-still` back view arms down, `rest-*` a seated front view with a steam/coffee pixel toggling), cat body 12x10 (same frame names; sitting cat loaf for `sit-*`, curled for `rest-*`). Side frames face LEFT (the renderer mirrors for right). Human palettes: vary `s` (skin tones), `h` (hair colors), `t` (shirt colors) across at least 6 variants; cat palettes: 2+ fur colors. Furniture (16x16 unless noted): `desk` wood top with `d` shading and front panel, `chair` small seat with back, `couch` 32x16 cushioned bench, `coffee` machine with `x` accent light and `g` pot, `door` framed with `k` gap and handle, `plant` pot + leaves (leaves may reuse `x`). `FURNITURE_PALETTE` example values: `w:'#8a6b48', d:'#6e5237', m:'#7a8087', c:'#b0563e', x:'#4caf6e', g:'#bcd6e4', k:'#2a2320'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/hub-sprites.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Hub/sprites.ts tests/unit/hub-sprites.test.ts
git commit -m "feat(hub): add pixel sprite data and rasterizer"
```

---

### Task 2: Office layout generator (`office-layout.ts`)

**Files:**
- Create: `src/renderer/components/Hub/office-layout.ts`
- Test: `tests/unit/office-layout.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (standalone pure module).
- Produces:

```ts
export interface Point { x: number; y: number }
export interface LayoutWorkspace { id: string; title: string }
export interface LayoutAgent { surfaceId: string; workspaceId: string }
export interface TablePlacement {
  workspaceId: string; title: string;
  x: number; y: number; w: number; // tile rect of the desk row (h is 1)
}
export interface OfficeLayout {
  cols: number; rows: number;
  blocked: Uint8Array;                       // cols*rows, index y*cols+x, 1 = not walkable
  tables: TablePlacement[];
  chairBySurface: Record<string, Point>;     // walkable tile directly below the desk
  breakRoom: { x: number; y: number; w: number; h: number };
  breakSeats: Point[];                       // walkable tiles (>= 4)
  door: Point;                               // walkable tile on the bottom corridor
}
export function buildLayout(workspaces: LayoutWorkspace[], agents: LayoutAgent[]): OfficeLayout;
export function isBlocked(layout: OfficeLayout, x: number, y: number): boolean; // out of bounds counts as blocked
export function planPath(layout: OfficeLayout, from: Point, to: Point): Point[];
// BFS over 4-neighbour walkable tiles, waypoints compressed to direction changes,
// excludes `from`, ends exactly at `to`. [] when from===to or unreachable.
```

Layout algorithm (deterministic, no RNG):
- Constants: `TABLES_PER_ROW = 2`, side margin 1 tile of wall (`x=0`, `x=cols-1`, `y=0`, `y=rows-1` all blocked).
- Each workspace table block: desk count `D = max(2, agentsInWorkspace)`. Desk row of `D` desk tiles (blocked). Chair row below it (walkable, chairs assigned left-to-right in the agents' array order). Below that a corridor row (walkable). One margin row above the desk row. Block width `D + 2` (1 margin column each side), block height 4.
- Blocks flow left-to-right, `TABLES_PER_ROW` per band, then wrap to the next band. Band height 4. Column x positions accumulate per band (tables in one band can have different widths).
- Break room: placed as the final block in the flow, footprint 8 wide x 3 tall inside its band: couch (2 tiles, blocked) at its top-left, coffee machine (1 tile, blocked) at its top-right, plant (1 blocked tile) beside the coffee machine; `breakSeats` = the 4+ walkable tiles below the couch and beside it.
- `cols` = max band width + 2; `rows` = 1 + bands*4 + 1 bottom corridor row + 1. Door on the bottom wall's corridor row at the horizontal center: `door = { x: floor(cols/2), y: rows-2 }`.
- Guarantee: every chair, break seat and the door are walkable and 4-connected to each other (the margin columns and corridor rows provide this by construction).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/office-layout.test.ts
import { describe, it, expect } from 'vitest';
import { buildLayout, isBlocked, planPath } from '../../src/renderer/components/Hub/office-layout';
import type { LayoutAgent, LayoutWorkspace, OfficeLayout, Point } from '../../src/renderer/components/Hub/office-layout';

const wss = (n: number): LayoutWorkspace[] =>
  Array.from({ length: n }, (_, i) => ({ id: `ws-${i}`, title: `WS ${i}` }));
const agents = (perWs: number[], _ignored?: unknown): LayoutAgent[] =>
  perWs.flatMap((count, w) =>
    Array.from({ length: count }, (_, i) => ({ surfaceId: `surf-${w}-${i}`, workspaceId: `ws-${w}` })));

const walkableAndReachable = (layout: OfficeLayout, p: Point, label: string) => {
  expect(isBlocked(layout, p.x, p.y), `${label} blocked`).toBe(false);
  const path = planPath(layout, layout.door, p);
  if (p.x !== layout.door.x || p.y !== layout.door.y) {
    expect(path.length, `${label} unreachable from door`).toBeGreaterThan(0);
    expect(path[path.length - 1], label).toEqual(p);
  }
};

describe('buildLayout', () => {
  it('creates one table per workspace, in workspace order', () => {
    const layout = buildLayout(wss(3), agents([1, 2, 0]));
    expect(layout.tables.map((t) => t.workspaceId)).toEqual(['ws-0', 'ws-1', 'ws-2']);
  });

  it('assigns every agent a chair below a desk tile of its workspace table', () => {
    const layout = buildLayout(wss(2), agents([2, 3]));
    for (const [id, chair] of Object.entries(layout.chairBySurface)) {
      const w = id.split('-')[1];
      const table = layout.tables.find((t) => t.workspaceId === `ws-${w}`)!;
      expect(chair.y).toBe(table.y + 1);
      expect(chair.x).toBeGreaterThanOrEqual(table.x);
      expect(chair.x).toBeLessThan(table.x + table.w);
      expect(isBlocked(layout, chair.x, chair.y)).toBe(false);
      expect(isBlocked(layout, chair.x, chair.y - 1)).toBe(true); // the desk itself
    }
  });

  it('desk count grows with agents: 5 agents in one workspace fit', () => {
    const layout = buildLayout(wss(1), agents([5]));
    expect(Object.keys(layout.chairBySurface)).toHaveLength(5);
    const xs = Object.values(layout.chairBySurface).map((c) => c.x);
    expect(new Set(xs).size).toBe(5); // no shared chairs
  });

  it('door, chairs and break seats are walkable and mutually reachable', () => {
    const layout = buildLayout(wss(5), agents([2, 1, 3, 0, 1]));
    walkableAndReachable(layout, layout.door, 'door');
    for (const [id, chair] of Object.entries(layout.chairBySurface)) walkableAndReachable(layout, chair, id);
    expect(layout.breakSeats.length).toBeGreaterThanOrEqual(4);
    for (const seat of layout.breakSeats) walkableAndReachable(layout, seat, 'break seat');
  });

  it('grows rows as workspaces are added, and stays bounded', () => {
    const small = buildLayout(wss(1), []);
    const big = buildLayout(wss(9), []);
    expect(big.rows).toBeGreaterThan(small.rows);
    expect(big.cols * big.rows).toBeLessThan(4000); // sanity: no runaway grid
  });

  it('outer border is walled', () => {
    const layout = buildLayout(wss(2), agents([1, 1]));
    for (let x = 0; x < layout.cols; x++) {
      expect(isBlocked(layout, x, 0)).toBe(true);
      expect(isBlocked(layout, x, layout.rows - 1)).toBe(true);
    }
    for (let y = 0; y < layout.rows; y++) {
      expect(isBlocked(layout, 0, y)).toBe(true);
      expect(isBlocked(layout, layout.cols - 1, y)).toBe(true);
    }
  });
});

describe('planPath', () => {
  it('returns [] for same start and goal, and for a blocked goal', () => {
    const layout = buildLayout(wss(1), agents([1]));
    expect(planPath(layout, layout.door, layout.door)).toEqual([]);
    expect(planPath(layout, layout.door, { x: 0, y: 0 })).toEqual([]);
  });

  it('never routes through a blocked tile', () => {
    const layout = buildLayout(wss(4), agents([3, 2, 1, 2]));
    const chair = Object.values(layout.chairBySurface)[0];
    const path = planPath(layout, layout.door, chair);
    // expand compressed waypoints back into steps and check each tile
    let cur = layout.door;
    for (const wp of path) {
      const dx = Math.sign(wp.x - cur.x), dy = Math.sign(wp.y - cur.y);
      expect(Math.abs(dx) + Math.abs(dy)).toBe(1); // axis-aligned segments only
      while (cur.x !== wp.x || cur.y !== wp.y) {
        cur = { x: cur.x + dx, y: cur.y + dy };
        expect(isBlocked(layout, cur.x, cur.y)).toBe(false);
      }
    }
    expect(cur).toEqual(chair);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/office-layout.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `office-layout.ts`**

Implement per the algorithm above. BFS sketch (complete logic, adapt freely):

```ts
export function planPath(layout: OfficeLayout, from: Point, to: Point): Point[] {
  if (from.x === to.x && from.y === to.y) return [];
  if (isBlocked(layout, to.x, to.y) || isBlocked(layout, from.x, from.y)) return [];
  const { cols, rows } = layout;
  const prev = new Int32Array(cols * rows).fill(-1);
  const start = from.y * cols + from.x;
  const goal = to.y * cols + to.x;
  prev[start] = start;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (cur === goal) break;
    const cx = cur % cols, cy = (cur / cols) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (isBlocked(layout, nx, ny)) continue;
      const ni = ny * cols + nx;
      if (prev[ni] !== -1) continue;
      prev[ni] = cur;
      queue.push(ni);
    }
  }
  if (prev[goal] === -1) return [];
  const tiles: Point[] = [];
  for (let cur = goal; cur !== start; cur = prev[cur]) tiles.push({ x: cur % cols, y: (cur / cols) | 0 });
  tiles.reverse();
  // compress to direction-change waypoints, always keeping the final tile
  const out: Point[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const a = i === 0 ? from : tiles[i - 1];
    const b = tiles[i];
    const c = tiles[i + 1];
    if (!c || Math.sign(c.x - b.x) !== Math.sign(b.x - a.x) || Math.sign(c.y - b.y) !== Math.sign(b.y - a.y)) {
      out.push(b);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/office-layout.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Hub/office-layout.ts tests/unit/office-layout.test.ts
git commit -m "feat(hub): add procedural office layout generator"
```

---

### Task 3: Character simulation (`office-sim.ts`)

**Files:**
- Create: `src/renderer/components/Hub/office-sim.ts`
- Test: `tests/unit/office-sim.test.ts`

**Interfaces:**
- Consumes: `OfficeLayout`, `Point`, `planPath`, `buildLayout` (test only) from `./office-layout`.
- Produces:

```ts
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
  x: number; y: number;               // tile coords, fractional while walking
  path: Point[];                      // remaining compressed waypoints
  phase: CharacterPhase;
  facing: 'up' | 'down' | 'left' | 'right';
  rosterState: SimRosterEntry['state'];
  bubble: Bubble;
  dwellMs: number;
  animClock: number;                  // ms, drives frame selection in the renderer
  chatUntil: number | null;           // simTime ms
  peerId: string | null;
  breakSeat: Point | null;
}
export interface SimState {
  simTime: number;                    // ms since sim creation
  characters: Record<string, Character>;
  overflow: number;                   // roster entries beyond MAX_CHARACTERS
}
export const MAX_CHARACTERS = 64;
export const SPEED_TILES_PER_SEC = 4;
export const HANDOFF_WINDOW_MS = 5000;
export const CHAT_DURATION_MS = 2000;
export function createSim(): SimState;
export function stepSim(
  prev: SimState,
  roster: SimRosterEntry[],
  layout: OfficeLayout,
  dtMs: number,
  rng: () => number,
): SimState;
```

Behavior contract (each numbered rule gets at least one test):

1. New roster entry -> character spawns at `layout.door` in `walkingToDesk` with a path to its chair.
2. Character whose roster entry disappeared -> `leaving` with a path to the door; once it arrives, it is removed from `characters`.
3. Roster state `blocked`/`working`/`unknown` -> goal is the chair; `idle` -> goal is a break seat (chosen with `rng` from `layout.breakSeats`).
4. At the chair (`atDesk`), `bubble` is `'exclaim'` when `state === 'blocked' && !answerPending`, `'hourglass'` when `blocked && answerPending`, else `'none'`. `facing` is `'up'`.
5. Movement advances along `path` at `SPEED_TILES_PER_SEC * dtMs / 1000` tiles, consuming waypoints; `facing` follows the current segment direction; arrival snaps to the waypoint.
6. Handoff: when a character transitions working->idle, and within `HANDOFF_WINDOW_MS` (before OR after, while the idler has not yet reached the break room) another character of the SAME workspace transitions from not-working to `working`, the idler walks to a tile adjacent to the starter's chair (`walkingToPeer`), both show `bubble: 'chat'` while `chatting` for `CHAT_DURATION_MS`, then the idler continues to the break room and the starter's bubble returns to rule-4 behavior. A starter that disappears or a peer tile that is unreachable cancels the handoff (straight to break).
7. If the layout changed a character's chair (workspace grew), a deskbound character re-paths to the new chair.
8. Roster entries beyond `MAX_CHARACTERS` (in roster order) get no character; `overflow` reports how many.
9. `stepSim` never mutates `prev` or `roster` (new objects on every change).
10. `dwellMs` and `rosterState` are copied fresh from the roster every tick.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/office-sim.test.ts
import { describe, it, expect } from 'vitest';
import { buildLayout } from '../../src/renderer/components/Hub/office-layout';
import {
  createSim, stepSim, MAX_CHARACTERS, HANDOFF_WINDOW_MS, CHAT_DURATION_MS,
} from '../../src/renderer/components/Hub/office-sim';
import type { SimRosterEntry, SimState } from '../../src/renderer/components/Hub/office-sim';

const rng = () => 0.5;
const entry = (id: string, ws: string, over: Partial<SimRosterEntry> = {}): SimRosterEntry => ({
  surfaceId: id, workspaceId: ws, state: 'working', answerPending: false, dwellMs: 0, ...over,
});
const LAYOUT = buildLayout(
  [{ id: 'ws-1', title: 'Alpha' }, { id: 'ws-2', title: 'Beta' }],
  [
    { surfaceId: 'a', workspaceId: 'ws-1' }, { surfaceId: 'b', workspaceId: 'ws-1' },
    { surfaceId: 'c', workspaceId: 'ws-2' },
  ],
);
/** Run the sim for `ms` in 100ms ticks with an unchanged roster. */
const run = (state: SimState, roster: SimRosterEntry[], ms: number): SimState => {
  for (let t = 0; t < ms; t += 100) state = stepSim(state, roster, LAYOUT, 100, rng);
  return state;
};

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
    const both = [entry('a', 'ws-1'), entry('b', 'ws-1', { state: 'idle' })];
    let s = run(createSim(), [entry('a', 'ws-1', { state: 'idle' }), entry('b', 'ws-1', { state: 'idle' })], 60_000);
    // b sits in the break room, a is idle too. Now a hands off: a goes idle->? No —
    // trigger: a was working then goes idle, while b starts working.
    s = run(createSim(), [entry('a', 'ws-1'), entry('b', 'ws-1', { state: 'idle' })], 60_000);
    const next = [entry('a', 'ws-1', { state: 'idle' }), entry('b', 'ws-1', { state: 'working' })];
    s = stepSim(s, next, LAYOUT, 100, rng);
    expect(s.characters['a'].phase).toBe('walkingToPeer');
    expect(s.characters['a'].peerId).toBe('b');
    s = run(s, next, 30_000);
    // chat happened (bubble seen mid-run is hard to freeze; assert the end state)
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

  it('does not mutate previous state (rule 9)', () => {
    const s0 = stepSim(createSim(), [entry('a', 'ws-1')], LAYOUT, 100, rng);
    const frozen = JSON.stringify(s0);
    stepSim(s0, [entry('a', 'ws-1', { state: 'blocked' })], LAYOUT, 100, rng);
    expect(JSON.stringify(s0)).toBe(frozen);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/office-sim.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `office-sim.ts`**

Implementation notes (write the full module):

- `stepSim` shape: clone the character map (shallow; replace changed characters with new objects), advance `simTime`, then per phase:
  1. **Reconcile roster**: build `byId` from roster (first `MAX_CHARACTERS`); spawn missing characters; mark `leaving` for absent ones (plan path to door; if already `leaving`, keep). Record transitions by comparing `ch.rosterState` to the roster state BEFORE overwriting: push `{ id, workspaceId, at: simTime }` into internal arrays `recentIdlers` / `recentStarters` kept INSIDE SimState (add both to `SimState` as `handoffIdlers: Array<{ id: string; ws: string; at: number }>` and `handoffStarters: same`); prune entries older than `HANDOFF_WINDOW_MS`. (Adding these two fields to `SimState` is expected; keep them out of the Character type.)
  2. **Handoff matching**: for each idler currently in `walkingToBreak` (or just transitioned), find the newest starter with the same `ws`, different id, within the window; on a match set idler phase `walkingToPeer`, `peerId`, path to an adjacent walkable tile of the starter's chair (try the 4 neighbours with `planPath`, first non-empty wins; all empty -> cancel). Remove both from the pending arrays.
  3. **Goal check**: for non-leaving characters whose goal tile changed (chair moved, or state flipped between deskbound/idle), re-plan. Deskbound = `blocked|working|unknown` -> chair; `idle` -> `breakSeat` (pick once with `rng` when becoming idle, keep in `ch.breakSeat`).
  4. **Move**: advance `SPEED_TILES_PER_SEC * dt / 1000` tiles toward `path[0]`; on reaching it (distance < step), snap and shift; empty path -> arrival: `walkingToDesk`->`atDesk`, `walkingToBreak`->`resting`, `walkingToPeer`->`chatting` (set `chatUntil = simTime + CHAT_DURATION_MS`, set own and peer's `bubble = 'chat'`), `leaving`-> delete.
  5. **Chat expiry**: `chatting && simTime >= chatUntil` -> `walkingToBreak` with path to `breakSeat`; clear both chat bubbles (peer's bubble recomputed next step by rule 4 anyway).
  6. **Bubbles + anim**: recompute `bubble` for `atDesk` per rule 4 (chat overrides while `chatting`); `animClock += dt` on every character.
- `facing`: derive from the active segment (`dx>0`->'right' etc.); at desk 'up'; resting 'down'.
- Keep every helper (`goalFor`, `arrive`, `advance`) module-private. No DOM, no Date.now — time only via accumulated `dtMs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/office-sim.test.ts` — Expected: PASS. Also re-run Task 2 tests (`npx vitest run tests/unit/office-layout.test.ts`) to catch interface drift.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Hub/office-sim.ts tests/unit/office-sim.test.ts
git commit -m "feat(hub): add character simulation with handoff heuristic"
```

---

### Task 4: Expose agent metadata to the roster (type-only)

**Files:**
- Modify: `src/renderer/store/agent-rollup.ts` (interfaces + `rosterEntryFor`)
- Test: `tests/unit/agent-rollup.test.ts` (append cases)

**Interfaces:**
- Consumes: existing `DeclaredAgentSnapshot`, `AgentRosterEntry`, `rosterEntryFor` internals.
- Produces:

```ts
export interface DeclaredAgentMetadata {
  model?: string;
  tokens?: string;
  contextPct?: number;
  expiresAt?: number;   // wall-clock ms; stale metadata must not render
}
// DeclaredAgentSnapshot gains:  metadata?: DeclaredAgentMetadata;
// AgentRosterEntry gains:       metadata: DeclaredAgentMetadata | null;
```

The runtime payload already carries `metadata` (main's `AgentStateSnapshot` in `src/main/agent-state.ts` sends it; `AgentStatePayload extends DeclaredAgentSnapshot` stores it verbatim) — this task only types it and passes it through.

- [ ] **Step 1: Append failing tests to `tests/unit/agent-rollup.test.ts`**

Add inside the existing `describe('rollupAgents', ...)` block, using the file's existing `ws`/`leaf`/`declared` helpers and `NOW` constant:

```ts
  it('passes live metadata through to the roster entry', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'working', metadata: { model: 'opus', tokens: '12.3k', contextPct: 41 } }),
    }, NOW);
    expect(out.roster[0].metadata).toEqual({ model: 'opus', tokens: '12.3k', contextPct: 41 });
  });

  it('drops metadata past its expiresAt', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'working', metadata: { model: 'opus', expiresAt: NOW - 1 } }),
    }, NOW);
    expect(out.roster[0].metadata).toBeNull();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/agent-rollup.test.ts`
Expected: FAIL — TS error (`metadata` not on `DeclaredAgentSnapshot`) or `metadata` undefined.

- [ ] **Step 3: Implement**

In `agent-rollup.ts`: add the `DeclaredAgentMetadata` interface; add `metadata?: DeclaredAgentMetadata;` to `DeclaredAgentSnapshot` (with a doc comment noting main TTL-stamps `expiresAt` and consumers must honor it); add `metadata: DeclaredAgentMetadata | null;` to `AgentRosterEntry`; in `rosterEntryFor`'s returned object add:

```ts
    metadata: liveMetadata(declared?.metadata, now),
```

and the helper:

```ts
/** Metadata is a claim with a shelf life — render nothing rather than a stale token count. */
function liveMetadata(
  meta: DeclaredAgentMetadata | undefined,
  now: number,
): DeclaredAgentMetadata | null {
  if (!meta) return null;
  if (typeof meta.expiresAt === 'number' && meta.expiresAt <= now) return null;
  return meta;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/agent-rollup.test.ts` — Expected: PASS (all existing cases too).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/agent-rollup.ts tests/unit/agent-rollup.test.ts
git commit -m "feat(hub): expose declared agent metadata in the roster"
```

---

### Task 5: HubView component + stylesheet

**Files:**
- Create: `src/renderer/components/Hub/HubView.tsx`
- Create: `src/renderer/styles/hub.css`

**Interfaces:**
- Consumes: `rollupAgents`, `AgentRosterEntry` (with `metadata` from Task 4), `formatDwell` from `../Sidebar/AgentRosterBanner`, `buildLayout`/`planPath` types from `./office-layout`, `createSim`/`stepSim` from `./office-sim`, `BODY_FRAMES`/`FURNITURE`/`VARIANTS`/`FURNITURE_PALETTE`/`variantFor`/`rasterize` from `./sprites`, store hooks like AgentNavigator, `useT`.
- Produces: `export default function HubView({ onClose, onFocusAgent }: { onClose: () => void; onFocusAgent?: (entry: AgentRosterEntry) => void })` — the exact prop shape AgentNavigator has, so App.tsx mounts it identically.

No unit test (rendering-only; all behavior lives in Tasks 1-3). Manual verification in Task 8.

- [ ] **Step 1: Implement `HubView.tsx`**

Full component structure (write it out; ~350 lines):

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { rollupAgents } from '../../store/agent-rollup';
import type { AgentRosterEntry } from '../../store/agent-rollup';
import { formatDwell } from '../Sidebar/AgentRosterBanner';
import { buildLayout } from './office-layout';
import type { OfficeLayout } from './office-layout';
import { createSim, stepSim } from './office-sim';
import type { Character, SimRosterEntry, SimState } from './office-sim';
import { BODY_FRAMES, FURNITURE, FURNITURE_PALETTE, VARIANTS, rasterize, variantFor } from './sprites';
import '../../styles/hub.css';

const TILE = 16;
const SIM_STEP_MS = 100;

interface Popover { surfaceId: string; screenX: number; screenY: number }

export default function HubView({ onClose, onFocusAgent }: {
  onClose: () => void;
  onFocusAgent?: (entry: AgentRosterEntry) => void;
}) { ... }
```

Required behavior, in order:

1. **Store + rollup**: identical subscription block to `AgentNavigator.tsx:51-63` (workspaces, agentStates, agentIdentities, agentDetections, 1 s `now` tick, `rollupAgents` in a `useMemo`).
2. **Layout**: `const layout = useMemo(() => buildLayout(workspaces.map(w => ({ id: w.id, title: w.title })), rollup.roster.map(e => ({ surfaceId: e.surfaceId, workspaceId: e.workspaceId }))), [workspaces, rollup])`.
3. **Sprite cache**: `useMemo` building `Record<string, HTMLCanvasElement>` — for each variant index and frame name, `rasterize(BODY_FRAMES[v.body][frame], v.palette)` keyed `` `${vi}:${frame}` ``; furniture keyed by name. Built once per mount (deps `[]`).
4. **Sim in refs**: `const simRef = useRef<SimState>(createSim());` plus `rosterRef`/`layoutRef` refs updated by an effect whenever rollup/layout change (the rAF loop must read fresh data without re-subscribing). Map `rollup.roster` to `SimRosterEntry[]` (surfaceId, workspaceId, state, answerPending, dwellMs).
5. **rAF loop** (one `useEffect` with `[]` deps): accumulate elapsed ms; `while (acc >= SIM_STEP_MS) simRef.current = stepSim(simRef.current, rosterRef.current, layoutRef.current, SIM_STEP_MS, Math.random)`; then draw. Cancel on unmount. `rng` is `Math.random` here — determinism only matters in tests.
6. **Canvas sizing**: canvas fills the dialog; on mount and on `resize`, set `canvas.width/height` to `clientWidth/Height * devicePixelRatio`. Compute `scale = Math.max(1, Math.floor(Math.min(widthPx / (layout.cols * TILE), heightPx / (layout.rows * TILE))))`; if the integer scale is 0 use the fractional fit. Center the office (`offsetX/offsetY`). `ctx.imageSmoothingEnabled = false`.
7. **Draw** (plain function `draw(ctx, sim, layout, sprites, rollupBySurface, t)`): floor as two alternating fill colors per tile; wall border tiles as a dark fill; per table: desk sprites along the desk row, workspace title centered above in a small monospace label (`ctx.fillText`, background plaque rect); break room: couch (2 tiles) + coffee + plant sprites; door sprite at `layout.door` on the wall below; characters sorted by `y` (painter's order): pick frame by phase — `walkingTo*`/`leaving`: `walk-{dir}-{0|1}` by `Math.floor(animClock / 200) % 2` (side frames mirrored via `ctx.save(); ctx.scale(-1, 1)` when facing right); `atDesk` working: `sit-up-{0|1}` (250 ms alternation); `atDesk` blocked/unknown: `sit-still`; `resting`: `rest-{0|1}` (600 ms); bubbles: rounded-rect white bubble with tail above the head, glyph `!` (red, pulsing scale `1 + 0.15 * Math.sin(animClock / p)` where `p` is 300 for dwell > 5 min, 500 for > 1 min, 800 otherwise), `⏳` approximated as an hourglass drawn from two triangles or the text glyph, chat `…`; overflow: if `sim.overflow > 0` draw a sign near the door `+N`.
8. **Hit-testing**: on `mousemove` over the canvas, convert to tile coords ((px - offsetX) / (scale * TILE)); find the character whose 1x1.5-tile rect contains the point; `setHover(surfaceId | null)` — also store the character's screen px position for the tooltip. On `click`: hovered character + its rollup entry; if `entry.state === 'blocked'` -> `setPopover({ surfaceId, screenX, screenY })`; else `onFocusAgent?.(entry); onClose();`.
9. **Tooltip** (hover, no popover open): absolutely positioned div near the character showing `label`, `kind`, state + `formatDwell(dwellMs)` when blocked, and when `metadata` is non-null: model / tokens / `contextPct`% rows. All labels through `t()` with fallbacks (`t('hub.model', 'model')` etc.).
10. **Popover** (blocked click): div with `blockedReason ?? t('hub.needsYou', 'Needs your input')`, one button per `choices` entry calling:

```tsx
const answer = useCallback(async (surfaceId: string, choiceId: string) => {
  const entry = rollup.roster.find((e) => e.surfaceId === surfaceId);
  try {
    const res = await (window as any).wmux?.agentState?.answer?.(surfaceId, choiceId);
    if (!res?.ok && entry) { onFocusAgent?.(entry); onClose(); }  // same fallback as WorkspaceRow
  } catch { if (entry) { onFocusAgent?.(entry); onClose(); } }
  setPopover(null);
}, [rollup, onFocusAgent, onClose]);
```

    plus a "go to pane" button (`focus + close`). No declared choices -> only reason + go-to-pane.
11. **Keys/backdrop**: root is `<div className="hub__backdrop" onClick={onClose} role="presentation">` wrapping `<div className="hub" role="dialog" aria-label={t('hub.title', 'Agent office')} onClick={e => e.stopPropagation()} onKeyDown={...} tabIndex={-1} ref={el => el?.focus()}>`; Escape closes popover first, then the overlay. A header row shows the title and totals (`{working} working · {blocked} need you`) and a close button. When `rollup.totals.total === 0`, still render the office (empty desks) with a centered hint `t('hub.empty', 'No agents running — the office is quiet.')`.

- [ ] **Step 2: Write `src/renderer/styles/hub.css`**

Follow `agent-navigator.css` conventions (check its tokens first and reuse the same `var(--...)` custom properties it uses for backdrop/panel/border colors). Classes: `.hub__backdrop` (fixed, full-window, backdrop blur/dim, z-index matching agent-nav), `.hub` (95vw/90vh panel, flex column), `.hub__header`, `.hub__canvas-wrap` (relative, flex-1, overflow hidden), `.hub__canvas` (width/height 100%, `image-rendering: pixelated`), `.hub__tooltip` (absolute, pointer-events none, small mono panel), `.hub__popover` (absolute panel with buttons), `.hub__popover-choice` (button), `.hub__empty-hint` (centered overlay text).

- [ ] **Step 3: Typecheck**

Run: `npx vite build` (renderer typecheck+build). Expected: builds clean. Fix any type errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Hub/HubView.tsx src/renderer/styles/hub.css
git commit -m "feat(hub): add HubView canvas overlay component"
```

---

### Task 6: Wire the overlay — App mount, shortcut, labels, locale

**Files:**
- Modify: `src/renderer/App.tsx` (state ~line 443, listener effect ~line 1023, mount ~line 1373, import ~line 17)
- Modify: `src/renderer/store/settings-slice.ts` (action union ~line 158, defaults ~line 272)
- Modify: `src/renderer/hooks/useKeyboardShortcuts.ts` (action map ~line 360)
- Modify: `src/renderer/components/Settings/KeyboardSettings.tsx` (ACTION_LABELS ~line 42, CATEGORY ~line 98)
- Modify: `src/renderer/i18n/locales/en.ts` (near `'shortcutAction.openAgentNavigator'`, ~line 332)

**Interfaces:**
- Consumes: `HubView` default export from Task 5.
- Produces: ShortcutAction `'openHub'`, CustomEvent name `'wmux:open-hub'` (Task 7 depends on this exact string), locale keys `shortcutAction.openHub`, `hub.*`.

- [ ] **Step 1: Add the shortcut action**

`settings-slice.ts`: after `| 'openAgentNavigator'` add `| 'openHub'`; after the `openAgentNavigator:` default add:

```ts
  // Ctrl+Shift+O was unbound; shift-modified like the batch above so bare
  // Ctrl+O keeps going to the terminal.
  openHub:                { key: 'o', ctrl: true, shift: true },
```

`useKeyboardShortcuts.ts`: after the `openAgentNavigator` entry add:

```ts
      openHub: () => fire('wmux:open-hub'),
```

`KeyboardSettings.tsx`: in `ACTION_LABELS` after `openAgentNavigator` add `openHub: 'Agent office',`; in `CATEGORY` extend the Agents line to `jumpToBlocked: 'Agents', openAgentNavigator: 'Agents', openHub: 'Agents',`.

`en.ts`: next to `'shortcutAction.openAgentNavigator'` add:

```ts
  'shortcutAction.openHub': 'Agent office',
```

and (grouped with the other feature blocks, e.g. after the agentNavigator keys):

```ts
  // ─── Agent office hub ───
  'hub.title': 'Agent office',
  'hub.empty': 'No agents running — the office is quiet.',
  'hub.needsYou': 'Needs your input',
  'hub.goToPane': 'Go to pane',
  'hub.model': 'model',
  'hub.tokens': 'tokens',
  'hub.context': 'context',
  'hub.workingCount': '{count} working',
  'hub.blockedCount': '{count} need you',
```

(If HubView from Task 5 used different key names, reconcile to THESE names in both places.)

- [ ] **Step 2: Mount in App.tsx**

Import: `import HubView from './components/Hub/HubView';` beside the AgentNavigator import. State beside `agentNavigatorOpen`:

```ts
  const [hubOpen, setHubOpen] = useState(false);
```

Listener, immediately after the agent-navigator listener effect (same comment style applies — the shortcut hook cannot reach this component's state):

```ts
  useEffect(() => {
    const open = () => setHubOpen(true);
    document.addEventListener('wmux:open-hub', open);
    return () => document.removeEventListener('wmux:open-hub', open);
  }, []);
```

Mount, directly after the `{agentNavigatorOpen && (...)}` block:

```tsx
      {hubOpen && (
        <HubView
          onClose={() => setHubOpen(false)}
          onFocusAgent={focusAgent}
        />
      )}
```

- [ ] **Step 3: Verify existing shortcut/i18n completeness tests still pass**

Run: `npx vitest run tests/unit/index-shortcuts.test.ts tests/unit/shortcut-binding.test.ts tests/unit/key-remaps.test.ts tests/unit/i18n.test.ts tests/unit/i18n-translator.test.ts`
Expected: PASS. If a completeness assertion fails (an action list somewhere enumerates all ShortcutActions), add `openHub` there in the same pattern as `openAgentNavigator` — never weaken the test.

- [ ] **Step 4: Typecheck + build**

Run: `npm run build:main` then `npx vite build`. Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/store/settings-slice.ts src/renderer/hooks/useKeyboardShortcuts.ts src/renderer/components/Settings/KeyboardSettings.tsx src/renderer/i18n/locales/en.ts
git commit -m "feat(hub): wire office overlay with Ctrl+Shift+O shortcut"
```

---

### Task 7: `wmux hub` CLI command

**Files:**
- Modify: `src/renderer/pipe-bridge.ts` (beside `__wmux_getMarkdownContent`, ~line 416)
- Modify: `src/main/v2-bridge.ts` (SPECS table, after `'notification.list'`, ~line 199)
- Modify: `src/cli/wmux.ts` (COMMAND_SPECS after `diff:` ~line 1599; COMMANDS after `diff:` ~line 1850; `printUsage` after the Diff line ~line 1931)

**Interfaces:**
- Consumes: the `'wmux:open-hub'` CustomEvent listener from Task 6.
- Produces: V2 method `hub.open`, CLI command `wmux hub`.

- [ ] **Step 1: Renderer bridge global** (`pipe-bridge.ts`)

```ts
  // Open the agent office overlay (CLI `wmux hub`). Same CustomEvent relay the
  // agent navigator uses — App.tsx owns the overlay's open state.
  w.__wmux_openHub = () => {
    document.dispatchEvent(new CustomEvent('wmux:open-hub'));
    return { ok: true };
  };
```

- [ ] **Step 2: V2 method** (`v2-bridge.ts` SPECS)

```ts
  'hub.open': {
    js: () => `window.__wmux_openHub?.()`,
  },
```

- [ ] **Step 3: CLI** (`cli/wmux.ts`)

COMMAND_SPECS: `hub: { usage: 'wmux hub   (open the agent office overlay)' },`
COMMANDS: `hub: async () => print(await sendV2('hub.open')),`
printUsage: add a line beside Diff: `Hub:        hub   (open the agent office overlay)`

- [ ] **Step 4: Run CLI/pipe tests**

Run: `npx vitest run tests/unit/cli-subcommands.test.ts tests/unit/pipe-server.test.ts tests/unit/caller-scope.test.ts`
Expected: PASS (COMMAND_SPECS/COMMANDS stay compile-time-linked via `CommandName`; a parity test failure means one of the two tables is missing the entry).

- [ ] **Step 5: Build + commit**

Run: `npm run build:main` — Expected: clean.

```bash
git add src/renderer/pipe-bridge.ts src/main/v2-bridge.ts src/cli/wmux.ts
git commit -m "feat(hub): add wmux hub CLI command"
```

---

### Task 8: Full verification

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `npm test` — Expected: all pass. Fix regressions without weakening tests.

- [ ] **Step 2: Lint**

Run: `npm run lint` — Expected: clean for changed files.

- [ ] **Step 3: Full build**

Run: `npm run build:main && npx vite build` — Expected: clean.

- [ ] **Step 4: Manual smoke test (report, do not skip)**

Without touching a possibly-running wmux instance's files: run `npm run dev` in this repo (Vite on 5199 + its own Electron), then in the dev window: open the hub via Ctrl+Shift+O; confirm the empty-office hint; start `claude` in a pane, confirm a character walks in and types; check hover tooltip; trigger a permission prompt, confirm the `!` bubble and the answer popover; close the pane, confirm the character leaves. If a second wmux is already running and `npm run dev` conflicts (pipe name collision), report that limitation instead of killing anything — the unit suite plus build is the acceptance floor.

- [ ] **Step 5: Final commit if anything changed**

```bash
git add -A && git commit -m "test(hub): verification fixes"
```

---

## Self-review notes (completed)

- Spec coverage: mounting/open paths (T6, T7), data layer + metadata typing (T4), rendering/sprites (T1, T5), office model (T2), sim + handoff + caps (T3), interactivity (T5), performance-by-unmount (T5/T6), testing (T1-T4, T8). Layout editor, sounds, real handoff signal: explicitly out of scope per spec §8.
- Type consistency: `SimRosterEntry` fields match `AgentRosterEntry` names (surfaceId, workspaceId, state, answerPending, dwellMs); HubView props match AgentNavigator's; CustomEvent name `'wmux:open-hub'` used identically in T6 and T7; locale keys defined once in T6 and referenced in T5 (reconciliation step included).
- Known judgment calls left to the implementer: exact pixel art rows (mechanically validated by T1's tests), CSS token names (mirror agent-navigator.css), draw-order details.
