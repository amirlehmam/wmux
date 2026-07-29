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
  getAgentState,
  listAgentStates,
  listBlocked,
} from './agent-state';

type Respond = (result: any) => void;
type RespondError = (code: number, message: string) => void;

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
  if (!handler) return false;

  const surfaceId = targetSurface(params);
  if (!surfaceId) {
    respondError(-32602, 'surfaceId required');
    return true;
  }
  respond(handler(surfaceId, params || {}));
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
    });
    return { accepted: !!record, state: getAgentState(surfaceId)?.state ?? 'unknown' };
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
