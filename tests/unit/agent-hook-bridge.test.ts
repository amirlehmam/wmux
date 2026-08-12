import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { hookToAgentReport, applyHookToAgentState, hookEventName, resetHookBridge } from '../../src/main/agent-hook-bridge';
import { getAgentState, resetAgentState } from '../../src/main/agent-state';
import { SurfaceId } from '../../src/shared/types';

const surf = 'surf-hook-1' as SurfaceId;

beforeEach(() => {
  resetAgentState();
  resetHookBridge();
});

/**
 * Turn context for the pure mapper. Defaults to a mid-turn pane on the 0.48.0
 * hook set, which is what every event other than Notification ignores anyway.
 */
const ctx = (over: Partial<Parameters<typeof hookToAgentReport>[2]> = {}) =>
  ({ known: true, runDepth: 1, turnStartTracked: true, ...over });

describe('hookToAgentReport', () => {
  it('Notification parks the pane on the user and keeps the message as the reason', () => {
    expect(hookToAgentReport('Notification', 'Claude needs your permission to use Bash', ctx()))
      .toEqual({ awaitingHuman: true, reason: 'Claude needs your permission to use Bash' });
  });

  it('the 60s idle nudge after a finished turn is NOT blocked (issue #151)', () => {
    // Same hook, different situation. A prompt can only exist inside a live
    // turn, so depth 0 at Notification time means this is the idle nudge — and
    // "Needs you" on a pane with nothing to answer is how a session that was
    // /clear'd and left alone starts asking for attention a minute later.
    expect(hookToAgentReport('Notification', 'Claude is waiting for your input', ctx({ runDepth: 0 })))
      .toBeNull();
  });

  it('a prompt inside a live turn is still blocked', () => {
    expect(hookToAgentReport('Notification', 'permission to use Bash', ctx({ runDepth: 1 }))?.awaitingHuman)
      .toBe(true);
  });

  it('parks the pane for both when the opening hooks are not installed', () => {
    // A settings.json written before 0.48.0 sits at depth 0 through an entire
    // turn, so the discriminator carries no information — and guessing would
    // fail in the dangerous direction, swallowing a real permission prompt.
    expect(hookToAgentReport('Notification', 'permission to use Bash', ctx({ runDepth: 0, turnStartTracked: false }))?.awaitingHuman)
      .toBe(true);
  });

  it('parks the pane for a surface it holds no record for', () => {
    // Depth 0 by default rather than by observation — what a main process
    // restarted in the middle of someone's turn sees.
    expect(hookToAgentReport('Notification', 'permission to use Bash', ctx({ known: false, runDepth: 0 }))?.awaitingHuman)
      .toBe(true);
  });

  it('PostToolUse asserts a run and clears any block, idempotently', () => {
    expect(hookToAgentReport('PostToolUse', null, ctx())).toEqual({ awaitingHuman: false, runDepth: 1 });
  });

  it('SubagentStop keeps the parent turn running (issue #151)', () => {
    // Not a decrement: subagents share the parent's surface id, so the first one
    // to finish used to drain the refcount and report the pane idle while the
    // parent and its siblings were still working.
    expect(hookToAgentReport('SubagentStop', null, ctx())).toEqual({ awaitingHuman: false, runDepth: 1 });
  });

  it('SubagentStop sustains a live turn but never starts one (issue #151)', () => {
    // Measured, twice, on two panes: Claude Code fires SubagentStop 1.8-2.2s
    // AFTER the parent's Stop, not before it. Asserting depth 1 unconditionally
    // therefore resurrects the run Stop had just ended — and with a strictly
    // newer hookAt, so the wall-clock ordering gate waves it through.
    expect(hookToAgentReport('SubagentStop', null, ctx({ runDepth: 0 }))).toBeNull();
    expect(hookToAgentReport('SubagentStop', null, ctx({ known: false, runDepth: 0 }))).toBeNull();
  });

  it('Stop is decisive: nothing running, nothing waiting', () => {
    expect(hookToAgentReport('Stop', null, ctx())).toEqual({ awaitingHuman: false, runDepth: 0 });
  });

  it('SessionStart registers the pane as an idle session (issue #151)', () => {
    expect(hookToAgentReport('SessionStart', null, ctx())).toEqual({ awaitingHuman: false, runDepth: 0 });
  });

  it('UserPromptSubmit starts the turn and ends the wait (issue #151)', () => {
    expect(hookToAgentReport('UserPromptSubmit', null, ctx())).toEqual({ awaitingHuman: false, runDepth: 1 });
  });

  it('PreToolUse asserts the run before the tool, not after it (issue #151)', () => {
    expect(hookToAgentReport('PreToolUse', null, ctx())).toEqual({ awaitingHuman: false, runDepth: 1 });
  });
});

