/**
 * The agent office — a full-window overlay that renders every agent in the
 * window as a pixel character. Watch + jump + answer: hover for model/stats,
 * click a character to focus its pane, click a blocked character to answer
 * its declared choices via the #128 back-channel, click a table to switch to
 * its workspace.
 *
 * All behavior lives in the pure modules beside this file (layout, sim,
 * sprites, camera) — this component only owns the canvas, the rAF loop and
 * the DOM tooltip/popover. Unmounted means gone: no timers, no rAF, no sim
 * state, so a closed hub costs nothing.
 *
 * Rendering is fixed-timestep-interpolated: the sim ticks at 10 Hz, and each
 * frame draws characters between their previous and current sim positions,
 * so walking is display-rate smooth while the sim stays deterministic.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { rollupAgents } from '../../store/agent-rollup';
import type { AgentRosterEntry } from '../../store/agent-rollup';
import { formatDwell } from '../Sidebar/AgentRosterBanner';
import { WorkspaceId } from '../../../shared/types';
import { buildLayout } from './office-layout';
import type { OfficeLayout, TablePlacement } from './office-layout';
import { createSim, stepSim } from './office-sim';
import type { Character, SimRosterEntry, SimState } from './office-sim';
import { BODY_FRAMES, FURNITURE, FURNITURE_PALETTE, VARIANTS, rasterize, variantFor } from './sprites';
import type { FrameName } from './sprites';
import { MIN_SCALE, MAX_ZOOM, computeCamera, fitZoom, zoomAt } from './camera';
import type { CameraView } from './camera';
import '../../styles/hub.css';

const TILE = 16;
const SIM_STEP_MS = 100;
/** Cap wasted work between frames after a long throttle (hidden window). */
const MAX_ACCUM_MS = 2000;
/** Pointer travel past this many px is a pan, not a click. */
const DRAG_THRESHOLD_PX = 4;

const FLOOR_A = '#3a3f4a';
const FLOOR_B = '#3f4450';
const WALL = '#23262e';
const RUG = '#584a38';
const RUG_EDGE = '#4a3e2f';
const PLAQUE_BG = 'rgba(20, 22, 28, 0.75)';
const PLAQUE_TEXT = '#c8cede';
const TABLE_HIGHLIGHT = 'rgba(255, 255, 255, 0.85)';
const TABLE_HIGHLIGHT_FILL = 'rgba(255, 255, 255, 0.08)';

interface HoverInfo {
  surfaceId: string;
  sx: number;
  sy: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  moved: boolean;
}

// Keyed frame tables instead of template-string casts: the compiler proves
// every entry is a real FrameName, so a renamed sprite frame fails the build
// here instead of silently drawing nothing.
const WALK_FRAMES: Record<'up' | 'down' | 'side', [FrameName, FrameName]> = {
  up: ['walk-up-0', 'walk-up-1'],
  down: ['walk-down-0', 'walk-down-1'],
  side: ['walk-side-0', 'walk-side-1'],
};
const TYPE_FRAMES: [FrameName, FrameName] = ['sit-up-0', 'sit-up-1'];
const REST_FRAMES: [FrameName, FrameName] = ['rest-0', 'rest-1'];

function frameFor(ch: Character): { name: FrameName; mirror: boolean } {
  const mirror = ch.facing === 'right';
  switch (ch.phase) {
    case 'walkingToDesk':
    case 'walkingToBreak':
    case 'walkingToPeer':
    case 'leaving': {
      const dir = ch.facing === 'up' ? 'up' : ch.facing === 'down' ? 'down' : 'side';
      return { name: WALK_FRAMES[dir][Math.floor(ch.animClock / 200) % 2], mirror };
    }
    case 'atDesk':
      if (ch.rosterState === 'working') {
        return { name: TYPE_FRAMES[Math.floor(ch.animClock / 250) % 2], mirror: false };
      }
      return { name: 'sit-still', mirror: false };
    case 'resting':
      return { name: REST_FRAMES[Math.floor(ch.animClock / 600) % 2], mirror: false };
    case 'chatting':
      return ch.facing === 'down'
        ? { name: 'stand-down', mirror: false }
        : { name: 'stand-side', mirror };
    default:
      return { name: 'stand-down', mirror: false };
  }
}

function bubblePulsePeriod(dwellMs: number): number {
  if (dwellMs > 5 * 60_000) return 300;
  if (dwellMs > 60_000) return 500;
  return 800;
}

