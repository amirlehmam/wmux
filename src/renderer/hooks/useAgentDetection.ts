/**
 * The screen-detection loop.
 *
 * WHY IT RUNS IN THE RENDERER — the one architectural decision in phase 3.
 *
 * The main process has raw PTY BYTES; it does not have a screen. Reconstructing
 * one there means embedding a headless VT emulator and parsing every chunk a
 * second time on the main event loop, which is exactly what issue #176 says not
 * to do. The renderer already HAS the grid: xterm parsed it once, for free,
 * because it has to draw it. Reading 40 lines out of that grid costs a loop
 * over 40 `translateToString` calls with no IPC at all — versus the ~0.6ms
 * `executeJavaScript` round trip `wmux read-screen` pays per surface, which is
 * cheap for a CLI call and wasteful several times a second.
 *
 * Reading the grid rather than the bytes also sidesteps two problems main-side
 * parsing has for free: ConPTY emits full-screen repaints that xterm has
 * already resolved into a stable buffer, and an ANSI stripper working on raw
 * chunks has to carry a remainder across chunk boundaries or it corrupts every
 * escape that straddles one.
 *
 * ONE loop for every surface, not one per terminal: the schedule and the budget
 * are global properties, and N independent intervals would make both unknowable.
 */
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { surfaceTerminalRegistry, surfaceOutputSeq, surfaceTitle } from './useTerminal';
import { detectScreen } from '../../shared/detection/engine';
import { BUNDLED_MANIFESTS } from '../../shared/detection/manifests';
import type { DetectionResult, Manifest } from '../../shared/detection/types';

/**
 * How much of the bottom of the buffer to read.
 *
 * Wider than the widest rule window (Claude's idle rule looks at 12 non-empty
 * lines, and blank padding roughly doubles that). Wider still would cost
 * nothing measurable but would let a rule accidentally reach into scrollback
 * that is no longer on screen, which is a correctness risk, not a perf one.
 */
const DETECTION_LINES = 40;

/** Tick while at least one surface is a known agent. */
const TICK_IDENTIFIED_MS = 300;
/** Tick when nothing is identified — this is the "is anyone there?" poll. */
const TICK_IDLE_MS = 800;

/**
 * A surface is left alone for this long after it first appears.
 *
 * Agent TUIs paint progressively: a half-drawn Claude Code shows its prompt box
 * a beat before its footer, and reading in between yields a confident answer
 * about a screen that does not exist yet.
 */
const STARTUP_GRACE_MS = 3_000;

interface SurfaceScanState {
  firstSeenAt: number;
  lastScannedSeq: number;
  lastResult: DetectionResult | null;
}

/** Bottom-anchored read straight out of the xterm buffer. No IPC. */
function readScreen(surfaceId: string): string[] | null {
  const terminal = surfaceTerminalRegistry.get(surfaceId);
  if (!terminal) return null;

  const buf = terminal.buffer.active;
  const end = buf.length;
  const out: string[] = [];
  for (let i = Math.max(0, end - DETECTION_LINES); i < end; i++) {
    out.push(buf.getLine(i)?.translateToString(true) ?? '');
  }
  // Agent UIs sit above a tail of blank rows; dropping them is what makes
  // `bottom_lines` mean "the bottom of the CONTENT".
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/**
 * Should this surface be scanned this tick?
 *
 * The pause is the important one, and it is deliberate discipline copied from
 * the prior art: a surface whose agent is REPORTING is not scanned at all,
 * rather than scanned and then ignored. That is a CPU win, and it removes a
 * whole class of precedence bug — a result that is never produced cannot leak
 * into a merge by accident.
 */
function shouldScan(
  surfaceId: string,
  scan: SurfaceScanState,
  declaredState: string | undefined,
  now: number,
): boolean {
  if (declaredState && declaredState !== 'unknown') return false;
  if (now - scan.firstSeenAt < STARTUP_GRACE_MS) return false;

  const seq = surfaceOutputSeq.get(surfaceId) ?? 0;
  if (seq !== scan.lastScannedSeq) return true;

  // No new output. Re-scan anyway only while we still have no answer — a
  // pane that has settled on a state needs no further looks until it moves.
  return scan.lastResult === null;
}

/** Scan one surface, publishing only when its verdict actually moved. */
function scanSurface(
  surfaceId: string,
  scan: SurfaceScanState,
  manifests: Manifest[],
  now: number,
): void {
  const store = useStore.getState();
  const identity = store.agentIdentities[surfaceId];

  if (!shouldScan(surfaceId, scan, store.agentStates[surfaceId]?.state, now)) return;

  const lines = readScreen(surfaceId);
  if (!lines) return;

  scan.lastScannedSeq = surfaceOutputSeq.get(surfaceId) ?? 0;
  const result = detectScreen(
    { lines, title: surfaceTitle.get(surfaceId) ?? null },
    manifests,
    identity?.kind ?? null,
  );

  const previous = scan.lastResult;
  scan.lastResult = result;
  const changed = previous?.state !== result.state
    || previous?.agent !== result.agent
    || previous?.ruleId !== result.ruleId;
  if (!changed) return;

  store.setAgentDetection(surfaceId, result);
  // Mirror to main only on a CHANGE. The loop ticks several times a second; an
  // unconditional send would be one IPC message per pane per tick to keep a
  // value that did not move.
  window.wmux?.agentDetection?.report?.(surfaceId, result);
}

export function useAgentDetection(enabled: boolean): void {
  const scans = useRef(new Map<string, SurfaceScanState>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manifests = useRef<Manifest[]>(BUNDLED_MANIFESTS);

  useEffect(() => {
    if (!enabled) {
      // Leaving the results behind would freeze whatever was last on screen
      // into the UI for the rest of the session.
      useStore.getState().clearAgentDetections();
      return;
    }

    let cancelled = false;

    // Bundled set until main answers with the user's overrides applied. Starting
    // from the bundled set rather than from nothing means a slow config read
    // costs a beat of stale rules, not a blind first tick.
    void (async () => {
      const loaded = await window.wmux?.agentDetection?.manifests?.();
      if (!cancelled && Array.isArray(loaded?.manifests) && loaded.manifests.length > 0) {
        manifests.current = loaded.manifests as Manifest[];
      }
      for (const warning of loaded?.warnings ?? []) {
        console.warn('[wmux] detection manifest:', warning);
      }
    })();

    const tick = () => {
      if (cancelled) return;
      const store = useStore.getState();
      const now = Date.now();
      let anyIdentified = false;

      for (const surfaceId of surfaceTerminalRegistry.keys()) {
        let scan = scans.current.get(surfaceId);
        if (!scan) {
          scan = { firstSeenAt: now, lastScannedSeq: -1, lastResult: null };
          scans.current.set(surfaceId, scan);
        }
        if (store.agentIdentities[surfaceId]?.kind) anyIdentified = true;
        scanSurface(surfaceId, scan, manifests.current, now);
      }

      // Drop bookkeeping for surfaces that went away, so the map cannot grow
      // for the life of the window. The store entry is dropped with it.
      for (const surfaceId of scans.current.keys()) {
        if (surfaceTerminalRegistry.has(surfaceId)) continue;
        scans.current.delete(surfaceId);
        useStore.getState().setAgentDetection(surfaceId, null);
      }

      timer.current = setTimeout(tick, anyIdentified ? TICK_IDENTIFIED_MS : TICK_IDLE_MS);
    };

    timer.current = setTimeout(tick, TICK_IDLE_MS);

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [enabled]);
}
