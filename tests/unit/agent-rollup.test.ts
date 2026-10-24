import { describe, it, expect } from 'vitest';
import {
  rollupAgents, workspaceAgentState, surfaceAgentState,
  isCurrentQuestion, detectionPausedBy, detectionNeedsPublish, withIdleSince, rankedRoster, firstWaiting,
} from '../../src/renderer/store/agent-rollup';
import type { DeclaredAgentSnapshot } from '../../src/renderer/store/agent-rollup';
import { toRemoteRosterSource } from '../../src/renderer/utils/remote-roster';
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
    expect(out.totals).toEqual({ blocked: 0, question: 0, working: 0, idle: 0, unknown: 0, total: 0 });
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

    expect(out.byWorkspace['ws-1']).toEqual({ blocked: 1, question: 0, working: 1, idle: 0, unknown: 0, total: 2 });
    expect(out.byWorkspace['ws-2']).toEqual({ blocked: 0, question: 0, working: 0, idle: 1, unknown: 0, total: 1 });
    expect(out.totals).toEqual({ blocked: 1, question: 0, working: 1, idle: 1, unknown: 0, total: 3 });
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

    expect(out.totals).toEqual({ blocked: 1, question: 0, working: 0, idle: 0, unknown: 0, total: 1 });
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

  it('names a workspace by the label the caller passes, else by its stored title', () => {
    // The display callers (the roster banner, the navigator, the Hub, the phone)
    // pass the sidebar's labels; a caller that passes none gets the stored title.
    const workspaces = [
      ws('ws-1', 'Workspace 1', leaf('pane-1', [{ id: 'surf-a' }])),
      ws('ws-2', 'beta', leaf('pane-2', [{ id: 'surf-b' }])),
    ];
    const states = { 'surf-a': declared({ state: 'working' }), 'surf-b': declared({ state: 'working' }) };
    const labels = new Map([['ws-1' as WorkspaceId, 'Fix login bug']]);

    const labelled = rollupAgents(workspaces, states, NOW, {}, {}, labels);
    expect(labelled.roster.map((r) => r.workspaceTitle)).toEqual(['Fix login bug', 'beta']);
    expect(labelled.roster.map((r) => toRemoteRosterSource(r).workspaceTitle)).toEqual(['Fix login bug', 'beta']);

    expect(rollupAgents(workspaces, states, NOW).roster.map((r) => r.workspaceTitle)).toEqual(['Workspace 1', 'beta']);
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
    expect(out.byWorkspace['ws-1']).toEqual({ blocked: 1, question: 0, working: 1, idle: 0, unknown: 0, total: 2 });
  });

  it('gives every workspace an entry, including those with no agents', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {}, NOW);
    expect(out.byWorkspace['ws-1']).toEqual({ blocked: 0, question: 0, working: 0, idle: 0, unknown: 0, total: 0 });
  });
});

describe('workspaceAgentState', () => {
  it('blocked outranks working — one parked agent beats three busy ones', () => {
    expect(workspaceAgentState({ blocked: 1, question: 0, working: 3, idle: 0, unknown: 0, total: 4 })).toBe('blocked');
  });

  it('working outranks idle', () => {
    expect(workspaceAgentState({ blocked: 0, question: 0, working: 1, idle: 2, unknown: 0, total: 3 })).toBe('working');
  });

  it('idle when agents exist but none are busy', () => {
    expect(workspaceAgentState({ blocked: 0, question: 0, working: 0, idle: 2, unknown: 0, total: 2 })).toBe('idle');
  });

  it('null when the workspace hosts no agent at all — the row keeps its shell status', () => {
    expect(workspaceAgentState({ blocked: 0, question: 0, working: 0, idle: 0, unknown: 0, total: 0 })).toBeNull();
  });
});

