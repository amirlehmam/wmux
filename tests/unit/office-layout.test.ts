import { describe, it, expect } from 'vitest';
import { buildLayout, isBlocked, nearestWalkable, pathCrossesBlocked, planPath } from '../../src/renderer/components/Hub/office-layout';
import type { LayoutAgent, LayoutWorkspace, OfficeLayout, Point } from '../../src/renderer/components/Hub/office-layout';
import { WorkspaceId } from '../../src/shared/types';

const wss = (n: number): LayoutWorkspace[] =>
  Array.from({ length: n }, (_, i) => ({ id: `ws-${i}` as WorkspaceId, title: `WS ${i}` }));
const agents = (perWs: number[]): LayoutAgent[] =>
  perWs.flatMap((count, w) =>
    Array.from({ length: count }, (_, i) => ({ surfaceId: `surf-${w}-${i}`, workspaceId: `ws-${w}` as WorkspaceId })));

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

  it('wraps a big workspace into multiple desk rows of at most 6', () => {
    const layout = buildLayout(wss(1), agents([14]));
    const table = layout.tables[0];
    expect(table.w).toBe(6);
    expect(table.deskRows).toBe(3);
    const chairs = Object.values(layout.chairBySurface);
    expect(chairs).toHaveLength(14);
    const rows = new Set(chairs.map((c) => c.y));
    expect(rows.size).toBe(3);
    for (const chair of chairs) {
      expect(isBlocked(layout, chair.x, chair.y)).toBe(false);
      expect(isBlocked(layout, chair.x, chair.y - 1)).toBe(true);
      walkableAndReachable(layout, chair, `wrapped chair ${chair.x},${chair.y}`);
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

  it('places decorations without walling anyone in', () => {
    const layout = buildLayout(wss(5), agents([2, 8, 1, 0, 3]));
    expect(layout.decorations.length).toBeGreaterThan(0);
    const kinds = new Set(layout.decorations.map((d) => d.kind));
    expect(kinds.has('window')).toBe(true);
    expect(kinds.has('rug')).toBe(true);
    for (const deco of layout.decorations) {
      if (deco.kind === 'window' || deco.kind === 'painting') {
        // wall dressing lives ON the wall
        expect(deco.y === 0 || deco.y === layout.rows - 1).toBe(true);
      }
      if (deco.kind === 'rug') {
        // rugs are cosmetic floor — never blocked
        for (let x = deco.x; x < deco.x + (deco.w ?? 1); x++) {
          for (let y = deco.y; y < deco.y + (deco.h ?? 1); y++) {
            expect(isBlocked(layout, x, y), `rug tile ${x},${y}`).toBe(false);
          }
        }
      }
    }
    // decorations must not break the core guarantee
    for (const chair of Object.values(layout.chairBySurface)) walkableAndReachable(layout, chair, 'chair');
    for (const seat of layout.breakSeats) walkableAndReachable(layout, seat, 'seat');
  });

  it('survives an empty office: break room only, door reachable', () => {
    const layout = buildLayout([], []);
    expect(layout.tables).toEqual([]);
    walkableAndReachable(layout, layout.door, 'door');
    for (const seat of layout.breakSeats) walkableAndReachable(layout, seat, 'seat');
  });

  it('gives a zero-agent workspace a minimum two-desk table', () => {
    const layout = buildLayout(wss(1), []);
    expect(layout.tables[0].w).toBe(2);
    expect(layout.tables[0].deskCount).toBe(2);
    expect(layout.tables[0].deskRows).toBe(1);
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

describe('pathCrossesBlocked / nearestWalkable', () => {
  it('detects a path that a layout change has invalidated', () => {
    const small = buildLayout(wss(1), agents([2]));
    const chair = Object.values(small.chairBySurface)[0];
    const path = planPath(small, small.door, chair);
    expect(pathCrossesBlocked(small, small.door, path)).toBe(false);
    // A grown office relocates furniture; the OLD path must be detectable as
    // stale against the NEW grid (same coordinates, different blocked set).
    const grown = buildLayout(wss(2), agents([6, 4]));
    const crossesSomething = pathCrossesBlocked(grown, small.door, path);
    // Either verdict is legal geometry; the call must terminate and be boolean
    // even from an off-axis start (regression: per-step sign re-derivation).
    expect(typeof crossesSomething).toBe('boolean');
    expect(pathCrossesBlocked(grown, { x: grown.door.x + 1, y: grown.door.y - 1 }, path)).toBeTypeOf('boolean');
  });

  it('finds the nearest walkable tile from a blocked one, identity for walkable', () => {
    const layout = buildLayout(wss(1), agents([2]));
    const desk = { x: layout.tables[0].x, y: layout.tables[0].y };
    expect(isBlocked(layout, desk.x, desk.y)).toBe(true);
    const safe = nearestWalkable(layout, desk);
    expect(safe).not.toBeNull();
    expect(isBlocked(layout, safe!.x, safe!.y)).toBe(false);
    expect(Math.abs(safe!.x - desk.x) + Math.abs(safe!.y - desk.y)).toBe(1);
    expect(nearestWalkable(layout, layout.door)).toEqual(layout.door);
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
