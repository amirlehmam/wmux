import { describe, it, expect } from 'vitest';
import { claudeSessionsForWorkspace, type HookActivityEntry } from '../../src/renderer/store/claude-session-view';
import { rollupAgents, type AgentIdentitySnapshot, type DeclaredAgentSnapshot, type DetectionSnapshot } from '../../src/renderer/store/agent-rollup';
import type { SplitNode, PaneId, WorkspaceInfo } from '../../src/shared/types';

const NOW = 1_000_000;
const leaf = (paneId: string, surfaces: Array<{ id: string; currentCwd?: string; customTitle?: string; defaultTitle?: string }>): SplitNode => ({
  type: 'leaf', paneId: paneId as PaneId, activeSurfaceIndex: 0,
  surfaces: surfaces.map(s => ({ ...s, type: 'terminal' })),
} as SplitNode);
const tree = leaf('pane-1', [{ id: 'surf-a', currentCwd: '/home/u/alpha' }, { id: 'surf-b', currentCwd: '/home/u/beta' }]);
const hook = (lastTool: string, lastSeen = NOW) => ({ lastTool, toolCount: 1, lastSeen });
const obs = (over = {}) => ({
  agents: [], activeSkill: null, lastTool: null, lastUpdate: NOW, isDone: false, ...over,
});

function view({
  splitTree = tree, states = {}, hooks = {}, activity = {}, detections = {}, identities = {},
}: {
  splitTree?: SplitNode;
  states?: Record<string, DeclaredAgentSnapshot>;
  hooks?: Record<string, HookActivityEntry>;
  activity?: Parameters<typeof claudeSessionsForWorkspace>[1];
  detections?: Record<string, DetectionSnapshot>;
  identities?: Record<string, AgentIdentitySnapshot>;
} = {}) {
  const workspace = { id: 'ws-1', title: 'Test', splitTree } as WorkspaceInfo;
  const rollup = rollupAgents([workspace], states, NOW, identities, detections);
  return claudeSessionsForWorkspace(splitTree, activity, hooks, NOW, rollup.roster, states);
}

