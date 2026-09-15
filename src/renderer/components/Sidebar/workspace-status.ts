/**
 * The workspace row's status line — which of the competing signals wins.
 *
 * Lives beside the component rather than inside it (as reorder.ts and
 * trace-signals.ts already do) because the precedence chain is the part worth
 * testing: it arbitrates between a DECLARED agent state, two decaying
 * heuristics (the TUI scraper and hook activity), and the shell's own idea of
 * whether it is busy. Getting that order wrong is invisible in a type check and
 * obvious to anyone watching the sidebar.
 */
import type { AgentCounts } from '../../store/agent-rollup';
import type { TranslationKey } from '../../i18n';

export type T = (key: TranslationKey, fallback?: string) => string;

export interface StatusTextInputs {
  statusOverride?: 'running' | 'idle';
  /**
   * This workspace's slice of the agent roster (declared state AND screen
   * detection), or undefined where no rollup was supplied. Folded into the
   * older signals by `mergedAgentSignals` — never read directly by a chain.
   */
  agentCounts?: AgentCounts;
  runningAgentCount: number;
  agentTotal: number;
  sessionCount: number;
  workingSessions: number;
  blockedSessions: number;
  currentToolLabel: string | null;
  claudeIsIdle: boolean;
  shellState?: string;
  notificationText?: string;
}

/** What the three chains below arbitrate on, once the roster is folded in. */
export interface MergedAgentSignals {
  /** Panes parked on the user, from either source. */
  blocked: number;
  /** Panes actively working, from either source. */
  working: number;
  /** Something claimed it had stopped. A claim, not an absence of one. */
  idle: boolean;
}

/**
 * Fold the roster's counts into the signals this module already arbitrated on.
 *
 * Issue #235 was the sidebar answering one question from two sets of facts: the
 * roster banner read `rollupAgents` (declared state AND screen detection) while
 * the workspace row read only the hook/observer-derived sessions. An agent
 * reached through ssh + tmux reports no hooks back to this machine, so its
 * screen was detected as working while the row beside it said "Idle".
 *
 * The fix is to give both the same inputs. What it must NOT do is rank the
 * rollup as a priority level of its own above the rest of the chain, which
 * breaks two things at once:
 *
 *  - The older signals answer a FINER question than the rollup does. "Reading
 *    file…" says more than "Running…", so a rollup ranked above the tool label
 *    throws information away every time it agrees with it.
 *  - `unknown` is the case the declared-state protocol exists for (issue #128):
 *    it means "an agent is here and has not said what it is doing", so it must
 *    fall THROUGH to the heuristics, never over them. As its own level it put
 *    the literal word "Unknown" on a row whose shell knew perfectly well that
 *    it was running, and dropped that row's state dot entirely.
 *
 * So each roster count joins the existing signal it is evidence for, and the
 * priority chain below is left exactly as it was. `unknown` contributes to no
 * count and therefore changes nothing — absence of a claim is not a claim.
 */
export function mergedAgentSignals(s: StatusTextInputs): MergedAgentSignals {
  const counts = s.agentCounts;
  return {
    blocked: Math.max(s.blockedSessions, counts?.blocked ?? 0),
    working: Math.max(s.workingSessions, counts?.working ?? 0),
    // `claudeIsIdle` is gated on a running shell where it is computed; a
    // declared or detected idle agent is a claim in its own right and needs no
    // such gate.
    idle: s.claudeIsIdle || (counts?.idle ?? 0) > 0,
  };
}

/** "Needs you", with the count only when there is more than one. */
function needsYouText(blocked: number, t: T): string {
  return blocked > 1
    ? t('workspaceRow.needsYouCount', 'Needs you · {count}').replace('{count}', String(blocked))
    : t('workspaceRow.needsYou', 'Needs you');
}

/** The multi-session summary line, or "Idle" when none of them is working. */
function multiSessionText(s: StatusTextInputs, agent: MergedAgentSignals, t: T): string {
  // Clamped: the roster can see agents this workspace has no tracked SESSION
  // for, and "3/2 running" reads as a bug rather than as detection working.
  const working = Math.min(agent.working, s.sessionCount);
  if (working === 0) return t('workspaceRow.idle', 'Idle');
  return t('workspaceRow.claudeRunning', 'Claude · {working}/{total} running')
    .replace('{working}', String(working))
    .replace('{total}', String(s.sessionCount));
}

