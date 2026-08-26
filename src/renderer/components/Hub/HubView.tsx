/**
 * The agent office — a full-window overlay that renders every agent in the
 * window as a pixel character (issue tracker: "hub"). Watch + jump + answer:
 * hover for model/stats, click a character to focus its pane, click a blocked
 * character to answer its declared choices via the #128 back-channel.
 *
 * All behavior lives in the pure modules beside this file (layout, sim,
 * sprites) — this component only owns the canvas, the rAF loop and the DOM
 * tooltip/popover. Unmounted means gone: no timers, no rAF, no sim state, so
 * a closed hub costs nothing.
 */
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
import type { FrameName } from './sprites';
import '../../styles/hub.css';

const TILE = 16;
const SIM_STEP_MS = 100;
/** Cap wasted work between frames after a long throttle (hidden window). */
const MAX_ACCUM_MS = 2000;

const FLOOR_A = '#3a3f4a';
const FLOOR_B = '#3f4450';
const WALL = '#23262e';
const PLAQUE_BG = 'rgba(20, 22, 28, 0.75)';
const PLAQUE_TEXT = '#c8cede';

interface View {
  scale: number;
  offX: number;
  offY: number;
}

interface HoverInfo {
  surfaceId: string;
  sx: number;
  sy: number;
}