/** Tile rect a table occupies for hover/click: plaque row through last chair row. */
function tableRect(table: TablePlacement): { x: number; y: number; w: number; h: number } {
  return { x: table.x, y: table.y - 1, w: table.w, h: 2 * table.deskRows + 1 };
}

export default function HubView({ onClose, onFocusAgent }: {
  onClose: () => void;
  onFocusAgent?: (entry: AgentRosterEntry) => void;
}) {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const agentStates = useStore((s) => s.agentStates);
  const agentIdentities = useStore((s) => s.agentIdentities);
  const agentDetections = useStore((s) => s.agentDetections);
  const [now, setNow] = useState(() => Date.now());
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [popover, setPopover] = useState<HoverInfo | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus ONCE on mount. An inline `ref={(el) => el?.focus()}` callback gets a
  // new identity every render, so React re-runs it — and this component
  // re-renders every second — which would steal focus from the popover's
  // buttons continuously.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const rollup = useMemo(
    () => rollupAgents(workspaces, agentStates, now, agentIdentities, agentDetections),
    [workspaces, agentStates, agentIdentities, agentDetections, now],
  );

  // Keyed on a stable projection, not on `rollup` itself: rollup's identity
  // changes every second (dwell tick) while the office geometry only changes
  // when a workspace or an agent appears, disappears, or is renamed.
  const layoutKey = useMemo(
    () => workspaces.map((w) => `${w.id}:${w.title}`).join('|')
      + '||' + rollup.roster.map((e) => `${e.surfaceId}:${e.workspaceId}`).join('|'),
    [workspaces, rollup],
  );
  const layout = useMemo(
    () => buildLayout(
      workspaces.map((w) => ({ id: w.id, title: w.title })),
      rollup.roster.map((e) => ({ surfaceId: e.surfaceId, workspaceId: e.workspaceId })),
    ),
    // layoutKey IS the projection of both inputs; when it is unchanged, the
    // values the body reads are geometrically equivalent.
    [layoutKey],
  );

  // Rasterize every sprite once per mount. Keyed `${variantIdx}:${frame}`.
  const sprites = useMemo(() => {
    const out: Record<string, HTMLCanvasElement> = {};
    VARIANTS.forEach((variant, vi) => {
      for (const [name, rows] of Object.entries(BODY_FRAMES[variant.body])) {
        out[`${vi}:${name}`] = rasterize(rows, variant.palette);
      }
    });
    for (const [name, rows] of Object.entries(FURNITURE)) {
      out[name] = rasterize(rows, FURNITURE_PALETTE);
    }
    return out;
  }, []);

  // The rAF loop reads through refs so it never needs to re-subscribe.
  const simRef = useRef<SimState>(createSim());
  const prevSimRef = useRef<SimState>(simRef.current);
  const alphaRef = useRef(0);
  const layoutRef = useRef<OfficeLayout>(layout);
  const rosterRef = useRef<SimRosterEntry[]>([]);
  const rollupRef = useRef(rollup);
  // zoom === null → auto-fit; a wheel gesture pins it until the hub reopens.
  const cameraRef = useRef<{ zoom: number | null; panX: number; panY: number }>({ zoom: null, panX: 0, panY: 0 });
  const viewRef = useRef<CameraView>({ zoom: MIN_SCALE, offX: 0, offY: 0, panX: 0, panY: 0, pannableX: false, pannableY: false });
  const hoverRef = useRef<HoverInfo | null>(null);
  const hoverTableRef = useRef<TablePlacement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  layoutRef.current = layout;
  rollupRef.current = rollup;
  rosterRef.current = rollup.roster.map((e) => ({
    surfaceId: e.surfaceId,
    workspaceId: e.workspaceId,
    state: e.state,
    answerPending: e.answerPending,
    dwellMs: e.dwellMs,
  }));

  // Dwell labels and metadata expiry move on their own; everything else is
  // event-driven. Only mounted while open, so the interval dies with the hub.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;

    const frame = (ts: number) => {
      acc = Math.min(acc + (ts - last), MAX_ACCUM_MS);
      last = ts;
      while (acc >= SIM_STEP_MS) {
        prevSimRef.current = simRef.current;
        simRef.current = stepSim(simRef.current, rosterRef.current, layoutRef.current, SIM_STEP_MS, Math.random);
        acc -= SIM_STEP_MS;
      }
      alphaRef.current = acc / SIM_STEP_MS;
      draw();
      raf = requestAnimationFrame(frame);
    };

    const draw = () => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = wrap.clientWidth;
      const cssH = wrap.clientHeight;
      if (!cssW || !cssH) return;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const lay = layoutRef.current;
      const sim = simRef.current;
      const prev = prevSimRef.current;
      const alpha = alphaRef.current;

      const officeW = lay.cols * TILE;
      const officeH = lay.rows * TILE;
      const zoom = cameraRef.current.zoom ?? fitZoom(cssW, cssH, officeW, officeH);
      const view = computeCamera({
        viewW: cssW, viewH: cssH, officeW, officeH,
        zoom, panX: cameraRef.current.panX, panY: cameraRef.current.panY,
      });
      cameraRef.current.panX = view.panX;
      cameraRef.current.panY = view.panY;
      viewRef.current = view;

      // Cursor lives here so pan/hover changes need no React round-trip.
      wrap.style.cursor = hoverRef.current || hoverTableRef.current
        ? 'pointer'
        : dragRef.current?.moved
          ? 'grabbing'
          : view.pannableX || view.pannableY ? 'grab' : 'default';

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, cssW, cssH);

      const scale = view.zoom;
      const px = (tx: number) => view.offX + tx * TILE * scale;
      const py = (ty: number) => view.offY + ty * TILE * scale;
      const ts = TILE * scale;

      // Floor + walls
      for (let y = 0; y < lay.rows; y++) {
        for (let x = 0; x < lay.cols; x++) {
          const wall = x === 0 || y === 0 || x === lay.cols - 1 || y === lay.rows - 1;
          ctx.fillStyle = wall ? WALL : (x + y) % 2 === 0 ? FLOOR_A : FLOOR_B;
          ctx.fillRect(px(x), py(y), ts, ts);
        }
      }

      // Decorations: rugs are floor, everything else is furniture-level.
      for (const deco of lay.decorations) {
        if (deco.kind !== 'rug') continue;
        const w = (deco.w ?? 1) * ts;
        const h = (deco.h ?? 1) * ts;
        ctx.fillStyle = RUG_EDGE;
        ctx.fillRect(px(deco.x), py(deco.y), w, h);
        ctx.fillStyle = RUG;
        ctx.fillRect(px(deco.x) + 2 * scale, py(deco.y) + 2 * scale, w - 4 * scale, h - 4 * scale);
      }
      for (const deco of lay.decorations) {
        if (deco.kind === 'rug') continue;
        ctx.drawImage(sprites[deco.kind], px(deco.x), py(deco.y), ts, ts);
      }

      // Door sits in the bottom wall, under the door tile of the corridor.
      ctx.drawImage(sprites.door, px(lay.door.x), py(lay.rows - 1), ts, ts);

      // Break room
      ctx.drawImage(sprites.couch, px(lay.breakRoom.x), py(lay.breakRoom.y), ts * 2, ts);
      ctx.drawImage(sprites.coffee, px(lay.breakRoom.x + 3), py(lay.breakRoom.y), ts, ts);
      ctx.drawImage(sprites.plant, px(lay.breakRoom.x + 4), py(lay.breakRoom.y), ts, ts);

      // Tables: desks (wrapping rows), title plaque, hover highlight
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const table of lay.tables) {
        for (let r = 0; r < table.deskRows; r++) {
          const desksInRow = Math.min(table.w, table.deskCount - r * table.w);
          for (let i = 0; i < desksInRow; i++) {
            ctx.drawImage(sprites.desk, px(table.x + i), py(table.y + r * 2), ts, ts);
          }
        }
        const fontPx = Math.max(9, Math.round(5 * scale));
        ctx.font = `600 ${fontPx}px ui-monospace, monospace`;
        const cx = px(table.x) + (table.w * ts) / 2;
        const cy = py(table.y - 1) + ts / 2;
        const tw = ctx.measureText(table.title).width;
        ctx.fillStyle = PLAQUE_BG;
        ctx.fillRect(cx - tw / 2 - 4, cy - fontPx / 2 - 3, tw + 8, fontPx + 6);
        ctx.fillStyle = PLAQUE_TEXT;
        ctx.fillText(table.title, cx, cy + 1);
      }
      const hovered = hoverTableRef.current;
      if (hovered && !hoverRef.current) {
        const rect = tableRect(hovered);
        ctx.fillStyle = TABLE_HIGHLIGHT_FILL;
        ctx.strokeStyle = TABLE_HIGHLIGHT;
        ctx.lineWidth = Math.max(1, scale);
        ctx.beginPath();
        ctx.roundRect(px(rect.x) - 2 * scale, py(rect.y) - 2 * scale, rect.w * ts + 4 * scale, rect.h * ts + 4 * scale, 3 * scale);
        ctx.fill();
        ctx.stroke();
      }
      for (const chair of Object.values(lay.chairBySurface)) {
        ctx.drawImage(sprites.chair, px(chair.x), py(chair.y), ts, ts);
      }

      // Characters, painter's order over interpolated positions
      const chars = Object.values(sim.characters)
        .map((ch) => {
          const before = prev.characters[ch.surfaceId];
          return {
            ch,
            ix: before ? before.x + (ch.x - before.x) * alpha : ch.x,
            iy: before ? before.y + (ch.y - before.y) * alpha : ch.y,
          };
        })
        .sort((a, b) => a.iy - b.iy);
      for (const { ch, ix, iy } of chars) {
        const vi = variantFor(ch.surfaceId);
        const { name, mirror } = frameFor(ch);
        const sprite = sprites[`${vi}:${name}`];
        if (!sprite) continue;
        const w = sprite.width * scale;
        const h = sprite.height * scale;
        const cx = px(ix) + (ts - w) / 2;
        const cy = py(iy + 1) - h;
        if (mirror) {
          ctx.save();
          ctx.translate(cx + w, cy);
          ctx.scale(-1, 1);
          ctx.drawImage(sprite, 0, 0, w, h);
          ctx.restore();
        } else {
          ctx.drawImage(sprite, cx, cy, w, h);
        }

        if (ch.bubble !== 'none') {
          const period = bubblePulsePeriod(ch.dwellMs);
          const pulse = ch.bubble === 'exclaim' ? 1 + 0.15 * Math.sin(ch.animClock / (period / (2 * Math.PI))) : 1;
          const bw = 14 * scale * pulse;
          const bh = 12 * scale * pulse;
          const bx = px(ix) + ts / 2;
          const by = cy - bh - 2 * scale;
          ctx.fillStyle = '#f4f2ec';
          ctx.beginPath();
          ctx.roundRect(bx - bw / 2, by, bw, bh, 3 * scale);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(bx - 2 * scale, by + bh);
          ctx.lineTo(bx + 2 * scale, by + bh);
          ctx.lineTo(bx, by + bh + 3 * scale);
          ctx.closePath();
          ctx.fill();
          ctx.font = `700 ${Math.round(8 * scale * pulse)}px ui-monospace, monospace`;
          ctx.fillStyle = ch.bubble === 'exclaim' ? '#c43d3d' : '#3a3f4a';
          const glyph = ch.bubble === 'exclaim' ? '!' : ch.bubble === 'hourglass' ? '⌛' : '…';
          ctx.fillText(glyph, bx, by + bh / 2 + scale);
        }
      }

      // Overflow sign beside the door
      if (sim.overflow > 0) {
        ctx.font = `700 ${Math.max(10, Math.round(6 * scale))}px ui-monospace, monospace`;
        ctx.fillStyle = PLAQUE_TEXT;
        ctx.fillText(`+${sim.overflow}`, px(lay.door.x + 1) + ts / 2, py(lay.door.y) + ts / 2);
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [sprites]);

  const toLocal = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return rect ? { mx: clientX - rect.left, my: clientY - rect.top } : null;
  }, []);

  /** Screen-position hit test against 1×1.5-tile character rects. */
  const charAt = useCallback((clientX: number, clientY: number): HoverInfo | null => {
    const local = toLocal(clientX, clientY);
    if (!local) return null;
    const { zoom, offX, offY } = viewRef.current;
    const ts = TILE * zoom;
    const sim = simRef.current;
    const prev = prevSimRef.current;
    const alpha = alphaRef.current;
    let best: HoverInfo | null = null;
    let bestIy = -Infinity;
    for (const ch of Object.values(sim.characters)) {
      const before = prev.characters[ch.surfaceId];
      const ix = before ? before.x + (ch.x - before.x) * alpha : ch.x;
      const iy = before ? before.y + (ch.y - before.y) * alpha : ch.y;
      const x0 = offX + ix * ts;
      const y0 = offY + (iy - 0.5) * ts;
      // Highest interpolated y wins, matching the painter's sort — the click
      // must select the character drawn on top, not insertion order.
      if (local.mx >= x0 && local.mx <= x0 + ts && local.my >= y0 && local.my <= y0 + 1.5 * ts && iy >= bestIy) {
        bestIy = iy;
        best = { surfaceId: ch.surfaceId, sx: x0 + ts / 2, sy: y0 };
      }
    }
    return best;
  }, [toLocal]);

  const tableAt = useCallback((clientX: number, clientY: number): TablePlacement | null => {
    const local = toLocal(clientX, clientY);
    if (!local) return null;
    const { zoom, offX, offY } = viewRef.current;
    const tx = (local.mx - offX) / (TILE * zoom);
    const ty = (local.my - offY) / (TILE * zoom);
    for (const table of layoutRef.current.tables) {
      const rect = tableRect(table);
      if (tx >= rect.x && tx < rect.x + rect.w && ty >= rect.y && ty < rect.y + rect.h) return table;
    }
    return null;
  }, [toLocal]);

  const entryFor = useCallback((surfaceId: string): AgentRosterEntry | undefined =>
    rollupRef.current.roster.find((e) => e.surfaceId === surfaceId), []);

  const jump = useCallback((entry: AgentRosterEntry) => {
    onFocusAgent?.(entry);
    onClose();
  }, [onFocusAgent, onClose]);

  const openWorkspace = useCallback((workspaceId: WorkspaceId) => {
    useStore.getState().selectWorkspace(workspaceId);
    onClose();
  }, [onClose]);

  const handleActivate = useCallback((clientX: number, clientY: number) => {
    const hit = charAt(clientX, clientY);
    if (hit) {
      const entry = entryFor(hit.surfaceId);
      if (!entry) return;
      if (entry.state === 'blocked') setPopover(hit);
      else jump(entry);
      return;
    }
    const table = tableAt(clientX, clientY);
    if (table) { openWorkspace(table.workspaceId); return; }
    setPopover(null);
  }, [charAt, tableAt, entryFor, jump, openWorkspace]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Capture ONLY when the press starts on the canvas itself. Capturing a
    // press that bubbled up from the popover's buttons would retarget the
    // pointerup to the wrap and swallow the button's click.
    if (e.button !== 0 || e.target !== canvasRef.current) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      panX: cameraRef.current.panX,
      panY: cameraRef.current.panY,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag && (e.buttons & 1)) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (drag.moved || Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) {
        drag.moved = true;
        cameraRef.current.panX = drag.panX + dx;
        cameraRef.current.panY = drag.panY + dy;
        hoverRef.current = null;
        hoverTableRef.current = null;
        setHover(null);
        // The popover anchors to screen coordinates; a moving camera would
        // leave it floating over the wrong tiles.
        setPopover(null);
        return;
      }
    }
    const charHit = charAt(e.clientX, e.clientY);
    hoverRef.current = charHit;
    hoverTableRef.current = charHit ? null : tableAt(e.clientX, e.clientY);
    // Bail when nothing changed — a fresh object per mousemove would re-render
    // the whole overlay at pointer speed.
    setHover((previous) => {
      if (!charHit) return previous === null ? previous : null;
      if (previous
        && previous.surfaceId === charHit.surfaceId
        && Math.abs(previous.sx - charHit.sx) < 1
        && Math.abs(previous.sy - charHit.sy) < 1) return previous;
      return charHit;
    });
  }, [charAt, tableAt]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !drag.moved && e.button === 0) handleActivate(e.clientX, e.clientY);
  }, [handleActivate]);

  const handlePointerCancel = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    // A purely horizontal trackpad swipe emits deltaY 0 — that is not a zoom.
    if (e.deltaY === 0) return;
    const local = toLocal(e.clientX, e.clientY);
    if (!local) return;
    const current = viewRef.current;
    const requested = current.zoom + (e.deltaY < 0 ? 1 : -1);
    if (requested < MIN_SCALE || requested > MAX_ZOOM) return;
    const next = zoomAt(current, local.mx, local.my, requested);
    cameraRef.current = { zoom: next.zoom, panX: next.panX, panY: next.panY };
    // Anchored DOM (tooltip, popover) would detach from the moving world.
    hoverRef.current = null;
    hoverTableRef.current = null;
    setHover(null);
    setPopover(null);
  }, [toLocal]);

  /**
   * Relay a declared choice. Refusal (the pane stopped asking, the choice is
   * gone) falls back to focusing the pane — same contract as WorkspaceRow,
   * including the in-flight guard: answering writes into a live PTY, so a
   * double-click must not relay the keystroke twice (issue #128).
   */
  const [answering, setAnswering] = useState(false);
  const answer = useCallback(async (surfaceId: string, choiceId: string) => {
    if (answering) return;
    setAnswering(true);
    const entry = entryFor(surfaceId);
    try {
      const res = await window.wmux?.agentState?.answer?.(surfaceId, choiceId);
      if (!res?.ok && entry) jump(entry);
    } catch {
      if (entry) jump(entry);
    } finally {
      setAnswering(false);
      setPopover(null);
    }
  }, [answering, entryFor, jump]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (popover) setPopover(null);
      else onClose();
    }
  };

  const hoverEntry = hover && !popover ? entryFor(hover.surfaceId) : undefined;
  const popoverEntry = popover ? entryFor(popover.surfaceId) : undefined;
  const { working, blocked, total } = rollup.totals;

  return (
    <div className="hub__backdrop" onClick={onClose} role="presentation">
      <div
        className="hub"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        ref={dialogRef}
        role="dialog"
        aria-label={t('hub.title', 'Agent office')}
      >
        <div className="hub__header">
          <span className="hub__title">{t('hub.title', 'Agent office')}</span>
          <span className="hub__totals">
            {working > 0 && t('hub.workingCount', '{count} working').replace('{count}', String(working))}
            {working > 0 && blocked > 0 && ' · '}
            {blocked > 0 && t('hub.blockedCount', '{count} waiting for you').replace('{count}', String(blocked))}
          </span>
          <button className="hub__close" onClick={onClose} aria-label={t('hub.close', 'Close')}>×</button>
        </div>

        <div
          className="hub__canvas-wrap"
          ref={wrapRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={() => { hoverRef.current = null; hoverTableRef.current = null; setHover(null); }}
          onWheel={handleWheel}
        >
          <canvas className="hub__canvas" ref={canvasRef} />

          {total === 0 && (
            <div className="hub__empty-hint">
              {t('hub.empty', 'No agents running. The office is quiet.')}
            </div>
          )}

          {hoverEntry && hover && (
            <div className="hub__tooltip" style={{ left: hover.sx, top: hover.sy }}>
              <div className="hub__tooltip-label">{hoverEntry.label}</div>
              {hoverEntry.kind && hoverEntry.kind !== hoverEntry.label && (
                <div className="hub__tooltip-row">{hoverEntry.kind}</div>
              )}
              <div className="hub__tooltip-row" data-state={hoverEntry.state}>
                {hoverEntry.state}
                {hoverEntry.state === 'blocked' && ` · ${formatDwell(hoverEntry.dwellMs)}`}
              </div>
              {hoverEntry.metadata?.model && (
                <div className="hub__tooltip-row">{t('hub.model', 'model')}: {hoverEntry.metadata.model}</div>
              )}
              {hoverEntry.metadata?.tokens && (
                <div className="hub__tooltip-row">{t('hub.tokens', 'tokens')}: {hoverEntry.metadata.tokens}</div>
              )}
              {typeof hoverEntry.metadata?.contextPct === 'number' && (
                <div className="hub__tooltip-row">{t('hub.context', 'context')}: {hoverEntry.metadata.contextPct}%</div>
              )}
            </div>
          )}

          {popoverEntry && popover && (
            <div
              className="hub__popover"
              style={{ left: popover.sx, top: popover.sy }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="hub__popover-reason">
                {popoverEntry.blockedReason ?? t('hub.needsYou', 'Needs your input')}
              </div>
              {popoverEntry.choices.map((choice) => (
                <button
                  key={choice.id}
                  className="hub__popover-choice"
                  disabled={answering}
                  onClick={() => void answer(popoverEntry.surfaceId, choice.id)}
                >
                  {choice.label}
                </button>
              ))}
              <button className="hub__popover-goto" disabled={answering} onClick={() => jump(popoverEntry)}>
                {t('hub.goToPane', 'Go to pane')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
