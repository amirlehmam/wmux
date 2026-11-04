import { getAgentState, wasAgentReleased, isSessionMissing, orphanedSession, agentSessionHost } from './agent-state';
import { mapSurfaces, stampClaudeSessionIds } from './claude-resume';
import { stampCodexSessionIds } from './codex-resume';
import { stampOpencodeSessionIds } from './opencode-resume';
import { stampAgySessionIds } from './agy-resume';
import { stampQwenSessionIds } from './qwen-resume';
import type { AgentSessionProvider } from './agent-state';
import { stampOmpSessionIds } from './omp-resume';
import { stampPiSessionFiles } from './pi-resume';
import type { SurfaceId } from '../shared/types';

/**
 * The handle a provider keeps on save. Its own report wins; another provider's
 * report, or a deliberate exit, clears it; and silence keeps it — a restored
 * agent has not reported yet, and that is its recovery handle. A pane whose
 * process died under its agent keeps the handle it held, by the same rules.
 */
function providerLookup(provider: AgentSessionProvider) {
  return (id: SurfaceId): string | null | undefined => {
    const agent = getAgentState(id);
    // An absent provider is Claude: that is what every report before #261 meant.
    if (agent?.sessionId && (agent.sessionProvider ?? 'claude') === provider) return agent.sessionId;
    if (agent?.sessionId || wasAgentReleased(id)) return null;
    const orphan = orphanedSession(id);
    if (orphan) return orphan.provider === provider ? orphan.sessionId : null;
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
  const claude = stampClaudeSessionIds(tree, providerLookup('claude'), agentSessionHost);
  const codex = dropMissingCodexIds(stampCodexSessionIds(claude, providerLookup('codex')));
  const opencode = stampOpencodeSessionIds(codex, providerLookup('opencode'));
  const agy = stampAgySessionIds(opencode, providerLookup('agy'));
  const qwen = stampQwenSessionIds(agy, providerLookup('qwen'));
  const omp = stampOmpSessionIds(qwen, providerLookup('omp'));
  return stampPiSessionFiles(omp, providerLookup('pi'));
}
