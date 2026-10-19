import { getAgentState, wasAgentReleased, isSessionMissing } from './agent-state';
import { mapSurfaces, stampClaudeSessionIds } from './claude-resume';
import { stampCodexSessionIds } from './codex-resume';
import { stampOpencodeSessionIds } from './opencode-resume';
import { stampAgySessionIds } from './agy-resume';
import type { AgentSessionProvider } from './agent-state';
import type { SurfaceId } from '../shared/types';

/**
 * The handle a provider keeps on save. Its own report wins; another provider's
 * report, or a deliberate exit, clears it; and silence keeps it — a restored
 * agent has not reported yet, and that is its recovery handle.
 */
function providerLookup(provider: AgentSessionProvider) {
  return (id: SurfaceId): string | null | undefined => {
    const agent = getAgentState(id);
    // An absent provider is Claude: that is what every report before #261 meant.
    if (agent?.sessionId && (agent.sessionProvider ?? 'claude') === provider) return agent.sessionId;
    if (agent?.sessionId || wasAgentReleased(id)) return null;
    return undefined;
  };
}

/**
 * Drop a saved Codex id that Codex said it cannot open. Silence keeps a
 * restored handle (above), so this is the one way such an id leaves — and only
 * when the id on disk is exactly the one Codex refused.
 */
function dropMissingCodexIds<T>(tree: T): T {
  return mapSurfaces(tree, surface => {
    const id = surface.codexSessionId;
    if (typeof id !== 'string' || !isSessionMissing(surface.id as SurfaceId, 'codex', id)) return surface;
    const rest = { ...surface };
    delete rest.codexSessionId;
    return rest;
  });
}

export function stampAgentSessionIds<T>(tree: T): T {
  const claude = stampClaudeSessionIds(tree, providerLookup('claude'));
  const codex = dropMissingCodexIds(stampCodexSessionIds(claude, providerLookup('codex')));
  const opencode = stampOpencodeSessionIds(codex, providerLookup('opencode'));
  return stampAgySessionIds(opencode, providerLookup('agy'));
}
