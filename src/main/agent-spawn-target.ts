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
 * causes that are all wrong ("no terminal for surface … (markdown/browser pane,
 * another window, or closed)"). The reporter restarted three orchestration
 * waves chasing it.
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
 * for the same reason: a rule you can test without an Electron app. The impure
 * half is `spawnTargetLookups` in `index.ts`, which asks EVERY window for a
 * pane's or surface's workspace and for pane loads, first real answer wins
 * (#143); the active workspace is the first window's.
 */

export interface SpawnTargetLookups {
  /**
   * Which workspace owns this pane, across EVERY window, or null if no window
   * has it. Every window, because a workspace is not a window (#143) — the
   * first window's store knows nothing about a pane in the second.
   */
  workspaceForPane(paneId: string): Promise<string | null>;
  /**
   * Which workspace holds this SURFACE, across every window, or null (#246).
   * Asked about the caller's own terminal — the `caller` every CLI call carries
   * as `$WMUX_SURFACE_ID` — so it has the same every-window rule (`index.ts`
   * resolves it through `__wmux_locateSurface` in every window). A miss is not
   * an error here: it is a stale id or a shell wmux did not start, and the
   * resolution simply moves on to the active workspace.
   */
  workspaceForSurface(surfaceId: string): Promise<string | null>;
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
 *
 * Order: the named workspace, then the CALLER's workspace, then the active one.
 * The caller step is #246. Every CLI call carries `caller: $WMUX_SURFACE_ID`,
 * and `layout.grid`, `pane.list` and friends already scope themselves to it
 * (#143, `resolveCallerTarget` in v2-bridge.ts) — but this path never read it,
 * so an agent spawned from a background workspace was filed in whichever one
 * the user happened to have focused, and a hand-rolled spawn loop scattered its
 * agents across every workspace the user clicked while it ran. "The workspace I
 * am typing in" is what a bare `wmux agent spawn` means; the focused one is only
 * the right answer when there is no caller to ask about.
 *
 * A caller that does not resolve (stale id, a shell wmux did not start) falls
 * through to the active workspace SILENTLY — the rule resolveCallerTarget
 * applies, and the pre-#246 behaviour rather than an error nobody can act on.
 */
export async function resolveSpawnWorkspace(
  requested: string | undefined,
  lookups: SpawnTargetLookups,
  caller?: unknown,
): Promise<string> {
  let workspaceId = requested || null;
  if (!workspaceId && typeof caller === 'string' && caller) {
    workspaceId = await lookups.workspaceForSurface(caller);
  }
  workspaceId ||= await lookups.activeWorkspaceId();
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
 * With a pane named, neither the caller (#246) nor the ACTIVE workspace is
 * consulted at all — so a
 * fully-specified spawn now works when there is no active workspace, where it
 * used to fail -32000 for a reason that had nothing to do with the request.
 */
export async function resolveSpawnTarget(
  params: { paneId?: string; workspaceId?: string; caller?: unknown },
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

  const workspaceId = await resolveSpawnWorkspace(params.workspaceId, lookups, params.caller);
  const loads = await resolveSpawnPaneLoads(workspaceId, lookups);
  const paneId = distributeAgents(1, loads)[0];
  // distributeAgents cannot return an empty assignment for a non-empty pane
  // list, but it indexes `sorted[i % sorted.length]` — so an empty list would
  // be a NaN index and `undefined` rather than a throw. The guard above makes
  // that unreachable; this keeps it unreachable rather than trusting it.
  if (!paneId) throw new SpawnTargetError(-32000, 'No panes available');
  return { paneId, workspaceId };
}
