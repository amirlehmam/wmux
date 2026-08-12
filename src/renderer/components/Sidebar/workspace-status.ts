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
import type { TranslationKey } from '../../i18n';

export type T = (key: TranslationKey, fallback?: string) => string;

export interface StatusTextInputs {
  statusOverride?: 'running' | 'idle';
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

/** Priorities 0–2: Claude-derived signals. Null → fall through to shell state. */
export function claudeStatusText(s: StatusTextInputs, t: T): string | null {
  // Priority 0: user pinned the status by hand (issue #81) — detection
  // heuristics can misread tools that keep the shell "running" while idle.
  if (s.statusOverride) {
    return s.statusOverride === 'running' ? t('workspaceRow.running', 'Running') : t('workspaceRow.idle', 'Idle');
  }

  // Priority 0.25: a session is parked on the user. Ranked above the running
  // summaries on purpose — everything else describes work that proceeds on its
  // own, this describes work that has stopped until the user acts (issue #128).
  if (s.blockedSessions > 0) {
    return s.blockedSessions > 1
      ? t('workspaceRow.needsYouCount', 'Needs you · {count}').replace('{count}', String(s.blockedSessions))
      : t('workspaceRow.needsYou', 'Needs you');
  }

  // Priority 0.5: agents are running — show the orchestration summary
  if (s.runningAgentCount > 0) {
    return (s.agentTotal > 1
      ? t('workspaceRow.orchestratingMany', 'Orchestrating · {count} agents')
      : t('workspaceRow.orchestratingOne', 'Orchestrating · {count} agent')
    ).replace('{count}', String(s.agentTotal));
  }

  // Priority 0.75: several Claude sessions in this workspace — summarize;
  // the per-session sub-lines below the status carry the detail.
  if (s.sessionCount >= 2) {
    return s.workingSessions > 0
      ? t('workspaceRow.claudeRunning', 'Claude · {working}/{total} running')
        .replace('{working}', String(s.workingSessions))
        .replace('{total}', String(s.sessionCount))
      : t('workspaceRow.idle', 'Idle');
  }

  // Priority 1: Claude is actively using a tool
  if (s.currentToolLabel) return s.currentToolLabel;

  // Priority 1.5: the session DECLARED it is working, but no tool label is
  // live. Ranked below the label because the label says more ("Reading
  // file…"), and above everything after it because this is the authoritative
  // signal — the agent's own claim, not a decaying inference.
  //
  // The gap this closes: `workingSessions` used to be read only in the
  // `sessionCount >= 2` branch above, so the common case of ONE agent pane
  // never consulted it. PostToolUse fires when a tool FINISHES, so during a
  // stretch of thinking, or one slow tool, the label expires while the turn
  // runs on; the chain then fell through to the shell, and a shell reporting
  // idle (the Claude Code TUI is not a "running command") rendered the row
  // "Idle" mid-turn. The per-session sub-line already got this right — see
  // sessionDetailText — so the row contradicted the very lines beneath it.
  if (s.workingSessions > 0) return t('workspaceRow.sessionRunning', 'Running…');

  // Priority 2: Claude was working but stopped → idle, not "Running"
  if (s.claudeIsIdle) return t('workspaceRow.idle', 'Idle');

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
  if (s.blockedSessions > 0) return 'workspace-row__status--blocked';
  if (s.runningAgentCount > 0) return 'workspace-row__status--working';
  if (s.sessionCount >= 2) {
    return s.workingSessions > 0 ? 'workspace-row__status--working' : 'workspace-row__status--idle';
  }
  if (s.currentToolLabel) return 'workspace-row__status--working';
  // Mirrors Priority 1.5 above — the declared claim, with no live tool label.
  if (s.workingSessions > 0) return 'workspace-row__status--working';
  if (s.claudeIsIdle) return 'workspace-row__status--idle';
  if (s.shellState === 'running') return 'workspace-row__status--running';
  if (s.shellState === 'interrupted') return 'workspace-row__status--interrupted';
  if (s.shellState === 'idle') return 'workspace-row__status--done';
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
