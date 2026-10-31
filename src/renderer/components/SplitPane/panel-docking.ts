import type { PaneId, SplitNode, SurfaceRef } from '../../../shared/types';

/** Promote a side panel to a normal leaf. Existing terminals retain their ids
 * and subtrees, so TerminalHost keeps every live session through the move. */
export function dockPanelInWorkspace(tree: SplitNode, surface: SurfaceRef, paneId: PaneId): SplitNode {
  return {
    type: 'branch', direction: 'horizontal', ratio: 0.7,
    children: [tree, { type: 'leaf', paneId, surfaces: [surface], activeSurfaceIndex: 0 }],
  };
}
