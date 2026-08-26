/**
 * Procedural office layout for the agent hub — pure, no React, no DOM.
 *
 * One desk table per workspace (desks grow with agent count), a break room, a
 * door, all flowed into a tile grid that grows band by band as workspaces are
 * added. There is no layout editor and no persistence on purpose: the office
 * is derived from the live workspace list every time, so a new workspace IS a
 * new table.
 *
 * Geometry contract the simulation relies on (unit-tested):
 * - every chair, break seat and the door are walkable and 4-connected;
 * - the tile directly above a chair is its desk (blocked);
 * - `planPath` returns axis-aligned compressed waypoints that never cross a
 *   blocked tile.
 */

export interface Point {
  x: number;
  y: number;
}

export interface LayoutWorkspace {
  id: string;
  title: string;
}

export interface LayoutAgent {
  surfaceId: string;
  workspaceId: string;
}

export interface TablePlacement {
  workspaceId: string;
  title: string;
  /** Tile rect of the desk row (height is always 1). */
  x: number;
  y: number;
  w: number;
}

export interface OfficeLayout {
  cols: number;
  rows: number;
  /** cols*rows, index y*cols+x, 1 = not walkable. */
  blocked: Uint8Array;
  tables: TablePlacement[];
  /** Walkable tile directly below the agent's desk. */
  chairBySurface: Record<string, Point>;
  breakRoom: { x: number; y: number; w: number; h: number };
  breakSeats: Point[];
  door: Point;
}

const TABLES_PER_ROW = 2;
/** Margin row + desk row + chair row + corridor row. */
const BAND_HEIGHT = 4;
const BREAK_ROOM_CONTENT_W = 6;

interface Block {
  contentW: number;
  workspace: LayoutWorkspace | null; // null = the break room block
}

export function buildLayout(workspaces: LayoutWorkspace[], agents: LayoutAgent[]): OfficeLayout {
  const agentsByWorkspace: Record<string, LayoutAgent[]> = {};
  for (const agent of agents) {
    (agentsByWorkspace[agent.workspaceId] ??= []).push(agent);
  }

  // The break room is simply the last block in the flow.
  const blocks: Block[] = workspaces.map((workspace) => ({
    contentW: Math.max(2, agentsByWorkspace[workspace.id]?.length ?? 0),
    workspace,
  }));
  blocks.push({ contentW: BREAK_ROOM_CONTENT_W, workspace: null });

  const bands: Block[][] = [];
  for (let i = 0; i < blocks.length; i += TABLES_PER_ROW) {
    bands.push(blocks.slice(i, i + TABLES_PER_ROW));
  }

  // Block width = content + a margin column on each side.
  const bandWidth = (band: Block[]): number => band.reduce((w, b) => w + b.contentW + 2, 0);
  const cols = 2 + Math.max(...bands.map(bandWidth));
  const rows = bands.length * BAND_HEIGHT + 2;

  const blocked = new Uint8Array(cols * rows);
  const block = (x: number, y: number) => { blocked[y * cols + x] = 1; };
  for (let x = 0; x < cols; x++) { block(x, 0); block(x, rows - 1); }
  for (let y = 0; y < rows; y++) { block(0, y); block(cols - 1, y); }

  const tables: TablePlacement[] = [];
  const chairBySurface: Record<string, Point> = {};
  let breakRoom = { x: 0, y: 0, w: 0, h: 0 };
  const breakSeats: Point[] = [];

  bands.forEach((band, bandIdx) => {
    const bandY = 1 + bandIdx * BAND_HEIGHT; // margin row
    let bx = 1;
    for (const b of band) {
      const deskY = bandY + 1;
      const contentX = bx + 1;
      if (b.workspace) {
        tables.push({ workspaceId: b.workspace.id, title: b.workspace.title, x: contentX, y: deskY, w: b.contentW });
        for (let i = 0; i < b.contentW; i++) block(contentX + i, deskY);
        const wsAgents = agentsByWorkspace[b.workspace.id] ?? [];
        wsAgents.forEach((agent, i) => {
          chairBySurface[agent.surfaceId] = { x: contentX + i, y: deskY + 1 };
        });
      } else {
        // Couch (2 tiles), a gap, coffee machine, plant — seats on the row below.
        breakRoom = { x: contentX, y: deskY, w: b.contentW, h: 2 };
        block(contentX, deskY); block(contentX + 1, deskY);        // couch
        block(contentX + 3, deskY);                                 // coffee
        block(contentX + 4, deskY);                                 // plant
        for (let i = 0; i < 4; i++) breakSeats.push({ x: contentX + i, y: deskY + 1 });
      }
      bx += b.contentW + 2;
    }
  });

  const door: Point = { x: Math.floor(cols / 2), y: rows - 2 };

  return { cols, rows, blocked, tables, chairBySurface, breakRoom, breakSeats, door };
}

/** Out of bounds counts as blocked. */
export function isBlocked(layout: OfficeLayout, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= layout.cols || y >= layout.rows) return true;
  return layout.blocked[y * layout.cols + x] === 1;
}

/**
 * BFS over 4-neighbour walkable tiles, compressed to direction-change
 * waypoints (final tile always included). `[]` when from === to, either end is
 * blocked, or the goal is unreachable. Grids here are tiny (< 4000 tiles) and
 * paths are planned only on state transitions, so plain BFS beats corridor
 * bookkeeping on both simplicity and correctness.
 */
export function planPath(layout: OfficeLayout, from: Point, to: Point): Point[] {
  if (from.x === to.x && from.y === to.y) return [];
  if (isBlocked(layout, to.x, to.y) || isBlocked(layout, from.x, from.y)) return [];
  const { cols } = layout;
  const prev = new Int32Array(cols * layout.rows).fill(-1);
  const start = from.y * cols + from.x;
  const goal = to.y * cols + to.x;
  prev[start] = start;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (cur === goal) break;
    const cx = cur % cols;
    const cy = (cur / cols) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (isBlocked(layout, nx, ny)) continue;
      const ni = ny * cols + nx;
      if (prev[ni] !== -1) continue;
      prev[ni] = cur;
      queue.push(ni);
    }
  }
  if (prev[goal] === -1) return [];

  const tiles: Point[] = [];
  for (let cur = goal; cur !== start; cur = prev[cur]) {
    tiles.push({ x: cur % cols, y: (cur / cols) | 0 });
  }
  tiles.reverse();

  const out: Point[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const a = i === 0 ? from : tiles[i - 1];
    const b = tiles[i];
    const c = tiles[i + 1];
    if (!c
      || Math.sign(c.x - b.x) !== Math.sign(b.x - a.x)
      || Math.sign(c.y - b.y) !== Math.sign(b.y - a.y)) {
      out.push(b);
    }
  }
  return out;
}
