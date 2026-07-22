import { v4 as uuid } from 'uuid';
import { PtyManager } from './pty-manager';
import { AgentId, AgentInfo, AgentSpawnParams, PaneId, SurfaceId, WorkspaceId } from '../shared/types';

export interface PaneLoadInfo {
  paneId: string;
  tabCount: number;
}

export function distributeAgents(count: number, panes: PaneLoadInfo[]): string[] {
  // Sort panes once by their initial load (stable sort preserves input order on ties),
  // then round-robin through that sorted order for all agent assignments.
  const sorted = panes
    .map((p, i) => ({ ...p, _origIdx: i }))
    .sort((a, b) => a.tabCount !== b.tabCount ? a.tabCount - b.tabCount : a._origIdx - b._origIdx);

  const assignments: string[] = [];
  for (let i = 0; i < count; i++) {
    assignments.push(sorted[i % sorted.length].paneId);
  }
  return assignments;
}

export class AgentManager {
  private agents = new Map<AgentId, AgentInfo>();
  private ptyManager: PtyManager;
  /** Notified exactly once per agent when it transitions to 'exited' (PTY exit or kill). */
  private onAgentExit?: (info: AgentInfo) => void;

  constructor(ptyManager: PtyManager) {
    this.ptyManager = ptyManager;
  }

  /** Wire the exit broadcast — the caller owns window access (mirrors how 'spawned' is emitted). */
  setOnAgentExit(cb: (info: AgentInfo) => void): void {
    this.onAgentExit = cb;
  }

  spawn(params: AgentSpawnParams & { paneId: PaneId; workspaceId: WorkspaceId }): { agentId: AgentId; surfaceId: SurfaceId } {
    if (!params.cmd) throw new Error('Cannot spawn agent: cmd is required');
    const agentId: AgentId = `agent-${uuid()}`;
    const created = this.ptyManager.create({
      shell: '',  // Use default shell (resolves to pwsh/powershell/bash, not hardcoded cmd.exe)
      cwd: params.cwd || process.env.USERPROFILE || 'C:\\',
      env: { ...(params.env || {}), WMUX_AGENT_ID: agentId, WMUX_AGENT_LABEL: params.label },
    });
    const surfaceId = created.id;

    // Wait for shell readiness before sending the agent command.
    // PowerShell with integration scripts takes 1-3s to reach a prompt;
    // a blind 800ms timeout was causing commands to be lost.
    let commandSent = false;
    let promptDebounce: ReturnType<typeof setTimeout> | null = null;

    const sendOnce = () => {
      if (commandSent) return;
      commandSent = true;
      if (removeDataListener) removeDataListener();
      clearTimeout(fallbackTimer);
      if (promptDebounce) clearTimeout(promptDebounce);
      // Brief pause after prompt detection to let the shell fully settle
      setTimeout(() => {
        if (this.ptyManager.has(surfaceId)) {
          this.ptyManager.write(surfaceId, params.cmd + '\r');
        }
      }, 150);
    };

    // Listen for PTY output to detect when the shell prompt appears
    const removeDataListener = this.ptyManager.onData(surfaceId, (data) => {
      if (commandSent) return;
      // Prompt patterns: "PS C:\path>" (PowerShell), "$ " (bash), "> " (generic)
      if (/(?:PS\s.*>|[$#%>])\s*$/m.test(data)) {
        sendOnce();
      } else if (!promptDebounce) {
        // Got output but no prompt yet — shell is loading; wait a bit more
        promptDebounce = setTimeout(sendOnce, 1500);
      }
    });

    // Absolute fallback: if shell produces no recognizable prompt after 5s, send anyway
    const fallbackTimer = setTimeout(sendOnce, 5000);

    const info: AgentInfo = {
      agentId, surfaceId, paneId: params.paneId, workspaceId: params.workspaceId,
      label: params.label, cmd: params.cmd, status: 'running',
      spawnTime: Date.now(), pid: this.ptyManager.getPid(surfaceId),
    };
    this.agents.set(agentId, info);

    this.ptyManager.onExit(surfaceId, (code) => {
      const agent = this.agents.get(agentId);
      // Transition guard: kill() marks 'exited' first, so a subsequent PTY
      // exit must not fire a duplicate broadcast.
      if (agent && agent.status !== 'exited') {
        agent.status = 'exited';
        agent.exitCode = code;
        this.onAgentExit?.(agent);
      }
    });

    return { agentId, surfaceId };
  }

  getStatus(agentId: AgentId): AgentInfo | undefined { return this.agents.get(agentId); }

  list(workspaceId?: WorkspaceId): AgentInfo[] {
    const all = Array.from(this.agents.values());
    return workspaceId ? all.filter((a) => a.workspaceId === workspaceId) : all;
  }

  kill(agentId: AgentId): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    // Mark exited BEFORE killing the PTY so the PTY exit callback's transition
    // guard sees 'exited' and skips a duplicate broadcast.
    const wasRunning = agent.status !== 'exited';
    agent.status = 'exited';
    agent.exitCode = -1;
    this.ptyManager.kill(agent.surfaceId);
    if (wasRunning) this.onAgentExit?.(agent);
    return true;
  }

  getAgentBySurface(surfaceId: SurfaceId): AgentInfo | undefined {
    for (const agent of this.agents.values()) {
      if (agent.surfaceId === surfaceId) return agent;
    }
    return undefined;
  }
}
