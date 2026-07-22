import { describe, it, expect } from 'vitest';
import { claudeSessionsForWorkspace } from '../../src/renderer/store/claude-session-view';
import { SplitNode, PaneId } from '../../src/shared/types';

const leaf = (paneId: string, surfaces: Array<{ id: string; currentCwd?: string; customTitle?: string }>): SplitNode => ({
  type: 'leaf',
  paneId: paneId as PaneId,
  surfaces: surfaces.map(s => ({ id: s.id, type: 'terminal', currentCwd: s.currentCwd, customTitle: s.customTitle } as any)),
  activeSurfaceIndex: 0,
} as SplitNode);

const split = (a: SplitNode, b: SplitNode): SplitNode => ({
  type: 'branch', direction: 'horizontal', ratio: 0.5, children: [a, b],
});

const NOW = 1_000_000;
const hook = (lastTool: string, lastSeen: number) => ({ lastTool, toolCount: 1, lastSeen });
const obs = (over: Partial<{ lastTool: string | null; lastUpdate: number; isDone: boolean; activeSkill: string | null }> = {}) => ({
  agents: [], activeSkill: null, lastTool: null, lastUpdate: NOW, isDone: false, ...over,
});

describe('claudeSessionsForWorkspace', () => {
  it('returns no sessions when neither hooks nor observer saw Claude', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(tree, {}, {}, NOW);
    expect(out).toEqual({ sessions: [], working: 0 });
  });

  it('a fresh hook event makes the surface a working session with its tool', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a', currentCwd: 'C:\\dev\\myproj' }]);
    const out = claudeSessionsForWorkspace(tree, {}, { 'surf-a': hook('Edit', NOW - 1000) }, NOW);
    expect(out.working).toBe(1);
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({
      surfaceId: 'surf-a', paneId: 'pane-1', label: 'myproj', working: true, tool: 'Edit',
    });
  });

  it('a Stop-zeroed hook entry keeps the session listed but idle', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(tree, {}, { 'surf-a': hook('Bash', 0) }, NOW);
    expect(out.working).toBe(0);
    expect(out.sessions[0]).toMatchObject({ working: false, tool: null });
  });

  it('tracks two sessions independently — one working, one idle', () => {
    const tree = split(
      leaf('pane-1', [{ id: 'surf-a', currentCwd: '/home/u/alpha' }]),
      leaf('pane-2', [{ id: 'surf-b', currentCwd: '/home/u/beta' }]),
    );
    const out = claudeSessionsForWorkspace(tree, {}, {
      'surf-a': hook('Read', 0),          // stopped
      'surf-b': hook('Bash', NOW - 500),  // active
    }, NOW);
    expect(out.working).toBe(1);
    expect(out.sessions.map(s => [s.label, s.working])).toEqual([['alpha', false], ['beta', true]]);
  });

  it('fresh observer activity with a tool counts as working and wins over hook tool', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(
      tree,
      { 'surf-a': obs({ lastTool: 'Grep', lastUpdate: NOW - 100 }) },
      { 'surf-a': hook('Bash', NOW - 100) },
      NOW,
    );
    expect(out.sessions[0]).toMatchObject({ working: true, tool: 'Grep' });
  });

  it('observer isDone means idle even when its lastUpdate is fresh', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(
      tree,
      { 'surf-a': obs({ isDone: true, lastTool: null, lastUpdate: NOW }) },
      {},
      NOW,
    );
    expect(out.working).toBe(0);
    expect(out.sessions[0]).toMatchObject({ working: false });
  });

  it('stale signals (past the activity TTL) mean idle, not gone', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(
      tree,
      { 'surf-a': obs({ lastTool: 'Edit', lastUpdate: NOW - 60_000 }) },
      { 'surf-a': hook('Edit', NOW - 60_000) },
      NOW,
    );
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({ working: false, tool: null });
  });

  it('ignores hook entries for surfaces outside this workspace and legacy ws-keyed entries', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(tree, {}, {
      'surf-foreign': hook('Bash', NOW),
      'ws-1234': hook('Bash', NOW),
    }, NOW);
    expect(out).toEqual({ sessions: [], working: 0 });
  });

  it('prefers the user-set surface title over the cwd basename (rename bug)', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a', currentCwd: 'C:\\dev\\wmux', customTitle: 'captely' }]);
    const out = claudeSessionsForWorkspace(tree, {}, { 'surf-a': hook('Edit', NOW - 1000) }, NOW);
    expect(out.sessions[0].label).toBe('captely');
  });

  it('falls back to a generic label without a cwd and exposes the active skill', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(
      tree,
      { 'surf-a': obs({ activeSkill: 'debugging', lastTool: 'Bash', lastUpdate: NOW }) },
      {},
      NOW,
    );
    expect(out.sessions[0]).toMatchObject({ label: 'Claude', skill: 'debugging' });
  });
});