describe('rollupAgents — identity (phase 2)', () => {
  const ident = (kind: string, source: 'shell-spec' | 'command' | 'probe' = 'command') => ({ kind, source });

  /**
   * The point of identity. A Codex pane reports nothing over the pipe, so before
   * this it was invisible — which made identifying it pointless.
   */
  it('lists an identified agent that has declared nothing', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {}, NOW, {
      'surf-a': ident('codex'),
    });
    expect(out.totals).toEqual({ blocked: 0, question: 0, working: 0, idle: 0, unknown: 1, total: 1 });
    expect(out.roster[0]).toMatchObject({ state: 'unknown', kind: 'codex', identitySource: 'command' });
  });

  /**
   * Invariant 1 again, at the new boundary: `idle` is a claim. An agent we
   * merely SAW must not be reported as having said it is idle.
   */
  it('reports an identified but silent agent as unknown, never idle', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'unknown' }),
    }, NOW, { 'surf-a': ident('aider', 'probe') });
    expect(out.roster[0].state).toBe('unknown');
    expect(out.totals.idle).toBe(0);
    expect(out.totals.unknown).toBe(1);
  });

  it('declared state wins over identity for what the agent is DOING', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'blocked', blockedReason: 'permission: Bash' }),
    }, NOW, { 'surf-a': ident('claude', 'shell-spec') });

    expect(out.roster[0]).toMatchObject({
      state: 'blocked', blockedReason: 'permission: Bash', kind: 'claude', identitySource: 'shell-spec',
    });
  });

  /**
   * With three panes in one repo the folder name identifies nothing; the agent
   * name is the distinction the user opened the list to make.
   */
  it('labels a pane by its agent kind in preference to the cwd folder', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a', currentCwd: 'C:\dev\myproj' }]))],
      {}, NOW, { 'surf-a': ident('claude') });
    expect(out.roster[0].label).toBe('claude');
  });

  it('a hand-set tab title still wins over the agent kind', () => {
    const out = rollupAgents(
      [ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a', customTitle: 'reviewer' }]))],
      {}, NOW, { 'surf-a': ident('claude') },
    );
    expect(out.roster[0].label).toBe('reviewer');
  });

  it('carries a null kind when only declared state is known', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'working' }),
    }, NOW);
    expect(out.roster[0]).toMatchObject({ kind: null, identitySource: null });
  });

  it('ignores identity for a surface no longer in any split tree', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {}, NOW, {
      'surf-a': ident('claude'),
      'surf-ghost': ident('codex'),
    });
    expect(out.totals.total).toBe(1);
  });

  it('blocked agents still sort ahead of identified-but-silent ones', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', split(
      leaf('pane-1', [{ id: 'surf-silent' }]),
      leaf('pane-2', [{ id: 'surf-blocked' }]),
    ))], {
      'surf-blocked': declared({ state: 'blocked', blockedSince: NOW - 5_000 }),
    }, NOW, { 'surf-silent': ident('codex') });

    expect(out.blocked.map((b) => b.surfaceId)).toEqual(['surf-blocked']);
    expect(out.totals).toEqual({ blocked: 1, question: 0, working: 0, idle: 0, unknown: 1, total: 2 });
  });
});

describe('workspaceAgentState — unknown', () => {
  it('a workspace of silent agents reads as unknown, not idle', () => {
    expect(workspaceAgentState({ blocked: 0, question: 0, working: 0, idle: 0, unknown: 2, total: 2 })).toBe('unknown');
  });

  it('one declared idle outranks any number of silent agents', () => {
    expect(workspaceAgentState({ blocked: 0, question: 0, working: 0, idle: 1, unknown: 5, total: 6 })).toBe('idle');
  });
});

