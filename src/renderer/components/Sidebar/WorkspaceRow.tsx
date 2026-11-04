import React, { useState, useRef, useMemo, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { WorkspaceInfo, SplitNode, PaneId } from '../../../shared/types';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { aggregateProgress } from '../../store/progress-slice';
import { agentsForWorkspace, resolveAgentLinger, WorkspaceAgentsView } from '../../store/agent-view';
import { claudeSessionsForWorkspace, HookActivityEntry, type ClaudeSessionView } from '../../store/claude-session-view';
import { rollupAgents } from '../../store/agent-rollup';
import UnreadBadge from './UnreadBadge';
import PrStatusIcon from './PrStatusIcon';
import { traceState, toolChannel } from './trace-signals';
import { resolveStatusText, statusClassFor, stateDotClassFor, backgroundShellsText, type StatusTextInputs, type T } from './workspace-status';
import { buildContextLine, sidebarDetails } from './context-line';
import { useWorkspaceLabel } from '../SplitPane/use-osc-title';

/** Stable empty view — avoids allocating a fresh object every collapsed tick. */
const EMPTY_AGENTS_VIEW: WorkspaceAgentsView = { lines: [], total: 0, running: 0, shells: 0 };

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

/** Keep silent agents distinct from agents that explicitly reported idle. */
function sessionDetailText(session: ClaudeSessionView, t: T): string {
  // Blocked outranks the tool label: a pane parked on a permission prompt is
  // the one thing the user has to act on, so it must not read as "Idle" just
  // because no tool is running (issue #128).
  //
  // "Sent…" is its own state rather than a cleared block: wmux relayed the
  // answer but the agent has not confirmed, and claiming the prompt is gone on
  // our own say-so is exactly the ghost this feature exists to avoid.
  if (session.answerPending) return t('workspaceRow.answerSent', 'Sent — waiting…');
  if (session.blocked) return session.blockedReason || t('workspaceRow.needsYou', 'Needs you');
  // The same words the workspace header uses for it, on the row that asked.
  if (session.question) return t('workspaceRow.question', 'Question for you');
  if (!session.working) {
    // The agent is at its prompt, but a shell it backgrounded runs on (#276).
    const shells = session.backgroundShells ?? 0;
    if (shells > 0) return backgroundShellsText(shells, t);
    return session.state === 'unknown'
      ? t('agentNavigator.silent', 'reports no state')
      : t('workspaceRow.idle', 'Idle');
  }
  return session.tool ? getToolLabel(session.tool, t) : t('workspaceRow.sessionRunning', 'Running…');
}

/** The row's `--row-accent` custom property, when the user picked a colour. */
function rowAccentStyle(customColor: string | undefined): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (customColor) (style as Record<string, string>)['--row-accent'] = customColor;
  return style;
}

