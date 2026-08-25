import { describe, it, expect } from 'vitest';
import { rollupAgents, workspaceAgentState } from '../../src/renderer/store/agent-rollup';
import type { DeclaredAgentSnapshot } from '../../src/renderer/store/agent-rollup';
import { SplitNode, PaneId, WorkspaceInfo, WorkspaceId } from '../../src/shared/types';

const NOW = 1_000_000;

const leaf = (paneId: string, surfaces: Array<{ id: string; currentCwd?: string; customTitle?: string }>): SplitNode => ({
  type: 'leaf',
  paneId: paneId as PaneId,
  surfaces: surfaces.map((s) => ({ id: s.id, type: 'terminal', currentCwd: s.currentCwd, customTitle: s.customTitle } as any)),
  activeSurfaceIndex: 0,
} as SplitNode);

const split = (a: SplitNode, b: SplitNode): SplitNode => ({
  type: 'branch', direction: 'horizontal', ratio: 0.5, children: [a, b],
});

const ws = (id: string, title: string, splitTree: SplitNode): WorkspaceInfo => ({
  id: id as WorkspaceId, title, pinned: false, shell: 'pwsh', splitTree, unreadCount: 0,
} as WorkspaceInfo);

const declared = (over: Partial<DeclaredAgentSnapshot> = {}): DeclaredAgentSnapshot => ({
  state: 'idle', blockedReason: null, choices: [], answeredAt: null, updatedAt: NOW, ...over,
});

