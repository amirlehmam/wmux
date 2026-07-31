import React, { useState, useRef, useMemo, useEffect } from 'react';
import { WorkspaceInfo, SplitNode, PaneId } from '../../../shared/types';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { aggregateProgress } from '../../store/progress-slice';
import { agentsForWorkspace, resolveAgentLinger, WorkspaceAgentsView } from '../../store/agent-view';
import { claudeSessionsForWorkspace, HookActivityEntry } from '../../store/claude-session-view';
import UnreadBadge from './UnreadBadge';
import PrStatusIcon from './PrStatusIcon';
import { traceState, toolChannel } from './trace-signals';

type T = (key: TranslationKey, fallback?: string) => string;

/** Stable empty view — avoids allocating a fresh object every collapsed tick. */
const EMPTY_AGENTS_VIEW: WorkspaceAgentsView = { lines: [], total: 0, running: 0 };

function getAllSurfaceIds(tree: SplitNode): string[] {
  if (tree.type === 'leaf') return tree.surfaces.map(s => s.id);
  return [...getAllSurfaceIds(tree.children[0]), ...getAllSurfaceIds(tree.children[1])];
}

/** Human-readable label for a tool name */
function getToolLabel(tool: string, t: T): string {
  switch (tool) {
    case 'Bash': return t('workspaceRow.tool.bash', 'Running command...');
    case 'Read': return t('workspaceRow.tool.read', 'Reading file...');
    case 'Edit': return t('workspaceRow.tool.edit', 'Editing...');
    case 'Write': return t('workspaceRow.tool.write', 'Writing file...');
    case 'Grep': return t('workspaceRow.tool.grep', 'Searching code...');
    case 'Glob': return t('workspaceRow.tool.glob', 'Finding files...');
    case 'Agent': return t('workspaceRow.tool.agent', 'Running agent...');
    case 'WebSearch': return t('workspaceRow.tool.webSearch', 'Searching web...');
    case 'WebFetch': return t('workspaceRow.tool.webFetch', 'Fetching page...');
    case 'Skill': return t('workspaceRow.tool.skill', 'Loading skill...');
    default: return tool.includes(':')
      ? t('workspaceRow.tool.mcp', 'MCP: {tool}').replace('{tool}', tool)
      : t('workspaceRow.tool.generic', '{tool}...').replace('{tool}', tool);
  }
}

/** Detail text of one Claude session sub-line. */
function sessionDetailText(session: { working: boolean; blocked: boolean; blockedReason: string | null; tool: string | null; answerPending?: boolean }, t: T): string {
  // Blocked outranks the tool label: a pane parked on a permission prompt is
  // the one thing the user has to act on, so it must not read as "Idle" just
  // because no tool is running (issue #128).
  //
  // "Sent…" is its own state rather than a cleared block: wmux relayed the
  // answer but the agent has not confirmed, and claiming the prompt is gone on
  // our own say-so is exactly the ghost this feature exists to avoid.
  if (session.answerPending) return t('workspaceRow.answerSent', 'Sent — waiting…');
  if (session.blocked) return session.blockedReason || t('workspaceRow.needsYou', 'Needs you');
  if (!session.working) return t('workspaceRow.idle', 'Idle');
  return session.tool ? getToolLabel(session.tool, t) : t('workspaceRow.sessionRunning', 'Running…');
}

