import { distributeAgents, PaneLoadInfo } from './agent-manager';

/**
 * Which (pane, workspace) pair an `agent.spawn` actually means (issue #242).
 *
 * The bug was that the two were resolved INDEPENDENTLY. `workspaceId` came from
 * the active workspace and `paneId` was taken verbatim, so nothing ever checked
 * that the pane belonged to the workspace it was being filed under. Pass a pane
 * from a non-active workspace and the agent starts, runs, and is recorded
 * against the wrong workspace — after which every lookup that goes through the
 * workspace record fails, including `read-screen`, whose error then names three
 * causes that are all wrong ("markdown/browser pane, another window, or
 * closed"). The reporter restarted three orchestration waves chasing it.
 *
 * The fix is to make the pane AUTHORITATIVE whenever it is given. A pane
 * belongs to exactly one workspace and the split tree says which, so there is
 * nothing to infer: `--pane` alone reads as fully specified because it IS fully
 * specified.
 *
 * There is a second, mirrored half the report only suspected. Pane loads were
 * always read off the ACTIVE workspace, so `spawn_batch --workspace <other>`
 * honoured the flag for the record and ignored it for the panes — agents landed
 * in the active workspace's panes and were filed under the other one. Both
 * directions are the same mistake, so both are resolved here, once.
 *
 * Pure, with the renderer lookups injected. The split tree lives in the Zustand
 * store and main has no copy, so every question here is a round trip into a
 * renderer — which is exactly what makes the decision worth separating from the
 * asking. This is the shape `close-guard.ts` and `agent-browser-verbs.ts` use
 * for the same reason: a rule you can test without an Electron app.
 */

export interface SpawnTargetLookups {
  /**
   * Which workspace owns this pane, across EVERY window, or null if no window
   * has it. Every window, because a workspace is not a window (#143) — the
   * first window's store knows nothing about a pane in the second.
   */
  workspaceForPane(paneId: string): Promise<string | null>;
  /** The first window's active workspace, or null. */
  activeWorkspaceId(): Promise<string | null>;
  /** Pane loads for one NAMED workspace, across every window. */
  paneLoads(workspaceId: string): Promise<PaneLoadInfo[]>;
}

export interface ResolvedSpawnTarget {
  paneId: string;
  workspaceId: string;
}

/** A JSON-RPC-shaped failure, so the caller maps it to a reply without a table. */
export class SpawnTargetError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'SpawnTargetError';
  }
}

/**
 * Resolve the workspace a spawn should be filed under.
 *
 * Shared by `agent.spawn` and `agent.spawn_batch` so the two cannot disagree
 * about what `--workspace` means — they already had, which is how the batch
 * half of #242 went unnoticed.
 */
export async function resolveSpawnWorkspace(
  requested: string | undefined,
  lookups: SpawnTargetLookups,
): Promise<string> {
  const workspaceId = requested || (await lookups.activeWorkspaceId());
  if (!workspaceId) throw new SpawnTargetError(-32000, 'No active workspace');
  return workspaceId;
}

/**
 * Pick the pane for one agent inside an already-resolved workspace.
 *
 * Separated from the workspace decision because the batch path needs the loads
 * themselves (it assigns N agents across them by strategy) while the single
 * path only needs one pane.
 */
export async function resolveSpawnPaneLoads(
  workspaceId: string,
  lookups: SpawnTargetLookups,
): Promise<PaneLoadInfo[]> {
  const loads = await lookups.paneLoads(workspaceId);
  if (loads.length === 0) throw new SpawnTargetError(-32000, 'No panes available');
  return loads;
}

/**
 * The full `agent.spawn` decision.
 *
 * Three outcomes when a pane is named, and the middle one is the fix:
 *
 *  - the pane is unknown to every window → -32602. Today this "succeeds": the
 *    agent spawns and the `AGENT_UPDATE` broadcast addresses a pane that does
 *    not exist, so nothing renders it and the caller is told everything is
 *    fine. A stale pane id is a caller bug, and saying so beats running an
 *    agent nobody can see.
 *  - the pane is known and no workspace was named → the OWNER is the answer,
 *    never the active workspace.
 *  - both named and they disagree → -32602 rather than a silently mismatched
 *    record. There is no reading of the request under which the caller wants
 *    the pane filed somewhere that does not contain it, and guessing which of
 *    the two they meant is how the original bug stayed invisible.
 *
 * With a pane named, the ACTIVE workspace is never consulted at all — so a
 * fully-specified spawn now works when there is no active workspace, where it
 * used to fail -32000 for a reason that had nothing to do with the request.
 */
export async function resolveSpawnTarget(
  params: { paneId?: string; workspaceId?: string },
  lookups: SpawnTargetLookups,
): Promise<ResolvedSpawnTarget> {
  if (params.paneId) {
    const owner = await lookups.workspaceForPane(params.paneId);
    if (!owner) {
      throw new SpawnTargetError(-32602, `Unknown pane: ${params.paneId}`);
    }
    if (params.workspaceId && params.workspaceId !== owner) {
      throw new SpawnTargetError(
        -32602,
        `Pane ${params.paneId} belongs to workspace ${owner}, not ${params.workspaceId}`,
      );
    }
    return { paneId: params.paneId, workspaceId: owner };
  }

  const workspaceId = await resolveSpawnWorkspace(params.workspaceId, lookups);
  const loads = await resolveSpawnPaneLoads(workspaceId, lookups);
  const paneId = distributeAgents(1, loads)[0];
  // distributeAgents cannot return an empty assignment for a non-empty pane
  // list, but it indexes `sorted[i % sorted.length]` — so an empty list would
  // be a NaN index and `undefined` rather than a throw. The guard above makes
  // that unreachable; this keeps it unreachable rather than trusting it.
  if (!paneId) throw new SpawnTargetError(-32000, 'No panes available');
  return { paneId, workspaceId };
}
