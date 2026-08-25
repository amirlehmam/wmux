/**
 * agent-identity.ts — which agent, if any, is running in each surface.
 *
 * The precedence chain is lifted from `ssh-detect.ts` rather than reinvented,
 * because it answers the same platform question. Windows has no tty foreground
 * process group, so there is no equivalent of "ask the terminal what owns it";
 * what wmux has instead is three signals of decreasing authority, and the rule
 * that the weakest may only CORROBORATE the others, never establish an answer
 * on its own.
 *
 *   1. Shell spec — wmux launched this pane's shell itself (`wmux new-workspace
 *                   --shell claude`, `wmux agent spawn --cmd`). If that command
 *                   line is an agent, the pane is that agent for as long as it
 *                   lives. Authoritative and free.
 *   2. Command    — the shell-integration preexec hook reported the command the
 *                   user just submitted. Instant, covers `claude` typed into a
 *                   pwsh pane, and cleared the moment the shell is back at its
 *                   prompt — which is what makes it safe to trust.
 *   3. Probe      — a `Win32_Process` sweep found an agent process descended
 *                   from the pane's PTY. Cannot distinguish foreground from
 *                   background, so it only fills the gap where neither of the
 *                   above spoke.
 *
 * Unlike ssh-detect, a wrong answer here is cosmetic: a mislabelled pane, not a
 * file uploaded to the wrong host. That is why the probe is allowed to stand
 * alone at all — but it is still ranked last, and it is still debounced.
 */
import { identifyAgentCommand } from './agent-argv';

export type IdentitySource = 'shell-spec' | 'command' | 'probe';

export interface AgentIdentity {
  /** Canonical agent kind — see AGENT_ALIASES. */
  kind: string;
  source: IdentitySource;
  /** When this answer was established. */
  at: number;
}

/**
 * Consecutive sweeps that must miss an agent before the probe drops it.
 *
 * Asymmetric on purpose: adopting on the first hit is right because a sweep
 * that SAW a process is proof it existed, while a sweep that missed one proves
 * very little — the sweep is 3s wide and ~550ms slow, so an agent restarting,
 * or a sweep landing mid-exec, reads as absence. Dropping on the first miss made
 * the label flicker on a perfectly healthy pane.
 */
const PROBE_MISSES_BEFORE_DROP = 2;

/** Same bound, and the same reason, as agent-state.ts's record map. */
const MAX_TRACKED_SURFACES = 256;

interface ProbeEntry {
  kind: string;
  at: number;
  misses: number;
}

export class AgentIdentityTracker {
  /** Layer 1: the pane's own shell command line resolved to an agent. */
  private shellSpec = new Map<string, AgentIdentity>();
  /** Layer 2: what the preexec hook says is running right now. */
  private command = new Map<string, AgentIdentity>();
  /** Layer 3: what the last sweep saw, with its miss counter. */
  private probe = new Map<string, ProbeEntry>();
  /** Monotonic per-surface guard, mirroring ssh-detect's sequence discipline. */
  private lastSequence = new Map<string, number>();

  private evictIfFull(map: Map<string, unknown>): void {
    if (map.size < MAX_TRACKED_SURFACES) return;
    // Oldest insertion first — Map preserves it, and a surface that has not been
    // written since is the safest thing to lose.
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }

  /**
   * A sequenced report is accepted only if it is newer than the last one seen.
   *
   * The shell hooks emit `seq=N` so a slow `report_command` cannot land after
   * the `report_shell_state` that was meant to clear it — the pane would then
   * show an agent that had already exited, forever.
   */
  private acceptSequence(surfaceId: string, value: number | undefined): boolean {
    if (value === undefined) return true;
    const previous = this.lastSequence.get(surfaceId) ?? 0;
    if (value < previous) return false;
    this.lastSequence.set(surfaceId, value);
    return true;
  }

