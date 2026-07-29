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
    expect(out).toEqual({ sessions: [], working: 0, blocked: 0 });
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
    expect(out).toEqual({ sessions: [], working: 0, blocked: 0 });
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

// ─── Declared agent state (issue #128) ───────────────────────────────────────
// The signal the freshness heuristic structurally cannot produce: an agent
// parked on a human emits nothing while it waits, so inference alone decays it
// to idle — hiding the one pane that needs the user.
describe('declared agent state precedence', () => {
  const declared = (state: string, blockedReason: string | null = null) => ({ state, blockedReason } as any);

  it('a blocked session stays blocked long after every signal went quiet', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(
      tree, {}, { 'surf-a': hook('Bash', NOW - 60_000) }, NOW,
      { 'surf-a': declared('blocked', 'permission: Bash') },
    );
    expect(out.blocked).toBe(1);
    expect(out.sessions[0]).toMatchObject({ blocked: true, blockedReason: 'permission: Bash' });
  });

  it('without a declared state the same stale surface reads idle — the old bug', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(tree, {}, { 'surf-a': hook('Bash', NOW - 60_000) }, NOW);
    expect(out.sessions[0]).toMatchObject({ working: false, blocked: false });
    expect(out.blocked).toBe(0);
  });

  it('a declared state alone makes a surface a session', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(tree, {}, {}, NOW, { 'surf-a': declared('working') });
    expect(out.sessions).toHaveLength(1);
    expect(out.working).toBe(1);
  });

  it('a declared idle overrides a fresh hook event', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(
      tree, {}, { 'surf-a': hook('Edit', NOW) }, NOW, { 'surf-a': declared('idle') },
    );
    expect(out.working).toBe(0);
  });

  it('unknown falls back to inference instead of pinning the pane idle', () => {
    // What a released agent leaves behind: no claim, so the heuristic decides.
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(
      tree, {}, { 'surf-a': hook('Edit', NOW) }, NOW, { 'surf-a': declared('unknown') },
    );
    expect(out.working).toBe(1);
  });

  it('counts blocked panes across a split workspace', () => {
    const tree = split(leaf('pane-1', [{ id: 'surf-a' }]), leaf('pane-2', [{ id: 'surf-b' }]));
    const out = claudeSessionsForWorkspace(tree, {}, {}, NOW, {
      'surf-a': declared('blocked', 'approve?'),
      'surf-b': declared('working'),
    });
    expect(out).toMatchObject({ blocked: 1, working: 1 });
    expect(out.sessions.map(s => s.blocked)).toEqual([true, false]);
  });

  it('a blocked session reports no tool label from a stale signal', () => {
    const tree = leaf('pane-1', [{ id: 'surf-a' }]);
    const out = claudeSessionsForWorkspace(
      tree, {}, { 'surf-a': hook('Bash', NOW - 60_000) }, NOW, { 'surf-a': declared('blocked') },
    );
    expect(out.sessions[0].tool).toBeNull();
  });
});