/** Priorities 0–2: Claude-derived signals. Null → fall through to shell state. */
export function claudeStatusText(s: StatusTextInputs, t: T): string | null {
  // Priority 0: user pinned the status by hand (issue #81) — detection
  // heuristics can misread tools that keep the shell "running" while idle.
  if (s.statusOverride) {
    return s.statusOverride === 'running' ? t('workspaceRow.running', 'Running') : t('workspaceRow.idle', 'Idle');
  }

  const agent = mergedAgentSignals(s);

  // Priority 0.25: a session is parked on the user. Ranked above the running
  // summaries on purpose — everything else describes work that proceeds on its
  // own, this describes work that has stopped until the user acts (issue #128).
  if (agent.blocked > 0) return needsYouText(agent.blocked, t);

  // Priority 0.5: agents are running — show the orchestration summary
  if (s.runningAgentCount > 0) {
    return (s.agentTotal > 1
      ? t('workspaceRow.orchestratingMany', 'Orchestrating · {count} agents')
      : t('workspaceRow.orchestratingOne', 'Orchestrating · {count} agent')
    ).replace('{count}', String(s.agentTotal));
  }

  // Priority 0.75: several Claude sessions in this workspace — summarize;
  // the per-session sub-lines below the status carry the detail.
  if (s.sessionCount >= 2) return multiSessionText(s, agent, t);

  // Priority 1: Claude is actively using a tool
  if (s.currentToolLabel) return s.currentToolLabel;

  // Priority 1.5: the pane is working, but no tool label is live. Ranked below
  // the label because the label says more ("Reading file…"), and above
  // everything after it because this is the authoritative signal — a claim the
  // agent made (or its screen carried), not a decaying inference.
  //
  // The gap this closes: `workingSessions` used to be read only in the
  // `sessionCount >= 2` branch above, so the common case of ONE agent pane
  // never consulted it. PostToolUse fires when a tool FINISHES, so during a
  // stretch of thinking, or one slow tool, the label expires while the turn
  // runs on; the chain then fell through to the shell, and a shell reporting
  // idle (the Claude Code TUI is not a "running command") rendered the row
  // "Idle" mid-turn. The per-session sub-line already got this right — see
  // sessionDetailText — so the row contradicted the very lines beneath it.
  if (agent.working > 0) return t('workspaceRow.sessionRunning', 'Running…');

  // Priority 2: Claude was working but stopped → idle, not "Running"
  if (agent.idle) return t('workspaceRow.idle', 'Idle');

  return null;
}

/**
 * The status line's modifier class, which must follow the SAME order as
 * claudeStatusText.
 *
 * Kept next to it deliberately: these two chains are written out separately
 * (one yields words, the other a class name) and drifted apart once already —
 * `workingSessions` was consulted only under `sessionCount >= 2` in BOTH, so a
 * single working pane rendered "Idle" in the text and the `--done` style in the
 * colour. Any priority added to one belongs in the other.
 */
export function statusClassFor(s: StatusTextInputs): string {
  if (s.statusOverride) {
    return s.statusOverride === 'running'
      ? 'workspace-row__status--running'
      : 'workspace-row__status--idle';
  }
  const agent = mergedAgentSignals(s);
  if (agent.blocked > 0) return 'workspace-row__status--blocked';
  if (s.runningAgentCount > 0) return 'workspace-row__status--working';
  if (s.sessionCount >= 2) {
    return agent.working > 0 ? 'workspace-row__status--working' : 'workspace-row__status--idle';
  }
  if (s.currentToolLabel) return 'workspace-row__status--working';
  // Mirrors Priority 1.5 above — the claim, with no live tool label.
  if (agent.working > 0) return 'workspace-row__status--working';
  if (agent.idle) return 'workspace-row__status--idle';
  return shellStatusClass(s.shellState);
}

/** The shell's own idea of the row's colour, once every agent signal is silent. */
function shellStatusClass(shellState: string | undefined): string {
  if (shellState === 'running') return 'workspace-row__status--running';
  if (shellState === 'interrupted') return 'workspace-row__status--interrupted';
  if (shellState === 'idle') return 'workspace-row__status--done';
  return 'workspace-row__status--idle';
}

/** Status line priority chain: override > agents > sessions > tool > idle > shell > notification. */
export function resolveStatusText(s: StatusTextInputs, t: T): string {
  const claude = claudeStatusText(s, t);
  if (claude) return claude;

  // Priority 3: Shell state from shell integration
  if (s.shellState === 'running') return t('workspaceRow.running', 'Running');
  if (s.shellState === 'interrupted') return t('workspaceRow.interrupted', 'Interrupted');
  if (s.shellState === 'idle') {
    return s.notificationText
      ? t('workspaceRow.done', 'Done: {text}').replace('{text}', s.notificationText)
      : t('workspaceRow.idle', 'Idle');
  }

  // Priority 4: Notification text without shell state
  if (s.notificationText) return s.notificationText;

  // Priority 5: Default — always show something
  return t('workspaceRow.idle', 'Idle');
}

/**
 * The workspace dot — the THIRD chain that has to agree with the other two.
 *
 * It lived inline in WorkspaceRow until #235 and had already drifted once (a
 * blocked workspace rendered a GREY dot beside a violet "Needs you", so the two
 * halves of one row disagreed about whether anything was wrong). Here it at
 * least sits against the chains it is supposed to mirror.
 */
export function stateDotClassFor(s: StatusTextInputs, isClaudeActive: boolean): string {
  if (s.statusOverride) return `workspace-row__state-dot--${s.statusOverride}`;
  const agent = mergedAgentSignals(s);
  if (agent.blocked > 0) return 'workspace-row__state-dot--blocked';
  if (isClaudeActive || agent.working > 0) return 'workspace-row__state-dot--running';
  if (agent.idle) return 'workspace-row__state-dot--idle';
  if (s.shellState === 'running') return 'workspace-row__state-dot--running';
  if (s.shellState === 'interrupted') return 'workspace-row__state-dot--interrupted';
  if (s.shellState === 'idle') return 'workspace-row__state-dot--idle';
  return '';
}
