import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendMock } }],
  },
}));

import {
  observePtyData, getActivity, clearActivity,
  markSubagentStop, markAllAgentsDone,
} from '../../src/main/claude-observer';
import { SurfaceId } from '../../src/shared/types';

const surf = 'surf-obs-1' as SurfaceId;

describe('observer agent parsing', () => {
  beforeEach(() => { sendMock.mockClear(); clearActivity(surf); });

  it('parses agent detail lines into the agents array', () => {
    observePtyData(surf, 'Running 3 agents\n├─ review:bugs · 12 tool uses · 45k tokens\n├─ review:perf · 8 tool uses · 30.2k tokens\n');
    const a = getActivity(surf)!;
    expect(a.agents).toHaveLength(2);
    expect(a.agents[0]).toMatchObject({ name: 'review:bugs', toolUses: 12, tokens: '45k' });
  });

  it('recognizes the ⏺ tool marker (current Claude Code UI) as well as ●', () => {
    observePtyData(surf, '⏺ Bash(ls -la)\n');
    expect(getActivity(surf)!.lastTool).toBe('Bash');
    clearActivity(surf);
    observePtyData(surf, '● Grep(pattern)\n');
    expect(getActivity(surf)!.lastTool).toBe('Grep');
  });

  it('repeated Done lines do not rebroadcast once the agent is already done', () => {
    observePtyData(surf, '├─ alpha · 2 tool uses · 3k tokens\n');
    observePtyData(surf, '⎿  Done\n');
    sendMock.mockClear();
    observePtyData(surf, '⎿  Done\n');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('caps tracked agents at 32', () => {
    for (let i = 0; i < 40; i++) {
      observePtyData(surf, `├─ agent-${i} · 1 tool use · 1k tokens\n`);
    }
    expect(getActivity(surf)!.agents.length).toBeLessThanOrEqual(32);
  });
});

describe('hook-driven lifecycle', () => {
  beforeEach(() => { sendMock.mockClear(); clearActivity(surf); });

  it('markSubagentStop marks the most recent non-done agent done and broadcasts', () => {
    observePtyData(surf, '├─ alpha · 2 tool uses · 3k tokens\n├─ beta · 1 tool use · 1k tokens\n');
    sendMock.mockClear();
    markSubagentStop(surf);
    const a = getActivity(surf)!;
    expect(a.agents.map(x => x.done)).toEqual([false, true]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('markSubagentStop on a surface with no agents is a safe no-op', () => {
    markSubagentStop(surf);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('markAllAgentsDone finishes every agent and sets isDone', () => {
    observePtyData(surf, '├─ alpha · 2 tool uses · 3k tokens\n├─ beta · 1 tool use · 1k tokens\n');
    markAllAgentsDone(surf);
    const a = getActivity(surf)!;
    expect(a.agents.every(x => x.done)).toBe(true);
    expect(a.isDone).toBe(true);
  });

  it('markAllAgentsDone on an untracked surface does not create an entry', () => {
    markAllAgentsDone(surf);
    expect(getActivity(surf)).toBeUndefined();
  });
});
