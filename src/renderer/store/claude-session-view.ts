import { SplitNode, SurfaceId, PaneId } from '../../shared/types';

/** One sidebar hook-activity entry — written by App.tsx from Claude Code hook events. */
export interface HookActivityEntry {
  lastTool: string;
  toolCount: number;
  lastSeen: number;
}

/** Observer shape (subset of ClaudeActivity from src/main/claude-observer.ts). */
interface ObserverActivity {
  agents: Array<{ name: string; toolUses: number; tokens: string; done: boolean }>;
  activeSkill: string | null;
  lastTool: string | null;
  lastUpdate: number;
  isDone: boolean;
}

/** How long a hook/observer signal counts as "actively working" (ms). */
export const SESSION_ACTIVITY_TTL_MS = 5000;

/** One answer the blocked agent declared it will accept (issue #128). */
export interface AgentChoiceView {
  id: string;
  label: string;
}

/** Declared state pushed by the agent itself (src/main/agent-state.ts, issue #128). */
export interface DeclaredAgentState {
  state: 'blocked' | 'working' | 'idle' | 'unknown';
  blockedReason?: string | null;
  choices?: AgentChoiceView[];
  answeredAt?: number | null;
}

/** One Claude Code session (= one surface where Claude ran) inside a workspace. */
export interface ClaudeSessionView {
  surfaceId: SurfaceId;
  paneId: PaneId;
  /** User-set tab title, else folder name of the pane's cwd — distinguishes sessions at a glance. */
  label: string;
  working: boolean;
  /**
   * The agent is parked on a human — a permission prompt, a question, a menu.
   * Distinct from `working`: a blocked agent emits nothing while it waits, so
   * the freshness heuristic alone would decay it to idle and hide the one pane
   * that actually needs the user (issue #128).
   */
  blocked: boolean;
  /** What it is waiting for, when the agent said. */
  blockedReason: string | null;
  /**
   * Answers offerable from the sidebar. Empty for a blocked pane whose agent
   * declared none — still worth showing as "needs you", just not answerable
   * from here.
   */
  choices: AgentChoiceView[];
  /** An answer has been relayed and the agent has not yet reported back. */
  answerPending: boolean;
  /** Raw tool name while working, null when idle or unknown. */
  tool: string | null;
  skill: string | null;
}

export interface WorkspaceSessionsView {
  /** Tree order — stable across renders. */
  sessions: ClaudeSessionView[];
  /** Number of sessions currently working. */
  working: number;
  /** Number of sessions parked on the user — the "who needs me?" count. */
  blocked: number;
}

interface SurfaceEntry {
  surfaceId: SurfaceId;
  paneId: PaneId;
  currentCwd?: string;
  customTitle?: string;
}

function collectTerminalSurfaces(tree: SplitNode, out: SurfaceEntry[]): void {
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
 * Fold the three signals for one surface into what the sidebar shows.
 *
 * Declared state beats inference: the agent knows what it is doing, whereas
 * the 5s freshness window is only a guess for agents that never told us.
 * `unknown` — never reported, or explicitly released — falls back to the
 * heuristic rather than overriding it with a confident "idle".
 */
function resolveActivity(
  hook: HookActivityEntry | undefined,
  observed: ObserverActivity | undefined,
  declared: DeclaredAgentState | undefined,
  now: number,
): Pick<ClaudeSessionView, 'working' | 'blocked' | 'blockedReason' | 'tool' | 'choices' | 'answerPending'> {
  const hookFresh = !!hook && now - hook.lastSeen < SESSION_ACTIVITY_TTL_MS;
  const obsFresh = !!observed && !observed.isDone && !!observed.lastTool
    && now - observed.lastUpdate < SESSION_ACTIVITY_TTL_MS;

  const declaredKnown = !!declared && declared.state !== 'unknown';
  const blocked = declared?.state === 'blocked';
  const working = declaredKnown ? declared.state === 'working' : (hookFresh || obsFresh);

  let tool: string | null = null;
  if (obsFresh) tool = observed.lastTool;
  else if (hookFresh && hook.lastTool) tool = hook.lastTool;

  // Choices only ever ride along with a live block. An answered prompt keeps
  // showing "sent" until the agent confirms — wmux deliberately does not clear
  // `blocked` on its own say-so (see answerAgent in src/main/agent-state.ts).
  const choices = blocked ? (declared?.choices ?? []) : [];
  const answerPending = blocked && choices.length === 0 && !!declared?.answeredAt;

  return {
    working,
    blocked,
    blockedReason: blocked ? (declared?.blockedReason ?? null) : null,
    tool,
    choices,
    answerPending,
  };
}

/**
 * Per-surface Claude session states of one workspace. A surface is a session
 * as soon as EITHER a hook event or observer activity was ever recorded for it
 * — entries never expire (a stale entry just reads as idle), mirroring the
 * intentional keep-forever semantics of hookActivity in App.tsx: "was active
 * but stopped" (idle) must stay distinguishable from "plain shell command"
 * (no session), or the row falls back to the shell's perpetual "Running".
 */
export function claudeSessionsForWorkspace(
  splitTree: SplitNode,
  claudeActivity: Record<string, ObserverActivity | undefined>,
  hookActivity: Record<string, HookActivityEntry | undefined>,
  now: number,
  agentStates: Record<string, DeclaredAgentState | undefined> = {},
): WorkspaceSessionsView {
  const surfaces: SurfaceEntry[] = [];
  collectTerminalSurfaces(splitTree, surfaces);

  const sessions: ClaudeSessionView[] = [];
  let working = 0;
  let blocked = 0;

  for (const { surfaceId, paneId, currentCwd, customTitle } of surfaces) {
    const hook = hookActivity[surfaceId];
    const observed = claudeActivity[surfaceId];
    const declared = agentStates[surfaceId];
    // A declared state alone is enough to make a surface a session — an agent
    // that reports over the pipe need never trip a hook or the TUI scraper.
    if (!hook && !observed && !declared) continue;

    const activity = resolveActivity(hook, observed, declared, now);

    sessions.push({
      surfaceId,
      paneId,
      // User-set tab title wins (rename must reflect here); cwd folder second.
      label: customTitle ?? cwdBasename(currentCwd) ?? 'Claude',
      ...activity,
      skill: observed?.activeSkill ?? null,
    });
    if (activity.working) working++;
    if (activity.blocked) blocked++;
  }

  return { sessions, working, blocked };
}