/** `[WT]` on a workspace that is a wmux-created git worktree (#366). */
function WorktreeBadge({ worktree }: { worktree?: WorkspaceInfo['worktree'] }) {
  const t = useT();
  if (!worktree) return null;
  const title = t('worktree.badgeTitle', 'Worktree: {branch} (base: {base})')
    .split('{branch}').join(worktree.branch)
    .split('{base}').join(worktree.baseBranch);
  return (
    <span className="workspace-row__badge workspace-row__badge--worktree" title={title}>
      [WT]
    </span>
  );
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
  // What the row shows: the stored title, or the program's window title while
  // wmux picked the name. A rename starts from it, and counts as one only if
  // the field differs from where it started: the label can change while the
  // field is open (a spinner in the title), and confirming an untouched field
  // must not freeze a followed title in place.
  const workspaceLabel = useWorkspaceLabel(workspace);
  const [renameValue, setRenameValue] = useState(workspaceLabel);
  const renameStartRef = useRef(workspaceLabel);
  const rowRef = useRef<HTMLDivElement>(null);
  const startRename = () => {
    renameStartRef.current = workspaceLabel;
    setRenameValue(workspaceLabel);
    setIsRenaming(true);
  };
  const submitRename = () => {
    if (renameValue.trim() && renameValue !== renameStartRef.current) {
      onRename?.(renameValue.trim());
    }
    setIsRenaming(false);
  };

  // Listen for rename shortcut event (only the active workspace responds)
  useEffect(() => {
    if (!isActive) return;
    document.addEventListener('wmux:rename-workspace', startRename);
    return () => document.removeEventListener('wmux:rename-workspace', startRename);
  }, [isActive, workspaceLabel]);

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
  const rowStyle = rowAccentStyle(workspace.customColor);

  // Tick counter — forces re-evaluation of time-based memos every 2 seconds.
  // Without this, useMemo caches stale Date.now() results because the deps
  // activity records don't change even though time has passed.
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
  // Settings → Sidebar's detail toggles, applied in ONE place (#279) — they
  // were persisted and shown for years while the row read none of them.
  const sidebarPrefs = useStore((state) => state.sidebarPrefs);
  const details = useMemo(() => sidebarDetails(sidebarPrefs), [sidebarPrefs]);

  // Select only THIS workspace's progress entries, shallow-compared. The slice
  // replaces the whole surfaceProgress object on any accepted update, so a bare
  // `state.surfaceProgress` subscription re-rendered EVERY sidebar row for one
  // pane's OSC 9;4 tick (#141's fan-out, one hop downstream of the slice's own
  // change-gate). Per-surface entries are identity-stable while unchanged, so
  // another workspace's progress leaves this array shallow-equal and this row
  // untouched.
  const wsProgressEntries = useStore(useShallow((state) => {
    const ids = getAllSurfaceIds(workspace.splitTree);
    return ids.map((id) => state.surfaceProgress[id]).filter(Boolean);
  }));
  const wsProgress = useMemo(() => aggregateProgress(wsProgressEntries), [wsProgressEntries]);

  // ── Unified agent list (observer subagents + wmux-spawned agents) ──
  const agentMeta = useStore((state) => state.agentMeta);
  const doneAtRef = useRef<number | null>(null);
  const wsAgents = useMemo<WorkspaceAgentsView>(() => {
    const now = Date.now();
    const view = agentsForWorkspace(workspace.splitTree, claudeActivity ?? {}, agentMeta, now, t);
    if (view.lines.length === 0) { doneAtRef.current = null; return EMPTY_AGENTS_VIEW; }
    // A running background shell keeps the lines up as much as an agent does (#276).
    const linger = resolveAgentLinger(view.running + view.shells === 0, doneAtRef.current, now);
    // The ref write lives in the memo, not an effect: the linger decision must
    // resolve synchronously with the list it gates (an effect would apply the
    // doneAt stamp one render late). Idempotent, so a StrictMode double render
    // lands on the same state.
    doneAtRef.current = linger.doneAt;
    return linger.visible ? view : EMPTY_AGENTS_VIEW;
  }, [workspace.splitTree, claudeActivity, agentMeta, tick, t]);
  const runningAgentCount = wsAgents.running;

  // Use the same sources and precedence as the window-wide roster (#235).
  const agentIdentities = useStore((state) => state.agentIdentities);
  const agentDetections = useStore((state) => state.agentDetections);
  const agentRollup = useMemo(
    () => rollupAgents([workspace], agentStates ?? {}, Date.now(), agentIdentities, agentDetections),
    [workspace, agentStates, agentIdentities, agentDetections],
  );
  const agentCounts = agentRollup.byWorkspace[workspace.id];

  // ── Per-surface Claude sessions (2 claude panes = 2 independent states) ──
  const sessionsView = useMemo(
    () => claudeSessionsForWorkspace(
      workspace.splitTree,
      claudeActivity ?? {},
      hookActivity ?? {},
      Date.now(),
      agentRollup.roster,
      agentStates ?? {},
    ),
    [workspace.splitTree, claudeActivity, hookActivity, agentRollup, agentStates, tick],
  );
  const sessions = sessionsView.sessions;
  const activeSkill = sessions.find(s => claudeActivity?.[s.surfaceId])?.skill;
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

  const isClaudeActive = workingSessions > 0;

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
      // Was never passed, so traceState's entire `blocked` branch — and the
      // blocked rail in trace.css it drives — had been unreachable since it was
      // written. An optional field nobody supplies type-checks perfectly.
      blockedSince: sessionsView.oldestBlockedSince,
      now,
    });
    // Idempotent under a StrictMode double render: same inputs, same write.
    if (toolCount !== prev.toolCount) traceRateRef.current = { toolCount, at: now };

    return { ...state, toolCount };
  }, [uiMode, workspace.splitTree, hookActivity, sessions, workingSessions, isClaudeActive, sessionsView.oldestBlockedSince, tick]);

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

  const currentToolLabel = useMemo(() => {
    const active = sessions.find(s => s.working && s.tool);
    return active?.tool ? getToolLabel(active.tool, t) : null;
  }, [sessions, t]);

  // One set of inputs feeding BOTH the words and the colour. They are separate
  // chains that must agree, and they drifted apart once already — sharing the
  // inputs at least guarantees they are arguing about the same facts.
  const statusInputs = useMemo<StatusTextInputs>(() => ({
    statusOverride: workspace.statusOverride,
    agentCounts,
    runningAgentCount,
    backgroundShellCount: wsAgents.shells,
    // Silent agents alone must not turn the multi-session summary into Idle.
    sessionCount: agentCounts.total === agentCounts.unknown ? 0 : sessions.length,
    workingSessions,
    blockedSessions,
    currentToolLabel,
    shellState: workspace.shellState,
    notificationText: details.notificationMessage ? workspace.notificationText : undefined,
  }), [workspace.statusOverride, agentCounts, runningAgentCount, wsAgents, sessions, workingSessions, blockedSessions, currentToolLabel, workspace.shellState, workspace.notificationText, details.notificationMessage]);

  // ── Status text: manual override > tool activity > shell state > default ──
  const statusText = useMemo(() => resolveStatusText(statusInputs, t), [statusInputs, t]);

  // ── Status color class ──
  const statusClass = useMemo(() => statusClassFor(statusInputs), [statusInputs]);

  // ── Context line: "branch* · ~/path/to/dir · :3000" (see ./context-line) ──
  const contextLine = useMemo(
    () => buildContextLine(workspace, details, window.wmux?.system?.homeDir),
    [workspace.gitBranch, workspace.gitDirty, workspace.cwd, workspace.ports, details],
  );

  const stateDotClass = stateDotClassFor(statusInputs, isClaudeActive);

  // The dot, the badges and the close button sit on the title line by default.
  // `sidebarPrefs.fullWidthTitles` moves them to a line of their own above it,
  // so the title and the status text each get the row's full width.
  const stateDot = (
    <>
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
    </>
  );

  const rowBadges = (
    <>
      <WorktreeBadge worktree={workspace.worktree} />


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
    </>
  );

  const closeButton = (
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
  );

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
      // Read by the sidebar list's own drop handler (#330), which has to map a
      // pointer in empty space back onto the nearest row.
      data-workspace-id={workspace.id}
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

      {sidebarPrefs.fullWidthTitles && (
        <div className="workspace-row__top-line">
          {stateDot}
          {rowBadges}
          {closeButton}
        </div>
      )}

      {/* Line 1: Title */}
      <div className="workspace-row__header">
        {!sidebarPrefs.fullWidthTitles && stateDot}
        {isRenaming ? (
          <input
            className="workspace-row__rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') {
                setRenameValue(renameStartRef.current);
                setIsRenaming(false);
              }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className={`workspace-row__title${sidebarPrefs.wrapTitles ? ' workspace-row__title--wrap' : ''}`}
            // The full name on hover (#342): a truncated title was otherwise
            // readable only by opening the rename box.
            title={workspaceLabel}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
          >
            {workspaceLabel}
          </span>
        )}

        {!sidebarPrefs.fullWidthTitles && rowBadges}
        {!sidebarPrefs.fullWidthTitles && closeButton}
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
                s.question ? 'workspace-row__session--question' : '',
                s.state === 'idle' && s.backgroundShells === 0 ? 'workspace-row__session--idle' : '',
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
              {s.question && <span className="workspace-row__agent-dot workspace-row__agent-dot--question" />}
              {(s.working || s.backgroundShells > 0) && !s.blocked && !s.question && <span className="workspace-row__agent-dot" />}
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
      {details.pr && workspace.prNumber != null && (
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
      {activeSkill && (
        <div className="workspace-row__meta-line workspace-row__skill">
          {activeSkill}
        </div>
      )}
    </div>
  );
}
