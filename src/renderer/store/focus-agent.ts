/**
 * "Take me to that agent" — the one implementation.
 *
 * Three callers want it (the roster banner, the jumpToBlocked shortcut, the
 * agent navigator) and getting it subtly wrong is easy: selecting the workspace
 * and focusing the pane is NOT enough when the agent sits in a background tab.
 * Keep-alive tabs mean that pane is mounted and rendering, so focusing it lands
 * the user on a *different* surface in the right pane, with no visible error —
 * the blocked prompt stays hidden behind an inactive tab.
 *
 * Kept out of the components for the same reason split-utils is: it is the
 * behaviour, not the markup, and it is what a test can hold onto.
 */
import { PaneId, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../shared/types';
import { findLeaf, getAllPaneIds } from './split-utils';

export interface AgentFocusTarget {
  workspaceId: WorkspaceId;
  paneId: PaneId;
  surfaceId: SurfaceId;
}

/** The store operations this needs — narrowed so tests need not build a store. */
export interface AgentFocusOps {
  workspaces: WorkspaceInfo[];
  selectWorkspace: (id: WorkspaceId) => void;
  selectSurface: (workspaceId: WorkspaceId, paneId: PaneId, index: number) => void;
}

/**
 * Resolve which tab index holds `surfaceId`, anywhere in the workspace.
 *
 * The target's `paneId` is trusted as a hint but re-verified, because the
 * roster is derived from a snapshot that may be a tick behind a split or a tab
 * drag. Falling back to a full scan costs nothing at these sizes and means a
 * moved tab still resolves instead of silently doing nothing.
 */
function locateSurface(
  workspace: WorkspaceInfo,
  target: AgentFocusTarget,
): { paneId: PaneId; index: number } | null {
  const hinted = findLeaf(workspace.splitTree, target.paneId);
  const hintedIdx = hinted ? hinted.surfaces.findIndex((s) => s.id === target.surfaceId) : -1;
  if (hintedIdx !== -1) return { paneId: target.paneId, index: hintedIdx };

  for (const paneId of getAllPaneIds(workspace.splitTree)) {
    const leaf = findLeaf(workspace.splitTree, paneId);
    const idx = leaf ? leaf.surfaces.findIndex((s) => s.id === target.surfaceId) : -1;
    if (idx !== -1) return { paneId, index: idx };
  }
  return null;
}

/**
 * Select the workspace, raise the tab, and hand back the pane to focus.
 *
 * Returns the pane the caller should focus, or null when the target no longer
 * exists — a pane closed between the render and the click. Null is a normal
 * outcome the caller ignores, not an error: the alternative is focusing an
 * arbitrary pane, which moves the user somewhere they did not ask to go.
 */
export function focusAgentTarget(ops: AgentFocusOps, target: AgentFocusTarget): PaneId | null {
  const workspace = ops.workspaces.find((w) => w.id === target.workspaceId);
  if (!workspace) return null;

  const located = locateSurface(workspace, target);
  if (!located) return null;

  ops.selectWorkspace(workspace.id);
  ops.selectSurface(workspace.id, located.paneId, located.index);
  return located.paneId;
}
