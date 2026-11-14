type AgentBrowserDisableResult = { url?: string };

// The store owns engine teardown even without a view. A mounted (or remounted)
// Web view joins that same readback instead of issuing a second native close.
// Keep the result until re-entry/real close: React may commit after it settles.
const handoffs = new Map<string, {
  promise: Promise<AgentBrowserDisableResult | null>;
  closed: boolean;
  settled: boolean;
  readbackValid: boolean;
  /** Empty selects the view's configured start page; absent means no restore intent. */
  restoredUrl?: string;
}>();

/** One engine exit has one close/readback, regardless of React view lifetime. */
export function beginAgentBrowserHandoff(surfaceId: string): Promise<AgentBrowserDisableResult | null> {
  const pending = handoffs.get(surfaceId);
  if (pending) return pending.promise;
  let result: Promise<AgentBrowserDisableResult | null>;
  try {
    result = (globalThis.window?.wmux?.agentBrowser?.disable(surfaceId) ?? Promise.resolve(null)).catch(() => null);
  } catch {
    result = Promise.resolve(null);
  }
  const handoff = { promise: result, closed: false, settled: false, readbackValid: true };
  handoffs.set(surfaceId, handoff);
  void result.then(() => { handoff.settled = true; });
  return result;
}

/** Invalidated readbacks still share their native close with later close visits. */
export function getAgentBrowserHandoff(surfaceId: string) {
  const handoff = handoffs.get(surfaceId);
  return handoff && !handoff.closed ? handoff : undefined;
}

/** A restored layout supplies its own destination; later navigation supersedes both. */
export function invalidateAgentBrowserReadback(surfaceId: string, restoredUrl?: string): void {
  const handoff = handoffs.get(surfaceId);
  if (handoff) {
    handoff.readbackValid = false;
    handoff.restoredUrl = restoredUrl;
  }
}

/** Both persistence and the view must honor newer navigation and engine lifetimes. */
export function canApplyAgentBrowserReadback(
  surfaceId: string,
  promise: Promise<AgentBrowserDisableResult | null>,
): boolean {
  const handoff = handoffs.get(surfaceId);
  return !!handoff && !handoff.closed && handoff.readbackValid && handoff.promise === promise;
}

/** A remounted Web view already has persisted readback unless teardown is still pending. */
export function hasPendingAgentBrowserHandoff(surfaceId: string): boolean {
  const handoff = handoffs.get(surfaceId);
  return !!handoff && !handoff.closed && handoff.readbackValid && !handoff.settled;
}

/** A new Agent lifetime invalidates the old Web handoff. */
export function clearAgentBrowserHandoff(surfaceId: string): void {
  handoffs.delete(surfaceId);
}

/** Real close fences readback immediately, while repeated close visits share teardown. */
export function closeAgentBrowserHandoff(surfaceId: string): void {
  const handoff = handoffs.get(surfaceId);
  if (!handoff) return;
  handoff.closed = true;
  void handoff.promise.then(() => {
    if (handoffs.get(surfaceId) === handoff) handoffs.delete(surfaceId);
  });
}
