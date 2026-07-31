/**
 * V2 pipe surface for declared agent state (issue #128).
 *
 * Lives in its own module rather than the main V2 switch in index.ts: that
 * switch is already at the repo's cognitive-complexity and switch-case
 * ceilings, and routeSpecialV2 exists precisely so method families can be
 * routed off to their own dispatcher.
 *
 * Method names follow the issue's proposal (`pane.report_agent`, …). wmux keys
 * on surfaces rather than panes — a pane can hold several tabs and the agent
 * runs in exactly one of them — so `surfaceId` is the real parameter, with
 * `paneId` accepted as an alias for clients written against the original
 * wording.
 */

import { SurfaceId } from '../shared/types';
import {
  reportAgent,
  reportAgentSession,
  reportMetadata,
  releaseAgent,
  answerAgent,
  sanitizeChoices,
  getAgentState,
  listAgentStates,
  listBlocked,
  type AnswerFailure,
} from './agent-state';

type Respond = (result: any) => void;
type RespondError = (code: number, message: string) => void;

/**
 * Writes the resolved answer into the pane. Injected rather than imported so
 * this module keeps no dependency on the PTY layer — which is also what lets
 * the routing be tested without a terminal.
 */
export type AnswerWriter = (surfaceId: SurfaceId, payload: { key?: string; text?: string }) => Promise<void> | void;

let writeAnswer: AnswerWriter | null = null;

/** Wired once at startup by index.ts, which owns the key table and the PTY manager. */
export function setAnswerWriter(writer: AnswerWriter): void {
  writeAnswer = writer;
}

/** Why an answer was refused, in words a CLI user can act on. */
const ANSWER_ERRORS: Record<AnswerFailure, string> = {
  'unknown-surface': 'no agent has reported for this surface',
  'not-blocked': 'that pane is not waiting on you right now',
  'no-choices': 'the agent is blocked but declared no answers — switch to the pane',
  'unknown-choice': 'no such choice (call pane.agent_state to list them)',
};

/** `surfaceId`, or the `paneId` alias from the issue's original method names. */
function targetSurface(params: any): SurfaceId | undefined {
  const id = params?.surfaceId || params?.paneId;
  return id ? (String(id) as SurfaceId) : undefined;
}

/**
 * Handle a `pane.*` agent-state method.
 * Returns false for anything this module does not own, so the caller can
 * continue routing.
 */
export function handleAgentStateV2(
  method: string,
  params: any,
  respond: Respond,
  respondError: RespondError,
): boolean {
  // `pane.agent_state` with no target is a broadcast query, so it is the one
  // method here that does not need a surface.
  if (method === 'pane.agent_state') {
    const sid = targetSurface(params);
    if (sid) respond({ state: getAgentState(sid) ?? { surfaceId: sid, state: 'unknown' } });
    else respond({ states: listAgentStates(), blocked: listBlocked() });
    return true;
  }

  const handler = HANDLERS[method];
  const isAnswer = method === 'pane.answer_agent';
  if (!handler && !isAnswer) return false;

  const surfaceId = targetSurface(params);
  if (!surfaceId) {
    respondError(-32602, 'surfaceId required');
    return true;
  }

  // The one method that writes rather than records, so it is the one that has
  // to reach the PTY — and the only one that can fail for reasons the caller
  // needs spelled out.
  if (isAnswer) {
    const result = answerAgent(surfaceId, { choiceId: params?.choiceId ?? params?.choice ?? null });
    if (!result.ok) {
      respondError(-32000, ANSWER_ERRORS[result.reason]);
      return true;
    }
    if (!writeAnswer) {
      respondError(-32000, 'no answer writer wired');
      return true;
    }
    // The writer is invoked INSIDE the async function, not handed to
    // Promise.resolve(): a writer that throws synchronously — an untranslatable
    // key name is the obvious case — would otherwise escape past `.catch()` and
    // take down the pipe request handler instead of returning an RPC error.
    void (async () => {
      try {
        await writeAnswer!(surfaceId, { key: result.key, text: result.text });
        respond({ ok: true, choice: result.choice });
      } catch (err: any) {
        respondError(-32000, err?.message || 'failed to deliver the answer');
      }
    })();
    return true;
  }

  respond(handler!(surfaceId, params || {}));
  return true;
}

/**
 * Each handler returns the RPC result. A report that loses the `seq` dedup race
 * answers `{ accepted: false }` rather than erroring — a client retry must be a
 * harmless no-op, not a failure that invites another retry.
 */
const HANDLERS: Record<string, (surfaceId: SurfaceId, p: any) => any> = {
  'pane.report_agent': (surfaceId, p) => {
    const record = reportAgent(surfaceId, {
      seq: p.seq,
      awaitingHuman: typeof p.awaitingHuman === 'boolean' ? p.awaitingHuman : undefined,
      reason: p.reason,
      runDelta: p.runDelta,
      runDepth: p.runDepth,
      choices: p.choices,
    });
    // `choices` echoes how many were KEPT, not how many were sent: a reporter
    // that declares an unanswerable choice (no key, no text) learns from the
    // reply instead of from a user clicking a dead button.
    return {
      accepted: !!record,
      state: getAgentState(surfaceId)?.state ?? 'unknown',
      ...(p.choices !== undefined ? { choices: sanitizeChoices(p.choices).length } : {}),
    };
  },

  'pane.report_agent_session': (surfaceId, p) => ({
    accepted: !!reportAgentSession(surfaceId, { seq: p.seq, sessionId: p.sessionId ?? null }),
  }),

  'pane.report_metadata': (surfaceId, p) => ({
    accepted: !!reportMetadata(surfaceId, {
      seq: p.seq,
      model: p.model,
      contextPct: p.contextPct,
      tokens: p.tokens,
      ttlMs: p.ttlMs,
    }),
  }),

  'pane.release_agent': (surfaceId, p) => ({ released: releaseAgent(surfaceId, { seq: p.seq }) }),
};
