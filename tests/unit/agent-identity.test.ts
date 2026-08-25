import { describe, it, expect, beforeEach } from 'vitest';
import { AgentIdentityTracker } from '../../src/main/agent-identity';
import { parseProcessTable, attributeAgentProcesses } from '../../src/main/ssh-detect';

let tracker: AgentIdentityTracker;
const surf = 'surf-1';
const other = 'surf-2';
const NOW = 1_000_000;

beforeEach(() => {
  tracker = new AgentIdentityTracker();
});

describe('layer 1 — shell spec', () => {
  it('names a pane wmux launched as an agent', () => {
    tracker.setSurfaceShell(surf, 'claude --resume', NOW);
    expect(tracker.identify(surf)).toEqual({ kind: 'claude', source: 'shell-spec', at: NOW });
  });

  it('claims nothing for an ordinary shell', () => {
    tracker.setSurfaceShell(surf, 'pwsh -NoLogo');
    expect(tracker.identify(surf)).toBeNull();
  });

  it('clears when the surface stops being an agent pane', () => {
    tracker.setSurfaceShell(surf, 'claude');
    tracker.setSurfaceShell(surf, 'pwsh');
    expect(tracker.identify(surf)).toBeNull();
  });
});

describe('layer 2 — reported command', () => {
  it('names an agent typed into an ordinary shell', () => {
    tracker.setSurfaceShell(surf, 'pwsh');
    tracker.reportCommand(surf, 'codex exec "fix it"', undefined, NOW);
    expect(tracker.identify(surf)).toEqual({ kind: 'codex', source: 'command', at: NOW });
  });

  /**
   * The layer is what the pane is doing NOW. A non-agent command is not noise
   * to skip past — it is evidence the previous agent has been replaced.
   */
  it('a non-agent command clears a previous agent', () => {
    tracker.reportCommand(surf, 'claude');
    tracker.reportCommand(surf, 'git status');
    expect(tracker.identify(surf)).toBeNull();
  });

  it('is cleared when the shell returns to its prompt', () => {
    tracker.reportCommand(surf, 'claude');
    tracker.clearReported(surf);
    expect(tracker.identify(surf)).toBeNull();
  });

  it('falls back to the shell spec once the command is cleared', () => {
    tracker.setSurfaceShell(surf, 'claude', NOW);
    tracker.reportCommand(surf, 'git log');
    tracker.clearReported(surf);
    expect(tracker.identify(surf)?.source).toBe('shell-spec');
  });
});

describe('sequence discipline', () => {
  /**
   * Without this, a slow report_command landing after the report_shell_state
   * meant to clear it pins an agent that already exited — permanently, since
   * nothing else will clear that layer.
   */
  it('drops a report that arrives out of order behind a clear', () => {
    tracker.reportCommand(surf, 'claude', 5);
    tracker.clearReported(surf, 6);
    tracker.reportCommand(surf, 'claude', 4); // the straggler
    expect(tracker.identify(surf)).toBeNull();
  });

  it('accepts an equal sequence — a retry of the same event is not a replay', () => {
    tracker.reportCommand(surf, 'claude', 7);
    tracker.clearReported(surf, 7);
    expect(tracker.identify(surf)).toBeNull();
  });

  it('keeps sequences per surface', () => {
    tracker.reportCommand(surf, 'claude', 9);
    tracker.reportCommand(other, 'codex', 1);
    expect(tracker.identify(other)?.kind).toBe('codex');
  });

  it('an unsequenced report is always accepted', () => {
    tracker.reportCommand(surf, 'claude', 9);
    tracker.reportCommand(surf, 'codex');
    expect(tracker.identify(surf)?.kind).toBe('codex');
  });
});

describe('layer 3 — probe', () => {
  it('claims a surface no authoritative layer spoke for', () => {
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf], NOW);
    expect(tracker.identify(surf)).toEqual({ kind: 'aider', source: 'probe', at: NOW });
  });

  it('never outranks an authoritative layer', () => {
    tracker.setSurfaceShell(surf, 'claude');
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf]);
    expect(tracker.identify(surf)?.source).toBe('shell-spec');

    tracker.setSurfaceShell(surf, 'pwsh');
    tracker.reportCommand(surf, 'codex');
    expect(tracker.identify(surf)?.source).toBe('command');
  });

  /**
   * Asymmetric debounce: a sweep that SAW a process proves it existed, while a
   * sweep that missed one proves little — it is 3s wide and ~550ms slow, so an
   * agent restarting reads as absence. Dropping on the first miss made the label
   * flicker on a healthy pane.
   */
  it('adopts on the first hit but survives one miss', () => {
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf]);
    tracker.applyProbe(new Map(), [surf]);
    expect(tracker.identify(surf)?.kind).toBe('aider');
  });

  it('drops after two consecutive misses', () => {
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf]);
    tracker.applyProbe(new Map(), [surf]);
    tracker.applyProbe(new Map(), [surf]);
    expect(tracker.identify(surf)).toBeNull();
  });

  it('a hit resets the miss counter', () => {
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf]);
    tracker.applyProbe(new Map(), [surf]);
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf]);
    tracker.applyProbe(new Map(), [surf]);
    expect(tracker.identify(surf)?.kind).toBe('aider');
  });

  it('keeps the original timestamp while the same agent is seen again', () => {
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf], NOW);
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf], NOW + 10_000);
    expect(tracker.identify(surf)?.at).toBe(NOW);
  });

  it('restarts the clock when the probe sees a DIFFERENT agent', () => {
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf], NOW);
    tracker.applyProbe(new Map([[surf, 'codex']]), [surf], NOW + 10_000);
    expect(tracker.identify(surf)).toEqual({ kind: 'codex', source: 'probe', at: NOW + 10_000 });
  });

  /** A surface not in the sweep's scope must not age — it was never looked at. */
  it('does not age a surface absent from the live list', () => {
    tracker.applyProbe(new Map([[surf, 'aider']]), [surf]);
    tracker.applyProbe(new Map(), [other]);
    tracker.applyProbe(new Map(), [other]);
    expect(tracker.identify(surf)?.kind).toBe('aider');
  });
});