describe('rollupAgents — current question (same surface, same session, same turn)', () => {
  const IDLE_SINCE = NOW - 10_000;
  const SESSION = '11111111-1111-1111-1111-111111111111';
  /** What the screen said, and when and for which session the renderer saw it. */
  const seen = (
    state: 'question' | 'blocked' | 'working' | 'idle' | 'unknown',
    over: { observedAt?: number; sessionId?: string | null } = { observedAt: IDLE_SINCE + 400, sessionId: SESSION },
  ) => ({ agent: 'claude', state, ...over });
  const idle = (over: Partial<DeclaredAgentSnapshot> = {}) =>
    declared({ state: 'idle', idleSince: IDLE_SINCE, sessionId: SESSION, ...over });
  const tree = () => [ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))];
  const stateOf = (decl: DeclaredAgentSnapshot, det: ReturnType<typeof seen>) =>
    rollupAgents(tree(), { 'surf-a': decl }, NOW, {}, { 'surf-a': det }).roster[0].state;

  it('a question seen after this turn ended, for this session, refines a declared idle everywhere at once', () => {
    const decl = idle();
    const out = rollupAgents(tree(), { 'surf-a': decl }, NOW, {}, { 'surf-a': seen('question') });

    expect(out.roster[0]).toMatchObject({ surfaceId: 'surf-a', state: 'question', detectedState: 'question' });
    expect(out.byWorkspace['ws-1'].question).toBe(1);
    expect(out.byWorkspace['ws-1'].idle).toBe(0);
    expect(workspaceAgentState(out.byWorkspace['ws-1'])).toBe('question');
    expect(surfaceAgentState(decl, seen('question'))).toMatchObject({ state: 'question' });
    // not a permission prompt: no "Needs you" queue entry, no answer choices
    expect(out.blocked).toHaveLength(0);
  });

  it('ranks a question after every permission prompt and ahead of work that proceeds on its own', () => {
    const out = rollupAgents(
      [ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-w' }, { id: 'surf-a' }, { id: 'surf-i' }, { id: 'surf-b' }]))],
      {
        'surf-w': declared({ state: 'working' }),
        'surf-a': idle(),
        'surf-i': declared({ state: 'idle' }),
        'surf-b': declared({ state: 'blocked', blockedSince: NOW - 5_000 }),
      },
      NOW, {}, { 'surf-a': seen('question') },
    );

    expect(rankedRoster(out).map((e) => e.surfaceId)).toEqual(['surf-b', 'surf-a', 'surf-w', 'surf-i']);
    expect(rankedRoster(out)).toHaveLength(out.roster.length);
  });

  // The stored verdict is whatever the screen said the last time it was read.
  // If that was before the agent's current idle period began, it describes an
  // earlier turn, however recent it looks.
  it('a question seen BEFORE this idle period began is an earlier turn, and reads as idle', () => {
    const stale = seen('question', { observedAt: IDLE_SINCE - 1, sessionId: SESSION });
    expect(stateOf(idle(), stale)).toBe('idle');
    expect(surfaceAgentState(idle(), stale)).toMatchObject({ state: 'idle', source: 'declared' });
    expect(isCurrentQuestion(idle(), stale)).toBe(false);
  });

  it('a question seen for another session on the same surface reads as idle', () => {
    const other = seen('question', { observedAt: IDLE_SINCE + 400, sessionId: '22222222-2222-2222-2222-222222222222' });
    expect(stateOf(idle(), other)).toBe('idle');
    expect(surfaceAgentState(idle(), other)).toMatchObject({ state: 'idle' });
  });

  it('evidence that cannot be placed in time or in a session is never promoted', () => {
    expect(stateOf(idle(), seen('question', {}))).toBe('idle');
    expect(stateOf(idle(), seen('question', { observedAt: IDLE_SINCE + 400 }))).toBe('idle');
    expect(stateOf(idle({ idleSince: undefined }), seen('question'))).toBe('idle');
    // a non-finite stamp is not a time
    expect(stateOf(idle(), seen('question', { observedAt: Number.NaN, sessionId: SESSION }))).toBe('idle');
  });

  it('an agent with no session on record matches only evidence that also has none', () => {
    const anonymous = idle({ sessionId: null });
    expect(stateOf(anonymous, seen('question', { observedAt: IDLE_SINCE + 400, sessionId: null }))).toBe('question');
    expect(stateOf(anonymous, seen('question'))).toBe('idle');
  });

  // Codex round 1, P1: with no declared idle there is no turn and no session to
  // place the screen's question in, so it must not become one. The remote then
  // stamped it `declared`, a claim no agent made.
  it('a question on the screen of an agent that declared nothing reads as the idle it refines, and says it was seen', () => {
    const out = rollupAgents(tree(), {}, NOW, {}, { 'surf-a': seen('question') });
    expect(out.roster[0]).toMatchObject({ state: 'idle', stateSource: 'detected', detectedState: 'question' });
    expect(out.byWorkspace['ws-1'].question).toBe(0);
    expect(surfaceAgentState(undefined, seen('question'))).toEqual({ state: 'idle', source: 'detected' });
    expect(toRemoteRosterSource(out.roster[0])).toMatchObject({ state: 'idle', stateSource: 'detected' });
    const unknown = rollupAgents(tree(), { 'surf-a': declared({ state: 'unknown' }) }, NOW, {}, { 'surf-a': seen('question') });
    expect(unknown.roster[0]).toMatchObject({ state: 'idle', stateSource: 'detected' });
  });

  // Codex round 1, P2: with only a question waiting, the banner read
  // "0 working · 1 asking" over a disabled button titled "No agent is waiting".
  it('the banner jumps to the oldest permission prompt, else to the first question, else nowhere', () => {
    const many = (states: Record<string, DeclaredAgentSnapshot>, dets = {}) => rollupAgents(
      [ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-w' }, { id: 'surf-a' }, { id: 'surf-b' }]))], states, NOW, {}, dets,
    );
    const asking = many({ 'surf-w': declared({ state: 'working' }), 'surf-a': idle() }, { 'surf-a': seen('question') });
    expect(firstWaiting(asking)?.surfaceId).toBe('surf-a');
    const both = many({ 'surf-a': idle(), 'surf-b': declared({ state: 'blocked' }) }, { 'surf-a': seen('question') });
    expect(firstWaiting(both)?.surfaceId).toBe('surf-b');
    expect(firstWaiting(many({ 'surf-w': declared({ state: 'working' }) }))).toBeUndefined();
  });

  it('never overrides a declared working or blocked, and a question needs the user before work in the same workspace', () => {
    const working = rollupAgents(tree(), { 'surf-a': declared({ state: 'working', sessionId: SESSION }) }, NOW, {}, { 'surf-a': seen('question') });
    expect(working.roster[0].state).toBe('working');
    const blocked = rollupAgents(tree(), { 'surf-a': declared({ state: 'blocked', sessionId: SESSION }) }, NOW, {}, { 'surf-a': seen('question') });
    expect(blocked.roster[0].state).toBe('blocked');
    expect(workspaceAgentState({ blocked: 0, question: 1, working: 1, idle: 0, unknown: 0, total: 2 })).toBe('question');
  });
});

