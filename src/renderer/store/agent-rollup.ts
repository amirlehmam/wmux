/**
 * Declared agent state, rolled up across every workspace in the window.
 *
 * `claude-session-view.ts` already folds the signals for ONE workspace, and the
 * workspace row already renders "Needs you · N" from it — but that count is
 * computed inside a render and thrown away, so nothing above a single row can
 * see it. There is no "which of my ten workspaces is waiting on me?" answer
 * anywhere in wmux, which is the one question a user running several agents
 * actually has.
 *
 * This module is the missing aggregate. It is deliberately pure and free of
 * React and Zustand: the precedence rules and the pruning below are the part
 * worth testing, exactly as workspace-status.ts is kept beside its component.
 *
 * It reads ONLY declared state (issue #128) — never a heuristic. A pane whose
 * agent never reported is not in the roster at all, rather than being asserted
 * idle. Adding a screen-detection source later means adding a field here, not
 * widening what `state` means.
 */
import { SplitNode, SurfaceId, PaneId, WorkspaceId, WorkspaceInfo } from '../../shared/types';
import type { AgentChoiceView } from './claude-session-view';

/** The three states an agent can be IN. `unknown` is absence, and never appears here. */
export type AgentPresenceState = 'blocked' | 'working' | 'idle';

/**
 * One AGENT_STATE payload as the renderer receives it (src/main/agent-state.ts,
 * `AgentStateSnapshot`). Only the fields the rollup needs are declared.
 */
export interface DeclaredAgentSnapshot {
  state: AgentPresenceState | 'unknown';
  blockedReason?: string | null;
  choices?: AgentChoiceView[];
  answeredAt?: number | null;
  /** Last accepted report of ANY kind, including metadata-only ones. */
  updatedAt?: number;
  /**
   * When this pane became blocked, if main stamped it. Distinct from
   * `updatedAt` because a blocked agent that keeps reporting token counts would
   * otherwise look as though it had just started waiting.
   */
  blockedSince?: number | null;
}

export interface AgentRosterEntry {
  surfaceId: SurfaceId;
  paneId: PaneId;
  workspaceId: WorkspaceId;
  workspaceTitle: string;
  /** User-set tab title, else the pane cwd's folder name. */
  label: string;
  state: AgentPresenceState;
  blockedReason: string | null;
  /** Answers offerable from the sidebar — empty unless the agent declared them. */
  choices: AgentChoiceView[];
  /** An answer was relayed and the agent has not reported back yet. */
  answerPending: boolean;
  /** How long this agent has been in `state`, in ms. */
  dwellMs: number;
}

export interface AgentCounts {
  blocked: number;
  working: number;
  idle: number;
  /** Agents present, i.e. blocked + working + idle. Not the pane count. */
  total: number;
}

export interface AgentRollup {
  /** Every workspace gets an entry, so a consumer never has to null-check. */
  byWorkspace: Record<string, AgentCounts>;
  totals: AgentCounts;
  /** Workspace order, then split-tree order. Stable across renders. */
  roster: AgentRosterEntry[];
  /** The blocked subset, longest-waiting first. */
  blocked: AgentRosterEntry[];
}

interface SurfaceEntry {
  surfaceId: SurfaceId;
  paneId: PaneId;
  currentCwd?: string;
  customTitle?: string;
}

function collectSurfaces(tree: SplitNode, out: SurfaceEntry[]): void {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) {
      out.push({
        surfaceId: s.id,
        paneId: tree.paneId,
        currentCwd: (s as { currentCwd?: string }).currentCwd,
        customTitle: s.customTitle,
      });
    }
    return;
  }
  collectSurfaces(tree.children[0], out);
  collectSurfaces(tree.children[1], out);
}

function cwdBasename(cwd: string | undefined): string | null {
  if (!cwd) return null;
  let normalized = cwd.replace(/\\/g, '/');
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === '/') end--;
  normalized = normalized.slice(0, end);
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base || null;
}

const EMPTY_COUNTS = (): AgentCounts => ({ blocked: 0, working: 0, idle: 0, total: 0 });

/**
 * One surface → one roster entry, or null when no agent claimed it.
 *
 * Split out of the fold below so the counting loop stays a loop: absence,
 * choice gating and dwell resolution are three independent rules and reading
 * them inline made the aggregate harder to follow than the sum of its parts.
 */
function rosterEntryFor(
  surface: SurfaceEntry,
  workspace: WorkspaceInfo,
  declared: DeclaredAgentSnapshot | undefined,
  now: number,
): AgentRosterEntry | null {
  // Absence and `unknown` are the same fact: nobody claimed this pane.
  if (!declared || declared.state === 'unknown') return null;

  const state = declared.state;
  const blocked = state === 'blocked';
  const choices = blocked ? (declared.choices ?? []) : [];
  // A stamped blockedSince is truthful; updatedAt is the best guess when main
  // did not stamp one. The dwell is clamped at 0 — a report from the future
  // (clock skew, a replayed hookAt) must not sort to the top of the queue.
  const since = (blocked ? declared.blockedSince : null) ?? declared.updatedAt ?? now;

  return {
    surfaceId: surface.surfaceId,
    paneId: surface.paneId,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    label: surface.customTitle ?? cwdBasename(surface.currentCwd) ?? 'Agent',
    state,
    blockedReason: blocked ? (declared.blockedReason ?? null) : null,
    choices,
    answerPending: blocked && choices.length === 0 && !!declared.answeredAt,
    dwellMs: Math.max(0, now - since),
  };
}

/**
 * Fold declared agent state over the live workspace list.
 *
 * Walking the split trees rather than the state map is the point, not an
 * implementation detail: AGENT_STATE is a delta channel and main prunes its
 * records only through a 256-entry LRU, so the renderer's map accumulates
 * entries for surfaces that were closed minutes ago. Iterating the map would
 * make "2 need you" survive closing both panes.
 */
export function rollupAgents(
  workspaces: WorkspaceInfo[],
  agentStates: Record<string, DeclaredAgentSnapshot | undefined>,
  now: number,
): AgentRollup {
  const byWorkspace: Record<string, AgentCounts> = {};
  const totals = EMPTY_COUNTS();
  const roster: AgentRosterEntry[] = [];

  for (const workspace of workspaces) {
    const counts = EMPTY_COUNTS();
    byWorkspace[workspace.id] = counts;

    const surfaces: SurfaceEntry[] = [];
    collectSurfaces(workspace.splitTree, surfaces);

    for (const surface of surfaces) {
      const entry = rosterEntryFor(surface, workspace, agentStates[surface.surfaceId], now);
      if (!entry) continue;

      roster.push(entry);
      counts[entry.state]++;
      counts.total++;
      totals[entry.state]++;
      totals.total++;
    }
  }

  // Stable: Array.prototype.sort is stable per spec, so equal dwells keep
  // workspace-then-tree order rather than shuffling between ticks.
  const blocked = roster.filter((r) => r.state === 'blocked').sort((a, b) => b.dwellMs - a.dwellMs);

  return { byWorkspace, totals, roster, blocked };
}

/**
 * The single state a workspace row should read as.
 *
 * Blocked outranks working for the same reason it does in workspace-status.ts:
 * everything else describes work that proceeds on its own, this describes work
 * that has stopped until the user acts. `null` means "no agent here" — the row
 * keeps whatever its shell integration was already saying.
 */
export function workspaceAgentState(counts: AgentCounts | undefined): AgentPresenceState | null {
  if (!counts || counts.total === 0) return null;
  if (counts.blocked > 0) return 'blocked';
  if (counts.working > 0) return 'working';
  return 'idle';
}
