/**
 * Agent PTY spawning (`wmux agent spawn` / `spawn-batch`), and the round-robin
 * distribution of agents across a workspace's panes.
 *
 * The agent command travels as a `startupCommands` entry that the PowerShell
 * integration runs during init (see `pty-manager.ts`), not as keystrokes typed
 * after a sniffed prompt. The sniff is what this module used to do, and it
 * broke silently: the prompt regex stopped matching the moment #207 wrapped the
 * prompt in OSC 133 marks, so every `wmux agent spawn` fell into the 1500 ms
 * debounce (moving the command to `startupCommands` took first output from
 * 1.71 s to 0.56 s). It no longer types anything itself: since #251
 * PtyManager delivers startup commands for every caller (see
 * `startup-commands.ts`), and `looksLikePrompt` is re-exported from there.
 */
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

// The prompt sniff moved to startup-commands.ts with the delivery it serves
// (#251): PtyManager now types every startup command itself, for every caller.
// Re-exported so nothing that imported it from here has to change.
export { looksLikePrompt } from './startup-commands';

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
    // The command is handed to the PTY as a STARTUP command, and PtyManager
    // owns delivering it: baked into the PowerShell integration (run during
    // init, before the first prompt — none of the DA1-query race pty-manager
    // describes), or, for any other shell, typed once that shell is ready to
    // read it (startup-commands.ts, #251). This used to keep its own prompt
    // sniff for the second case while the renderer typed restore commands on
    // a blind timer; one delivery path means one idea of "ready".
    const created = this.ptyManager.create({
      shell: '',  // Use default shell (resolves to pwsh/powershell/bash, not hardcoded cmd.exe)
      cwd: params.cwd || process.env.USERPROFILE || 'C:\\',
      // Straight to PtyManager.create(), not through resolveSurfaceEnv
      // (surface-env.ts): that filter drops every WMUX_* key, these included.
      env: { ...(params.env || {}), WMUX_AGENT_ID: agentId, WMUX_AGENT_LABEL: params.label },
      startupCommands: [params.cmd],
    });
    const surfaceId = created.id;

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
