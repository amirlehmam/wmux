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

  constructor(ptyManager: PtyManager) {
    this.ptyManager = ptyManager;
  }

  spawn(params: AgentSpawnParams & { paneId: PaneId; workspaceId: WorkspaceId }): { agentId: AgentId; surfaceId: SurfaceId } {
    const agentId: AgentId = `agent-${uuid()}`;
    const created = this.ptyManager.create({
      shell: '',  // Use default shell (resolves to pwsh/powershell/bash, not hardcoded cmd.exe)
      cwd: params.cwd || process.env.USERPROFILE || 'C:\\',
      env: { ...(params.env || {}), WMUX_AGENT_ID: agentId, WMUX_AGENT_LABEL: params.label },
    });
    const surfaceId = created.id;

    setTimeout(() => {
      if (this.ptyManager.has(surfaceId)) {
        this.ptyManager.write(surfaceId, params.cmd + '\r');
      }
    }, 800);

    const info: AgentInfo = {
      agentId, surfaceId, paneId: params.paneId, workspaceId: params.workspaceId,
      label: params.label, cmd: params.cmd, status: 'running',
      spawnTime: Date.now(), pid: this.ptyManager.getPid(surfaceId),
    };
    this.agents.set(agentId, info);

    this.ptyManager.onExit(surfaceId, (code) => {
      const agent = this.agents.get(agentId);
      if (agent) { agent.status = 'exited'; agent.exitCode = code; }
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
    this.ptyManager.kill(agent.surfaceId);
    agent.status = 'exited';
    agent.exitCode = -1;
    return true;
  }

  getAgentBySurface(surfaceId: SurfaceId): AgentInfo | undefined {
    for (const agent of this.agents.values()) {
      if (agent.surfaceId === surfaceId) return agent;
    }
    return undefined;
  }
}
