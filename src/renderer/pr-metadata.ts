import { SurfaceId, WorkspaceInfo } from '../shared/types';
import { normalizePrStatus } from './components/Sidebar/pr-status';

/**
 * Pure decision logic for the `report_pr` / `clear_pr` V1 pipe commands
 * (issue #4). Split out of `App.tsx`'s `handleSurfaceMetadata` so it can be
 * exercised without pulling in the whole component tree — same reasoning as
 * `pr-status.ts` next to `PrStatusIcon`.
 *
 * Every PowerShell pane in a workspace runs its own PR poller and they all
 * write the SAME workspace-scoped fields, so a `clear_pr` from one pane can
 * otherwise wipe a PR another pane just reported (two panes, two repos, one
 * workspace). `ws.prSurfaceId` records who currently owns the row; a
 * `clear_pr` is honoured only from that surface. When no owner is recorded
 * — a fresh workspace, or one where the badge was already cleared — the
 * comparison against `undefined` simply fails and the clear is dropped,
 * which is correct: there is nothing to clear. In practice a workspace never
 * has `prNumber` set without `prSurfaceId` alongside it, because PR metadata
 * is never persisted across a restart (see `PrStatusIcon.tsx`) — the owner
 * is always written in the same patch as the PR number.
 *
 * Returns the patch for `updateWorkspaceMetadata`, or `null` when the
 * command is a no-op (an unowned/foreign `clear_pr`).
 */
export function applyPrCommand(
  cmd: { command: string; surfaceId?: string; args?: string[] },
  ws: Pick<WorkspaceInfo, 'prSurfaceId'>,
): Partial<WorkspaceInfo> | null {
  if (cmd.command === 'report_pr') {
    const [num, status, ...labelParts] = cmd.args || [];
    return {
      prNumber: num ? parseInt(num) : undefined,
      // gh reports OPEN/MERGED/CLOSED; the store and the icon speak the
      // lowercase union. `SidebarMetadata.prStatus` is a plain string, so
      // the casing difference had nothing to catch it on the way through.
      prStatus: normalizePrStatus(status),
      prLabel: labelParts.join(' '),
      prSurfaceId: cmd.surfaceId as SurfaceId | undefined,
    };
  }

  if (cmd.command === 'clear_pr') {
    if (!cmd.surfaceId || cmd.surfaceId !== ws.prSurfaceId) return null;
    return { prNumber: undefined, prStatus: undefined, prLabel: undefined, prSurfaceId: undefined };
  }

  return null;
}
