import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { hookToAgentReport, applyHookToAgentState } from '../../src/main/agent-hook-bridge';
import { getAgentState, resetAgentState } from '../../src/main/agent-state';
import { SurfaceId } from '../../src/shared/types';

const surf = 'surf-hook-1' as SurfaceId;

beforeEach(() => resetAgentState());

describe('hookToAgentReport', () => {
  it('Notification parks the pane on the user and keeps the message as the reason', () => {
    expect(hookToAgentReport('Notification', 'Claude needs your permission to use Bash'))
      .toEqual({ awaitingHuman: true, reason: 'Claude needs your permission to use Bash' });
  });

  it('the 60s idle nudge also counts as blocked', () => {
    // Deliberate: the agent genuinely is waiting on the user. Text-sniffing to
    // tell a nudge from a permission prompt would break on any rewording, and
    // would fail in the dangerous direction.
    expect(hookToAgentReport('Notification', 'Claude is waiting for your input')?.awaitingHuman).toBe(true);
  });

  it('PostToolUse asserts a run and clears any block, idempotently', () => {
    expect(hookToAgentReport('PostToolUse', null)).toEqual({ awaitingHuman: false, runDepth: 1 });
  });

  it('SubagentStop keeps the parent turn running (issue #151)', () => {
    // Not a decrement: subagents share the parent's surface id, so the first one
    // to finish used to drain the refcount and report the pane idle while the
    // parent and its siblings were still working.
    expect(hookToAgentReport('SubagentStop', null)).toEqual({ awaitingHuman: false, runDepth: 1 });
  });

  it('Stop is decisive: nothing running, nothing waiting', () => {
    expect(hookToAgentReport('Stop', null)).toEqual({ awaitingHuman: false, runDepth: 0 });
  });

  it('SessionStart registers the pane as an idle session (issue #151)', () => {
    expect(hookToAgentReport('SessionStart', null)).toEqual({ awaitingHuman: false, runDepth: 0 });
  });

  it('UserPromptSubmit starts the turn and ends the wait (issue #151)', () => {
    expect(hookToAgentReport('UserPromptSubmit', null)).toEqual({ awaitingHuman: false, runDepth: 1 });
  });

  it('PreToolUse asserts the run before the tool, not after it (issue #151)', () => {
    expect(hookToAgentReport('PreToolUse', null)).toEqual({ awaitingHuman: false, runDepth: 1 });
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
});
