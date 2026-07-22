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

  it('caps tracked agents at 32 with FIFO eviction', () => {
    for (let i = 0; i < 40; i++) {
      observePtyData(surf, `├─ agent-${i} · 1 tool use · 1k tokens\n`);
    }
    const a = getActivity(surf)!;
    expect(a.agents.length).toBe(32);
    expect(a.agents[0].name).toBe('agent-8'); // oldest 8 of 40 evicted first
  });

  it('strips ANSI escapes before matching tool markers', () => {
    observePtyData(surf, '\x1b[1m⏺ Bash(ls)\x1b[0m\n');
    expect(getActivity(surf)!.lastTool).toBe('Bash');
  });

  it('marks all agents done on an "N ... agents finished" line', () => {
    observePtyData(surf, '├─ alpha · 2 tool uses · 3k tokens\n├─ beta · 1 tool use · 1k tokens\n');
    observePtyData(surf, '3 Explore agents finished\n');
    expect(getActivity(surf)!.agents.every(x => x.done)).toBe(true);
  });

  it('sets isDone and clears lastTool on the response-done marker', () => {
    observePtyData(surf, '⏺ Bash(ls)\n');
    observePtyData(surf, '✻ Baked for 3m 10s\n');
    const a = getActivity(surf)!;
    expect(a.isDone).toBe(true);
    expect(a.lastTool).toBeNull();
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
