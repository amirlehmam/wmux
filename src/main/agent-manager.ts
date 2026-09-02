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

// Does this chunk of shell output end on a prompt? Two things are easy to get
// wrong here, and each one silently costs every spawn the 1500 ms debounce:
//
//  - The prompt CHARACTER is not the last thing on the line any more. Since
//    #207 the shell integrations wrap the prompt in OSC 133 marks, so a
//    PowerShell prompt arrives as `PS C:\x> ` FOLLOWED BY `ESC ] 133;B ESC \`,
//    and PSReadLine / oh-my-posh tack CSI sequences (cursor show, SGR reset)
//    on after that. So after the prompt character this allows any run of
//    whitespace, OSC strings (BEL- or ST-terminated) and CSI sequences before
//    end-of-line — and nothing else, or a `>` in the middle of a banner would
//    count.
//  - `/m` is load-bearing: a chunk can carry several lines, and the prompt is
//    the last one.
//
// ESC and BEL are spelled out via fromCharCode rather than as `\x1b`/`\x07`
// in the literal: they are the terminator bytes of the very sequences this
// matches, and a raw control character in a regex literal is what the
// no-control-regex lint (rightly, elsewhere) rejects.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const OSC_SEQ = String.raw`${ESC}\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\)`;
const CSI_SEQ = String.raw`${ESC}\[[0-9;?]*[A-Za-z]`;
const PROMPT_RE = new RegExp(String.raw`(?:PS\s.*>|[$#%>])(?:\s|${OSC_SEQ}|${CSI_SEQ})*$`, 'm');

export function looksLikePrompt(data: string): boolean {
  return PROMPT_RE.test(data);
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
    // The command is offered as a STARTUP command first. For a PowerShell pane
    // with the integration script, pty-manager bakes it into
    // WMUX_STARTUP_COMMANDS and the script runs it during init, before the
    // first prompt — no prompt-sniffing, no settle delay, and none of the
    // DA1-query race pty-manager describes. The shell reports whether it took
    // it (`startupCommandsConsumed`); when it did, typing the command as well
    // would run it twice.
    const created = this.ptyManager.create({
      shell: '',  // Use default shell (resolves to pwsh/powershell/bash, not hardcoded cmd.exe)
      cwd: params.cwd || process.env.USERPROFILE || 'C:\\',
      env: { ...(params.env || {}), WMUX_AGENT_ID: agentId, WMUX_AGENT_LABEL: params.label },
      startupCommands: [params.cmd],
    });
    const surfaceId = created.id;

    if (!created.startupCommandsConsumed) this.typeAfterPrompt(surfaceId, params.cmd);

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

  /**
   * Keystroke delivery, for shells that could not take the command at startup
   * (bash, cmd, wsl, or PowerShell without the integration script). Waits for
   * a prompt before typing: PowerShell with profile scripts takes 1-3 s to
   * reach one, and a blind 800 ms timeout used to lose commands.
   */
  private typeAfterPrompt(surfaceId: SurfaceId, cmd: string): void {
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
          this.ptyManager.write(surfaceId, cmd + '\r');
        }
      }, 150);
    };

    // Listen for PTY output to detect when the shell prompt appears
    const removeDataListener = this.ptyManager.onData(surfaceId, (data) => {
      if (commandSent) return;
      if (looksLikePrompt(data)) {
        sendOnce();
      } else if (!promptDebounce) {
        // Got output but no prompt yet — shell is loading; wait a bit more
        promptDebounce = setTimeout(sendOnce, 1500);
      }
    });

    // Absolute fallback: if shell produces no recognizable prompt after 5s, send anyway
    const fallbackTimer = setTimeout(sendOnce, 5000);
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