describe('rollupAgents', () => {
  it('reports nothing when no surface has declared a state', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {}, NOW);
    expect(out.totals).toEqual({ blocked: 0, working: 0, idle: 0, total: 0 });
    expect(out.roster).toEqual([]);
    expect(out.blocked).toEqual([]);
  });

  it('counts blocked, working and idle per workspace and globally', () => {
    const workspaces = [
      ws('ws-1', 'alpha', split(leaf('pane-1', [{ id: 'surf-a' }]), leaf('pane-2', [{ id: 'surf-b' }]))),
      ws('ws-2', 'beta', leaf('pane-3', [{ id: 'surf-c' }])),
    ];
    const out = rollupAgents(workspaces, {
      'surf-a': declared({ state: 'blocked' }),
      'surf-b': declared({ state: 'working' }),
      'surf-c': declared({ state: 'idle' }),
    }, NOW);

    expect(out.byWorkspace['ws-1']).toEqual({ blocked: 1, working: 1, idle: 0, total: 2 });
    expect(out.byWorkspace['ws-2']).toEqual({ blocked: 0, working: 0, idle: 1, total: 1 });
    expect(out.totals).toEqual({ blocked: 1, working: 1, idle: 1, total: 3 });
  });

  /**
   * The load-bearing one. AGENT_STATE is a delta channel and main's record map
   * is only pruned by its own 256-entry LRU — nothing tells the renderer that a
   * surface was closed. Rolling up the raw map would count agents from panes
   * that no longer exist, and "3 need you" would point at nothing.
   */
  it('ignores declared state for surfaces that are no longer in any split tree', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'blocked' }),
      'surf-ghost': declared({ state: 'blocked' }),
    }, NOW);

    expect(out.totals).toEqual({ blocked: 1, working: 0, idle: 0, total: 1 });
    expect(out.blocked.map((b) => b.surfaceId)).toEqual(['surf-a']);
  });

  /**
   * Invariant 1 of the declared-state protocol: `unknown` means "never reported,
   * or explicitly released". It must fall back, never assert. Counting it as an
   * idle agent would put a plain shell pane in the roster.
   */
  it('treats `unknown` as not-an-agent rather than as idle', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'unknown' }),
    }, NOW);
    expect(out.totals.total).toBe(0);
    expect(out.roster).toEqual([]);
  });

  it('orders blocked agents longest-waiting first', () => {
    const workspaces = [ws('ws-1', 'alpha', split(
      leaf('pane-1', [{ id: 'surf-recent' }]),
      leaf('pane-2', [{ id: 'surf-old' }]),
    ))];
    const out = rollupAgents(workspaces, {
      'surf-recent': declared({ state: 'blocked', blockedSince: NOW - 1_000 }),
      'surf-old': declared({ state: 'blocked', blockedSince: NOW - 90_000 }),
    }, NOW);

    expect(out.blocked.map((b) => b.surfaceId)).toEqual(['surf-old', 'surf-recent']);
    expect(out.blocked[0].dwellMs).toBe(90_000);
  });

  it('falls back to updatedAt for dwell when blockedSince is absent', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'blocked', updatedAt: NOW - 5_000 }),
    }, NOW);
    expect(out.blocked[0].dwellMs).toBe(5_000);
  });

  it('keeps roster in workspace then tree order, and carries the pane label', () => {
    const workspaces = [
      ws('ws-1', 'alpha', split(
        leaf('pane-1', [{ id: 'surf-a', currentCwd: 'C:\\dev\\myproj' }]),
        leaf('pane-2', [{ id: 'surf-b', customTitle: 'reviewer' }]),
      )),
      ws('ws-2', 'beta', leaf('pane-3', [{ id: 'surf-c' }])),
    ];
    const out = rollupAgents(workspaces, {
      'surf-a': declared({ state: 'working' }),
      'surf-b': declared({ state: 'working' }),
      'surf-c': declared({ state: 'working' }),
    }, NOW);

    expect(out.roster.map((r) => [r.surfaceId, r.label, r.workspaceTitle])).toEqual([
      ['surf-a', 'myproj', 'alpha'],
      ['surf-b', 'reviewer', 'alpha'],
      ['surf-c', 'Agent', 'beta'],
    ]);
  });

  it('carries the blocked reason and declared choices through to the roster', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({
        state: 'blocked',
        blockedReason: 'Run the migration?',
        choices: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }],
      }),
    }, NOW);

    expect(out.blocked[0]).toMatchObject({
      blockedReason: 'Run the migration?',
      choices: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }],
      answerPending: false,
      paneId: 'pane-1',
      workspaceId: 'ws-1',
    });
  });

  /**
   * Mirrors claude-session-view: answering never clears `blocked` (the agent
   * must confirm), so a relayed answer with no choices left reads as "sent".
   */
  it('marks a blocked agent with a relayed answer and no choices as answerPending', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'blocked', choices: [], answeredAt: NOW - 100 }),
    }, NOW);
    expect(out.blocked[0].answerPending).toBe(true);
  });

  it('counts each surface of a multi-tab pane separately', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }, { id: 'surf-b' }]))], {
      'surf-a': declared({ state: 'blocked' }),
      'surf-b': declared({ state: 'working' }),
    }, NOW);
    expect(out.byWorkspace['ws-1']).toEqual({ blocked: 1, working: 1, idle: 0, total: 2 });
  });

  it('gives every workspace an entry, including those with no agents', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {}, NOW);
    expect(out.byWorkspace['ws-1']).toEqual({ blocked: 0, working: 0, idle: 0, total: 0 });
  });
});

describe('workspaceAgentState', () => {
  it('blocked outranks working — one parked agent beats three busy ones', () => {
    expect(workspaceAgentState({ blocked: 1, working: 3, idle: 0, total: 4 })).toBe('blocked');
  });

  it('working outranks idle', () => {
    expect(workspaceAgentState({ blocked: 0, working: 1, idle: 2, total: 3 })).toBe('working');
  });

  it('idle when agents exist but none are busy', () => {
    expect(workspaceAgentState({ blocked: 0, working: 0, idle: 2, total: 2 })).toBe('idle');
  });

  it('null when the workspace hosts no agent at all — the row keeps its shell status', () => {
    expect(workspaceAgentState({ blocked: 0, working: 0, idle: 0, total: 0 })).toBeNull();
  });
});