describe('the scan loop\'s part in keeping a question current', () => {
  // An idle agent is the one place a question can be hiding, so it must be
  // looked at. Working and blocked stay unscanned, as before.
  it('pauses scanning for working and blocked, not for idle, unknown or silence', () => {
    expect(detectionPausedBy('working')).toBe(true);
    expect(detectionPausedBy('blocked')).toBe(true);
    expect(detectionPausedBy('idle')).toBe(false);
    expect(detectionPausedBy('unknown')).toBe(false);
    expect(detectionPausedBy(undefined)).toBe(false);
  });

  it('stamps the start of an idle period once, and keeps it across later idle reports', () => {
    const first = withIdleSince(undefined, declared({ state: 'idle', updatedAt: 500 }), 9_000);
    expect(first.idleSince).toBe(9_000);
    // a metadata-only report bumps updatedAt while the agent is still idle
    const again = withIdleSince(first, declared({ state: 'idle', updatedAt: 700 }), 9_500);
    expect(again.idleSince).toBe(9_000);
    const working = withIdleSince(again, declared({ state: 'working', updatedAt: 800 }), 9_600);
    expect(working.idleSince).toBeUndefined();
    const nextTurn = withIdleSince(working, declared({ state: 'idle', updatedAt: 900 }), 9_900);
    expect(nextTurn.idleSince).toBe(9_900);
  });

  // Codex round 1, P1: a resumed or restarted session that goes straight from
  // idle to idle kept the old period, so its question was never republished.
  it('starts a new idle period when the session changes, even from idle to idle', () => {
    const first = withIdleSince(undefined, declared({ state: 'idle', sessionId: 'old' }), 9_000);
    const same = withIdleSince(first, declared({ state: 'idle', sessionId: 'old' }), 9_500);
    expect(same.idleSince).toBe(9_000);
    const resumed = withIdleSince(same, declared({ state: 'idle', sessionId: 'new' }), 9_800);
    expect(resumed.idleSince).toBe(9_800);
    // and the question the new session asks is republished under its stamp
    const q = { agent: 'claude', state: 'question' as const, ruleId: 'claude.question.pending', observedAt: 9_200 };
    expect(detectionNeedsPublish(q, { ...q, observedAt: undefined }, resumed.idleSince)).toBe(true);
  });

  // Codex rounds 2 and 3. Round 2 asked for the same question to be reread
  // after that session change even with no new output; round 3 showed what
  // that does: it restamps the previous session's pixels as the new one's. So
  // the scan loop still rereads on output only, and until the new session
  // prints, its pane reads as the idle it declared. This pins the refusal.
  it('keeps the previous session\'s question off the new session until the screen is read again', () => {
    const resumed = withIdleSince(
      withIdleSince(undefined, declared({ state: 'idle', sessionId: 'old' }), 9_000),
      declared({ state: 'idle', sessionId: 'new' }), 9_800,
    );
    const askedBefore = { agent: 'claude', state: 'question' as const, observedAt: 9_200, sessionId: 'old' };
    expect(isCurrentQuestion(resumed, askedBefore)).toBe(false);
    expect(surfaceAgentState(resumed, askedBefore)).toEqual({ state: 'idle', source: 'declared' });
  });

  it('republishes a question whose stored stamp predates the current idle period, even when nothing else moved', () => {
    const q = { agent: 'claude', state: 'question' as const, ruleId: 'claude.question.pending', evidence: ['a ?'] };
    const stored = { ...q, observedAt: 1_000 };
    expect(detectionNeedsPublish(stored, q, 500)).toBe(false);
    expect(detectionNeedsPublish(stored, q, 2_000)).toBe(true);
    expect(detectionNeedsPublish(null, q, undefined)).toBe(true);
    // an unchanged non-question verdict is left alone, as before
    const w = { agent: 'claude', state: 'working' as const, ruleId: 'r', evidence: ['x'] };
    const wMoved = { ...w, evidence: ['y'] };
    expect(detectionNeedsPublish({ ...w, observedAt: 1 }, wMoved, 2_000)).toBe(false);
  });

  it('does not republish a question on every keystroke of the answer being typed under it', () => {
    // The prompt line is part of the rule's evidence, and it carries the
    // answer as it is typed. Within one idle period that changes nothing a
    // consumer reads, so it must not cost a store write per scan tick.
    const asked = {
      agent: 'claude', state: 'question' as const, ruleId: 'claude.question.pending',
      evidence: ['✻ Crunched for 2s · done 12:40 AM', '> ', 'Ce deuxième essai est-il réussi ?'],
    };
    const stored = { ...asked, observedAt: 1_000 };
    const typing = { ...asked, evidence: ['✻ Crunched for 2s · done 12:40 AM', '> Oui, je le', 'Ce deuxième essai est-il réussi ?'] };
    expect(detectionNeedsPublish(stored, typing, 500)).toBe(false);
  });
});

