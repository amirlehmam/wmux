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
  noteMissingSession,
  answerAgent,
  sanitizeChoices,
  getAgentState,
  listAgentStates,
  listBlocked,
  type AgentChoice,
  type AnswerFailure,
} from './agent-state';
import { agentIdentity } from './agent-identity';
import type { DeliverAnswerReason } from './remote-console/contract';
import { CHOICE_ID_RE } from '../shared/remote-console-protocol';

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
  'stale': 'the pane is asking a different question now',
};

type AnswerOutcome =
  | { ok: true; choice: AgentChoice | null }
  | { ok: false; reason: DeliverAnswerReason; message: string };

/**
 * Resolve a declared choice and write it into the pane — the one answer path,
 * shared by `pane.answer_agent` and the Remote Console (#254, invariant I4).
 *
 * `answerAgent` runs BEFORE the first `await`, so its guard (blocked-only,
 * declared payload only) and the consumption of the choices happen in the same
 * tick as the caller's request; a second answer racing in behind finds them
 * gone. It never clears blocked — the agent confirms that, as always (#128).
 *
 * The writer is invoked INSIDE the async function, not handed to
 * Promise.resolve(): a writer that throws synchronously — an untranslatable key
 * name is the obvious case — would otherwise escape past the catch and take
 * down the caller instead of coming back as a failure.
 */
async function runAnswer(surfaceId: SurfaceId, params: Parameters<typeof answerAgent>[1]): Promise<AnswerOutcome> {
  const result = answerAgent(surfaceId, params);
  if (!result.ok) return { ok: false, reason: result.reason, message: ANSWER_ERRORS[result.reason] };
  const writer = writeAnswer;
  if (!writer) return { ok: false, reason: 'write-failed', message: 'no answer writer wired' };
  try {
    await writer(surfaceId, { key: result.key, text: result.text });
    return { ok: true, choice: result.choice };
  } catch (err: any) {
    return { ok: false, reason: 'write-failed', message: err?.message || 'failed to deliver the answer' };
  }
}

/**
 * `ConsoleOps.deliverAnswer` (#254). Deliberately NARROWER than what the pipe
 * gets back: no resolved choice, no writer message. The choice's `key`/`text`
 * is exactly what I7 keeps off the wire, so the runtime is never handed it and
 * cannot leak it by accident.
 */
export async function deliverAnswer(
  surfaceId: string,
  choiceId: string,
  promptId?: number,
): Promise<{ ok: true } | { ok: false; reason: DeliverAnswerReason }> {
  // The console always NAMES its choice. `answerAgent` reads an empty (or
  // all-blank) id as an UNNAMED answer and resolves it to the declared default
  // or the only choice — right for `wmux answer-agent` with no --choice, never
  // for a remote tap: an empty id reaching here is a bug upstream, and it must
  // not turn into "press the default" on somebody's permission prompt (I4).
  // Same shape the wire validator enforces, so nothing legitimate is refused.
  // `choiceId` is a WIRE id (`wireChoiceIds`): the declared id when it fits the
  // wire, an opaque index otherwise. `answerAgent` maps it back to the declared
  // id against the current prompt, after its stale check.
  if (typeof choiceId !== 'string' || !CHOICE_ID_RE.test(choiceId)) {
    return { ok: false, reason: 'unknown-choice' };
  }
  // The prompt the phone saw. Anything but a positive integer cannot name a
  // live prompt, so it is stale rather than an answer that skips the check.
  if (promptId !== undefined && !(Number.isSafeInteger(promptId) && promptId > 0)) return { ok: false, reason: 'stale' };
  const outcome = await runAnswer(
    surfaceId as SurfaceId,
    promptId === undefined ? { wireChoiceId: choiceId } : { wireChoiceId: choiceId, promptId },
  );
  return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
}

/** `surfaceId`, or the `paneId` alias from the issue's original method names. */
function targetSurface(params: any): SurfaceId | undefined {
  const id = params?.surfaceId || params?.paneId;
  return id ? (String(id) as SurfaceId) : undefined;
}

/**
 * Attach WHO to a snapshot of WHAT.
 *
 * Two separate trackers because they have two separate sources of truth — the
 * agent's own reports, and what wmux launched or the shell hook saw. They are
 * joined here, at the read, rather than merged in either store, so a caller can
 * still tell "Claude, silent" from "something, blocked".
 */
function withIdentity<T extends { surfaceId: string; sessionId?: string | null; sessionProvider?: string }>(snapshot: T): T & {
  agent: string | null;
  agentSource: string | null;
} {
  const identity = agentIdentity.identify(snapshot.surfaceId);
  // Only Codex overrides: identity already names a Claude pane, and taking
  // every Claude session report as the source would change `agentSource` for
  // panes this feature has nothing to do with.
  const reported = snapshot.sessionId && snapshot.sessionProvider === 'codex' ? 'codex' : undefined;
  return { ...snapshot, agent: reported ?? identity?.kind ?? null, agentSource: reported ? 'session' : identity?.source ?? null };
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
    if (sid) respond({ state: withIdentity(getAgentState(sid) ?? { surfaceId: sid, state: 'unknown' }) });
    else {
      respond({
        states: listAgentStates().map(withIdentity),
        blocked: listBlocked().map(withIdentity),
        // Panes wmux identified as agents that have never declared anything —
        // exactly the population the identity layer exists to surface, and the
        // one `states` cannot show because it is keyed on having reported.
        identified: agentIdentity.list(),
      });
    }
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
    void (async () => {
      const outcome = await runAnswer(surfaceId, { choiceId: params?.choiceId ?? params?.choice ?? null });
      if (outcome.ok) respond({ ok: true, choice: outcome.choice });
      else respondError(-32000, outcome.message);
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
    accepted: !!reportAgentSession(surfaceId, { seq: p.seq, sessionId: p.sessionId ?? null, provider: p.provider }),
  }),

  // Distinct verbs keep the Codex launcher inert against older wmux instances.
  'pane.report_codex_session': (surfaceId, p) => ({
    accepted: !!reportAgentSession(surfaceId, { sessionId: p.sessionId ?? null, provider: 'codex' }),
  }),
  'pane.release_codex_session': (surfaceId, p) => {
    const current = getAgentState(surfaceId);
    if (current?.sessionProvider !== 'codex' || current.sessionId !== p.sessionId) return { released: false };
    return { released: releaseAgent(surfaceId) };
  },
  // OpenCode exited (#290): forget its handle, so restore gives back a shell.
  // Same guard as Codex — only the session the pane still holds, so a late
  // exit cannot take the NEXT session in the same tab with it.
  'pane.release_opencode_session': (surfaceId, p) => {
    const current = getAgentState(surfaceId);
    if (current?.sessionProvider !== 'opencode' || current.sessionId !== p.sessionId) return { released: false };
    return { released: releaseAgent(surfaceId) };
  },
  // A restore typed `codex resume <id>` and Codex answered that the thread does
  // not exist (an empty one never written). Forget that saved id — only it.
  'pane.codex_session_missing': (surfaceId, p) => ({
    accepted: noteMissingSession(surfaceId, 'codex', p.sessionId),
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
