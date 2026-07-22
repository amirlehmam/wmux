import React, { useState, useRef, useMemo, useEffect } from 'react';
import { WorkspaceInfo, SplitNode, PaneId } from '../../../shared/types';
import { useStore } from '../../store';
import { aggregateProgress } from '../../store/progress-slice';
import { agentsForWorkspace, resolveAgentLinger, WorkspaceAgentsView } from '../../store/agent-view';
import { claudeSessionsForWorkspace, HookActivityEntry } from '../../store/claude-session-view';
import UnreadBadge from './UnreadBadge';
import PrStatusIcon from './PrStatusIcon';

/** Stable empty view — avoids allocating a fresh object every collapsed tick. */
const EMPTY_AGENTS_VIEW: WorkspaceAgentsView = { lines: [], total: 0, running: 0 };

function getAllSurfaceIds(tree: SplitNode): string[] {
  if (tree.type === 'leaf') return tree.surfaces.map(s => s.id);
  return [...getAllSurfaceIds(tree.children[0]), ...getAllSurfaceIds(tree.children[1])];
}

/** Human-readable label for a tool name */
function getToolLabel(tool: string): string {
  switch (tool) {
    case 'Bash': return 'Running command...';
    case 'Read': return 'Reading file...';
    case 'Edit': return 'Editing...';
    case 'Write': return 'Writing file...';
    case 'Grep': return 'Searching code...';
    case 'Glob': return 'Finding files...';
    case 'Agent': return 'Running agent...';
    case 'WebSearch': return 'Searching web...';
    case 'WebFetch': return 'Fetching page...';
    case 'Skill': return 'Loading skill...';
    default: return tool.includes(':') ? `MCP: ${tool}` : `${tool}...`;
  }
}

/** Detail text of one Claude session sub-line. */
function sessionDetailText(working: boolean, tool: string | null): string {
  if (!working) return 'Idle';
  return tool ? getToolLabel(tool) : 'Running…';
}

interface StatusTextInputs {
  statusOverride?: 'running' | 'idle';
  runningAgentCount: number;
  agentTotal: number;
  sessionCount: number;
  workingSessions: number;
  currentToolLabel: string | null;
  claudeIsIdle: boolean;
  shellState?: string;
  notificationText?: string;
}

/** Priorities 0–2: Claude-derived signals. Null → fall through to shell state. */
function claudeStatusText(s: StatusTextInputs): string | null {
  // Priority 0: user pinned the status by hand (issue #81) — detection
  // heuristics can misread tools that keep the shell "running" while idle.
  if (s.statusOverride) {
    return s.statusOverride === 'running' ? 'Running' : 'Idle';
  }

  // Priority 0.5: agents are running — show the orchestration summary
  if (s.runningAgentCount > 0) {
    return `Orchestrating · ${s.agentTotal} agent${s.agentTotal > 1 ? 's' : ''}`;
  }

  // Priority 0.75: several Claude sessions in this workspace — summarize;
  // the per-session sub-lines below the status carry the detail.
  if (s.sessionCount >= 2) {
    return s.workingSessions > 0
      ? `Claude · ${s.workingSessions}/${s.sessionCount} running`
      : 'Idle';
  }

  // Priority 1: Claude is actively using a tool
  if (s.currentToolLabel) return s.currentToolLabel;

  // Priority 2: Claude was working but stopped → idle, not "Running"
  if (s.claudeIsIdle) return 'Idle';

  return null;
}