interface StatusTextInputs {
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
function claudeStatusText(s: StatusTextInputs, t: T): string | null {
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

  // Priority 2: Claude was working but stopped → idle, not "Running"
  if (s.claudeIsIdle) return t('workspaceRow.idle', 'Idle');

  return null;
}

/** Status line priority chain: override > agents > sessions > tool > idle > shell > notification. */
function resolveStatusText(s: StatusTextInputs, t: T): string {
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

interface WorkspaceRowProps {
  workspace: WorkspaceInfo;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename?: (newTitle: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  /** Which edge of this row the dragged workspace would land on, or null when
   *  it isn't the drop target. The marker has to name an edge: drawing it
   *  always above the hovered row lied about every downward move (issue #124). */
  dropEdge?: 'above' | 'below' | null;
  /** Full hook-activity map — keyed by surface id (per Claude session) or workspace id (legacy). */
  hookActivity?: Record<string, HookActivityEntry>;
  claudeActivity?: Record<string, any>;
  /** surfaceId → declared agent state (issue #128). */
  agentStates?: Record<string, any>;
  onFocusAgentPane?: (paneId: PaneId) => void;
}

export default function WorkspaceRow({
  workspace,
  isActive,
  onSelect,
  onClose,
  onRename,
  onContextMenu,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dropEdge = null,
  hookActivity,
  claudeActivity,
  agentStates,
  onFocusAgentPane,
}: WorkspaceRowProps) {
  const t = useT();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(workspace.title);
  const rowRef = useRef<HTMLDivElement>(null);

  // Listen for rename shortcut event (only the active workspace responds)
  useEffect(() => {
    if (!isActive) return;
    const handler = () => {
      setIsRenaming(true);
      setRenameValue(workspace.title);
    };
    document.addEventListener('wmux:rename-workspace', handler);
    return () => document.removeEventListener('wmux:rename-workspace', handler);
  }, [isActive, workspace.title]);

  // Emit the workspace colour as a CUSTOM PROPERTY, not as a background.
  //
  // The old code set `backgroundColor` inline, which beat every class rule and
  // so hardcoded *how* the accent was expressed: an opaque fill. That is what
  // flattened the live agent status colours the moment a row was selected, and
  // it is why the shipped `activeTabIndicator` preference could never take
  // effect. An inline custom property does not beat the class rule — it feeds
  // it, so CSS decides the treatment (rail / tint / fill) while the colour
  // still comes from the workspace. issue #10 (customColor must win) and
  // issue #80 (15% tint, not 5%) both survive; see sidebar.css.
  const rowStyle: React.CSSProperties = {};
  if (workspace.customColor) {
    (rowStyle as Record<string, string>)['--row-accent'] = workspace.customColor;
  }

  // Tick counter — forces re-evaluation of time-based memos every 2 seconds.
  // Without this, useMemo caches stale Date.now() results because the deps
  // (hookActivity/wsActivity) don't change even though time has passed.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 2000);
    return () => clearInterval(timer);
  }, []);

  // OSC 9;4 progress from this workspace's terminals, folded into one bar.
  // Shipped in settings, persisted, exposed in a <select> — and read by nothing
  // under Sidebar/ until now, which is why selecting a row was always an opaque
  // fill regardless of the preference.
  const activeTabIndicator = useStore((state) => state.sidebarPrefs.activeTabIndicator);
  const uiMode = useStore((state) => state.appearancePrefs.uiMode);

  const surfaceProgress = useStore((state) => state.surfaceProgress);
  const wsProgress = useMemo(() => {
    const ids = getAllSurfaceIds(workspace.splitTree);
    const entries = ids.map((id) => surfaceProgress[id]).filter(Boolean);
    return aggregateProgress(entries);
  }, [surfaceProgress, workspace.splitTree]);

  // Find Claude activity for this workspace's surfaces (from PTY observer)
  const wsActivity = useMemo(() => {
    if (!claudeActivity) return null;
    const surfaceIds = getAllSurfaceIds(workspace.splitTree);
    for (const sid of surfaceIds) {
      if (claudeActivity[sid]) return claudeActivity[sid];
    }
    return null;
  }, [claudeActivity, workspace.splitTree]);

  // ── Unified agent list (observer subagents + wmux-spawned agents) ──
  const agentMeta = useStore((state) => state.agentMeta);
  const doneAtRef = useRef<number | null>(null);
  const wsAgents = useMemo<WorkspaceAgentsView>(() => {
    const now = Date.now();
    const view = agentsForWorkspace(workspace.splitTree, claudeActivity ?? {}, agentMeta, now, t);
    if (view.lines.length === 0) { doneAtRef.current = null; return EMPTY_AGENTS_VIEW; }
    const linger = resolveAgentLinger(view.running === 0, doneAtRef.current, now);
    // The ref write lives in the memo, not an effect: the linger decision must
    // resolve synchronously with the list it gates (an effect would apply the
    // doneAt stamp one render late). Idempotent, so a StrictMode double render
    // lands on the same state.
    doneAtRef.current = linger.doneAt;
    return linger.visible ? view : EMPTY_AGENTS_VIEW;
  }, [workspace.splitTree, claudeActivity, agentMeta, tick, t]);
  const runningAgentCount = wsAgents.running;

  // How long a tool label persists after the last hook/observer event (ms)
  const ACTIVITY_TTL = 5000;

  // ── Per-surface Claude sessions (2 claude panes = 2 independent states) ──
  const sessionsView = useMemo(
    () => claudeSessionsForWorkspace(
      workspace.splitTree,
      claudeActivity ?? {},
      hookActivity ?? {},
      Date.now(),
      agentStates ?? {},
    ),
    [workspace.splitTree, claudeActivity, hookActivity, agentStates, tick],
  );
  const sessions = sessionsView.sessions;
  const workingSessions = sessionsView.working;
  // Panes parked on the user. Surfaced on the collapsed row too: the whole
  // point is seeing which of ten workspaces needs you WITHOUT expanding them.
  const blockedSessions = sessionsView.blocked;

  // Answering is a write into someone else's live terminal, so it is guarded
  // against double-fire while in flight (issue #128).
  const [answering, setAnswering] = useState<string | null>(null);

  /**
   * Relay a declared answer to a blocked pane.
   *
   * On refusal — the pane stopped asking, the choice was already consumed, the
   * agent declared a key wmux cannot translate — fall back to FOCUSING the
   * pane. That is the honest outcome: wmux could not answer for you, so it puts
   * you where you can answer yourself, rather than silently swallowing a click
   * on a button that looked like it worked.
   */
  const answerSession = async (surfaceId: string, choiceId: string, paneId: PaneId) => {
    setAnswering(surfaceId);
    try {
      const res = await window.wmux?.agentState?.answer?.(surfaceId, choiceId);
      if (!res?.ok) onFocusAgentPane?.(paneId);
    } catch {
      onFocusAgentPane?.(paneId);
    } finally {
      setAnswering(null);
    }
  };

  // Legacy workspace-keyed entry — only written by hook events with no surfaceId.
  const legacyHook = hookActivity?.[workspace.id];

  // ── Determine if Claude is actively working (recent hook or observer data) ──
  const isClaudeActive = useMemo(() => {
    if (workingSessions > 0) return true;
    const now = Date.now();
    if (legacyHook && now - legacyHook.lastSeen < ACTIVITY_TTL) return true;
    if (wsActivity && now - wsActivity.lastUpdate < ACTIVITY_TTL) return true;
    return false;
  }, [workingSessions, legacyHook, wsActivity, tick]);

  // ── TRACE mode (issue #118) ──────────────────────────────────────────────
  // Rate is derived by comparing the monotonic tool counter against the
  // previous sample. The sample is taken inside the memo that already runs on
  // the existing 2s tick — no new timer, no rAF, no per-row interval.
  //
  // MUST stay below `isClaudeActive`: it reads that binding in its dependency
  // array, and a deps array is a plain array literal evaluated at the call site
  // — only the callback is deferred. Declared above, the read hit the temporal
  // dead zone on *every* render including classic mode, and 0.35.0 shipped with
  // every workspace row throwing straight into the ErrorBoundary. tsc catches
  // this as TS2448; see tests/unit/renderer-typecheck.test.ts, which is why the
  // renderer now has a type gate at all.
  const traceRateRef = useRef<{ toolCount: number; at: number }>({ toolCount: 0, at: 0 });
  const rowTrace = useMemo(() => {
    if (uiMode !== 'trace') return null;
    const now = Date.now();
    const ids = getAllSurfaceIds(workspace.splitTree);
    const entries = ids.map((id) => hookActivity?.[id]).filter(Boolean) as HookActivityEntry[];

    // Sum, not first-match: a workspace with several Claude panes has several
    // counters, and the odometer is a workspace-level odometer.
    const toolCount = entries.reduce((sum, e) => sum + (e.toolCount || 0), 0);
    const lastSeen = entries.reduce((max, e) => Math.max(max, e.lastSeen || 0), 0);
    const active = sessions.find((s) => s.working && s.tool);

    const prev = traceRateRef.current;
    const state = traceState({
      working: workingSessions > 0 || isClaudeActive,
      tool: active?.tool ?? null,
      toolCount,
      lastSeen,
      prev: prev.at ? prev : undefined,
      now,
    });
    // Idempotent under a StrictMode double render: same inputs, same write.
    if (toolCount !== prev.toolCount) traceRateRef.current = { toolCount, at: now };

    return { ...state, toolCount };
  }, [uiMode, workspace.splitTree, hookActivity, sessions, workingSessions, isClaudeActive, tick]);

  if (rowTrace) {
    // Two numbers, both continuous, both read by CSS. --tr-lit is the staleness
    // ramp and --tr-flow-dur is the dash period; keeping them as plain inline
    // custom properties (rather than registered @property values inherited on
    // the row) avoids forcing a style recalc of the whole row subtree on every
    // frame of a transition.
    //
    // Still mutates `rowStyle` before the JSX below consumes it as `style=`.
    const s = rowStyle as Record<string, string>;
    s['--tr-lit'] = rowTrace.lit.toFixed(2);
    s['--tr-flow-dur'] = `${rowTrace.flowMs}ms`;
  }

  // ── Current tool label (from observer or hooks) ──
  const currentToolLabel = useMemo(() => {
    // Prefer per-session state — first working session with a known tool.
    const active = sessions.find(s => s.working && s.tool);
    if (active?.tool) return getToolLabel(active.tool, t);
    const now = Date.now();
    if (wsActivity?.lastTool && now - wsActivity.lastUpdate < ACTIVITY_TTL) {
      return getToolLabel(wsActivity.lastTool, t);
    }
    if (legacyHook?.lastTool && now - legacyHook.lastSeen < ACTIVITY_TTL) {
      return getToolLabel(legacyHook.lastTool, t);
    }
    return null;
  }, [sessions, wsActivity, legacyHook, tick, t]);

  // ── Detect "Claude was active but stopped" (shell still says running) ──
  const claudeIsIdle = useMemo(() => {
    if (workspace.shellState !== 'running') return false;
    // Sessions tracked per surface: idle only when EVERY session stopped —
    // one busy claude pane never reads as workspace-wide idle, and one idle
    // claude pane never keeps the row on "Running" (the 2-window bug).
    if (sessions.length > 0) return workingSessions === 0;
    // Observer saw "Baked for" / "Cost:" — Claude explicitly finished
    if (wsActivity?.isDone) return true;
    // Hook activity went stale — Claude stopped using tools
    if (legacyHook) {
      const now = Date.now();
      return now - legacyHook.lastSeen >= ACTIVITY_TTL;
    }
    return false;
  }, [workspace.shellState, sessions, workingSessions, wsActivity, legacyHook, tick]);

  // ── Status text: manual override > tool activity > shell state > default ──
  const statusText = useMemo(() => resolveStatusText({
    statusOverride: workspace.statusOverride,
    runningAgentCount,
    agentTotal: wsAgents.total,
    sessionCount: sessions.length,
    workingSessions,
    blockedSessions,
    currentToolLabel,
    claudeIsIdle,
    shellState: workspace.shellState,
    notificationText: workspace.notificationText,
  }, t), [workspace.statusOverride, runningAgentCount, wsAgents, sessions, workingSessions, blockedSessions, currentToolLabel, claudeIsIdle, workspace.shellState, workspace.notificationText, t]);

  // ── Status color class ──
  const statusClass = useMemo(() => {
    if (workspace.statusOverride) {
      return workspace.statusOverride === 'running'
        ? 'workspace-row__status--running'
        : 'workspace-row__status--idle';
    }
    if (blockedSessions > 0) return 'workspace-row__status--blocked';
    if (runningAgentCount > 0) return 'workspace-row__status--working';
    if (sessions.length >= 2) {
      return workingSessions > 0 ? 'workspace-row__status--working' : 'workspace-row__status--idle';
    }
    if (currentToolLabel) return 'workspace-row__status--working';
    if (claudeIsIdle) return 'workspace-row__status--idle';
    const state = workspace.shellState;
    if (state === 'running') return 'workspace-row__status--running';
    if (state === 'interrupted') return 'workspace-row__status--interrupted';
    if (state === 'idle') return 'workspace-row__status--done';
    return 'workspace-row__status--idle';
  }, [workspace.statusOverride, blockedSessions, runningAgentCount, sessions.length, workingSessions, currentToolLabel, claudeIsIdle, workspace.shellState]);

  // ── Context line: "branch* · ~/path/to/dir" ──
  const contextLine = useMemo(() => {
    const parts: string[] = [];
    if (workspace.gitBranch) {
      parts.push(`${workspace.gitBranch}${workspace.gitDirty ? '*' : ''}`);
    }
    if (workspace.cwd) {
      const shortCwd = workspace.cwd
        .replace(/\\/g, '/')
        .replace(/^[A-Z]:\//i, '~/')
        .replace(/\/Users\/[^/]+/i, '~');
      parts.push(shortCwd);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [workspace.gitBranch, workspace.gitDirty, workspace.cwd]);

  // ── State dot class — pulsing when Claude is active ──
  const stateDotClass = useMemo(() => {
    if (workspace.statusOverride) {
      return workspace.statusOverride === 'running'
        ? 'workspace-row__state-dot--running'
        : 'workspace-row__state-dot--idle';
    }
    if (isClaudeActive) return 'workspace-row__state-dot--running';
    if (claudeIsIdle) return 'workspace-row__state-dot--idle';
    if (workspace.shellState === 'running') return 'workspace-row__state-dot--running';
    if (workspace.shellState === 'interrupted') return 'workspace-row__state-dot--interrupted';
    if (workspace.shellState === 'idle') return 'workspace-row__state-dot--idle';
    return '';
  }, [workspace.statusOverride, isClaudeActive, claudeIsIdle, workspace.shellState]);

  return (
    <div
      ref={rowRef}
      className={[
        'workspace-row',
        isActive ? 'workspace-row--active' : '',
        // Selection treatment now honours the shipped preference. `leftRail`
        // (the default) is a rail + inset ring over an elevated tint;
        // `solidFill` restores the pre-0.35 opaque block for anyone who wants it.
        isActive && activeTabIndicator === 'solidFill' ? 'workspace-row--fill' : '',
        workspace.customColor ? 'workspace-row--custom' : '',
        dropEdge ? `workspace-row--drop-${dropEdge}` : '',
      ].filter(Boolean).join(' ')}
      style={rowStyle}
      // TRACE drives everything from attributes so the CSS owns the rendering
      // and no style object is rebuilt per tick. Absent in classic mode, where
      // rowTrace is null and none of these selectors exist.
      data-tr-live={rowTrace?.live ? '1' : undefined}
      data-tr-blocked={rowTrace?.blocked ? '1' : undefined}
      data-tr-chan={rowTrace?.channel ?? undefined}
      data-tr-telemetry={rowTrace?.noTelemetry ? 'none' : undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {/* Rail colour comes from --row-accent now, so it no longer needs an
          inline override that the active row used to have to fight. */}
      <span className="workspace-row__rail" />

      {/* Line 1: Title */}
      <div className="workspace-row__header">
        <span className={`workspace-row__state-dot ${stateDotClass}`} />
        {/* One ring per tool call. Keyed on the tool counter so React remounts
            the span and the one-shot animation replays — genuinely evented,
            rather than a loop that runs whether or not anything happened.
            Bucketed to cap the remount rate on a very fast agent. */}
        {rowTrace?.live && !rowTrace.blocked && (
          <span
            key={`ping-${Math.floor(rowTrace.toolCount / 2)}`}
            className="workspace-row__via-ping"
            aria-hidden="true"
          />
        )}
        {isRenaming ? (
          <input
            className="workspace-row__rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => {
              if (renameValue.trim() && renameValue !== workspace.title) {
                onRename?.(renameValue.trim());
              }
              setIsRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (renameValue.trim() && renameValue !== workspace.title) {
                  onRename?.(renameValue.trim());
                }
                setIsRenaming(false);
              }
              if (e.key === 'Escape') {
                setRenameValue(workspace.title);
                setIsRenaming(false);
              }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className="workspace-row__title"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenameValue(workspace.title);
              setIsRenaming(true);
            }}
          >
            {workspace.title}
          </span>
        )}

        {/* Work odometer: total tool calls this workspace's sessions have made.
            hookActivity[].toolCount is live, monotonic and deliberately never
            garbage-collected — and was rendered nowhere in the app until now.
            Static text, so it is the one part of TRACE that survives a narrow
            sidebar, reduced motion, and a screenshot. */}
        {!!rowTrace && rowTrace.toolCount > 0 && (
          <span
            className="workspace-row__odometer"
            title={t('workspaceRow.toolCallsTitle', '{count} tool calls in this workspace').replace('{count}', String(rowTrace.toolCount))}
          >
            {rowTrace.toolCount}
          </span>
        )}

        {workspace.unreadCount > 0 && (
          <UnreadBadge count={workspace.unreadCount} isSelected={isActive} />
        )}

        <button
          className="workspace-row__close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={t('workspaceRow.closeWorkspace', 'Close workspace')}
        >
          &#x2715;
        </button>
      </div>

      {/* Line 2: Status — always visible */}
      <div className={`workspace-row__status ${statusClass}`}>
        {statusText}
      </div>

      {/* Per-Claude-session sub-lines — one per pane running Claude Code,
          shown as soon as the workspace hosts 2+ sessions (click → focus pane) */}
      {(sessions.length >= 2 || blockedSessions > 0) && (
        <div className="workspace-row__agents workspace-row__sessions">
          {sessions.map((s, i) => (
            <React.Fragment key={s.surfaceId}>
            <div
              className={[
                'workspace-row__agent',
                'workspace-row__agent--clickable',
                'workspace-row__session',
                s.blocked ? 'workspace-row__session--blocked' : '',
                s.working || s.blocked ? '' : 'workspace-row__session--idle',
              ].filter(Boolean).join(' ')}
              // Per-session channel: this is what makes "that one is REWRITING
              // my code, that one is only reading" legible at a glance. Bound
              // to the tool name, a closed vocabulary from the hook, so an
              // unknown tool falls back to the neutral bus colour rather than
              // being miscoloured as something harmless.
              data-tr-live={uiMode === 'trace' && s.working ? '1' : undefined}
              data-tr-chan={uiMode === 'trace' ? (toolChannel(s.tool) ?? undefined) : undefined}
              onClick={(e) => {
                e.stopPropagation();
                onFocusAgentPane?.(s.paneId);
              }}
            >
              <span className="workspace-row__agent-glyph" aria-hidden="true">{i === sessions.length - 1 ? '└' : '├'}</span>
              {s.blocked && <span className="workspace-row__agent-dot workspace-row__agent-dot--blocked" />}
              {s.working && !s.blocked && <span className="workspace-row__agent-dot" />}
              <span className="workspace-row__agent-name">{s.label}</span>
              <span className={`workspace-row__agent-detail${uiMode === 'trace' ? ' workspace-row__session-tool' : ''}`}>
                {sessionDetailText(s, t)}
              </span>
            </div>
            {/* The back-channel (issue #128): answer the pane that needs you
                without leaving the pane you are in. Only rendered when the
                AGENT declared these answers — wmux never invents a keystroke
                for someone else's prompt. */}
            {s.choices.length > 0 && (
              <div className="workspace-row__answers">
                <span className="workspace-row__agent-glyph" aria-hidden="true">{' '}</span>
                {s.choices.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="workspace-row__answer"
                    disabled={answering === s.surfaceId}
                    title={t('workspaceRow.answerTitle', 'Answer without switching to this pane')}
                    onClick={(e) => {
                      e.stopPropagation();
                      void answerSession(s.surfaceId, c.id, s.paneId);
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Agent sub-lines — only while agents run (+10s linger with ✓) */}
      {wsAgents.lines.length > 0 && (
        <div className="workspace-row__agents">
          {wsAgents.lines.map((agent, i) => (
            <div
              key={agent.key}
              className={[
                'workspace-row__agent',
                agent.done ? 'workspace-row__agent--done' : '',
                agent.paneId ? 'workspace-row__agent--clickable' : '',
              ].filter(Boolean).join(' ')}
              onClick={agent.paneId ? (e) => {
                e.stopPropagation();
                onFocusAgentPane?.(agent.paneId!);
              } : undefined}
            >
              <span className="workspace-row__agent-glyph" aria-hidden="true">{i === wsAgents.lines.length - 1 ? '└' : '├'}</span>
              {!agent.done && <span className="workspace-row__agent-dot" />}
              <span className="workspace-row__agent-name">{agent.name}</span>
              <span className="workspace-row__agent-detail">{agent.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* OSC 9;4 progress bar — only while a terminal reports progress */}
      {wsProgress && (
        <div className="workspace-row__progress" title={
          wsProgress.state === 3 ? t('workspaceRow.working', 'Working…') : `${wsProgress.value}%`
        }>
          <div className="workspace-row__progress-track">
            <div
              className={`workspace-row__progress-fill workspace-row__progress-fill--s${wsProgress.state}`}
              style={wsProgress.state === 3 ? undefined : { width: `${wsProgress.value}%` }}
            />
          </div>
          {wsProgress.state !== 3 && (
            <span className="workspace-row__progress-pct">{wsProgress.value}%</span>
          )}
        </div>
      )}

      {/* PR info */}
      {workspace.prNumber != null && (
        <div className="workspace-row__pr">
          {workspace.prStatus != null && (
            <PrStatusIcon status={workspace.prStatus} size={12} />
          )}
          <span className="workspace-row__pr-number">#{workspace.prNumber}</span>
          {workspace.prStatus != null && (
            <span className="workspace-row__pr-status">{workspace.prStatus}</span>
          )}
        </div>
      )}

      {/* Line 3: Context — branch · path */}
      {contextLine && (
        <div className="workspace-row__context">
          {contextLine}
        </div>
      )}

      {/* Active skill */}
      {wsActivity?.activeSkill && (
        <div className="workspace-row__meta-line workspace-row__skill">
          {wsActivity.activeSkill}
        </div>
      )}
    </div>
  );
}