function frameFor(ch: Character): { name: FrameName; mirror: boolean } {
  const mirror = ch.facing === 'right';
  switch (ch.phase) {
    case 'walkingToDesk':
    case 'walkingToBreak':
    case 'walkingToPeer':
    case 'leaving': {
      const step = (Math.floor(ch.animClock / 200) % 2) as 0 | 1;
      const dir = ch.facing === 'up' ? 'up' : ch.facing === 'down' ? 'down' : 'side';
      return { name: `walk-${dir}-${step}` as FrameName, mirror };
    }
    case 'atDesk':
      if (ch.rosterState === 'working') {
        return { name: `sit-up-${Math.floor(ch.animClock / 250) % 2}` as FrameName, mirror: false };
      }
      return { name: 'sit-still', mirror: false };
    case 'resting':
      return { name: `rest-${Math.floor(ch.animClock / 600) % 2}` as FrameName, mirror: false };
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

  const rollup = useMemo(
    () => rollupAgents(workspaces, agentStates, now, agentIdentities, agentDetections),
    [workspaces, agentStates, agentIdentities, agentDetections, now],
  );

  const layout = useMemo(
    () => buildLayout(
      workspaces.map((w) => ({ id: w.id, title: w.title })),
      rollup.roster.map((e) => ({ surfaceId: e.surfaceId, workspaceId: e.workspaceId })),
    ),
    [workspaces, rollup],
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
  const layoutRef = useRef<OfficeLayout>(layout);
  const rosterRef = useRef<SimRosterEntry[]>([]);
  const rollupRef = useRef(rollup);
  const viewRef = useRef<View>({ scale: 1, offX: 0, offY: 0 });
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
        simRef.current = stepSim(simRef.current, rosterRef.current, layoutRef.current, SIM_STEP_MS, Math.random);
        acc -= SIM_STEP_MS;
      }
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

      const fit = Math.min(cssW / (lay.cols * TILE), cssH / (lay.rows * TILE));
      const scale = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit;
      const offX = (cssW - lay.cols * TILE * scale) / 2;
      const offY = (cssH - lay.rows * TILE * scale) / 2;
      viewRef.current = { scale, offX, offY };

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, cssW, cssH);

      const px = (tx: number) => offX + tx * TILE * scale;
      const py = (ty: number) => offY + ty * TILE * scale;
      const ts = TILE * scale;

      // Floor + walls
      for (let y = 0; y < lay.rows; y++) {
        for (let x = 0; x < lay.cols; x++) {
          const wall = x === 0 || y === 0 || x === lay.cols - 1 || y === lay.rows - 1;
          ctx.fillStyle = wall ? WALL : (x + y) % 2 === 0 ? FLOOR_A : FLOOR_B;
          ctx.fillRect(px(x), py(y), ts, ts);
        }
      }

      // Door sits in the bottom wall, under the door tile of the corridor.
      ctx.drawImage(sprites.door, px(lay.door.x), py(lay.rows - 1), ts, ts);

      // Break room
      ctx.drawImage(sprites.couch, px(lay.breakRoom.x), py(lay.breakRoom.y), ts * 2, ts);
      ctx.drawImage(sprites.coffee, px(lay.breakRoom.x + 3), py(lay.breakRoom.y), ts, ts);
      ctx.drawImage(sprites.plant, px(lay.breakRoom.x + 4), py(lay.breakRoom.y), ts, ts);

      // Tables: desks, chairs, title plaque
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const table of lay.tables) {
        for (let i = 0; i < table.w; i++) {
          ctx.drawImage(sprites.desk, px(table.x + i), py(table.y), ts, ts);
        }
        const label = table.title;
        const fontPx = Math.max(9, Math.round(5 * scale));
        ctx.font = `600 ${fontPx}px ui-monospace, monospace`;
        const cx = px(table.x) + (table.w * ts) / 2;
        const cy = py(table.y - 1) + ts / 2;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = PLAQUE_BG;
        ctx.fillRect(cx - tw / 2 - 4, cy - fontPx / 2 - 3, tw + 8, fontPx + 6);
        ctx.fillStyle = PLAQUE_TEXT;
        ctx.fillText(label, cx, cy + 1);
      }
      for (const chair of Object.values(lay.chairBySurface)) {
        ctx.drawImage(sprites.chair, px(chair.x), py(chair.y), ts, ts);
      }

      // Characters, painter's order
      const chars = Object.values(sim.characters).sort((a, b) => a.y - b.y);
      for (const ch of chars) {
        const vi = variantFor(ch.surfaceId);
        const { name, mirror } = frameFor(ch);
        const sprite = sprites[`${vi}:${name}`];
        if (!sprite) continue;
        const w = sprite.width * scale;
        const h = sprite.height * scale;
        const cx = px(ch.x) + (ts - w) / 2;
        const cy = py(ch.y + 1) - h;
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
          const bx = px(ch.x) + ts / 2;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprites]);

  /** Screen-position hit test against 1×1.5-tile character rects. */
  const charAt = useCallback((clientX: number, clientY: number): HoverInfo | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { scale, offX, offY } = viewRef.current;
    const ts = TILE * scale;
    let best: HoverInfo | null = null;
    for (const ch of Object.values(simRef.current.characters)) {
      const x0 = offX + ch.x * ts;
      const y0 = offY + (ch.y - 0.5) * ts;
      if (mx >= x0 && mx <= x0 + ts && my >= y0 && my <= y0 + 1.5 * ts) {
        best = { surfaceId: ch.surfaceId, sx: x0 + ts / 2, sy: y0 };
      }
    }
    return best;
  }, []);

  const entryFor = useCallback((surfaceId: string): AgentRosterEntry | undefined =>
    rollupRef.current.roster.find((e) => e.surfaceId === surfaceId), []);

  const jump = useCallback((entry: AgentRosterEntry) => {
    onFocusAgent?.(entry);
    onClose();
  }, [onFocusAgent, onClose]);

  const handleMove = useCallback((e: React.MouseEvent) => {
    setHover(charAt(e.clientX, e.clientY));
  }, [charAt]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const hit = charAt(e.clientX, e.clientY);
    if (!hit) { setPopover(null); return; }
    const entry = entryFor(hit.surfaceId);
    if (!entry) return;
    if (entry.state === 'blocked') setPopover(hit);
    else jump(entry);
  }, [charAt, entryFor, jump]);

  /**
   * Relay a declared choice. Refusal (the pane stopped asking, the choice is
   * gone) falls back to focusing the pane — same contract as WorkspaceRow.
   */
  const answer = useCallback(async (surfaceId: string, choiceId: string) => {
    const entry = entryFor(surfaceId);
    try {
      const res = await (window as any).wmux?.agentState?.answer?.(surfaceId, choiceId);
      if (!res?.ok && entry) jump(entry);
    } catch {
      if (entry) jump(entry);
    }
    setPopover(null);
  }, [entryFor, jump]);

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
        ref={(el) => el?.focus()}
        role="dialog"
        aria-label={t('hub.title', 'Agent office')}
      >
        <div className="hub__header">
          <span className="hub__title">{t('hub.title', 'Agent office')}</span>
          <span className="hub__totals">
            {working > 0 && t('hub.workingCount', '{count} working').replace('{count}', String(working))}
            {working > 0 && blocked > 0 && ' · '}
            {blocked > 0 && t('hub.blockedCount', '{count} need you').replace('{count}', String(blocked))}
          </span>
          <button className="hub__close" onClick={onClose} aria-label={t('hub.close', 'Close')}>×</button>
        </div>

        <div
          className="hub__canvas-wrap"
          ref={wrapRef}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
          onClick={handleClick}
          data-pointer={!!hover}
        >
          <canvas className="hub__canvas" ref={canvasRef} />

          {total === 0 && (
            <div className="hub__empty-hint">
              {t('hub.empty', 'No agents running — the office is quiet.')}
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
            <div className="hub__popover" style={{ left: popover.sx, top: popover.sy }}>
              <div className="hub__popover-reason">
                {popoverEntry.blockedReason ?? t('hub.needsYou', 'Needs your input')}
              </div>
              {popoverEntry.choices.map((choice) => (
                <button
                  key={choice.id}
                  className="hub__popover-choice"
                  onClick={() => void answer(popoverEntry.surfaceId, choice.id)}
                >
                  {choice.label}
                </button>
              ))}
              <button className="hub__popover-goto" onClick={() => jump(popoverEntry)}>
                {t('hub.goToPane', 'Go to pane')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
