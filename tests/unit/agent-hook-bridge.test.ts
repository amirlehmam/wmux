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

  it('SubagentStop decrements rather than clearing the run', () => {
    expect(hookToAgentReport('SubagentStop', null)).toEqual({ runDelta: -1 });
  });

  it('Stop is decisive: nothing running, nothing waiting', () => {
    expect(hookToAgentReport('Stop', null)).toEqual({ awaitingHuman: false, runDepth: 0 });
  });
});

describe('applyHookToAgentState', () => {
  it('ignores hook events that are not part of the model', () => {
    applyHookToAgentState(surf, 'SessionStart', null);
    expect(getAgentState(surf)).toBeUndefined();
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

  it('a subagent finishing does not end the outer turn', () => {
    applyHookToAgentState(surf, 'PostToolUse', null);
    applyHookToAgentState(surf, 'SubagentStop', null);
    // PostToolUse set depth to exactly 1, so one SubagentStop drains it; the
    // clamp is what keeps a second one from going negative.
    applyHookToAgentState(surf, 'SubagentStop', null);
    expect(getAgentState(surf)?.runDepth).toBe(0);
  });
});
