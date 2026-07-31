import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendMock } }],
  },
}));

import {
  reportAgent,
  answerAgent,
  sanitizeChoices,
  getAgentState,
  clearAgentState,
  resetAgentState,
} from '../../src/main/agent-state';
import type { SurfaceId } from '../../src/shared/types';

const SID = 'surf-1' as SurfaceId;

const ALLOW = { id: 'allow', label: 'Yes, allow Bash', key: '1' };
const DENY = { id: 'deny', label: 'No', key: 'esc' };

function block(choices?: unknown[]) {
  reportAgent(SID, {
    awaitingHuman: true,
    reason: 'permission: Bash',
    ...(choices ? { choices: choices as never } : {}),
  });
}

beforeEach(() => {
  resetAgentState();
  sendMock.mockClear();
});

// Issue #128, the back-channel. herdr's protocol is one-way — every method is
// report_*. This is the other direction: answer the pane that needs you without
// leaving the pane you are in.

describe('sanitizeChoices', () => {
  it('keeps a well-formed choice', () => {
    expect(sanitizeChoices([ALLOW])).toEqual([ALLOW]);
  });

  it('drops a choice that carries neither key nor text', () => {
    // The worst available outcome is a button that looks like it worked: the
    // user clicks Allow, nothing reaches the agent, and the pane sits blocked
    // while they believe they answered it.
    expect(sanitizeChoices([{ id: 'x', label: 'Allow' }])).toEqual([]);
  });

  it('drops choices missing an id or a label', () => {
    expect(sanitizeChoices([{ label: 'no id', key: '1' }, { id: 'no-label', key: '1' }])).toEqual([]);
  });

  it('keeps the first of two choices sharing an id — an answer must be unambiguous', () => {
    const out = sanitizeChoices([ALLOW, { id: 'allow', label: 'Different', key: '9' }]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Yes, allow Bash');
  });

  it('accepts a text payload as an alternative to a key', () => {
    expect(sanitizeChoices([{ id: 'y', label: 'Yes', text: 'yes' }])[0].text).toBe('yes');
  });

  it('caps a runaway list rather than rendering an unbounded menu', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: 'c' + i, label: 'c' + i, key: '1' }));
    expect(sanitizeChoices(many).length).toBeLessThanOrEqual(12);
  });

  it('survives junk instead of an array', () => {
    expect(sanitizeChoices(null)).toEqual([]);
    expect(sanitizeChoices('nope')).toEqual([]);
    expect(sanitizeChoices([null, 7, 'x'])).toEqual([]);
  });
});

