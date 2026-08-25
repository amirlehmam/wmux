import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { rollupAgents, workspaceAgentState } from '../../store/agent-rollup';
import type { AgentRosterEntry, AgentPresenceState } from '../../store/agent-rollup';
import { formatDwell } from '../Sidebar/AgentRosterBanner';
import '../../styles/agent-navigator.css';

type Filter = 'all' | AgentPresenceState;

const FILTER_KEYS: Record<string, Filter> = { a: 'all', b: 'blocked', w: 'working', i: 'idle' };

/**
 * Every agent in the window, in one list, ranked by who needs you most.
 *
 * The sidebar answers "which workspace needs me" — this answers "which agent",
 * across workspaces, without expanding rows one at a time. It is read-only on
 * purpose: it navigates, it never answers a prompt. Answering is the sidebar's
 * back-channel, which is gated on the agent having DECLARED its choices, and a
 * list this far from the pane is the wrong place to relay a keystroke from.
 */
export default function AgentNavigator({ onClose, onFocusAgent }: {
  onClose: () => void;
  onFocusAgent?: (entry: AgentRosterEntry) => void;
}) {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const agentStates = useStore((s) => s.agentStates);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  const rollup = useMemo(
    () => rollupAgents(workspaces, agentStates, now),
    [workspaces, agentStates, now],
  );

  /**
   * Blocked first and longest-waiting first, then everything else in tree
   * order. Ranking by urgency rather than by position is the whole point: the
   * sidebar already shows tree order, and re-showing it here would answer a
   * question the user can already see the answer to.
   */
  const ordered = useMemo(() => {
    const rest = rollup.roster.filter((e) => e.state !== 'blocked');
    return [...rollup.blocked, ...rest];
  }, [rollup]);

  const visible = useMemo(
    () => (filter === 'all' ? ordered : ordered.filter((e) => e.state === filter)),
    [ordered, filter],
  );

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Clamp rather than reset: an agent unblocking under the cursor should not
  // throw the user back to the top of a list they were reading.
  useEffect(() => {
    setSelected((i) => Math.min(i, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, filter]);

  const jump = (entry: AgentRosterEntry | undefined) => {
    if (!entry) return;
    onFocusAgent?.(entry);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, visible.length - 1));
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); jump(visible[selected]); return; }

    // Bare letters filter. Safe because this overlay owns the keyboard while it
    // is open and holds no text input — the moment it grows one, these move
    // behind a modifier.
    const next = !e.ctrlKey && !e.altKey && !e.metaKey ? FILTER_KEYS[e.key.toLowerCase()] : undefined;
    if (next) { e.preventDefault(); setFilter(next); setSelected(0); }
  };

  const counts = rollup.totals;
  const filterLabels: Array<[Filter, string, number]> = [
    ['all', t('agentNavigator.filterAll', 'all'), counts.total],
    ['blocked', t('agentNavigator.filterBlocked', 'blocked'), counts.blocked],
    ['working', t('agentNavigator.filterWorking', 'working'), counts.working],
    ['idle', t('agentNavigator.filterIdle', 'idle'), counts.idle],
  ];

  return (
    <div className="agent-nav__backdrop" onClick={onClose} role="presentation">
      <div
        className="agent-nav"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        ref={(el) => el?.focus()}
        role="dialog"
        aria-label={t('agentNavigator.title', 'Agents')}
      >
        <div className="agent-nav__filters">
          {filterLabels.map(([id, label, count]) => (
            <button
              key={id}
              className="agent-nav__filter"
              data-active={filter === id}
              onClick={() => { setFilter(id); setSelected(0); }}
            >
              <span className="agent-nav__filter-key">{id[0]}</span>
              {label}
              <span className="agent-nav__filter-count">{count}</span>
            </button>
          ))}
        </div>

        <div className="agent-nav__list" ref={listRef}>
          {visible.length === 0 && (
            <div className="agent-nav__empty">
              {counts.total === 0
                ? t('agentNavigator.emptyAll', 'No agent is running in this window.')
                : t('agentNavigator.emptyFilter', 'No agent matches this filter.')}
            </div>
          )}

          {visible.map((entry, i) => (
            <button
              key={entry.surfaceId}
              className="agent-nav__row"
              data-state={entry.state}
              data-selected={i === selected}
              onMouseEnter={() => setSelected(i)}
              onClick={() => jump(entry)}
            >
              <span className="agent-nav__row-dot" />
              <span className="agent-nav__row-label">{entry.label}</span>
              <span className="agent-nav__row-workspace">{entry.workspaceTitle}</span>
              <span className="agent-nav__row-reason">
                {entry.blockedReason ?? (entry.answerPending
                  ? t('agentNavigator.answerSent', 'answer sent — waiting')
                  : '')}
              </span>
              <span className="agent-nav__row-dwell">
                {entry.state === 'blocked' ? formatDwell(entry.dwellMs) : ''}
              </span>
            </button>
          ))}
        </div>

        <div className="agent-nav__hint">
          {t('agentNavigator.hint', '↑↓ move · enter jump · a/b/w/i filter · esc close')}
          <span className="agent-nav__hint-rollup">
            {workspaces
              .filter((w) => workspaceAgentState(rollup.byWorkspace[w.id]) !== null)
              .length} {t('agentNavigator.workspacesWithAgents', 'workspaces')}
          </span>
        </div>
      </div>
    </div>
  );
}
