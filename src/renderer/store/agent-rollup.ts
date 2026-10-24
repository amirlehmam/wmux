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
export type AgentPresenceState = 'blocked' | 'question' | 'working' | 'idle' | 'unknown';

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
  /** When the renderer published this verdict. Absent → it cannot be placed in time. */
  observedAt?: number;
  /** The declared session on the surface when it was published, if any. */
  sessionId?: string | null;
}

/**
 * What the agent reported about itself (src/main/agent-state.ts,
 * `AgentMetadata`). Main stamps `expiresAt` from the report's TTL; consumers
 * must honor it — a token count is a claim with a shelf life.
 */
export interface DeclaredAgentMetadata {
  model?: string;
  tokens?: string;
  /** 0-100. */
  contextPct?: number;
  /** Wall-clock ms; past this, render nothing rather than a stale value. */
  expiresAt?: number;
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
  /** The agent session main has on record for this surface. */
  sessionId?: string | null;
  /**
   * When this surface's current idle period began, stamped by the renderer on
   * the transition INTO idle (see withIdleSince). Not `updatedAt`: that moves
   * on every metadata report, so it cannot say when a turn ended.
   */
  idleSince?: number;
  /**
   * When this pane became blocked, if main stamped it. Distinct from
   * `updatedAt` because a blocked agent that keeps reporting token counts would
   * otherwise look as though it had just started waiting.
   */
  blockedSince?: number | null;
  /** Model / token / context claims, if the agent reported any. */
  metadata?: DeclaredAgentMetadata;
}

export interface AgentRosterEntry {
  surfaceId: SurfaceId;
  paneId: PaneId;
  workspaceId: WorkspaceId;
  /**
   * What the workspace is called: its label from `rollupAgents`'
   * `workspaceLabels` (the sidebar's name, #343), else its stored title.
   */
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
  /** The agent's live metadata claims, null when absent or expired. */
  metadata: DeclaredAgentMetadata | null;
}

export interface AgentCounts {
  blocked: number;
  /** Finished its turn on an ordinary question; nothing to approve. */
  question: number;
  working: number;
  idle: number;
  /** Identified, but silent about what it is doing. */
  unknown: number;
  /** Agents present, i.e. blocked + question + working + idle + unknown. Not the pane count. */
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
  defaultTitle?: string;
}

function collectSurfaces(tree: SplitNode, out: SurfaceEntry[]): void {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) {
      out.push({
        surfaceId: s.id,
        paneId: tree.paneId,
        currentCwd: (s as { currentCwd?: string }).currentCwd,
        customTitle: s.customTitle,
        defaultTitle: s.defaultTitle,
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

const EMPTY_COUNTS = (): AgentCounts => ({ blocked: 0, question: 0, working: 0, idle: 0, unknown: 0, total: 0 });

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
  workspaceTitle: string,
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
  const refined = isCurrentQuestion(declared, detection) ? 'question' : declaredState;
  const state: AgentPresenceState = refined ?? screenOnlyState(detectedState) ?? 'unknown';
  const stateSource = refined !== declaredState ? 'detected' : resolveStateSource(declaredState, detectedState);
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
    workspaceTitle,
    // The agent's own name beats a folder name: with three panes in one repo,
    // "myproj / myproj / myproj" identifies nothing, "claude / codex / claude"
    // is the distinction the user is looking at the list to make. A hand-set tab
    // title still wins over both — it is the only label the user chose.
    label: surface.customTitle ?? kind ?? surface.defaultTitle ?? cwdBasename(surface.currentCwd) ?? 'Agent',
    state,
    blockedReason: blocked ? (declared?.blockedReason ?? null) : null,
    choices,
    answerPending: blocked && choices.length === 0 && !!declared?.answeredAt,
    dwellMs: Math.max(0, now - since),
    kind,
    identitySource: identity?.source ?? null,
    stateSource,
    detectedState,
    metadata: liveMetadata(declared?.metadata, now),
  };
}

/**
 * Metadata is a claim with a shelf life — render nothing rather than a stale
 * token count. Main always sends a `metadata` object (`{}` when nothing was
 * reported or it expired server-side), so emptiness must map to null too or
 * the roster's "null when absent" contract would never hold in practice.
 */
function liveMetadata(
  meta: DeclaredAgentMetadata | undefined,
  now: number,
): DeclaredAgentMetadata | null {
  if (!meta) return null;
  if (typeof meta.expiresAt === 'number' && meta.expiresAt <= now) return null;
  if (meta.model === undefined && meta.tokens === undefined && meta.contextPct === undefined) return null;
  return meta;
}

/**
 * One surface's agent state, for consumers that have a surfaceId and no roster.
 *
 * The same precedence as the roster, exported rather than re-derived: the tab
 * bar and the roster disagreeing about whether a pane is blocked would be worse
 * than either being wrong, and "declared beats detected" is a rule that must
 * exist once. Returns null when no layer claims the surface.
 */
/**
 * A visible, CURRENT question refines a declared `idle`, and nothing else.
 *
 * The agent's hooks say "my turn ended", which is true and says nothing about
 * the question its last message closed on. It never overrides `working` or
 * `blocked`: those are claims about the present, and a repainted screen must
 * not outvote them (see the precedence note in rosterEntryFor).
 *
 * "Current" is checked, not assumed. The stored verdict is only what the
 * screen said the last time it was read, so it must have been read during this
 * idle period (same turn) and for the session main has on record now (same
 * session). Evidence that cannot be placed in either is never promoted: the
 * surface then reads as plain `idle`, which is what the agent itself declared.
 */
export function isCurrentQuestion(
  declared: DeclaredAgentSnapshot | undefined,
  detection: DetectionSnapshot | undefined,
): boolean {
  if (!declared || declared.state !== 'idle' || detection?.state !== 'question') return false;
  // Same turn: the screen was read after this idle period began. A verdict
  // stored earlier describes a previous turn — and a declared agent used not to
  // be rescanned at all, so "earlier" could mean hours.
  const { idleSince } = declared;
  const { observedAt } = detection;
  if (typeof idleSince !== 'number' || !Number.isFinite(idleSince)) return false;
  if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) return false;
  if (observedAt < idleSince) return false;
  // Same session: a surface can outlive the agent session that asked.
  return (declared.sessionId ?? null) === (detection.sessionId ?? null) && 'sessionId' in detection;
}

