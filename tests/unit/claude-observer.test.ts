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

describe('workflow panel parsing', () => {
  beforeEach(() => { sendMock.mockClear(); clearActivity(surf); });

  // Real lines captured from the Workflow tool's TUI panel (wmux read-screen).
  // Each box row carries TWO columns: "│ <phase list> │ <agent row> │".
  const RUNNING_ROW = ' │ > 1 Écrire   1/3 │  ● write:pilote             Opus 4.8 (1M context)                               82.9k tok · 17 tools │\n';
  const RUNNING_ROW2 = ' │   2 Vérifier 0/1 │  ● write:compliance         Opus 4.8 (1M context)                               81.1k tok · 10 tools │\n';
  const DONE_ROW = ' │   3 Corriger     │  √ write:mcp-page           Opus 4.8 (1M context)                      78.9k tok · 16 tools · 2m 23s │\n';

  it('parses running workflow agent rows into the agents array', () => {
    observePtyData(surf, RUNNING_ROW + RUNNING_ROW2);
    const a = getActivity(surf)!;
    expect(a.agents).toHaveLength(2);
    expect(a.agents[0]).toMatchObject({ name: 'write:pilote', toolUses: 17, tokens: '82.9k', done: false });
    expect(a.agents[1]).toMatchObject({ name: 'write:compliance', toolUses: 10, tokens: '81.1k', done: false });
  });

  it('marks agents with a check glyph as done', () => {
    observePtyData(surf, RUNNING_ROW + DONE_ROW);
    const a = getActivity(surf)!;
    expect(a.agents.map(x => [x.name, x.done])).toEqual([
      ['write:pilote', false],
      ['write:mcp-page', true],
    ]);
  });

  it('identical repaint frames do not rebroadcast', () => {
    observePtyData(surf, RUNNING_ROW);
    sendMock.mockClear();
    observePtyData(surf, RUNNING_ROW);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('updates an existing agent in place when its counters change', () => {
    observePtyData(surf, RUNNING_ROW);
    observePtyData(surf, ' │ > 1 Écrire   1/3 │  ● write:pilote             Opus 4.8 (1M context)                               90.2k tok · 21 tools │\n');
    const a = getActivity(surf)!;
    expect(a.agents).toHaveLength(1);
    expect(a.agents[0]).toMatchObject({ toolUses: 21, tokens: '90.2k' });
  });

  it('a done-glyph repaint transitions the agent to done exactly once', () => {
    observePtyData(surf, ' │ 1 Écrire │  ● write:pilote   Opus 4.8   82.9k tok · 17 tools │\n');
    observePtyData(surf, ' │ 1 Écrire │  √ write:pilote   Opus 4.8   82.9k tok · 17 tools · 1m 2s │\n');
    expect(getActivity(surf)!.agents[0].done).toBe(true);
    sendMock.mockClear();
    observePtyData(surf, ' │ 1 Écrire │  √ write:pilote   Opus 4.8   82.9k tok · 17 tools · 1m 2s │\n');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does not mistake plain tool-use lines for workflow agents', () => {
    observePtyData(surf, '● Bash(git status)\n');
    const a = getActivity(surf)!;
    expect(a.agents).toHaveLength(0);
    expect(a.lastTool).toBe('Bash');
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
