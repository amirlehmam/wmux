import { SplitNode, SurfaceId, PaneId } from '../../shared/types';
import { AgentMeta } from './agent-slice';

/** One display line under a workspace row. */
export interface WorkspaceAgent {
  key: string;
  name: string;
  detail: string;
  done: boolean;
  /** Set only for wmux-spawned agents that own a pane — makes the line clickable. */
  paneId?: PaneId;
  /** Tool-use count of an observer-parsed agent — feeds the "+N more" summary. */
  toolUses?: number;
}

/** Observer agent shape (subset of ClaudeActivity from src/main/claude-observer.ts). */
interface ObserverActivity {
  agents: Array<{ name: string; toolUses: number; tokens: string; done: boolean }>;
  lastUpdate: number;
}

const OBSERVER_TTL_MS = 5 * 60 * 1000; // stale observer data never renders (ghost guard)
const MAX_LINES = 4;
export const AGENT_LINGER_MS = 10_000;
/** Key of the synthetic "+N more" summary line appended when the list overflows. */
export const MORE_KEY = '__more';

function collectSurfacePanes(tree: SplitNode, out: Array<{ surfaceId: SurfaceId; paneId: PaneId }>): void {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) out.push({ surfaceId: s.id, paneId: tree.paneId });
    return;
  }
  collectSurfacePanes(tree.children[0], out);
  collectSurfacePanes(tree.children[1], out);
}

function observerLines(surfaceId: string, activity: ObserverActivity | undefined, now: number): WorkspaceAgent[] {
  if (!activity || now - activity.lastUpdate > OBSERVER_TTL_MS) return [];
  return activity.agents.map(a => ({
    key: `${surfaceId}:${a.name}`,
    name: a.name,
    detail: a.done ? '✓' : `⚒${a.toolUses} · ${a.tokens}`,
    done: a.done,
    toolUses: a.toolUses,
  }));
}

function wmuxLine(surfaceId: string, paneId: PaneId, meta: AgentMeta | undefined): WorkspaceAgent | null {
  if (!meta) return null;
  const done = meta.status === 'exited';
  return { key: `wmux:${surfaceId}`, name: meta.label, detail: done ? '✓' : '', done, paneId };
}

function summarize(ordered: WorkspaceAgent[]): WorkspaceAgent[] {
  if (ordered.length <= MAX_LINES) return ordered;
  const shown = ordered.slice(0, MAX_LINES - 1);
  const hidden = ordered.slice(MAX_LINES - 1);
  // Done observer agents contribute their toolUses too — the summary reads
  // "work done by hidden agents", not "work in flight".
  const hiddenTools = hidden.reduce((sum, a) => sum + (a.toolUses ?? 0), 0);
  shown.push({
    key: MORE_KEY,
    name: `+${hidden.length} more`,
    detail: hiddenTools > 0 ? `⚒${hiddenTools}` : '',
    done: hidden.every(a => a.done),
  });
  return shown;
}

/** Agent list of one workspace, plus true counts unaffected by the display cap. */
export interface WorkspaceAgentsView {
  /** Display lines, running first, capped at MAX_LINES (last may be "+N more"). */
  lines: WorkspaceAgent[];
  /** True number of merged agents, before summarize() truncates. */
  total: number;
  /** True number of still-running agents, before summarize() truncates. */
  running: number;
}

/**
 * Merge observer-parsed subagents and wmux-spawned agents of one workspace
 * into a single display list, running first, capped at MAX_LINES (3 agents +
 * one "+N more" summary when overflowing). `total`/`running` count the full
 * merged list so callers can report real numbers despite the cap.
 */
export function agentsForWorkspace(
  splitTree: SplitNode,
  claudeActivity: Record<string, ObserverActivity | undefined>,
  agentMeta: Map<SurfaceId, AgentMeta>,
  now: number,
): WorkspaceAgentsView {
  const pairs: Array<{ surfaceId: SurfaceId; paneId: PaneId }> = [];
  collectSurfacePanes(splitTree, pairs);

  const merged: WorkspaceAgent[] = [];
  for (const { surfaceId, paneId } of pairs) {
    merged.push(...observerLines(surfaceId, claudeActivity[surfaceId], now));
    const wmux = wmuxLine(surfaceId, paneId, agentMeta.get(surfaceId));
    if (wmux) merged.push(wmux);
  }

  // Stable partition: running agents first, done ones after.
  const runningAgents = merged.filter(a => !a.done);
  const ordered = [...runningAgents, ...merged.filter(a => a.done)];
  return { lines: summarize(ordered), total: merged.length, running: runningAgents.length };
}

/**
 * Linger state machine: agent lines stay visible while anything runs, then
 * linger AGENT_LINGER_MS after everything finished so the ✓s are seen, then
 * collapse. Pure — the caller stores doneAt and supplies the clock.
 */
export function resolveAgentLinger(
  allDone: boolean,
  prevDoneAt: number | null,
  now: number,
): { visible: boolean; doneAt: number | null } {
  if (!allDone) return { visible: true, doneAt: null };
  const doneAt = prevDoneAt ?? now;
  return { visible: now - doneAt <= AGENT_LINGER_MS, doneAt };
}
