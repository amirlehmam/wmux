import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
}));

import { handleAgentStateV2, setAnswerWriter } from '../../src/main/agent-state-rpc';
import { resetAgentState } from '../../src/main/agent-state';
import type { SurfaceId } from '../../src/shared/types';

const SID = 'surf-1';

/** Drive a V2 call the way the pipe server does, and await whichever side answers. */
function call(method: string, params: unknown): Promise<{ ok: boolean; result?: any; error?: string }> {
  return new Promise((resolve) => {
    const routed = handleAgentStateV2(
      method,
      params,
      (result: any) => resolve({ ok: true, result }),
      (_code: number, message: string) => resolve({ ok: false, error: message }),
    );
    if (!routed) resolve({ ok: false, error: 'not routed' });
  });
}

let written: Array<{ surfaceId: SurfaceId; payload: { key?: string; text?: string } }>;

beforeEach(() => {
  resetAgentState();
  written = [];
  setAnswerWriter((surfaceId, payload) => { written.push({ surfaceId, payload }); });
});

const CHOICES = [
  { id: 'allow', label: 'Allow', key: '1' },
  { id: 'deny', label: 'Deny', text: 'no' },
];

async function block() {
  await call('pane.report_agent', { surfaceId: SID, awaitingHuman: true, reason: 'permission: Bash', choices: CHOICES });
}

describe('pane.answer_agent routing (issue #128)', () => {
  it('delivers the declared key to the pane', async () => {
    await block();
    const res = await call('pane.answer_agent', { surfaceId: SID, choiceId: 'allow' });
    expect(res.ok).toBe(true);
    expect(written).toEqual([{ surfaceId: SID, payload: { key: '1', text: undefined } }]);
  });

  it('delivers a text payload when that is what the agent declared', async () => {
    await block();
    await call('pane.answer_agent', { surfaceId: SID, choiceId: 'deny' });
    expect(written[0].payload.text).toBe('no');
  });

  it('writes NOTHING when the pane is not waiting on anyone', async () => {
    // The guard that keeps this from being a keystroke-injection primitive.
    await call('pane.report_agent', { surfaceId: SID, runDepth: 1 });
    const res = await call('pane.answer_agent', { surfaceId: SID, choiceId: 'allow' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not waiting on you/);
    expect(written).toEqual([]);
  });

  it('explains itself when the agent declared no answers', async () => {
    await call('pane.report_agent', { surfaceId: SID, awaitingHuman: true, reason: 'thinking' });
    const res = await call('pane.answer_agent', { surfaceId: SID, choiceId: 'allow' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/switch to the pane/);
    expect(written).toEqual([]);
  });

  it('refuses an unknown choice rather than sending something else', async () => {
    await block();
    const res = await call('pane.answer_agent', { surfaceId: SID, choiceId: 'rm-rf' });
    expect(res.ok).toBe(false);
    expect(written).toEqual([]);
  });

  it('needs a surface', async () => {
    const res = await call('pane.answer_agent', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/surfaceId required/);
  });

  it('accepts the paneId alias, like the report_* methods', async () => {
    await block();
    const res = await call('pane.answer_agent', { paneId: SID, choiceId: 'allow' });
    expect(res.ok).toBe(true);
  });

  it('surfaces a writer failure instead of claiming the answer landed', async () => {
    // An agent can declare a key wmux cannot translate; saying "ok" would leave
    // the user believing they answered a prompt that never saw a keystroke.
    setAnswerWriter(() => { throw new Error('the agent declared an unknown key name: "wat"'); });
    await block();
    const res = await call('pane.answer_agent', { surfaceId: SID, choiceId: 'allow' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown key name/);
  });

  it('answers only once — the second click finds the choices consumed', async () => {
    await block();
    expect((await call('pane.answer_agent', { surfaceId: SID, choiceId: 'allow' })).ok).toBe(true);
    expect((await call('pane.answer_agent', { surfaceId: SID, choiceId: 'allow' })).ok).toBe(false);
    expect(written).toHaveLength(1);
  });
});

describe('pane.report_agent choices echo', () => {
  it('reports how many choices were KEPT, so a bad declaration is caught at the source', async () => {
    const res = await call('pane.report_agent', {
      surfaceId: SID,
      awaitingHuman: true,
      choices: [
        { id: 'ok', label: 'Fine', key: '1' },
        { id: 'broken', label: 'No payload' }, // unanswerable — dropped
      ],
    });
    expect(res.result.choices).toBe(1);
  });

  it('omits the count entirely when the report did not mention choices', async () => {
    const res = await call('pane.report_agent', { surfaceId: SID, runDepth: 1 });
    expect(res.result.choices).toBeUndefined();
  });
});

describe('pane.agent_state', () => {
  it('lists the blocked panes with their answers — "which one needs me?" in one call', async () => {
    await block();
    const res = await call('pane.agent_state', {});
    expect(res.result.blocked).toHaveLength(1);
    expect(res.result.blocked[0].choices.map((c: { id: string }) => c.id)).toEqual(['allow', 'deny']);
  });
});
