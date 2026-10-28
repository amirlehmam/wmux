// Bringing a manifest's panes up in order (#284). Every pane already EXISTS
// when this runs — `after`/`waitFor` gate only when a pane's commands are
// typed, never whether the pane is there — so the layout appears at once and
// a stuck dependency can only ever hold back its own dependents.
//
// The rules, each one a line in the issue's guardrails:
//   - A pane runs once everything in its `after` has been DISPATCHED, and its
//     own `waitFor` (if any) has passed. Panes with neither go at t=0.
//   - Every wait is bounded. A wait that gives up says so IN THAT PANE (a
//     `[wmux] …` notice) and runs nothing there; its dependents still go (with
//     their own waits), so one dead service cannot hang the whole bring-up.
//   - Commands are typed through PtyManager's one delivery path (#251):
//     `PtyManager.deliverCommands`, the same readiness-gated typing a cold
//     start uses, applied to a shell that is already running.
//   - Notices are written to xterm (the renderer's `showPaneNotice`, parked
//     until the pane mounts), never to the PTY.
//
// I/O is injected, which is what makes the ordering testable without a PTY,
// a socket or a clock.

import type { PlannedPane, WaitFor } from './workspace-manifest';
import { topoOrder } from './workspace-manifest';

export interface SchedulerIo {
  /** Type commands into the surface's live shell; false if it has no PTY yet. */
  deliver(surfaceId: string, commands: string[]): boolean;
  /** Resolve true when the condition holds, false once its timeout passes. */
  wait(waitFor: WaitFor): Promise<boolean>;
  notice(surfaceId: string, text: string): void;
  sleep(ms: number): Promise<void>;
}

export type PaneOutcome = 'started' | 'idle' | 'wait-timeout' | 'no-terminal';

/** How long a pane's PTY may take to appear before its commands are given up on. */
export const PTY_APPEAR_TIMEOUT_MS = 30_000;
const PTY_POLL_MS = 100;

function describeWaitShort(w: WaitFor): string {
  if (w.kind === 'port') return `port ${w.port}`;
  if (w.kind === 'http') return w.url;
  return `${w.ms} ms`;
}

async function deliverWhenPtyExists(io: SchedulerIo, surfaceId: string, commands: string[]): Promise<boolean> {
  for (let waited = 0; waited <= PTY_APPEAR_TIMEOUT_MS; waited += PTY_POLL_MS) {
    if (io.deliver(surfaceId, commands)) return true;
    await io.sleep(PTY_POLL_MS);
  }
  return false;
}

async function runPane(pane: PlannedPane, surfaceId: string, deps: Promise<PaneOutcome>[], io: SchedulerIo): Promise<PaneOutcome> {
  if (deps.length || pane.waitFor) {
    const reasons = [...pane.after, ...(pane.waitFor ? [describeWaitShort(pane.waitFor)] : [])];
    io.notice(surfaceId, `waiting for ${reasons.join(', ')} before running ${pane.commands.length} command(s)…`);
  }
  await Promise.all(deps);
  if (pane.waitFor && !(await io.wait(pane.waitFor))) {
    io.notice(surfaceId, `gave up waiting for ${describeWaitShort(pane.waitFor)} — nothing was run in this pane. Start it by hand, or fix the manifest and open it again.`);
    return 'wait-timeout';
  }
  if (!pane.commands.length) return 'idle';
  if (!(await deliverWhenPtyExists(io, surfaceId, pane.commands))) return 'no-terminal';
  return 'started';
}

/**
 * Run every pane's commands in dependency order. Resolves once every pane has
 * an outcome; `surfaces` maps manifest pane ids to the surfaces created for
 * them (a pane missing from it is skipped).
 */
export async function runPlan(
  panes: PlannedPane[],
  surfaces: Record<string, string>,
  io: SchedulerIo,
): Promise<Record<string, PaneOutcome>> {
  const order = topoOrder(panes) ?? panes.map((p) => p.id);
  const byId = new Map(panes.map((p) => [p.id, p]));
  const running = new Map<string, Promise<PaneOutcome>>();
  for (const id of order) {
    const pane = byId.get(id);
    const surfaceId = surfaces[id];
    if (!pane || !surfaceId) {
      running.set(id, Promise.resolve('no-terminal'));
      continue;
    }
    const deps = pane.after.map((dep) => running.get(dep)).filter((p): p is Promise<PaneOutcome> => !!p);
    running.set(id, runPane(pane, surfaceId, deps, io));
  }
  const outcomes: Record<string, PaneOutcome> = {};
  for (const [id, outcome] of running) outcomes[id] = await outcome;
  return outcomes;
}