describe('list and forget', () => {
  it('lists one entry per attributed surface, at its winning source', () => {
    tracker.setSurfaceShell(surf, 'claude', NOW);
    tracker.reportCommand(other, 'codex', undefined, NOW);
    tracker.applyProbe(new Map([[other, 'aider']]), [other]);

    expect(tracker.list().sort((a, b) => a.surfaceId.localeCompare(b.surfaceId))).toEqual([
      { surfaceId: surf, kind: 'claude', source: 'shell-spec', at: NOW },
      { surfaceId: other, kind: 'codex', source: 'command', at: NOW },
    ]);
  });

  it('omits a surface whose layers all cleared', () => {
    tracker.reportCommand(surf, 'claude');
    tracker.clearReported(surf);
    expect(tracker.list()).toEqual([]);
  });

  it('forget drops every layer including the sequence guard', () => {
    tracker.setSurfaceShell(surf, 'claude');
    tracker.reportCommand(surf, 'codex', 5);
    tracker.forget(surf);
    expect(tracker.identify(surf)).toBeNull();

    // The guard is gone too, so a recycled surface id starts clean.
    tracker.reportCommand(surf, 'codex', 1);
    expect(tracker.identify(surf)?.kind).toBe('codex');
  });
});

// ── Process-table attribution (the probe's raw material) ────────────────────

describe('parseProcessTable — agent rows', () => {
  // pid|ppid|Name|ExecutablePath|CommandLine — the five columns listSshProcesses asks for.
  const row = (pid: number, ppid: number, name: string, cmd = name) =>
    [pid, ppid, name, `C:\\bin\\${name}`, cmd].join('|');

  it('collects agent processes alongside ssh ones, in one pass', () => {
    const out = parseProcessTable([
      row(100, 4, 'pwsh.exe'),
      row(200, 100, 'claude.exe'),
      row(300, 100, 'ssh.exe', 'ssh user@host'),
    ].join('\n'));

    expect(out.agentProcesses).toEqual([{ pid: 200, kind: 'claude' }]);
    expect(out.sshProcesses.map((p) => p.pid)).toEqual([300]);
    expect(out.parents.get(200)).toBe(100);
  });

  /**
   * Classified off the process NAME, never the command line: `cmd.exe /c claude`
   * and the claude.exe it spawns are two separate rows, and only one of them IS
   * the agent. Unwrapping here would attribute the pane to a wrapper that has
   * already handed off.
   */
  it('does not treat a wrapper as the agent it launched', () => {
    const out = parseProcessTable(row(100, 4, 'cmd.exe', 'cmd /c claude'));
    expect(out.agentProcesses).toEqual([]);
  });

  it('ignores ordinary processes', () => {
    const out = parseProcessTable([row(10, 4, 'explorer.exe'), row(11, 4, 'git.exe')].join('\n'));
    expect(out.agentProcesses).toEqual([]);
  });
});

describe('attributeAgentProcesses', () => {
  const source = (roots: Record<string, number>) => ({
    getPid: (id: string) => roots[id],
    liveSurfaceIds: () => Object.keys(roots),
  });

  it('attributes an agent to the surface whose PTY subtree holds it', () => {
    const parents = new Map([[500, 100], [100, 4]]);
    const found = attributeAgentProcesses([{ pid: 500, kind: 'claude' }], parents, source({ [surf]: 100 }));
    expect(found.get(surf)).toBe('claude');
  });

  it('attributes a pane whose PTY root IS the agent', () => {
    const found = attributeAgentProcesses(
      [{ pid: 100, kind: 'codex' }], new Map([[100, 4]]), source({ [surf]: 100 }),
    );
    expect(found.get(surf)).toBe('codex');
  });

  /** `pwsh -> claude`: the deeper process is what the pane is running. */
  it('deepest wins when a subtree holds more than one agent', () => {
    const parents = new Map([[300, 200], [200, 100], [100, 4]]);
    const found = attributeAgentProcesses(
      [{ pid: 200, kind: 'claude' }, { pid: 300, kind: 'codex' }],
      parents, source({ [surf]: 100 }),
    );
    expect(found.get(surf)).toBe('codex');
  });

  it('claims nothing for an agent under no tracked PTY', () => {
    const found = attributeAgentProcesses(
      [{ pid: 900, kind: 'claude' }], new Map([[900, 4]]), source({ [surf]: 100 }),
    );
    expect(found.size).toBe(0);
  });

  it('returns empty when there are no agents or no live surfaces', () => {
    expect(attributeAgentProcesses([], new Map(), source({ [surf]: 100 })).size).toBe(0);
    expect(attributeAgentProcesses([{ pid: 1, kind: 'claude' }], new Map(), source({})).size).toBe(0);
  });
});