describe('rollupAgents — detection merge (phase 3)', () => {
  const det = (state: 'blocked' | 'working' | 'idle' | 'unknown', agent = 'claude') => ({ agent, state });

  it('lists an agent known only from its screen', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {}, NOW, {}, {
      'surf-a': det('working', 'codex'),
    });
    expect(out.totals).toEqual({ blocked: 0, question: 0, working: 1, idle: 0, unknown: 0, total: 1 });
    expect(out.roster[0]).toMatchObject({
      kind: 'codex', state: 'working', stateSource: 'detected', detectedState: 'working',
    });
  });

  /**
   * THE invariant. wmux deliberately diverges from the prior art here: a visible
   * blocker must NOT override a declaration, because wmux's `blocked` never
   * expires AND answering never clears it. A screen rule re-asserting `blocked`
   * on a repainted frame would make the sidebar's answer button permanently
   * useless — the user clicks, the agent moves on, and the next scan puts the
   * pane straight back in the queue.
   */
  it('declared state always beats detected state', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'working' }),
    }, NOW, {}, { 'surf-a': det('blocked') });

    expect(out.roster[0]).toMatchObject({
      state: 'working', stateSource: 'declared', detectedState: 'blocked',
    });
    expect(out.totals.blocked).toBe(0);
  });

  /** Both facts survive to the UI so an operator can still tell them apart. */
  it('keeps the detected verdict alongside the declared one', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'idle' }),
    }, NOW, {}, { 'surf-a': det('working') });
    expect(out.roster[0].detectedState).toBe('working');
    expect(out.roster[0].state).toBe('idle');
  });

  it('detection fills in only where the agent declared nothing', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'unknown' }),
    }, NOW, { 'surf-a': { kind: 'claude', source: 'command' } }, { 'surf-a': det('blocked') });

    expect(out.roster[0]).toMatchObject({ state: 'blocked', stateSource: 'detected' });
    expect(out.blocked).toHaveLength(1);
  });

  /** A detection that concluded nothing must not push the pane off `unknown`. */
  it('an unknown detection leaves an identified agent unknown', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {}, NOW,
      { 'surf-a': { kind: 'claude', source: 'shell-spec' } }, { 'surf-a': det('unknown') });
    expect(out.roster[0]).toMatchObject({ state: 'unknown', stateSource: null, detectedState: null });
  });

  it('falls back to the detected agent name when identity said nothing', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {}, NOW, {}, {
      'surf-a': det('idle', 'opencode'),
    });
    expect(out.roster[0]).toMatchObject({ kind: 'opencode', label: 'opencode' });
  });

  it('ignores detection for a surface no longer in any split tree', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {}, NOW, {}, {
      'surf-ghost': det('blocked'),
    });
    expect(out.totals.total).toBe(0);
  });

  it('a detected block still sorts into the needs-you queue by dwell', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', split(
      leaf('pane-1', [{ id: 'surf-declared' }]),
      leaf('pane-2', [{ id: 'surf-detected' }]),
    ))], {
      'surf-declared': declared({ state: 'blocked', blockedSince: NOW - 1_000 }),
    }, NOW, {}, { 'surf-detected': det('blocked') });

    expect(out.totals.blocked).toBe(2);
    expect(out.blocked.map((b) => b.stateSource)).toEqual(['declared', 'detected']);
  });
});