/** Status line priority chain: override > agents > sessions > tool > idle > shell > notification. */
function resolveStatusText(s: StatusTextInputs): string {
  const claude = claudeStatusText(s);
  if (claude) return claude;

  // Priority 3: Shell state from shell integration
  if (s.shellState === 'running') return 'Running';
  if (s.shellState === 'interrupted') return 'Interrupted';
  if (s.shellState === 'idle') {
    return s.notificationText ? `Done: ${s.notificationText}` : 'Idle';
  }

  // Priority 4: Notification text without shell state
  if (s.notificationText) return s.notificationText;

  // Priority 5: Default — always show something
  return 'Idle';
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
  isDragOver?: boolean;
  /** Full hook-activity map — keyed by surface id (per Claude session) or workspace id (legacy). */
  hookActivity?: Record<string, HookActivityEntry>;
  claudeActivity?: Record<string, any>;
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
  isDragOver = false,
  hookActivity,
  claudeActivity,
  onFocusAgentPane,
}: WorkspaceRowProps) {
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

  const activeBackground = workspace.customColor ?? '#0091FF';
  // 15% alpha tint for inactive colored rows. The previous 5% (`0D`) was
  // indistinguishable from the sidebar background on dark themes (issue #80).
  const customColorTint = workspace.customColor
    ? `${workspace.customColor}26`
    : undefined;
  // Solid color rail so the assigned color reads unambiguously even where a
  // translucent tint can't (issue #80). Skipped on the active row, whose full
  // background is already the custom color (the CSS overlay rail stays).
  const railStyle: React.CSSProperties | undefined =
    workspace.customColor && !isActive
      ? { background: workspace.customColor, opacity: 1 }
      : undefined;

  // Tick counter — forces re-evaluation of time-based memos every 2 seconds.
  // Without this, useMemo caches stale Date.now() results because the deps
  // (hookActivity/wsActivity) don't change even though time has passed.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 2000);
    return () => clearInterval(timer);
  }, []);

  // OSC 9;4 progress from this workspace's terminals, folded into one bar.
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
    const view = agentsForWorkspace(workspace.splitTree, claudeActivity ?? {}, agentMeta, now);
    if (view.lines.length === 0) { doneAtRef.current = null; return EMPTY_AGENTS_VIEW; }
    const linger = resolveAgentLinger(view.running === 0, doneAtRef.current, now);
    // The ref write lives in the memo, not an effect: the linger decision must
    // resolve synchronously with the list it gates (an effect would apply the
    // doneAt stamp one render late). Idempotent, so a StrictMode double render
    // lands on the same state.
    doneAtRef.current = linger.doneAt;
    return linger.visible ? view : EMPTY_AGENTS_VIEW;
  }, [workspace.splitTree, claudeActivity, agentMeta, tick]);
  const runningAgentCount = wsAgents.running;

  let rowStyle: React.CSSProperties = {};
  if (isActive) {
    rowStyle = { backgroundColor: activeBackground };
  } else if (customColorTint) {
    rowStyle = { backgroundColor: customColorTint };
  }

  // How long a tool label persists after the last hook/observer event (ms)
  const ACTIVITY_TTL = 5000;

  // ── Per-surface Claude sessions (2 claude panes = 2 independent states) ──
  const sessionsView = useMemo(
    () => claudeSessionsForWorkspace(workspace.splitTree, claudeActivity ?? {}, hookActivity ?? {}, Date.now()),
    [workspace.splitTree, claudeActivity, hookActivity, tick],
  );
  const sessions = sessionsView.sessions;
  const workingSessions = sessionsView.working;

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

  // ── Current tool label (from observer or hooks) ──
  const currentToolLabel = useMemo(() => {
    // Prefer per-session state — first working session with a known tool.
    const active = sessions.find(s => s.working && s.tool);
    if (active?.tool) return getToolLabel(active.tool);
    const now = Date.now();
    if (wsActivity?.lastTool && now - wsActivity.lastUpdate < ACTIVITY_TTL) {
      return getToolLabel(wsActivity.lastTool);
    }
    if (legacyHook?.lastTool && now - legacyHook.lastSeen < ACTIVITY_TTL) {
      return getToolLabel(legacyHook.lastTool);
    }
    return null;
  }, [sessions, wsActivity, legacyHook, tick]);

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
    currentToolLabel,
    claudeIsIdle,
    shellState: workspace.shellState,
    notificationText: workspace.notificationText,
  }), [workspace.statusOverride, runningAgentCount, wsAgents, sessions, workingSessions, currentToolLabel, claudeIsIdle, workspace.shellState, workspace.notificationText]);

  // ── Status color class ──
  const statusClass = useMemo(() => {
    if (workspace.statusOverride) {
      return workspace.statusOverride === 'running'
        ? 'workspace-row__status--running'
        : 'workspace-row__status--idle';
    }
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
  }, [workspace.statusOverride, runningAgentCount, currentToolLabel, claudeIsIdle, workspace.shellState]);

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
        isDragOver ? 'workspace-row--drag-over' : '',
      ].filter(Boolean).join(' ')}
      style={rowStyle}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <span className="workspace-row__rail" style={railStyle} />

      {/* Line 1: Title */}
      <div className="workspace-row__header">
        <span className={`workspace-row__state-dot ${stateDotClass}`} />
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

        {workspace.unreadCount > 0 && (
          <UnreadBadge count={workspace.unreadCount} isSelected={isActive} />
        )}

        <button
          className="workspace-row__close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close workspace"
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
      {sessions.length >= 2 && (
        <div className="workspace-row__agents workspace-row__sessions">
          {sessions.map((s, i) => (
            <div
              key={s.surfaceId}
              className={[
                'workspace-row__agent',
                'workspace-row__agent--clickable',
                s.working ? '' : 'workspace-row__session--idle',
              ].filter(Boolean).join(' ')}
              onClick={(e) => {
                e.stopPropagation();
                onFocusAgentPane?.(s.paneId);
              }}
            >
              <span className="workspace-row__agent-glyph" aria-hidden="true">{i === sessions.length - 1 ? '└' : '├'}</span>
              {s.working && <span className="workspace-row__agent-dot" />}
              <span className="workspace-row__agent-name">{s.label}</span>
              <span className="workspace-row__agent-detail">
                {sessionDetailText(s.working, s.tool)}
              </span>
            </div>
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
          wsProgress.state === 3 ? 'Working…' : `${wsProgress.value}%`
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