/**
 * Does a declared state stop the scan loop from reading this surface?
 *
 * Working and blocked do: the agent is reporting, and a result that is never
 * produced cannot leak into a merge. Idle does not, because an idle agent is
 * exactly where an unanswered question sits — the hooks say "my turn ended"
 * and nothing about what the last message asked.
 */
export function detectionPausedBy(declaredState: string | undefined): boolean {
  return declaredState === 'working' || declaredState === 'blocked';
}

/**
 * Carry `idleSince` across one declared-state delta.
 *
 * Stamped with the renderer's clock on the transition into idle and kept for
 * as long as the surface stays idle in the same session; dropped the moment it
 * is anything else. A new session restarts it even from idle to idle (a resume
 * reports no turn), or a question it asks would sit under the old stamp and
 * never be republished. Main's snapshot always carries `sessionId`, so a
 * metadata-only report cannot restart it by omission.
 * The renderer's clock on purpose: it is compared against `observedAt`, which
 * the same renderer stamps, so no cross-process skew enters the comparison.
 */
export function withIdleSince<T extends DeclaredAgentSnapshot>(
  previous: DeclaredAgentSnapshot | undefined,
  next: T,
  now: number,
): T {
  if (next.state !== 'idle') return { ...next, idleSince: undefined };
  const samePeriod = previous?.state === 'idle' && (previous.sessionId ?? null) === (next.sessionId ?? null);
  const kept = samePeriod ? previous.idleSince : undefined;
  return { ...next, idleSince: kept ?? now };
}

/** The fields of a stored or fresh verdict that decide whether to publish it. */
interface PublishableDetection {
  agent: string | null;
  state: string;
  ruleId: string | null;
  observedAt?: number;
}

/**
 * Should the scan loop publish `next` over the verdict it last published?
 *
 * Unchanged verdicts are not published — the loop ticks several times a second
 * (#141). A question is the one exception, because its stamp is what makes it
 * current: a stamp older than the surface's current idle period must be
 * renewed, or the same question asked again next turn would never be shown.
 *
 * Evidence is deliberately not compared. The question rule's evidence includes
 * the prompt line, which carries the answer as the user types it, so comparing
 * it republished on every keystroke. Nothing reads the stored evidence, and a
 * second question in the same idle period is current under the first stamp.
 */
export function detectionNeedsPublish(
  previous: PublishableDetection | null | undefined,
  next: PublishableDetection,
  idleSince: number | undefined,
): boolean {
  if (!previous) return true;
  if (previous.state !== next.state || previous.agent !== next.agent || previous.ruleId !== next.ruleId) return true;
  if (next.state !== 'question') return false;
  return typeof idleSince === 'number' && (previous.observedAt ?? -Infinity) < idleSince;
}

