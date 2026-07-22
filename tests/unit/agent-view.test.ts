import { describe, it, expect } from 'vitest';
import { agentsForWorkspace, resolveAgentLinger, MORE_KEY } from '../../src/renderer/store/agent-view';
import { SplitNode, SurfaceId, PaneId } from '../../src/shared/types';

const leaf = (paneId: string, surfaceIds: string[]): SplitNode => ({
  type: 'leaf',
  paneId: paneId as PaneId,
  surfaces: surfaceIds.map(id => ({ id, type: 'terminal' } as any)),
  activeSurfaceIndex: 0,
} as SplitNode);

const NOW = 1_000_000;
const obs = (agents: any[], lastUpdate = NOW) => ({ agents, activeSkill: null, lastTool: null, lastUpdate, isDone: false });

describe('agentsForWorkspace', () => {
  it('maps observer agents of the workspace surfaces', () => {
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-a': obs([{ name: 'review:bugs', toolUses: 12, tokens: '45k', done: false }]) }, new Map(), NOW);
    expect(out).toEqual([{ key: 'surf-a:review:bugs', name: 'review:bugs', detail: '⚒12 · 45k', done: false, toolUses: 12 }]);
  });

  it('merges wmux-spawned agents with their paneId and ✓ when exited', () => {
    const tree = leaf('pane-1', ['surf-a', 'surf-b']);
    const meta = new Map([
      ['surf-b' as SurfaceId, { agentId: 'ag-1', label: 'worker-1', status: 'exited' as const }],
    ]);
    const out = agentsForWorkspace(tree, {}, meta, NOW);
    expect(out).toEqual([{ key: 'wmux:surf-b', name: 'worker-1', detail: '✓', done: true, paneId: 'pane-1' }]);
  });

  it('ignores observer data older than 5 minutes (TTL)', () => {
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-a': obs([{ name: 'x', toolUses: 1, tokens: '1k', done: false }], NOW - 301_000) }, new Map(), NOW);
    expect(out).toEqual([]);
  });

  it('ignores surfaces that belong to other workspaces', () => {
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-other': obs([{ name: 'x', toolUses: 1, tokens: '1k', done: false }]) }, new Map(), NOW);
    expect(out).toEqual([]);
  });

  it('sorts running agents before done ones', () => {
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-a': obs([
      { name: 'a', toolUses: 1, tokens: '1k', done: true },
      { name: 'b', toolUses: 2, tokens: '2k', done: false },
    ]) }, new Map(), NOW);
    expect(out.map(x => x.name)).toEqual(['b', 'a']);
  });

  it('caps at 4 lines: 3 agents + a summary of the rest', () => {
    const agents = Array.from({ length: 8 }, (_, i) => ({ name: `ag-${i}`, toolUses: 2, tokens: '1k', done: false }));
    const tree = leaf('pane-1', ['surf-a']);
    const out = agentsForWorkspace(tree, { 'surf-a': obs(agents) }, new Map(), NOW);
    expect(out).toHaveLength(4);
    expect(out[3]).toMatchObject({ key: MORE_KEY, name: '+5 more', detail: '⚒10' });
  });

  it('shows exactly 4 agents without a summary; 5 agents become 3 + summary', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `ag-${i}`, toolUses: 1, tokens: '1k', done: false }));
    const tree = leaf('pane-1', ['surf-a']);

    const four = agentsForWorkspace(tree, { 'surf-a': obs(mk(4)) }, new Map(), NOW);
    expect(four).toHaveLength(4);
    expect(four.some(a => a.key === MORE_KEY)).toBe(false);

    const five = agentsForWorkspace(tree, { 'surf-a': obs(mk(5)) }, new Map(), NOW);
    expect(five).toHaveLength(4);
    expect(five[3]).toMatchObject({ key: MORE_KEY, name: '+2 more' });
  });

  it('marks the summary done only when every hidden agent is done', () => {
    const tree = leaf('pane-1', ['surf-a']);
    const agents = [
      { name: 'r1', toolUses: 1, tokens: '1k', done: false },
      { name: 'r2', toolUses: 1, tokens: '1k', done: false },
      { name: 'r3', toolUses: 1, tokens: '1k', done: false },
      { name: 'd1', toolUses: 3, tokens: '1k', done: true },
      { name: 'd2', toolUses: 4, tokens: '1k', done: true },
    ];
    const out = agentsForWorkspace(tree, { 'surf-a': obs(agents) }, new Map(), NOW);
    // Running-first ordering pushes the two done agents into the hidden tail.
    expect(out[3]).toMatchObject({ key: MORE_KEY, name: '+2 more', done: true, detail: '⚒7' });
  });

  it('merges one observer agent and one wmux agent in the same call', () => {
    const tree = leaf('pane-1', ['surf-a', 'surf-b']);
    const meta = new Map([
      ['surf-b' as SurfaceId, { agentId: 'ag-1', label: 'worker-1', status: 'running' as const }],
    ]);
    const out = agentsForWorkspace(tree, { 'surf-a': obs([{ name: 'obs-agent', toolUses: 3, tokens: '2k', done: false }]) }, meta, NOW);
    expect(out).toHaveLength(2);
    expect(out.map(a => a.key)).toEqual(['surf-a:obs-agent', 'wmux:surf-b']);
    expect(out[1]).toMatchObject({ name: 'worker-1', done: false, paneId: 'pane-1' });
  });
});

describe('resolveAgentLinger', () => {
  it('visible while any agent runs, resets doneAt', () => {
    expect(resolveAgentLinger(false, 123, NOW)).toEqual({ visible: true, doneAt: null });
  });
  it('stamps doneAt on first all-done observation and stays visible', () => {
    expect(resolveAgentLinger(true, null, NOW)).toEqual({ visible: true, doneAt: NOW });
  });
  it('collapses 10s after all agents finished', () => {
    expect(resolveAgentLinger(true, NOW - 9_000, NOW).visible).toBe(true);
    expect(resolveAgentLinger(true, NOW - 10_001, NOW).visible).toBe(false);
  });
});