/**
 * The tab bar has a surfaceId and no roster, so it needs the precedence rule on
 * its own. Exported rather than re-derived: the tab bar and the sidebar
 * disagreeing about whether a pane is blocked would be worse than either being
 * wrong on its own.
 */
describe('surfaceAgentState', () => {
  const det = (state: 'blocked' | 'working' | 'idle' | 'unknown') => ({ agent: 'claude', state });

  it('declared wins over detected, exactly as in the roster', () => {
    expect(surfaceAgentState(declared({ state: 'working' }), det('blocked')))
      .toEqual({ state: 'working', source: 'declared' });
  });

  it('falls through to detected when the agent declared nothing', () => {
    expect(surfaceAgentState(undefined, det('blocked')))
      .toEqual({ state: 'blocked', source: 'detected' });
    expect(surfaceAgentState(declared({ state: 'unknown' }), det('idle')))
      .toEqual({ state: 'idle', source: 'detected' });
  });

  it('is null when neither layer claims the surface', () => {
    expect(surfaceAgentState(undefined, undefined)).toBeNull();
    expect(surfaceAgentState(declared({ state: 'unknown' }), det('unknown'))).toBeNull();
  });

  it('agrees with the roster on the same inputs', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'idle' }),
    }, NOW, {}, { 'surf-a': det('working') });

    const direct = surfaceAgentState(declared({ state: 'idle' }), det('working'));
    expect(direct!.state).toBe(out.roster[0].state);
    expect(direct!.source).toBe(out.roster[0].stateSource);
  });
});

describe('roster metadata passthrough', () => {
  it('passes live metadata through to the roster entry', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'working', metadata: { model: 'opus', tokens: '12.3k', contextPct: 41 } }),
    }, NOW);
    expect(out.roster[0].metadata).toEqual({ model: 'opus', tokens: '12.3k', contextPct: 41 });
  });

  it('drops metadata past its expiresAt', () => {
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'working', metadata: { model: 'opus', expiresAt: NOW - 1 } }),
    }, NOW);
    expect(out.roster[0].metadata).toBeNull();
  });

  it('treats an empty metadata object as absent', () => {
    // Main always sends a metadata object — {} when nothing was reported — so
    // emptiness must map to null or "null when absent" would never hold.
    const out = rollupAgents([ws('ws-1', 'alpha', leaf('pane-1', [{ id: 'surf-a' }]))], {
      'surf-a': declared({ state: 'working', metadata: {} }),
    }, NOW);
    expect(out.roster[0].metadata).toBeNull();
  });
});
