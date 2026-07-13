import React, { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { OrchestrationWave, OrchestrationAgent, OrchestrationState } from '../../../shared/types';

/**
 * Sidebar panel for the wmux-orchestrator plugin. Self-contained; auto-hides
 * when no orchestration is active. Main process pushes state via IPC.
 */
export default function OrchestrationPanel() {
  const orch = useStore((s) => s.currentOrchestration);
  const clear = useStore((s) => s.clearOrchestration);
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState(false);

  // Tick every second so the elapsed timer stays live even between
  // state.json updates. Only tick when we actually have a running run.
  useEffect(() => {
    if (!orch || orch.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [orch?.status, orch?.id]);

  if (!orch) return null;
  // Defence in depth: the watcher already rejects malformed state.json, but a
  // run with no `id`/`waves` must never reach the render body — throwing here
  // unmounts the whole app (see ErrorBoundary).
  if (typeof orch.id !== 'string' || !Array.isArray(orch.waves)) return null;

  // parseIso returns 0 for a missing/unparseable startedAt, and `now - 0` is the
  // whole Unix epoch — the panel rendered "495520:02:09" for a run that had been
  // going ten minutes. An unknown start time is not a 56-year-old run: show that
  // we don't know it. (The plugin's schema is `startedAt`; runs that write some
  // other key land here.)
  const startedMs = parseIso(orch.startedAt);
  const elapsed = startedMs > 0 ? formatElapsed(Math.max(0, now - startedMs)) : '—';
  const currentWaveIdx = findCurrentWaveIndex(orch);
  const totalAgents = orch.waves.reduce((sum, w) => sum + w.agents.length, 0);
  const runningAgents = countByStatus(orch, 'running');
  const doneAgents = countByStatus(orch, 'exited');

  const statusLabel: Record<string, string> = {
    running: 'running',
    complete: 'complete',
    failed: 'failed',
    pending: 'queued',
  };

  return (
    <div className="orch-panel" data-status={orch.status} data-collapsed={collapsed}>
      <button
        className="orch-panel__header"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? 'Expand orchestration' : 'Collapse orchestration'}
      >
        <span className="orch-panel__header-dot" />
        <span className="orch-panel__header-title">orchestration</span>
        <span className="orch-panel__header-status">{statusLabel[orch.status] || orch.status}</span>
        <span className="orch-panel__header-id">{orch.id.replace(/^orch-/, '')}</span>
      </button>

      {!collapsed && (
        <>
          <div className="orch-panel__task" title={orch.task}>
            {orch.task}
          </div>

          <div className="orch-panel__meta">
            <span className="orch-panel__meta-elapsed">{elapsed}</span>
            <span className="orch-panel__meta-sep">·</span>
            <span>wave {currentWaveIdx + 1}/{orch.waves.length}</span>
            <span className="orch-panel__meta-sep">·</span>
            <span>{doneAgents}/{totalAgents} done</span>
            {runningAgents > 0 && (
              <>
                <span className="orch-panel__meta-sep">·</span>
                <span className="orch-panel__meta-running">{runningAgents} running</span>
              </>
            )}
          </div>

          <div className="orch-panel__waves">
            {orch.waves.map((wave) => (
              <WaveBlock key={wave.index} wave={wave} now={now} />
            ))}
          </div>

          {orch.reviewer && orch.reviewer.status !== 'pending' && (
            <div className="orch-panel__reviewer" data-status={orch.reviewer.status}>
              <span className="orch-panel__reviewer-dot" />
              <span className="orch-panel__reviewer-label">reviewer</span>
              <span className="orch-panel__reviewer-status">{orch.reviewer.status}</span>
            </div>
          )}

          {(orch.status === 'complete' || orch.status === 'failed') && (
            <button className="orch-panel__dismiss" onClick={clear}>
              dismiss
            </button>
          )}
        </>
      )}
    </div>
  );
}

function WaveBlock({ wave, now }: { wave: OrchestrationWave; now: number }) {
  const doneCount = wave.agents.filter((a) => a.status === 'exited' || a.status === 'failed').length;
  const progress = wave.agents.length > 0 ? doneCount / wave.agents.length : 0;

  return (
    <div className="orch-panel__wave" data-status={wave.status}>
      <div className="orch-panel__wave-head">
        <span className="orch-panel__wave-name">wave {wave.index + 1}</span>
        <span className="orch-panel__wave-bar">
          <span
            className="orch-panel__wave-bar-fill"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </span>
        <span className="orch-panel__wave-pct">{Math.round(progress * 100)}%</span>
      </div>
      <div className="orch-panel__agents">
        {wave.agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} now={now} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ agent, now }: { agent: OrchestrationAgent; now: number }) {
  const started = agent.startedAt ? parseIso(agent.startedAt) : 0;
  const finished = agent.finishedAt ? parseIso(agent.finishedAt) : null;
  let durStr = '';
  if (started > 0) {
    const endMs = finished ?? now;
    durStr = formatElapsedShort(Math.max(0, endMs - started));
  }

  const toolUses = agent.toolUses ?? 0;
  const isFailed = agent.status === 'failed' || (agent.status === 'exited' && (agent.exitCode ?? 0) !== 0);
  const dataStatus = isFailed ? 'failed' : agent.status;

  return (
    <div className="orch-panel__agent" data-status={dataStatus}>
      <span className="orch-panel__agent-dot" />
      <div className="orch-panel__agent-body">
        <div className="orch-panel__agent-label" title={agent.label}>
          {agent.label}
        </div>
        {(agent.status === 'running' || agent.status === 'exited') && (
          <div className="orch-panel__agent-meta">
            <span className="orch-panel__agent-tools">↦ {toolUses}</span>
            {durStr && <span className="orch-panel__agent-time">{durStr}</span>}
          </div>
        )}
        {agent.status === 'pending' && (
          <div className="orch-panel__agent-meta">
            <span className="orch-panel__agent-pending">waiting</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseIso(iso: string | undefined | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function findCurrentWaveIndex(orch: OrchestrationState): number {
  for (let i = 0; i < orch.waves.length; i++) {
    if (orch.waves[i].status === 'running') return i;
  }
  for (let i = 0; i < orch.waves.length; i++) {
    if (orch.waves[i].status === 'pending') return i;
  }
  return Math.max(0, orch.waves.length - 1);
}

function countByStatus(orch: OrchestrationState, status: string): number {
  let n = 0;
  for (const w of orch.waves) {
    for (const a of w.agents) {
      if (a.status === status) n++;
    }
  }
  return n;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatElapsedShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
