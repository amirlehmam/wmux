// ─── Antigravity CLI resume, main side ───────────────────────────────────────
//
// The fourth provider beside Claude (#186), Codex (#261) and OpenCode (#290).
// The handle comes from wmux's own agy plugin (agy-context.ts), whose hooks
// read `conversationId` off agy's hook payload and report it with
// `provider: 'agy'`; restore types `agy --conversation <id>`. Same shape as
// opencode-resume.ts on purpose — one stamp per provider, mutually exclusive
// through agent-session-persistence.ts.

import { SurfaceId } from '../shared/types';
import { mapSurfaces } from './claude-resume';

/**
 * agy conversation ids are UUIDs. Strict on purpose: the value arrives over the
 * pipe and ends up on a restored pane's command line, and nothing about a
 * conversation id needs more than hex and dashes.
 */
export const AGY_CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidAgyConversationId(id: unknown): id is string {
  return typeof id === 'string' && AGY_CONVERSATION_ID_RE.test(id);
}

/**
 * `undefined` from the lookup means "no opinion" and keeps what the persisted
 * copy already had: a restored agy that has not reported yet must not lose its
 * handle to the first auto-save.
 */
export function stampAgySessionIds<T>(tree: T, lookup: (id: SurfaceId) => string | null | undefined): T {
  return mapSurfaces(tree, surface => {
    if (surface.type !== 'terminal') return surface;
    const found = lookup(surface.id as SurfaceId);
    if (found === undefined) return surface;
    const next = isValidAgyConversationId(found) ? found : undefined;
    if (next === surface.agySessionId) return surface;
    if (next) return { ...surface, agySessionId: next };
    const rest = { ...surface };
    delete rest.agySessionId;
    return rest;
  });
}