export function surfaceAgentState(
  declared: DeclaredAgentSnapshot | undefined,
  detection: DetectionSnapshot | undefined,
): { state: AgentPresenceState; source: 'declared' | 'detected' } | null {
  if (isCurrentQuestion(declared, detection)) return { state: 'question', source: 'detected' };
  if (declared && declared.state !== 'unknown') return { state: declared.state, source: 'declared' };
  const seen = screenOnlyState(detection && detection.state !== 'unknown' ? detection.state : null);
  return seen ? { state: seen, source: 'detected' } : null;
}

/**
 * What a screen verdict stands for when no agent declared anything.
 *
 * `question` only ever refines a declared idle (isCurrentQuestion): without one
 * there is no turn and no session to place it in. What such a screen does show
 * is a finished turn at an open prompt, which is idle.
 */
function screenOnlyState(detected: AgentPresenceState | null): AgentPresenceState | null {
  return detected === 'question' ? 'idle' : detected;
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

const NO_WORKSPACE_LABELS: ReadonlyMap<WorkspaceId, string> = new Map();

/**
 * Fold declared agent state over the live workspace list.
 *
 * Walking the split trees rather than the state map is the point, not an
 * implementation detail: AGENT_STATE is a delta channel and main prunes its
 * records only through a 256-entry LRU, so the renderer's map accumulates
 * entries for surfaces that were closed minutes ago. Iterating the map would
 * make "2 need you" survive closing both panes.
 *
 * @param workspaceLabels What each workspace is called, by id
 *   (`useWorkspaceLabels`, or `selectWorkspaceLabels` outside React). Every
 *   caller that SHOWS `workspaceTitle` passes it, so the roster names a
 *   workspace the way the sidebar does (#343); a workspace it does not list, or
 *   a caller that only counts, gets the stored title.
 */
export function rollupAgents(
  workspaces: WorkspaceInfo[],
  agentStates: Record<string, DeclaredAgentSnapshot | undefined>,
  now: number,
  identities: Record<string, AgentIdentitySnapshot | undefined> = {},
  detections: Record<string, DetectionSnapshot | undefined> = {},
  workspaceLabels: ReadonlyMap<WorkspaceId, string> = NO_WORKSPACE_LABELS,
): AgentRollup {
  const byWorkspace: Record<string, AgentCounts> = {};
  const totals = EMPTY_COUNTS();
  const roster: AgentRosterEntry[] = [];

  for (const workspace of workspaces) {
    const counts = EMPTY_COUNTS();
    byWorkspace[workspace.id] = counts;

    const surfaces: SurfaceEntry[] = [];
    collectSurfaces(workspace.splitTree, surfaces);
    const workspaceTitle = workspaceLabels.get(workspace.id) ?? workspace.title;

    for (const surface of surfaces) {
      const entry = rosterEntryFor(
        surface,
        workspace,
        workspaceTitle,
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
 * The roster ranked by who is waiting on the user.
 *
 * Permission prompts first, longest-waiting first; then questions; then
 * everything else — each of the last two in tree order. A question has no dwell
 * to rank by (nothing declared when it was asked), so tree order is the honest
 * one. Same chain as `workspaceAgentState`, so the list and the sidebar cannot
 * disagree about which agent comes first.
 */
export function rankedRoster(rollup: AgentRollup): AgentRosterEntry[] {
  const questions = rollup.roster.filter((e) => e.state === 'question');
  const rest = rollup.roster.filter((e) => e.state !== 'blocked' && e.state !== 'question');
  return [...rollup.blocked, ...questions, ...rest];
}

/**
 * The one agent a "go to who needs me" button should land on: the permission
 * prompt waiting longest, else the first question in tree order, else none.
 * Read off the same ranking, so the button cannot pick a different agent from
 * the one the list puts first.
 */
export function firstWaiting(rollup: AgentRollup): AgentRosterEntry | undefined {
  const first = rankedRoster(rollup)[0];
  return first && (first.state === 'blocked' || first.state === 'question') ? first : undefined;
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
  // Waiting on the user, so ahead of work that proceeds on its own.
  if (counts.question > 0) return 'question';
  if (counts.working > 0) return 'working';
  // `idle` outranks `unknown` because it is a claim someone actually made; a
  // workspace of nothing but silent agents must not borrow it.
  if (counts.idle > 0) return 'idle';
  return 'unknown';
}