describe('answerAgent', () => {
  it('resolves the choice into the payload the agent declared', () => {
    block([ALLOW, DENY]);
    const res = answerAgent(SID, { choiceId: 'allow' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.key).toBe('1');
  });

  it('does NOT clear blocked — the agent must confirm', () => {
    // The load-bearing rule. A mis-declared key would otherwise silently stop
    // the pane asking for help while the agent is still stuck, which is the
    // exact ghost this module exists to remove, in the dangerous direction.
    block([ALLOW]);
    answerAgent(SID, { choiceId: 'allow' });
    expect(getAgentState(SID)!.state).toBe('blocked');
  });

  it('consumes the choices so a button cannot be answered twice', () => {
    block([ALLOW]);
    expect(answerAgent(SID, { choiceId: 'allow' }).ok).toBe(true);
    const second = answerAgent(SID, { choiceId: 'allow' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('no-choices');
  });

  it('records that an answer went out, so the UI can say "sent" not "needs you"', () => {
    block([ALLOW]);
    answerAgent(SID, { choiceId: 'allow' });
    expect(getAgentState(SID)!.answeredAt).toBeGreaterThan(0);
    expect(getAgentState(SID)!.choices).toEqual([]);
  });

  it('refuses a pane that is not asking anything', () => {
    // Security-relevant: this writes bytes into a live PTY. A stale click on a
    // button the sidebar has not repainted must never reach a shell where a
    // human is now typing.
    reportAgent(SID, { runDepth: 1 });
    const res = answerAgent(SID, { choiceId: 'allow' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not-blocked');
  });

  it('refuses a surface nothing has ever reported for', () => {
    const res = answerAgent('surf-nope' as SurfaceId, { choiceId: 'allow' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown-surface');
  });

  it('refuses a blocked pane whose agent declared no answers', () => {
    block();
    const res = answerAgent(SID, { choiceId: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-choices');
  });

  it('refuses a choice that is not on offer', () => {
    block([ALLOW]);
    const res = answerAgent(SID, { choiceId: 'rm-rf' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown-choice');
  });

  it('uses the declared default when the answer names no choice', () => {
    block([ALLOW, { ...DENY, isDefault: true }]);
    const res = answerAgent(SID, {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.choice!.id).toBe('deny');
  });

  it('takes the only choice when there is exactly one and no default', () => {
    block([ALLOW]);
    const res = answerAgent(SID, {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.choice!.id).toBe('allow');
  });

  it('refuses an unnamed answer to a multi-way prompt with no default', () => {
    // Picking one for the user would be worse than refusing.
    block([ALLOW, DENY]);
    const res = answerAgent(SID, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown-choice');
  });
});

describe('choice lifecycle', () => {
  it('clears the choices when the agent reports it is no longer blocked', () => {
    // Otherwise the sidebar keeps armed buttons that would inject keystrokes
    // into a shell nobody is asking anything.
    block([ALLOW]);
    reportAgent(SID, { awaitingHuman: false });
    expect(getAgentState(SID)!.choices).toEqual([]);
    expect(answerAgent(SID, { choiceId: 'allow' }).ok).toBe(false);
  });

  it('clears a stale "sent" when a new prompt arrives', () => {
    block([ALLOW]);
    answerAgent(SID, { choiceId: 'allow' });
    reportAgent(SID, { awaitingHuman: false });
    block([DENY]);
    expect(getAgentState(SID)!.answeredAt).toBeNull();
    expect(getAgentState(SID)!.choices).toHaveLength(1);
  });

  it('re-arms the buttons when the agent re-declares its answers', () => {
    // Which is also how a user retries an answer the agent evidently ignored.
    block([ALLOW]);
    answerAgent(SID, { choiceId: 'allow' });
    reportAgent(SID, { choices: [ALLOW] as never });
    expect(getAgentState(SID)!.choices).toHaveLength(1);
    expect(getAgentState(SID)!.answeredAt).toBeNull();
  });

  it('never offers choices for a pane that is not blocked', () => {
    block([ALLOW]);
    reportAgent(SID, { awaitingHuman: false, runDepth: 1 });
    expect(getAgentState(SID)!.choices).toEqual([]);
  });

  it('leaves the declared answers alone on a report that omits them', () => {
    block([ALLOW]);
    reportAgent(SID, { reason: 'permission: Bash (still)' });
    expect(getAgentState(SID)!.choices).toHaveLength(1);
  });

  it('an explicit empty array clears them', () => {
    block([ALLOW]);
    reportAgent(SID, { choices: [] });
    expect(getAgentState(SID)!.choices).toEqual([]);
  });

  it('takes the buttons away with the pane when its PTY dies', () => {
    block([ALLOW]);
    sendMock.mockClear();
    clearAgentState(SID);
    const payload = sendMock.mock.calls.at(-1)![1];
    expect(payload.state).toBe('unknown');
    expect(payload.choices).toEqual([]);
    expect(answerAgent(SID, { choiceId: 'allow' }).ok).toBe(false);
  });

  it('broadcasts the choices to the renderer when a block is declared', () => {
    sendMock.mockClear();
    block([ALLOW, DENY]);
    const payload = sendMock.mock.calls.at(-1)![1];
    expect(payload.state).toBe('blocked');
    expect(payload.choices.map((c: { id: string }) => c.id)).toEqual(['allow', 'deny']);
  });
});
