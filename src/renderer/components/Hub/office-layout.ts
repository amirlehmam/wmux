/**
 * Procedural office layout for the agent hub — pure, no React, no DOM.
 *
 * One desk table per workspace (desks grow with agent count, wrapping into
 * extra desk rows past 6), a break room, a door, decorations, all flowed into
 * a tile grid that grows band by band as workspaces are added. There is no
 * layout editor and no persistence on purpose: the office is derived from the
 * live workspace list every time, so a new workspace IS a new table.
 *
 * Geometry contract the simulation relies on (unit-tested):
 * - every chair, break seat and the door are walkable and 4-connected;
 * - the tile directly above a chair is its desk (blocked);
 * - `planPath` returns axis-aligned compressed waypoints that never cross a
 *   blocked tile;
 * - decorations never break any of the above (blocking ones claim only tiles
 *   that leave the corridors connected; wall dressing sits on wall tiles).
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
  /** Tile rect of the FIRST desk row; further desk rows sit 2 tiles apart. */
  x: number;
  y: number;
  w: number;
  deskRows: number;
  /** Total desks — the last row may be ragged. */
  deskCount: number;
}

export type DecorationKind = 'plant' | 'bookshelf' | 'cooler' | 'window' | 'painting' | 'rug';

export interface Decoration {
  kind: DecorationKind;
  x: number;
  y: number;
  /** Only rugs span more than one tile. */
  w?: number;
  h?: number;
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
  decorations: Decoration[];
}

const TABLES_PER_ROW = 2;
/** Desks per table row before wrapping into another row. */
const DESKS_PER_TABLE_ROW = 6;
const BREAK_ROOM_CONTENT_W = 6;

interface Block {
  contentW: number;
  blockH: number;
  deskRows: number;
  deskCount: number;
  workspace: LayoutWorkspace | null; // null = the break room block
}

export function buildLayout(workspaces: LayoutWorkspace[], agents: LayoutAgent[]): OfficeLayout {
  const agentsByWorkspace: Record<string, LayoutAgent[]> = {};
  for (const agent of agents) {
    (agentsByWorkspace[agent.workspaceId] ??= []).push(agent);
  }

  // The break room is simply the last block in the flow.
  const blocks: Block[] = workspaces.map((workspace) => {
    const deskCount = Math.max(2, agentsByWorkspace[workspace.id]?.length ?? 0);
    const deskRows = Math.ceil(deskCount / DESKS_PER_TABLE_ROW);
    return {
      contentW: Math.min(deskCount, DESKS_PER_TABLE_ROW),
      blockH: 2 + deskRows * 2, // margin + (desk row + chair row) per wrap + corridor
      deskRows,
      deskCount,
      workspace,
    };
  });
  blocks.push({ contentW: BREAK_ROOM_CONTENT_W, blockH: 4, deskRows: 0, deskCount: 0, workspace: null });

  const bands: Block[][] = [];
  for (let i = 0; i < blocks.length; i += TABLES_PER_ROW) {
    bands.push(blocks.slice(i, i + TABLES_PER_ROW));
  }

  // Block width = content + a margin column on each side.
  const bandWidth = (band: Block[]): number => band.reduce((w, b) => w + b.contentW + 2, 0);
  const cols = 2 + Math.max(...bands.map(bandWidth));

  const bandHeights = bands.map((band) => Math.max(...band.map((b) => b.blockH)));
  const rows = bandHeights.reduce((a, b) => a + b, 0) + 2;

  const blocked = new Uint8Array(cols * rows);
  const block = (x: number, y: number) => { blocked[y * cols + x] = 1; };
  const blockedAt = (x: number, y: number) => blocked[y * cols + x] === 1;
  for (let x = 0; x < cols; x++) { block(x, 0); block(x, rows - 1); }
  for (let y = 0; y < rows; y++) { block(0, y); block(cols - 1, y); }

  const tables: TablePlacement[] = [];
  const chairBySurface: Record<string, Point> = {};
  let breakRoom = { x: 0, y: 0, w: 0, h: 0 };
  const breakSeats: Point[] = [];

  let bandY = 1; // first row after the top wall is the band's margin row
  bands.forEach((band, bandIdx) => {
    let bx = 1;
    for (const b of band) {
      const deskY = bandY + 1;
      const contentX = bx + 1;
      if (b.workspace) {
        tables.push({
          workspaceId: b.workspace.id,
          title: b.workspace.title,
          x: contentX,
          y: deskY,
          w: b.contentW,
          deskRows: b.deskRows,
          deskCount: b.deskCount,
        });
        for (let r = 0; r < b.deskRows; r++) {
          const desksInRow = Math.min(DESKS_PER_TABLE_ROW, b.deskCount - r * DESKS_PER_TABLE_ROW);
          for (let i = 0; i < desksInRow; i++) block(contentX + i, deskY + r * 2);
        }
        const wsAgents = agentsByWorkspace[b.workspace.id] ?? [];
        wsAgents.forEach((agent, i) => {
          chairBySurface[agent.surfaceId] = {
            x: contentX + (i % DESKS_PER_TABLE_ROW),
            y: deskY + 1 + Math.floor(i / DESKS_PER_TABLE_ROW) * 2,
          };
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
    bandY += bandHeights[bandIdx];
  });

  const door: Point = { x: Math.floor(cols / 2), y: bandY - 1 };

  // ── Decorations ─────────────────────────────────────────────────────────────
  // Deterministic dressing. Blocking pieces claim only corridor-endpoint tiles
  // (corners of the interior), which cannot cut any chair or seat off — the
  // reachability tests hold that promise.
  const decorations: Decoration[] = [];
  for (let x = 3; x < cols - 3; x += 6) decorations.push({ kind: 'window', x, y: 0 });
  if (door.x + 3 < cols - 1) decorations.push({ kind: 'painting', x: door.x + 3, y: rows - 1 });

  const placeBlocking = (kind: DecorationKind, x: number, y: number) => {
    if (blockedAt(x, y)) return;
    if (x === door.x && y === door.y) return;
    block(x, y);
    decorations.push({ kind, x, y });
  };
  placeBlocking('bookshelf', 1, 1);
  placeBlocking('cooler', cols - 2, 1);
  placeBlocking('plant', 1, rows - 2);
  placeBlocking('plant', cols - 2, rows - 2);

  // Rug under the break seats — cosmetic floor, never blocked.
  decorations.push({ kind: 'rug', x: breakRoom.x, y: breakRoom.y + 1, w: 4, h: 1 });

  return { cols, rows, blocked, tables, chairBySurface, breakRoom, breakSeats, door, decorations };
}

/** Out of bounds counts as blocked. */
export function isBlocked(layout: OfficeLayout, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= layout.cols || y >= layout.rows) return true;
  return layout.blocked[y * layout.cols + x] === 1;
}

/**
 * BFS over 4-neighbour walkable tiles, compressed to direction-change
 * waypoints (final tile always included). `[]` when from === to, either end is
 * blocked, or the goal is unreachable. Grids here are tiny (a few thousand
 * tiles) and paths are planned only on state transitions, so plain BFS beats
 * corridor bookkeeping on both simplicity and correctness.
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