describe('sidebar sessions share roster membership and state', () => {
  it('does not list a plain shell or a cleared declaration', () => {
    expect(view()).toEqual({ sessions: [], working: 0, blocked: 0, oldestBlockedSince: null });
    expect(view({ states: { 'surf-a': { state: 'unknown', sessionId: null } } }).sessions).toEqual([]);
  });

  it.each([NOW, NOW - 60_000])('does not let retained history recreate a released pi session (activity at %s)', lastSeen => {
    const history = {
      hooks: { 'surf-a': hook('Edit', lastSeen), 'surf-b': hook('Bash', lastSeen) },
      activity: { 'surf-a': obs({ lastTool: 'Edit', lastUpdate: lastSeen }) },
    };
    const live = view({ ...history, states: {
      'surf-a': { state: 'idle', sessionId: '/sessions/a.jsonl', sessionProvider: 'pi' },
      'surf-b': { state: 'idle', sessionId: '/sessions/b.jsonl', sessionProvider: 'pi' },
    } });
    expect(live.sessions).toHaveLength(2);
    const released = view({ ...history, states: {
      'surf-a': { state: 'unknown', sessionId: null },
      'surf-b': { state: 'unknown', sessionId: null },
    } });
    expect(released.sessions).toEqual([]);
  });

  it('does not establish presence from hook or observer activity alone', () => {
    expect(view({
      hooks: { 'surf-a': hook('Edit'), 'ws-1': hook('Bash'), 'surf-foreign': hook('Read') },
      activity: { 'surf-b': obs({ lastTool: 'Grep' }) },
    }).sessions).toEqual([]);
  });

  it('preserves genuinely identified and session-only unknown agents without inferring idle', () => {
    const out = view({
      states: { 'surf-b': { state: 'unknown', sessionId: 'conversation', sessionProvider: 'codex' } },
      identities: { 'surf-a': { kind: 'claude', source: 'command' } },
      hooks: { 'surf-a': hook('Bash', NOW - 60_000) },
    });
    expect(out.sessions.map(s => [s.surfaceId, s.state, s.working, s.tool])).toEqual([
      ['surf-a', 'unknown', false, null], ['surf-b', 'unknown', false, null],
    ]);
  });

  it('unknown falls back to inference instead of pinning the pane idle', () => {
    // A roster member with no claim: fresh hook or observer activity decides.
    const out = view({
      identities: { 'surf-a': { kind: 'claude', source: 'command' } },
      states: { 'surf-b': { state: 'unknown', sessionId: 'conversation', sessionProvider: 'codex' } },
      hooks: { 'surf-a': hook('Edit') },
      activity: { 'surf-b': obs({ lastTool: 'Grep' }) },
    });
    expect(out.sessions.map(s => [s.surfaceId, s.state, s.working, s.tool])).toEqual([
      ['surf-a', 'working', true, 'Edit'], ['surf-b', 'working', true, 'Grep'],
    ]);
    expect(out.working).toBe(2);
  });

  it('does not let fresh history bring back a released agent through the unknown fallback', () => {
    const out = view({
      states: { 'surf-a': { state: 'unknown', sessionId: null } },
      hooks: { 'surf-a': hook('Edit') },
      activity: { 'surf-a': obs({ lastTool: 'Edit' }) },
    });
    expect(out).toEqual({ sessions: [], working: 0, blocked: 0, oldestBlockedSince: null });
  });

  it('keeps detected states and explicit declarations in the same order as the roster', () => {
    const out = view({
      states: { 'surf-a': { state: 'idle' } },
      detections: {
        'surf-a': { agent: 'codex', state: 'working' },
        'surf-b': { agent: 'codex', state: 'working' },
      },
    });
    expect(out.sessions.map(s => [s.surfaceId, s.state])).toEqual([
      ['surf-a', 'idle'], ['surf-b', 'working'],
    ]);
    expect(out.working).toBe(1);
  });

  it('tracks sessions independently across separate split panes in tree order', () => {
    const out = view({
      splitTree: {
        type: 'branch', direction: 'horizontal', ratio: 0.5,
        children: [
          leaf('pane-1', [{ id: 'surf-a', currentCwd: '/home/u/alpha' }]),
          leaf('pane-2', [{ id: 'surf-b', currentCwd: '/home/u/beta' }]),
        ],
      },
      states: { 'surf-a': { state: 'idle' }, 'surf-b': { state: 'working' } },
      hooks: { 'surf-a': hook('Read', 0), 'surf-b': hook('Bash') },
    });
    expect(out.working).toBe(1);
    expect(out.sessions.map(s => [s.paneId, s.label, s.working, s.tool])).toEqual([
      ['pane-1', 'alpha', false, null], ['pane-2', 'beta', true, 'Bash'],
    ]);
  });

  it('enriches a working roster entry with fresh observer or hook tool labels', () => {
    const out = view({
      states: { 'surf-a': { state: 'working' }, 'surf-b': { state: 'working' } },
      hooks: { 'surf-a': hook('Bash'), 'surf-b': hook('Read') },
      activity: { 'surf-a': obs({ lastTool: 'Grep', activeSkill: 'debugging' }) },
    });
    expect(out.sessions.map(s => [s.tool, s.skill])).toEqual([
      ['Grep', 'debugging'], ['Read', null],
    ]);
  });

  it('expires tool labels without changing a declared working state', () => {
    const out = view({
      states: { 'surf-a': { state: 'working' }, 'surf-b': { state: 'working' } },
      hooks: { 'surf-a': hook('Edit', NOW - 60_000) },
      activity: {
        'surf-a': obs({ lastTool: 'Edit', lastUpdate: NOW - 60_000 }),
        'surf-b': obs({ lastTool: 'Bash', isDone: true }),
      },
    });
    expect(out.working).toBe(2);
    expect(out.sessions.map(s => s.tool)).toEqual([null, null]);
  });

  it('does not let fresh tool history override declared idle or blocked states', () => {
    const out = view({
      states: {
        'surf-a': { state: 'idle' },
        'surf-b': { state: 'blocked', blockedReason: 'Permission', blockedSince: NOW - 10_000 },
      },
      hooks: { 'surf-a': hook('Read'), 'surf-b': hook('Bash') },
    });
    expect(out.working).toBe(0);
    expect(out.blocked).toBe(1);
    expect(out.sessions.map(s => s.tool)).toEqual([null, null]);
    expect(out.sessions[1].blockedReason).toBe('Permission');
    expect(out.oldestBlockedSince).toBe(NOW - 10_000);
  });

  it('retains declared choices and the pending-answer state', () => {
    const out = view({ states: {
      'surf-a': { state: 'blocked', choices: [{ id: 'yes', label: 'Yes' }] },
      'surf-b': { state: 'blocked', choices: [], answeredAt: NOW },
    } });
    expect(out.sessions[0].choices).toEqual([{ id: 'yes', label: 'Yes' }]);
    expect(out.sessions[1].answerPending).toBe(true);
  });

  it('never offers old choices when only screen detection reports blocking', () => {
    const out = view({
      states: { 'surf-a': { state: 'unknown', choices: [{ id: 'old', label: 'Old' }], answeredAt: NOW } },
      detections: { 'surf-a': { agent: 'codex', state: 'blocked' } },
    });
    expect(out.blocked).toBe(1);
    expect(out.sessions[0]).toMatchObject({ choices: [], answerPending: false, blockedReason: null });
  });

  it('carries current questions from the roster to the row that asked', () => {
    const out = view({
      states: { 'surf-a': { state: 'idle', idleSince: NOW - 10_000, sessionId: 'session-a' } },
      detections: { 'surf-a': { agent: 'claude', state: 'question', observedAt: NOW - 5000, sessionId: 'session-a' } },
    });
    expect(out.sessions[0]).toMatchObject({ state: 'question', question: true, working: false, blocked: false });
  });

  it('preserves sidebar pane labels instead of replacing them with agent names', () => {
    const out = view({
      splitTree: leaf('pane-1', [
        { id: 'surf-a', currentCwd: 'C:\\dev\\project', customTitle: 'Reviewer' },
        { id: 'surf-b', currentCwd: '/home/u/project', defaultTitle: 'Profile' },
      ]),
      identities: { 'surf-a': { kind: 'pi', source: 'command' }, 'surf-b': { kind: 'pi', source: 'command' } },
    });
    expect(out.sessions.map(s => s.label)).toEqual(['Reviewer', 'Profile']);
    expect(view({ states: { 'surf-a': { state: 'idle' } } }).sessions[0].label).toBe('alpha');
  });

  it('falls back to a generic label without a cwd or known agent kind', () => {
    const out = view({
      splitTree: leaf('pane-1', [{ id: 'surf-a' }]),
      states: { 'surf-a': { state: 'working' } },
      activity: { 'surf-a': obs({ activeSkill: 'debugging', lastTool: 'Bash' }) },
    });
    expect(out.sessions[0]).toMatchObject({ label: 'Agent', skill: 'debugging' });
  });

  it('preserves background shell details for idle agents', () => {
    const out = view({
      states: { 'surf-a': { state: 'idle' } },
      activity: { 'surf-a': obs({ agents: [{ id: 'shell-tests', name: 'tests', toolUses: 0, tokens: '', done: false, kind: 'shell', touchedAt: NOW }] }) },
    });
    expect(out.sessions[0]).toMatchObject({ state: 'idle', backgroundShells: 1 });
  });

  it('uses the oldest block across panes and falls back to now when unstamped', () => {
    const out = view({ states: {
      'surf-a': { state: 'blocked', blockedSince: NOW - 1000 },
      'surf-b': { state: 'blocked', blockedSince: NOW - 600_000 },
    } });
    expect(out.oldestBlockedSince).toBe(NOW - 600_000);
    expect(view({ states: { 'surf-a': { state: 'blocked' } } }).oldestBlockedSince).toBe(NOW);
  });

  it('ignores old block timestamps after a pane resumes working', () => {
    const out = view({ states: {
      'surf-a': { state: 'working', blockedSince: NOW - 900_000 },
    } });
    expect(out.blocked).toBe(0);
    expect(out.oldestBlockedSince).toBeNull();
  });

  it('preserves block timestamps without substituting update times or clamping future stamps', () => {
    expect(view({ states: {
      'surf-a': { state: 'blocked', blockedSince: null, updatedAt: NOW - 60_000 },
    } }).oldestBlockedSince).toBe(NOW);
    expect(view({ states: {
      'surf-a': { state: 'blocked', blockedSince: NOW + 1000 },
    } }).oldestBlockedSince).toBe(NOW + 1000);
  });
});