  /** Layer 1. Called at pane create and whenever the surface's shell changes. */
  setSurfaceShell(surfaceId: string, shell: string | undefined, now = Date.now()): void {
    const kind = shell ? identifyAgentCommand(shell) : null;
    if (!kind) {
      this.shellSpec.delete(surfaceId);
      return;
    }
    this.evictIfFull(this.shellSpec);
    this.shellSpec.set(surfaceId, { kind, source: 'shell-spec', at: now });
  }

  /**
   * Layer 2. The preexec hook reporting a submitted command line.
   *
   * A command that is not an agent CLEARS the layer rather than being ignored:
   * the user running `git status` in a pane where they previously ran Claude
   * means Claude is no longer what that pane is doing.
   */
  reportCommand(surfaceId: string, commandLine: string, sequence?: number, now = Date.now()): void {
    if (!this.acceptSequence(surfaceId, sequence)) return;
    const kind = identifyAgentCommand(commandLine);
    if (!kind) {
      this.command.delete(surfaceId);
      return;
    }
    this.evictIfFull(this.command);
    this.command.set(surfaceId, { kind, source: 'command', at: now });
  }

  /** The shell is back at its prompt, so whatever it was running has exited. */
  clearReported(surfaceId: string, sequence?: number): void {
    if (!this.acceptSequence(surfaceId, sequence)) return;
    this.command.delete(surfaceId);
  }

  /**
   * Layer 3. Apply one sweep's findings for every live surface.
   *
   * Takes the WHOLE map rather than one surface at a time so the miss counters
   * advance exactly once per sweep. Called per-surface, a sweep that happened to
   * touch one pane twice would age every other pane's counter unevenly.
   */
  applyProbe(found: Map<string, string>, liveSurfaceIds: string[], now = Date.now()): void {
    for (const surfaceId of liveSurfaceIds) {
      const kind = found.get(surfaceId);
      const existing = this.probe.get(surfaceId);

      if (kind) {
        this.evictIfFull(this.probe);
        // A CHANGED kind resets the clock: this is a different agent, not the
        // same one seen again.
        this.probe.set(surfaceId, { kind, at: existing?.kind === kind ? existing.at : now, misses: 0 });
        continue;
      }

      if (!existing) continue;
      existing.misses += 1;
      if (existing.misses >= PROBE_MISSES_BEFORE_DROP) this.probe.delete(surfaceId);
    }
  }

  /** The answer for one surface, or null when no layer claims it. */
  identify(surfaceId: string): AgentIdentity | null {
    const spec = this.shellSpec.get(surfaceId);
    if (spec) return spec;

    const reported = this.command.get(surfaceId);
    if (reported) return reported;

    const probed = this.probe.get(surfaceId);
    if (probed) return { kind: probed.kind, source: 'probe', at: probed.at };

    return null;
  }

  /** Every surface currently attributed to an agent. */
  list(): Array<AgentIdentity & { surfaceId: string }> {
    const ids = new Set([...this.shellSpec.keys(), ...this.command.keys(), ...this.probe.keys()]);
    const out: Array<AgentIdentity & { surfaceId: string }> = [];
    for (const surfaceId of ids) {
      const identity = this.identify(surfaceId);
      if (identity) out.push({ surfaceId, ...identity });
    }
    return out;
  }

  /** Drop everything for a closed surface. */
  forget(surfaceId: string): void {
    this.shellSpec.delete(surfaceId);
    this.command.delete(surfaceId);
    this.probe.delete(surfaceId);
    this.lastSequence.delete(surfaceId);
  }

  /** Tests only. */
  reset(): void {
    this.shellSpec.clear();
    this.command.clear();
    this.probe.clear();
    this.lastSequence.clear();
  }
}

/**
 * The one tracker.
 *
 * Exported from the module that DEFINES it rather than from ipc-handlers, where
 * sshDetector lives: agent-state-rpc needs to read it to answer
 * `pane.agent_state`, and ipc-handlers already imports agent-state-rpc — so
 * hanging the singleton off ipc-handlers would close an import cycle.
 */
export const agentIdentity = new AgentIdentityTracker();
