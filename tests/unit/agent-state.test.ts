import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendMock } }],
  },
}));

import {
  reportAgent,
  reportAgentSession,
  reportMetadata,
  releaseAgent,
  getAgentState,
  listAgentStates,
  listBlocked,
  clearAgentState,
  resetAgentState,
  resolveState,
  liveMetadata,
  WORKING_TRUST_MS,
  DEFAULT_METADATA_TTL_MS,
  AgentStateRecord,
} from '../../src/main/agent-state';
import { SurfaceId } from '../../src/shared/types';

const surf = 'surf-1' as SurfaceId;
const other = 'surf-2' as SurfaceId;

beforeEach(() => {
  resetAgentState();
  sendMock.mockClear();
});

describe('the three-state model', () => {
  it('an unreported surface is unknown', () => {
    expect(getAgentState(surf)).toBeUndefined();
  });

  it('awaitingHuman parks the pane as blocked, carrying the reason', () => {
    reportAgent(surf, { awaitingHuman: true, reason: 'permission: Bash' });
    expect(getAgentState(surf)).toMatchObject({ state: 'blocked', blockedReason: 'permission: Bash' });
  });

  it('a run in flight is working', () => {
    reportAgent(surf, { runDelta: 1 });
    expect(getAgentState(surf)?.state).toBe('working');
  });

  it('no run and no human wait is idle', () => {
    reportAgent(surf, { runDepth: 1 });
    reportAgent(surf, { runDepth: 0 });
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('blocked outranks a run still in flight', () => {
    // A tool call can be outstanding while the agent waits on a permission
    // prompt; the pane must read as "needs you", not "busy".
    reportAgent(surf, { runDelta: 1 });
    reportAgent(surf, { awaitingHuman: true, reason: 'approve edit?' });
    expect(getAgentState(surf)).toMatchObject({ state: 'blocked', runDepth: 1 });
  });

  it('clearing awaitingHuman drops the stale reason with it', () => {
    reportAgent(surf, { awaitingHuman: true, reason: 'permission: Bash' });
    reportAgent(surf, { awaitingHuman: false });
    expect(getAgentState(surf)).toMatchObject({ state: 'idle', blockedReason: null });
  });
});

describe('run depth is a refcount, not a boolean', () => {
  it('nested runs need every level to end before the pane goes idle', () => {
    reportAgent(surf, { runDelta: 1 });
    reportAgent(surf, { runDelta: 1 });
    reportAgent(surf, { runDelta: -1 });
    expect(getAgentState(surf)?.state).toBe('working');
    reportAgent(surf, { runDelta: -1 });
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('an unbalanced decrement clamps at zero instead of going negative', () => {
    reportAgent(surf, { runDelta: -5 });
    expect(getAgentState(surf)).toMatchObject({ runDepth: 0, state: 'idle' });
    // A later genuine run must still register — a negative floor would have
    // swallowed the next few increments.
    reportAgent(surf, { runDelta: 1 });
    expect(getAgentState(surf)?.state).toBe('working');
  });

  it('an absolute runDepth is idempotent under repetition', () => {
    for (let i = 0; i < 200; i++) reportAgent(surf, { runDepth: 1 });
    expect(getAgentState(surf)?.runDepth).toBe(1);
  });
});

describe('seq dedupe', () => {
  it('drops a replayed older message', () => {
    reportAgent(surf, { seq: 5, awaitingHuman: true, reason: 'waiting' });
    const stale = reportAgent(surf, { seq: 3, awaitingHuman: false });
    expect(stale).toBeNull();
    expect(getAgentState(surf)?.state).toBe('blocked');
  });

  it('drops an exact retry of the same seq', () => {
    reportAgent(surf, { seq: 7, runDelta: 1 });
    expect(reportAgent(surf, { seq: 7, runDelta: 1 })).toBeNull();
    expect(getAgentState(surf)?.runDepth).toBe(1);
  });

  it('accepts a strictly newer seq', () => {
    reportAgent(surf, { seq: 1, awaitingHuman: true });
    reportAgent(surf, { seq: 2, awaitingHuman: false });
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('a reporter that omits seq is never deduped', () => {
    reportAgent(surf, { awaitingHuman: true });
    expect(reportAgent(surf, { awaitingHuman: false })).not.toBeNull();
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('the seq gate is shared across message types', () => {
    reportAgent(surf, { seq: 10, runDelta: 1 });
    expect(reportMetadata(surf, { seq: 4, model: 'opus' })).toBeNull();
    expect(getAgentState(surf)?.metadata.model).toBeUndefined();
  });
});

describe('release', () => {
  it('release drops the record so the pane reads unknown, not a ghost working', () => {
    reportAgent(surf, { runDelta: 1 });
    expect(releaseAgent(surf)).toBe(true);
    expect(getAgentState(surf)).toBeUndefined();
  });

  it('releasing an untracked surface is a no-op', () => {
    expect(releaseAgent(surf)).toBe(false);
  });

  it('a released pane broadcasts unknown so the sidebar can clear it', () => {
    reportAgent(surf, { awaitingHuman: true });
    sendMock.mockClear();
    releaseAgent(surf);
    expect(sendMock).toHaveBeenCalledWith('agent:state', expect.objectContaining({ state: 'unknown' }));
  });

  it('clearAgentState (PTY exit) announces unknown, not just deletes', () => {
    // The renderer keeps its own copy of the last broadcast, so a silent delete
    // would leave the sidebar rendering a dead pane as working forever — the
    // exact ghost this module exists to prevent. A shell can exit while its tab
    // stays open, so the surface is still on screen to render.
    reportAgent(surf, { runDelta: 1 });
    sendMock.mockClear();
    clearAgentState(surf);
    expect(getAgentState(surf)).toBeUndefined();
    expect(sendMock).toHaveBeenCalledWith('agent:state', expect.objectContaining({
      surfaceId: surf, state: 'unknown',
    }));
  });

  it('clearing an untracked surface broadcasts nothing', () => {
    clearAgentState(surf);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a blocked pane whose PTY dies stops claiming it needs you', () => {
    reportAgent(surf, { awaitingHuman: true, reason: 'permission: Bash' });
    sendMock.mockClear();
    clearAgentState(surf);
    const [, payload] = sendMock.mock.calls.at(-1)!;
    expect(payload).toMatchObject({ state: 'unknown', blockedReason: null });
  });
});

describe('expiry', () => {
  const record = (over: Partial<AgentStateRecord> = {}): AgentStateRecord => ({
    surfaceId: surf,
    state: 'unknown',
    awaitingHuman: false,
    runDepth: 0,
    blockedReason: null,
    sessionId: null,
    metadata: {},
    lastSeq: 0,
    updatedAt: 1_000_000,
    ...over,
  });

  it('blocked NEVER expires — a waiting agent emits nothing while it waits', () => {
    const r = record({ awaitingHuman: true });
    expect(resolveState(r, r.updatedAt + WORKING_TRUST_MS * 100)).toBe('blocked');
  });

  it('a stale working claim decays to unknown rather than lying', () => {
    const r = record({ runDepth: 1 });
    expect(resolveState(r, r.updatedAt + 1000)).toBe('working');
    expect(resolveState(r, r.updatedAt + WORKING_TRUST_MS + 1)).toBe('unknown');
  });

  it('idle needs no trust window', () => {
    const r = record();
    expect(resolveState(r, r.updatedAt + WORKING_TRUST_MS * 10)).toBe('idle');
  });

  it('metadata past its TTL is not shown', () => {
    const r = record({ metadata: { model: 'opus', expiresAt: 2_000 } });
    expect(liveMetadata(r, 1_999).model).toBe('opus');
    expect(liveMetadata(r, 2_000)).toEqual({});
  });

  it('metadata gets the default TTL when the reporter gives none', () => {
    const before = Date.now();
    reportMetadata(surf, { model: 'opus', tokens: '82.9k' });
    const expiresAt = getAgentState(surf)!.metadata.expiresAt!;
    expect(expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_METADATA_TTL_MS);
  });
});

describe('session handle and queries', () => {
  it('records a resumable session id', () => {
    reportAgentSession(surf, { sessionId: 'sess-abc' });
    expect(getAgentState(surf)?.sessionId).toBe('sess-abc');
  });

  it('listBlocked answers "which pane needs me?"', () => {
    reportAgent(surf, { awaitingHuman: true, reason: 'permission: Bash' });
    reportAgent(other, { runDelta: 1 });
    expect(listAgentStates()).toHaveLength(2);
    const blocked = listBlocked();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ surfaceId: surf, blockedReason: 'permission: Bash' });
  });

  it('surfaces are tracked independently', () => {
    reportAgent(surf, { awaitingHuman: true });
    reportAgent(other, { runDelta: 1 });
    expect(getAgentState(surf)?.state).toBe('blocked');
    expect(getAgentState(other)?.state).toBe('working');
  });
});

describe('broadcast', () => {
  it('every accepted report reaches the renderer', () => {
    reportAgent(surf, { awaitingHuman: true, reason: 'why' });
    expect(sendMock).toHaveBeenCalledWith('agent:state', expect.objectContaining({
      surfaceId: surf, state: 'blocked', blockedReason: 'why',
    }));
  });

  it('a deduped report broadcasts nothing', () => {
    reportAgent(surf, { seq: 9, runDelta: 1 });
    sendMock.mockClear();
    reportAgent(surf, { seq: 2, runDelta: 1 });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
