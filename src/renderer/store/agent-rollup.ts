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

/**
 * What an agent in the roster is doing.
 *
 * `unknown` is NOT absence — absence is not being in the roster at all. It means
 * "we know an agent is running here (it was identified) but it has not told us
 * what it is doing". Keeping that distinct from `idle` is invariant 1 of the
 * declared-state protocol: `idle` is a CLAIM, and asserting it for an agent that
 * never spoke is exactly the lie the protocol exists to prevent. This is also
 * the slot screen detection fills in later.
 */
export type AgentPresenceState = 'blocked' | 'working' | 'idle' | 'unknown';

/** Which agent is running, and how confident we are about that. */
export interface AgentIdentitySnapshot {
  kind: string | null;
  source: 'shell-spec' | 'command' | 'probe' | null;
}

/**
 * What the pane's SCREEN said (src/shared/detection).
 *
 * Only the two fields the rollup consumes are declared, so this module keeps
 * compiling for both processes without dragging the engine's types into the
 * renderer's dependency graph.
 */
export interface DetectionSnapshot {
  agent: string | null;
  state: AgentPresenceState;
}

/**
 * One AGENT_STATE payload as the renderer receives it (src/main/agent-state.ts,
 * `AgentStateSnapshot`). Only the fields the rollup needs are declared.
 */
export interface DeclaredAgentSnapshot {
  state: AgentPresenceState;
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
  /** Which agent (`claude`, `codex`, …), when one was identified. */
  kind: string | null;
  /** How that kind was established — null when only declared state is known. */
  identitySource: AgentIdentitySnapshot['source'];
  /**
   * Where `state` came from.
   *
   * Kept beside the merged value rather than folded into it: "Claude says it is
   * blocked" and "Claude's screen looks blocked" are different facts with
   * different reliability, and the UI marks the second one so a user is never
   * told wmux knows something it inferred.
   */
  stateSource: 'declared' | 'detected' | null;
  /** What the screen said, independent of what the agent declared. */
  detectedState: AgentPresenceState | null;
}

export interface AgentCounts {
  blocked: number;
  working: number;
  idle: number;
  /** Identified, but silent about what it is doing. */
  unknown: number;
  /** Agents present, i.e. blocked + working + idle + unknown. Not the pane count. */
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

const EMPTY_COUNTS = (): AgentCounts => ({ blocked: 0, working: 0, idle: 0, unknown: 0, total: 0 });

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
  identity: AgentIdentitySnapshot | undefined,
  detection: DetectionSnapshot | undefined,
  now: number,
): AgentRosterEntry | null {
  const declaredState = declared && declared.state !== 'unknown' ? declared.state : null;
  const detectedState = detection && detection.state !== 'unknown' ? detection.state : null;
  const kind = identity?.kind ?? detection?.agent ?? null;

  // Three independent ways to be an agent pane: the agent said so, wmux
  // identified the process, or the screen carries an agent's chrome. Any one is
  // enough to be listed — an agent that reports nothing AND was started outside
  // wmux's sight is exactly the case detection exists to cover.
  if (!declaredState && !kind && !detectedState) return null;

  /**
   * THE precedence rule, and the point where this could have gone wrong.
   *
   * Declared beats detected, always. wmux deliberately does NOT let a visible
   * blocker override a stale declaration, which is where the prior art goes the
   * other way — because in wmux `blocked` never expires AND answering never
   * clears it, so a screen rule re-asserting `blocked` on a repainted frame
   * would make the sidebar's answer button permanently useless.
   *
   * `unknown` rather than `idle` when nobody spoke: idle is a claim.
   */
  const state: AgentPresenceState = declaredState ?? detectedState ?? 'unknown';
  const stateSource = resolveStateSource(declaredState, detectedState);
  const blocked = state === 'blocked';
  const choices = blocked ? (declared?.choices ?? []) : [];
  // A stamped blockedSince is truthful; updatedAt is the best guess when main
  // did not stamp one. The dwell is clamped at 0 — a report from the future
  // (clock skew, a replayed hookAt) must not sort to the top of the queue.
  const since = (blocked ? declared?.blockedSince : null) ?? declared?.updatedAt ?? now;

  return {
    surfaceId: surface.surfaceId,
    paneId: surface.paneId,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    // The agent's own name beats a folder name: with three panes in one repo,
    // "myproj / myproj / myproj" identifies nothing, "claude / codex / claude"
    // is the distinction the user is looking at the list to make. A hand-set tab
    // title still wins over both — it is the only label the user chose.
    label: surface.customTitle ?? kind ?? cwdBasename(surface.currentCwd) ?? 'Agent',
    state,
    blockedReason: blocked ? (declared?.blockedReason ?? null) : null,
    choices,
    answerPending: blocked && choices.length === 0 && !!declared?.answeredAt,
    dwellMs: Math.max(0, now - since),
    kind,
    identitySource: identity?.source ?? null,
    stateSource,
    detectedState,
  };
}

/** Which layer supplied `state`. Declared always wins — see the note above. */
function resolveStateSource(
  declaredState: AgentPresenceState | null,
  detectedState: AgentPresenceState | null,
): AgentRosterEntry['stateSource'] {
  if (declaredState) return 'declared';
  if (detectedState) return 'detected';
  return null;
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
  identities: Record<string, AgentIdentitySnapshot | undefined> = {},
  detections: Record<string, DetectionSnapshot | undefined> = {},
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
      const entry = rosterEntryFor(
        surface,
        workspace,
        agentStates[surface.surfaceId],
        identities[surface.surfaceId],
        detections[surface.surfaceId],
        now,
      );
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
  // `idle` outranks `unknown` because it is a claim someone actually made; a
  // workspace of nothing but silent agents must not borrow it.
  if (counts.idle > 0) return 'idle';
  return 'unknown';
}
