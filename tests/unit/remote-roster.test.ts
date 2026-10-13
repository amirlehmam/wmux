import { describe, expect, it } from 'vitest';
import { toRemoteRosterSource } from '../../src/renderer/utils/remote-roster';
import type { AgentRosterEntry } from '../../src/renderer/store/agent-rollup';
import type { RemoteRosterSource } from '../../src/shared/remote-console-config';
import type { PaneId, SurfaceId, WorkspaceId } from '../../src/shared/types';

// Every key RemoteRosterSource declares — the Record forces this list to stay
// in step with the interface at compile time.
const SOURCE_KEYS: Record<keyof RemoteRosterSource, true> = {
  surfaceId: true,
  workspaceId: true,
  workspaceTitle: true,
  label: true,
  kind: true,
  state: true,
  stateSource: true,
  blockedReason: true,
  choices: true,
  answerPending: true,
  dwellMs: true,
};

function entry(overrides: Partial<AgentRosterEntry> = {}): AgentRosterEntry {
  return {
    surfaceId: 'surf-1' as SurfaceId,
    paneId: 'pane-1' as PaneId,
    workspaceId: 'ws-1' as WorkspaceId,
    workspaceTitle: 'Session 1',
    label: 'wmux',
    state: 'blocked',
    blockedReason: 'Run the migration?',
    choices: [
      // What main actually sends carries the payload too; the renderer's
      // AgentChoiceView type just does not declare it.
      { id: 'yes', label: 'Yes', key: '1', isDefault: true } as never,
      { id: 'no', label: 'No', text: 'n\r' } as never,
    ],
    answerPending: false,
    dwellMs: 4200,
    kind: 'claude',
    identitySource: 'shell-spec',
    stateSource: 'declared',
    detectedState: 'working',
    metadata: { model: 'opus', tokens: '12k', contextPct: 40 },
    ...overrides,
  };
}

describe('toRemoteRosterSource', () => {
  it('outputs exactly the RemoteRosterSource keys', () => {
    const out = toRemoteRosterSource(entry());
    expect(Object.keys(out).sort()).toEqual(Object.keys(SOURCE_KEYS).sort());
  });

  it('copies the allowed fields verbatim', () => {
    const out = toRemoteRosterSource(entry());
    expect(out).toMatchObject({
      surfaceId: 'surf-1',
      workspaceId: 'ws-1',
      workspaceTitle: 'Session 1',
      label: 'wmux',
      kind: 'claude',
      state: 'blocked',
      stateSource: 'declared',
      blockedReason: 'Run the migration?',
      answerPending: false,
      dwellMs: 4200,
    });
  });

  it('drops metadata, detectedState, paneId and identitySource', () => {
    const out = toRemoteRosterSource(entry()) as unknown as Record<string, unknown>;
    for (const k of ['metadata', 'detectedState', 'paneId', 'identitySource']) {
      expect(out).not.toHaveProperty(k);
    }
    expect(JSON.stringify(out)).not.toContain('opus');
    expect(JSON.stringify(out)).not.toContain('pane-1');
  });

  it('reduces choices to {id,label,isDefault} — never key or text', () => {
    const out = toRemoteRosterSource(entry());
    expect(out.choices).toEqual([
      { id: 'yes', label: 'Yes', isDefault: true },
      { id: 'no', label: 'No' },
    ]);
    for (const c of out.choices) {
      expect(Object.keys(c).every(k => k === 'id' || k === 'label' || k === 'isDefault')).toBe(true);
    }
    const wire = JSON.stringify(out);
    expect(wire).not.toContain('"key"');
    expect(wire).not.toContain('"text"');
  });

  it('handles an idle entry with no choices and null fields', () => {
    const out = toRemoteRosterSource(
      entry({ state: 'idle', blockedReason: null, choices: [], kind: null, stateSource: null, metadata: null }),
    );
    expect(out.choices).toEqual([]);
    expect(out.kind).toBeNull();
    expect(out.stateSource).toBeNull();
    expect(out.blockedReason).toBeNull();
  });
});

// The phone protocol's state set is closed (RemoteRosterSource.state) and has
// no `question`. Until it gains one, a question degrades to `unknown` at this
// boundary: the phone must never receive a value its protocol does not name,
// and `unknown` is the one state that makes no claim the agent did not make.
describe('a question degrades to unknown on the wire', () => {
  it('never puts `question` on the wire, and sends `unknown` in its place', () => {
    const out = toRemoteRosterSource(
      entry({ state: 'question', stateSource: 'detected', blockedReason: null, choices: [] }),
    );
    expect(out.state).toBe('unknown');
    expect(JSON.stringify(out)).not.toContain('question');
  });

  it('a question offers the phone no answer buttons — it is not a permission prompt', () => {
    const out = toRemoteRosterSource(
      entry({ state: 'question', stateSource: 'detected', blockedReason: null, choices: [] }),
    );
    expect(out.choices).toEqual([]);
    expect(out.blockedReason).toBeNull();
  });

  it('leaves the four states the protocol does name exactly as they are', () => {
    for (const state of ['blocked', 'working', 'idle', 'unknown'] as const) {
      expect(toRemoteRosterSource(entry({ state })).state).toBe(state);
    }
  });
});
