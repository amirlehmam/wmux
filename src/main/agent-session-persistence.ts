import { getAgentState, wasAgentReleased } from './agent-state';
import { stampClaudeSessionIds } from './claude-resume';
import { stampCodexSessionIds } from './codex-resume';
import { stampOpencodeSessionIds } from './opencode-resume';
import { stampOmpSessionIds } from './omp-resume';
import type { SurfaceId } from '../shared/types';

/**
 * The handle a non-Claude provider keeps on save. Its own report wins; another
 * provider's report, or a deliberate exit, clears it; and silence keeps it — a
 * restored agent has not reported yet, and that is its recovery handle.
 */
function providerLookup(provider: 'codex' | 'opencode' | 'omp') {
  return (id: SurfaceId): string | null | undefined => {
    const agent = getAgentState(id);
    if (agent?.sessionProvider === provider) return agent.sessionId;
    if (agent?.sessionId || wasAgentReleased(id)) return null;
    return undefined;
  };
}

export function stampAgentSessionIds<T>(tree: T): T {
  const claude = stampClaudeSessionIds(tree, id => {
    const agent = getAgentState(id);
    // An absent provider is Claude: that is what every report before #261 meant.
    return agent?.sessionProvider && agent.sessionProvider !== 'claude' ? null : agent?.sessionId;
  });
  const codex = stampCodexSessionIds(claude, providerLookup('codex'));
  const opencode = stampOpencodeSessionIds(codex, providerLookup('opencode'));
  return stampOmpSessionIds(opencode, providerLookup('omp'));
}