describe('hookEventName', () => {
  it('reads the event when the payload names one', () => {
    expect(hookEventName({ event: 'Stop' })).toBe('Stop');
  });

  it('resolves a bare tool payload to PostToolUse (issue #151)', () => {
    // The per-tool PostToolUse entries invoke the hook helper by bare tool
    // name, so they arrive with a `tool` and no `event` at all. Gating on
    // `params.event` dropped every one of them and made the PostToolUse case
    // unreachable.
    expect(hookEventName({ tool: 'Bash' })).toBe('PostToolUse');
  });

  it('ignores an event outside the model', () => {
    expect(hookEventName({ event: 'PreCompact' })).toBeNull();
  });

  it('ignores a payload that names neither', () => {
    expect(hookEventName({})).toBeNull();
    expect(hookEventName(null)).toBeNull();
  });
});

describe('applyHookToAgentState', () => {
  it('ignores hook events that are not part of the model', () => {
    applyHookToAgentState(surf, 'PreCompact', null);
    expect(getAgentState(surf)).toBeUndefined();
  });

  it('a fresh session reads idle, not unknown (issue #151)', () => {
    // The pane must become a KNOWN session immediately. Left unknown, the
    // sidebar falls back to shell state — and `claude` is a foreground command,
    // so a brand-new session that has done nothing showed "Running".
    applyHookToAgentState(surf, 'SessionStart', null);
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('the pane is working from the moment the human hits Enter (issue #151)', () => {
    // The gap this closes: before UserPromptSubmit, nothing said a turn had
    // begun until the FIRST TOOL FINISHED. A turn that thinks for a minute, or
    // runs one long command, read as idle for all of it.
    applyHookToAgentState(surf, 'SessionStart', null);
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    expect(getAgentState(surf)?.state).toBe('working');
  });

  it('replying to a blocked pane un-blocks it without waiting for a tool (issue #151)', () => {
    applyHookToAgentState(surf, 'Notification', 'Claude needs your permission to use Bash');
    expect(getAgentState(surf)?.state).toBe('blocked');

    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    expect(getAgentState(surf)).toMatchObject({ state: 'working', blockedReason: null });
  });

  it('a long tool reports working while it runs, not once it ends (issue #151)', () => {
    applyHookToAgentState(surf, 'PreToolUse', null);
    expect(getAgentState(surf)?.state).toBe('working');
  });

  it('SessionEnd releases the pane rather than pinning it idle (issue #151)', () => {
    // Forgotten, not set to idle: a declared `idle` outranks the sidebar's own
    // inference, so an ended session would freeze the pane's reading forever.
    applyHookToAgentState(surf, 'SessionStart', null);
    applyHookToAgentState(surf, 'SessionEnd', null);
    expect(getAgentState(surf)).toBeUndefined();
  });

  it('orders racing hook processes by fire time, not arrival (issue #151)', () => {
    // PostToolUse fired first but its node process lost the race to the pipe.
    // Applied in arrival order it would re-assert a run that Stop had ended, and
    // the pane would claim `working` for the full 15-minute trust window.
    applyHookToAgentState(surf, 'Stop', null, 2000);
    applyHookToAgentState(surf, 'PostToolUse', null, 1000);
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('still applies hook events that arrive in order', () => {
    applyHookToAgentState(surf, 'Stop', null, 1000);
    applyHookToAgentState(surf, 'UserPromptSubmit', null, 2000);
    expect(getAgentState(surf)?.state).toBe('working');
  });

  it('drives a full turn: tool use → permission prompt → answered → done', () => {
    applyHookToAgentState(surf, 'PostToolUse', null);
    expect(getAgentState(surf)?.state).toBe('working');

    applyHookToAgentState(surf, 'Notification', 'permission to use Bash');
    expect(getAgentState(surf)).toMatchObject({ state: 'blocked', blockedReason: 'permission to use Bash' });

    // The user approved: the next tool ran, which can only happen once the
    // prompt is gone.
    applyHookToAgentState(surf, 'PostToolUse', null);
    expect(getAgentState(surf)).toMatchObject({ state: 'working', blockedReason: null });

    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('hundreds of tool calls do not inflate the run depth', () => {
    for (let i = 0; i < 300; i++) applyHookToAgentState(surf, 'PostToolUse', null);
    expect(getAgentState(surf)?.runDepth).toBe(1);
  });

  it('Stop clears a pane that was left blocked', () => {
    // The backstop property: even if the un-block event is missed, ending the
    // turn must not leave a ghost "needs you" behind.
    applyHookToAgentState(surf, 'Notification', 'waiting');
    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)).toMatchObject({ state: 'idle', blockedReason: null });
  });

  it('the idle nudge does not resurrect a finished turn (issue #151)', () => {
    // The sequence that produced the report: a session is /clear'd and left
    // alone. /clear wipes the transcript but not Claude Code's idle timer, so
    // 60s after the Stop the nudge lands on an empty conversation.
    applyHookToAgentState(surf, 'SessionStart', null);
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)?.state).toBe('idle');

    applyHookToAgentState(surf, 'Notification', 'Claude is waiting for your input');
    expect(getAgentState(surf)).toMatchObject({ state: 'idle', blockedReason: null });
  });

  it('but a permission prompt mid-turn still parks the pane', () => {
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    applyHookToAgentState(surf, 'Notification', 'permission to use Bash');
    expect(getAgentState(surf)).toMatchObject({ state: 'blocked', blockedReason: 'permission to use Bash' });
  });

  it('a subagent finishing does not end the outer turn (issue #151)', () => {
    // Three subagents on one surface. Every one of them finishing must leave the
    // pane working — only the parent's Stop ends the turn.
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    for (let i = 0; i < 3; i++) {
      applyHookToAgentState(surf, 'PostToolUse', null);
      applyHookToAgentState(surf, 'SubagentStop', null);
      expect(getAgentState(surf)?.state).toBe('working');
    }
    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('a SubagentStop trailing the parent Stop does not resurrect the turn (issue #151)', () => {
    // The real wire order, with the real stamps: Stop at T, SubagentStop at
    // T+2s. The later stamp is what makes this bite — acceptHookAt orders by
    // hookAt, so the trailing report is newer and cannot be dropped as a replay.
    applyHookToAgentState(surf, 'UserPromptSubmit', null, 1000);
    applyHookToAgentState(surf, 'PostToolUse', null, 2000);
    applyHookToAgentState(surf, 'Stop', null, 3000);
    expect(getAgentState(surf)?.state).toBe('idle');

    applyHookToAgentState(surf, 'SubagentStop', null, 5000);
    expect(getAgentState(surf)?.state).toBe('idle');

    // And the 60s idle nudge that follows must still read as a nudge, not as a
    // prompt — the resurrection defeated that gate too.
    applyHookToAgentState(surf, 'Notification', 'Claude is waiting for your input', 65000);
    expect(getAgentState(surf)?.state).toBe('idle');
  });
});
