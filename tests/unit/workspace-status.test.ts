import { describe, it, expect } from 'vitest';

import { resolveStatusText, statusClassFor, StatusTextInputs } from '../../src/renderer/components/Sidebar/workspace-status';

/** The component passes the real translator; the fallback text is what we assert on. */
const t = ((_key: string, fallback?: string) => fallback ?? _key) as never;

function inputs(over: Partial<StatusTextInputs> = {}): StatusTextInputs {
  return {
    runningAgentCount: 0,
    agentTotal: 0,
    sessionCount: 0,
    workingSessions: 0,
    blockedSessions: 0,
    currentToolLabel: null,
    claudeIsIdle: false,
    ...over,
  };
}

describe('resolveStatusText — declared work outranks the shell', () => {
  // The regression. One agent pane, which has DECLARED runDepth>0 over the
  // pipe, mid-turn. No tool label is live because PostToolUse only fires when a
  // tool FINISHES — during a stretch of thinking, or one slow tool, the label's
  // freshness window lapses while the turn is very much still running.
  //
  // `workingSessions` used to be consulted ONLY inside the `sessionCount >= 2`
  // branch, so a single session fell past it, past the null tool label, past
  // claudeIsIdle (false — it early-returns unless the shell says "running"),
  // and landed on the shell's own state. A shell reporting idle (the Claude
  // Code TUI is not a "running command") then rendered the row "Idle" while the
  // agent worked — the authoritative signal computed, then dropped.
  it('a single working session is not reported as Idle by the shell state', () => {
    const s = inputs({ sessionCount: 1, workingSessions: 1, shellState: 'idle' });
    expect(resolveStatusText(s, t)).toBe('Running…');
  });

  it('holds even when the shell says nothing at all', () => {
    const s = inputs({ sessionCount: 1, workingSessions: 1 });
    expect(resolveStatusText(s, t)).toBe('Running…');
  });

  it('a live tool label is kept — it is strictly more informative', () => {
    const s = inputs({
      sessionCount: 1, workingSessions: 1, currentToolLabel: 'Reading file...', shellState: 'idle',
    });
    expect(resolveStatusText(s, t)).toBe('Reading file...');
  });

  it('a done notification still wins once the session stops working', () => {
    const s = inputs({ sessionCount: 1, workingSessions: 0, shellState: 'idle', notificationText: 'build ok' });
    expect(resolveStatusText(s, t)).toBe('Done: build ok');
  });
});

describe('resolveStatusText — established precedence is unchanged', () => {
  it('a manual override beats everything', () => {
    expect(resolveStatusText(inputs({ statusOverride: 'idle', sessionCount: 1, workingSessions: 1 }), t)).toBe('Idle');
    expect(resolveStatusText(inputs({ statusOverride: 'running' }), t)).toBe('Running');
  });

  it('a blocked pane outranks a working one — it is the thing needing the user', () => {
    const s = inputs({ sessionCount: 2, workingSessions: 1, blockedSessions: 1 });
    expect(resolveStatusText(s, t)).toBe('Needs you');
    expect(resolveStatusText({ ...s, blockedSessions: 3 }, t)).toBe('Needs you · 3');
  });

  it('orchestration summary outranks the session summary', () => {
    const s = inputs({ runningAgentCount: 2, agentTotal: 3, sessionCount: 1, workingSessions: 1 });
    expect(resolveStatusText(s, t)).toBe('Orchestrating · 3 agents');
  });

  it('multiple sessions still summarize rather than showing one row Running', () => {
    expect(resolveStatusText(inputs({ sessionCount: 3, workingSessions: 2 }), t))
      .toBe('Claude · 2/3 running');
    // Every session stopped — the summary is the authority, not the shell.
    expect(resolveStatusText(inputs({ sessionCount: 3, workingSessions: 0, shellState: 'running' }), t))
      .toBe('Idle');
  });

  it('claudeIsIdle stops a busy shell from reading as Running', () => {
    const s = inputs({ sessionCount: 1, workingSessions: 0, claudeIsIdle: true, shellState: 'running' });
    expect(resolveStatusText(s, t)).toBe('Idle');
  });

  it('falls back to the shell when no session is tracked at all', () => {
    expect(resolveStatusText(inputs({ shellState: 'running' }), t)).toBe('Running');
    expect(resolveStatusText(inputs({ shellState: 'interrupted' }), t)).toBe('Interrupted');
    expect(resolveStatusText(inputs(), t)).toBe('Idle');
  });
});

describe('statusClassFor — the colour must not contradict the words', () => {
  // The two chains are written out separately and drifted apart once already.
  // A single working session used to render "Idle" in text AND the `--done`
  // style in colour; both had `workingSessions` gated behind `sessionCount>=2`.
  it('a single working session is styled working, not done', () => {
    const s = inputs({ sessionCount: 1, workingSessions: 1, shellState: 'idle' });
    expect(statusClassFor(s)).toBe('workspace-row__status--working');
  });

  it('never says Running… while painting an idle/done colour', () => {
    const cases: StatusTextInputs[] = [
      inputs({ sessionCount: 1, workingSessions: 1, shellState: 'idle' }),
      inputs({ sessionCount: 1, workingSessions: 1 }),
      inputs({ sessionCount: 1, workingSessions: 1, shellState: 'running' }),
      inputs({ sessionCount: 2, workingSessions: 1, shellState: 'idle' }),
    ];
    for (const s of cases) {
      const text = resolveStatusText(s, t);
      const cls = statusClassFor(s);
      expect({ text, cls }).toMatchObject({ cls: 'workspace-row__status--working' });
      expect(text).not.toBe('Idle');
    }
  });

  it('blocked is its own colour, outranking a concurrent run', () => {
    expect(statusClassFor(inputs({ sessionCount: 2, workingSessions: 1, blockedSessions: 1 })))
      .toBe('workspace-row__status--blocked');
  });

  it('an idle session with a busy shell stays idle, not running', () => {
    const s = inputs({ sessionCount: 1, workingSessions: 0, claudeIsIdle: true, shellState: 'running' });
    expect(statusClassFor(s)).toBe('workspace-row__status--idle');
    expect(resolveStatusText(s, t)).toBe('Idle');
  });

  it('with no session tracked the shell still drives the colour', () => {
    expect(statusClassFor(inputs({ shellState: 'running' }))).toBe('workspace-row__status--running');
    expect(statusClassFor(inputs({ shellState: 'interrupted' }))).toBe('workspace-row__status--interrupted');
    expect(statusClassFor(inputs({ shellState: 'idle' }))).toBe('workspace-row__status--done');
    expect(statusClassFor(inputs())).toBe('workspace-row__status--idle');
  });
});
