/**
 * Open (or focus) the project Git view (#362).
 *
 * The tab is pinned to a folder through `SurfaceRef.cwd` when it opens — the
 * focused terminal's live cwd, else the workspace cwd — and never follows
 * focus afterwards: the request is explicitly that reviewing one agent's
 * worktree must not jump when the user clicks into another agent's pane.
 * Any folder inside the repository works as the pin; main asks git for the
 * top level and the worktree list from there.
 *
 * Opened by Ctrl+Alt+G (`openGitPanel`), the tab bar `+` menu, the explorer
 * header's ⑂ button, or `wmux new-surface --type git`.
 */
import type { PaneId, SplitNode, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../../shared/types';
import { findLeaf, getAllPaneIds, patchLeafPrimarySurface, splitNode } from '../../store/split-utils';

export interface OpenGitOps {
  workspaces: WorkspaceInfo[];
  selectSurface: (workspaceId: WorkspaceId, paneId: PaneId, index: number) => void;
  addSurface: (
    workspaceId: WorkspaceId, paneId: PaneId, type: 'git', options?: { cwd?: string },
  ) => SurfaceId | null;
}

/** The folder a new Git tab should be pinned to. */
export function gitRootFor(workspace: WorkspaceInfo, paneId: PaneId | null): string | undefined {
  if (paneId) {
    const leaf = findLeaf(workspace.splitTree, paneId);
    const active = leaf?.surfaces[leaf.activeSurfaceIndex];
    const fromTerminal = leaf?.surfaces.find((s) => s.type === 'terminal' && (s.currentCwd || s.cwd));
    const pick = active?.type === 'terminal' && (active.currentCwd || active.cwd) ? active : fromTerminal;
    const cwd = pick?.currentCwd || pick?.cwd;
    if (cwd) return cwd;
  }
  return workspace.cwd || undefined;
}

/**
 * Focus a Git tab already in `paneId`, else open one there pinned to the
 * focused terminal's folder. One per pane, like the Diff shortcut — a second
 * repository is a second pane or an explicit `wmux new-surface --type git`.
 */
export function openGitView(ops: OpenGitOps, workspaceId: WorkspaceId, paneId: PaneId | null): SurfaceId | null {
  const workspace = ops.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;
  const panes = getAllPaneIds(workspace.splitTree);
  const target = paneId && panes.includes(paneId) ? paneId : panes[0];
  if (!target) return null;
  const leaf = findLeaf(workspace.splitTree, target);
  const existing = leaf ? leaf.surfaces.findIndex((s) => s.type === 'git') : -1;
  if (leaf && existing >= 0) {
    ops.selectSurface(workspaceId, target, existing);
    return leaf.surfaces[existing].id;
  }
  const root = gitRootFor(workspace, target);
  return ops.addSurface(workspaceId, target, 'git', root ? { cwd: root } : undefined);
}

/** Every Git tab in a workspace, with the pane that holds it. */
export function gitSurfacesIn(workspace: WorkspaceInfo): Array<{ paneId: PaneId; surfaceId: SurfaceId }> {
  const found: Array<{ paneId: PaneId; surfaceId: SurfaceId }> = [];
  for (const paneId of getAllPaneIds(workspace.splitTree)) {
    const leaf = findLeaf(workspace.splitTree, paneId);
    for (const s of leaf?.surfaces ?? []) if (s.type === 'git') found.push({ paneId, surfaceId: s.id });
  }
  return found;
}

export interface ToggleGitOps {
  workspaces: WorkspaceInfo[];
  updateSplitTree: (workspaceId: WorkspaceId, tree: SplitNode) => void;
  closeSurface: (workspaceId: WorkspaceId, paneId: PaneId, surfaceId: SurfaceId) => void;
}

/**
 * The titlebar's Git button: a panel toggle, not a tab opener. With no Git
 * view in the workspace it splits one to the RIGHT of the focused pane, so the
 * terminal it was opened from stays visible (Ctrl+Alt+G, by contrast, opens a
 * tab IN the focused pane). With one or more open, it closes them all. The
 * button's lit state is derived from the tree, never stored beside it, so a
 * Git tab closed by its own × turns the button off too.
 */
export function toggleGitView(
  ops: ToggleGitOps,
  workspaceId: WorkspaceId,
  paneId: PaneId | null,
  newPaneId: PaneId,
): 'opened' | 'closed' | null {
  const workspace = ops.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;
  const open = gitSurfacesIn(workspace);
  if (open.length > 0) {
    for (const { paneId: p, surfaceId } of open) ops.closeSurface(workspaceId, p, surfaceId);
    return 'closed';
  }
  const panes = getAllPaneIds(workspace.splitTree);
  const target = paneId && panes.includes(paneId) ? paneId : panes[0];
  if (!target) return null;
  const root = gitRootFor(workspace, target);
  let tree = splitNode(workspace.splitTree, target, newPaneId, 'git', 'horizontal');
  if (root) tree = patchLeafPrimarySurface(tree, newPaneId, { cwd: root });
  ops.updateSplitTree(workspaceId, tree);
  return 'opened';
}

export const FOCUS_SURFACE_EVENT = 'wmux:focus-surface';

/** Ask App to focus a surface (workspace, pane and tab): the focused pane is App state. */
export function requestFocusSurface(workspaceId: WorkspaceId, surfaceId: SurfaceId): void {
  document.dispatchEvent(new CustomEvent(FOCUS_SURFACE_EVENT, { detail: { workspaceId, surfaceId } }));
}
