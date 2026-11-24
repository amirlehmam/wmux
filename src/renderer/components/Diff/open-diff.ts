/**
 * "Show me these changes" from the file explorer (#325) — the one implementation.
 *
 * The explorer and the Diff tab read the SAME provider (`diff-provider.ts`),
 * but until now nothing on screen connected them: the explorer printed
 * `8 changed +37 -18 vs HEAD` and the only way to see those lines was to know
 * Ctrl+Shift+G. This module is the connection.
 *
 * A Diff tab normally follows the workspace cwd, which is last-reporter-wins
 * across every pane. The explorer's root is the FOCUSED pane's terminal, so
 * with two panes in two repos the shortcut's tab could show the other one. A
 * tab opened from here is therefore pinned to the explorer's root through
 * `SurfaceRef.cwd` (persisted like any other cwd), and a later click reuses
 * a tab already looking at that root instead of stacking a second one.
 *
 * Selecting a file is not state worth persisting — it is a one-shot request to
 * a component that may not be mounted yet — so it travels through a pending
 * map plus a window event rather than through the store.
 */
import type { PaneId, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../../shared/types';
import { findLeaf, getAllPaneIds } from '../../store/split-utils';

/**
 * One spelling per directory for comparison only: separators unified, no
 * trailing separator, case folded (Windows paths are case-insensitive). Never
 * used to build a path that is handed to anything.
 */
export function diffRootKey(p: string | undefined | null): string {
  if (!p) return '';
  let key = p.replace(/\//g, '\\').toLowerCase();
  while (key.endsWith('\\')) key = key.slice(0, -1);
  return key;
}

export interface DiffSurfaceLocation {
  paneId: PaneId;
  index: number;
  surfaceId: SurfaceId;
}

/**
 * The Diff tab already showing `root`, if any — the preferred pane first, so
 * the tab the user is most likely looking at wins over one in a corner.
 *
 * A tab's effective root is its own pinned `cwd`, else the workspace cwd it
 * follows; that second half is what lets the tab Ctrl+Shift+G (or the agent
 * auto-open) made be reused when it happens to point at the same folder.
 */
export function findDiffSurface(
  workspace: WorkspaceInfo,
  root: string,
  preferPane?: PaneId | null,
  remote = false,
): DiffSurfaceLocation | null {
  const want = diffRootKey(root);
  // A remote workspace has ONE checkout (its ssh target), and its Diff tabs
  // ignore their cwd, so any Diff tab in it is "the" one.
  if (!want && !remote) return null;
  const panes = getAllPaneIds(workspace.splitTree);
  const ordered = preferPane && panes.includes(preferPane)
    ? [preferPane, ...panes.filter((p) => p !== preferPane)]
    : panes;
  for (const paneId of ordered) {
    const leaf = findLeaf(workspace.splitTree, paneId);
    if (!leaf) continue;
    const index = leaf.surfaces.findIndex(
      (s) => s.type === 'diff' && (remote || diffRootKey(s.cwd ?? workspace.cwd) === want),
    );
    if (index >= 0) return { paneId, index, surfaceId: leaf.surfaces[index].id };
  }
  return null;
}

// ─── File selection hand-off ─────────────────────────────────────────────────

export const DIFF_SELECT_EVENT = 'wmux:diff-select';

const pendingSelection = new Map<string, string>();

/** Ask a Diff surface to select `file`, whether or not it has mounted yet. */
export function requestDiffSelection(surfaceId: SurfaceId, file: string): void {
  pendingSelection.set(surfaceId, file);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DIFF_SELECT_EVENT, { detail: { surfaceId } }));
  }
}

/** Take (and clear) the pending selection for a surface. */
export function takeDiffSelection(surfaceId: string): string | null {
  const file = pendingSelection.get(surfaceId) ?? null;
  pendingSelection.delete(surfaceId);
  return file;
}

// ─── The action ──────────────────────────────────────────────────────────────

/** The store operations this needs — narrowed so tests need not build a store. */
export interface OpenDiffOps {
  workspaces: WorkspaceInfo[];
  selectSurface: (workspaceId: WorkspaceId, paneId: PaneId, index: number) => void;
  addSurface: (
    workspaceId: WorkspaceId, paneId: PaneId, type: 'diff', options?: { cwd?: string },
  ) => SurfaceId | null;
}

/**
 * Focus the Diff tab for `root` (or open one in `paneId`, falling back to the
 * workspace's first pane), then select `file` in it when one is given.
 * Returns the surface, or null when there is nowhere to put it.
 */
export function openDiffView(
  ops: OpenDiffOps,
  workspaceId: WorkspaceId,
  paneId: PaneId | null,
  root: string,
  file?: string | null,
  options: { remote?: boolean } = {},
): SurfaceId | null {
  const workspace = ops.workspaces.find((w) => w.id === workspaceId);
  const remote = options.remote === true;
  if (!workspace || (!root && !remote)) return null;

  let surfaceId: SurfaceId | null;
  const existing = findDiffSurface(workspace, root, paneId, remote);
  if (existing) {
    ops.selectSurface(workspaceId, existing.paneId, existing.index);
    surfaceId = existing.surfaceId;
  } else {
    const panes = getAllPaneIds(workspace.splitTree);
    const target = paneId && panes.includes(paneId) ? paneId : panes[0];
    if (!target) return null;
    // A remote root is a path THERE: pinning it as `cwd` would persist a
    // folder that does not exist locally. Main resolves the checkout from the
    // workspace's ssh target (diff:get-files with this surface), so the tab
    // needs no cwd at all.
    surfaceId = remote
      ? ops.addSurface(workspaceId, target, 'diff')
      : ops.addSurface(workspaceId, target, 'diff', { cwd: root });
  }
  if (surfaceId && file) requestDiffSelection(surfaceId, file);
  return surfaceId;
}
