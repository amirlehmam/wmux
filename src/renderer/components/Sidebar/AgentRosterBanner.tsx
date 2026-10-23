import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { firstWaiting, rollupAgents } from '../../store/agent-rollup';
import type { AgentRosterEntry } from '../../store/agent-rollup';

/**
 * "Who needs me?", answered above the workspace list.
 *
 * wmux already knew this per workspace — `claudeSessionsForWorkspace` counts
 * blocked and working panes, and the row renders "Needs you · N" from it — but
 * the count died inside that row's render. With ten workspaces the user still
 * had to read ten rows to find the one that had stopped, which is the exact
 * scan the declared-state protocol was built to remove.
 *
 * Auto-hides when no agent is running anywhere, on the same contract as
 * OrchestrationPanel: a user who never runs an agent never sees it.
 */
export default function AgentRosterBanner({ onFocusAgent, onOpenNavigator }: {
  onFocusAgent?: (entry: AgentRosterEntry) => void;
  onOpenNavigator?: () => void;
}) {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const agentStates = useStore((s) => s.agentStates);
  const agentIdentities = useStore((s) => s.agentIdentities);
  const agentDetections = useStore((s) => s.agentDetections);
  const [now, setNow] = useState(() => Date.now());

  const rollup = useMemo(
    () => rollupAgents(workspaces, agentStates, now, agentIdentities, agentDetections),
    [workspaces, agentStates, agentIdentities, agentDetections, now],
  );

  const { blocked, question, working, total } = rollup.totals;

  // Only tick while something is actually waiting: the dwell label is the only
  // thing here that changes on its own, and a blocked agent is the only state
  // that shows one. An idle roster costs no timer at all.
  useEffect(() => {
    if (blocked === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [blocked]);

  if (total === 0) return null;

  // A permission prompt first, else a question; never a question ahead of a
  // prompt, which has a dwell to rank by where a question has none.
  const target = firstWaiting(rollup);
  const oldest = target?.state === 'blocked' ? target : undefined;
  const where = target ? `${target.workspaceTitle} · ${target.label}` : '';

  return (
    <div className="agent-roster" data-blocked={blocked > 0} data-question={blocked === 0 && question > 0}>
      <button
        className="agent-roster__main"
        disabled={!target}
        onClick={() => target && onFocusAgent?.(target)}
        title={oldest
          ? t('agentRoster.jumpHint', 'Go to the agent waiting longest — {label}').replace('{label}', where)
          : target
            ? t('agentRoster.jumpQuestionHint', 'Go to the agent asking you a question — {label}').replace('{label}', where)
            : t('agentRoster.noneBlocked', 'No agent is waiting on you')}
      >
        <span className="agent-roster__dot" />
        <span className="agent-roster__count">
          {blocked > 0
            ? t('agentRoster.needYou', '{count} need you').replace('{count}', String(blocked))
            : question > 0
              ? t('agentRoster.asking', '{count} asking').replace('{count}', String(question))
              : t('agentRoster.allBusy', '{count} working').replace('{count}', String(working))}
        </span>
        {blocked > 0 && question > 0 && (
          <span className="agent-roster__secondary">
            {t('agentRoster.alsoAsking', '· {count} asking').replace('{count}', String(question))}
          </span>
        )}
        {(blocked > 0 || question > 0) && working > 0 && (
          <span className="agent-roster__secondary">
            {t('agentRoster.alsoWorking', '· {count} working').replace('{count}', String(working))}
          </span>
        )}
        {oldest && <span className="agent-roster__dwell">{formatDwell(oldest.dwellMs)}</span>}
      </button>

      <button
        className="agent-roster__expand"
        onClick={() => onOpenNavigator?.()}
        title={t('agentRoster.openNavigator', 'All agents (Ctrl+Shift+A)')}
        aria-label={t('agentRoster.openNavigator', 'All agents (Ctrl+Shift+A)')}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M2 4h12v1.5H2V4zm0 3.25h12v1.5H2v-1.5zM2 10.5h12V12H2v-1.5z" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Compact enough for a narrow sidebar: "12s", "4m", "1h20".
 *
 * Seconds are dropped past a minute on purpose — the number is there to rank
 * two waiting agents against each other, not to time them, and a value that
 * changes every second draws the eye away from the one that matters.
 */
export function formatDwell(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
}
