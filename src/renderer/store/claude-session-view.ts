import { SplitNode, SurfaceId, PaneId } from '../../shared/types';
import type { AgentPresenceState, AgentRosterEntry, DeclaredAgentSnapshot } from './agent-rollup';
import { runningBackgroundShells } from './agent-view';

/** One sidebar hook-activity entry — written by App.tsx from Claude Code hook events. */
export interface HookActivityEntry {
  lastTool: string;
  toolCount: number;
  lastSeen: number;
}

/** Observer shape (subset of ClaudeActivity from src/main/claude-observer.ts). */
interface ObserverActivity {
  agents: Array<{ name: string; toolUses: number; tokens: string; done: boolean; id?: string; kind?: 'shell'; touchedAt?: number }>;
  activeSkill: string | null;
  lastTool: string | null;
  lastUpdate: number;
  isDone: boolean;
}

/** Tool labels expire independently of the agent's declared run state. */
export const SESSION_ACTIVITY_TTL_MS = 5000;

/** An answer is only offerable when the agent explicitly declared it. */
export interface AgentChoiceView {
  id: string;
  label: string;
}

/** Sidebar details enrich roster membership; history cannot establish presence. */
export interface ClaudeSessionView {
  surfaceId: SurfaceId;
  paneId: PaneId;
  /** User-set tab title, else folder name of the pane's cwd — distinguishes sessions at a glance. */
  label: string;
  state: AgentPresenceState;
  working: boolean;
  /**
   * Shells the agent left running are independent of its own turn state: an
   * idle agent can still have tests running in the background.
   */
  backgroundShells: number;
  /** A blocked agent needs the human even when every activity signal is quiet. */
  blocked: boolean;
  /**
   * A finished turn asking a question is distinct from a blocked permission
   * prompt: nothing is parked behind it and there is nothing to approve here.
   */
  question: boolean;
  blockedReason: string | null;
  /** Only choices explicitly declared for a live block may be offered. */
  choices: AgentChoiceView[];
  /** Relaying an answer does not clear the block until the agent confirms. */
  answerPending: boolean;
  /** Raw tool name while working, null when idle or unknown. */
  tool: string | null;
  skill: string | null;
}

export interface WorkspaceSessionsView {
  /** Tree order — stable across renders. */
  sessions: ClaudeSessionView[];
  working: number;
  blocked: number;
  /**
   * A workspace represents several panes, so the oldest open block determines
   * how long it has needed the human. Null means nothing is currently blocked.
   */
  oldestBlockedSince: number | null;
}

interface SurfaceEntry {
  surfaceId: SurfaceId;
  paneId: PaneId;
  currentCwd?: string;
  customTitle?: string;
  defaultTitle?: string;
}

function collectTerminalSurfaces(tree: SplitNode, out: SurfaceEntry[]): void {
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
  collectTerminalSurfaces(tree.children[0], out);
  collectTerminalSurfaces(tree.children[1], out);
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

/**
 * The roster owns both presence and state so released agents cannot survive as
 * idle rows through retained hook or observer history. Keep the sidebar's pane
 * labels and activity details without using them to invent agent membership.
 * Read the original block timestamp separately so roster dwell-time fallbacks
 * do not change the sidebar's existing oldest-block timing.
 */
export function claudeSessionsForWorkspace(
  splitTree: SplitNode,
  claudeActivity: Record<string, ObserverActivity | undefined>,
  hookActivity: Record<string, HookActivityEntry | undefined>,
  now: number,
  roster: readonly AgentRosterEntry[],
  agentStates: Record<string, DeclaredAgentSnapshot | undefined>,
): WorkspaceSessionsView {
  const surfaces: SurfaceEntry[] = [];
  collectTerminalSurfaces(splitTree, surfaces);
  const bySurface = new Map(roster.map(entry => [entry.surfaceId, entry]));

  const sessions: ClaudeSessionView[] = [];
  let working = 0;
  let blocked = 0;
  let oldestBlockedSince: number | null = null;

  for (const { surfaceId, paneId, currentCwd, customTitle, defaultTitle } of surfaces) {
    const entry = bySurface.get(surfaceId);
    if (!entry) continue;
    const hook = hookActivity[surfaceId];
    const observed = claudeActivity[surfaceId];
    const isWorking = entry.state === 'working';
    const isBlocked = entry.state === 'blocked';
    const declaredBlock = isBlocked && entry.stateSource === 'declared';
    const hookFresh = !!hook && now - hook.lastSeen < SESSION_ACTIVITY_TTL_MS;
    const obsFresh = !!observed && !observed.isDone && !!observed.lastTool
      && now - observed.lastUpdate < SESSION_ACTIVITY_TTL_MS;

    sessions.push({
      surfaceId,
      paneId,
      label: customTitle ?? defaultTitle ?? cwdBasename(currentCwd) ?? entry.kind ?? 'Agent',
      state: entry.state,
      working: isWorking,
      blocked: isBlocked,
      question: entry.state === 'question',
      blockedReason: declaredBlock ? entry.blockedReason : null,
      choices: declaredBlock ? entry.choices : [],
      answerPending: declaredBlock && entry.answerPending,
      tool: isWorking ? (obsFresh ? observed.lastTool : hookFresh ? hook.lastTool : null) : null,
      backgroundShells: runningBackgroundShells(observed, now),
      skill: observed?.activeSkill ?? null,
    });
    if (isWorking) working++;
    if (isBlocked) {
      blocked++;
      const since = agentStates[surfaceId]?.blockedSince ?? now;
      if (oldestBlockedSince === null || since < oldestBlockedSince) oldestBlockedSince = since;
    }
  }

  return { sessions, working, blocked, oldestBlockedSince };
}
