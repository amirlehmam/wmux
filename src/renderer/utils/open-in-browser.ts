import { useStore } from '../store';
import { splitNode, getAllPaneIds } from '../store/split-utils';
import { PaneId, SplitNode, SurfaceRef, WorkspaceId } from '../../shared/types';
import { v4 as uuid } from 'uuid';

function findLeaf(tree: SplitNode, paneId: PaneId): (SplitNode & { type: 'leaf' }) | null {
  if (tree.type === 'leaf') return tree.paneId === paneId ? tree : null;
  return findLeaf(tree.children[0], paneId) ?? findLeaf(tree.children[1], paneId);
}

/** Recursively collect all surfaces from a split tree. */
function getAllSurfaces(node: SplitNode): SurfaceRef[] {
  if (node.type === 'leaf') return node.surfaces;
  return [...getAllSurfaces(node.children[0]), ...getAllSurfaces(node.children[1])];
}

/**
 * Decide where a clicked link goes: the wmux panel, or the system browser.
 *
 * The destination is `browserPrefs.openLinksExternally`, and Ctrl/Cmd INVERTS
 * it rather than forcing one side (issue #201). Inverting is what makes the
 * setting worth having: whichever default someone picks, the other destination
 * stays one modifier away, so nobody loses the behaviour they had — they only
 * change which one costs a keypress.
 *
 * Kept here rather than at the call sites so the rule is stated once. The two
 * callers (terminal OSC 8 links, markdown anchors) only report whether the
 * modifier was held; they have no opinion about what that means.
 */
export function linkOpensExternally(preferExternal: boolean, invert: boolean | undefined): boolean {
  return invert ? !preferExternal : preferExternal;
}

/**
 * Open a URL in the wmux browser panel, or the system browser.
 * - Destination follows `browserPrefs.openLinksExternally`; Ctrl/Cmd inverts it.
 * - For the panel: finds or creates a browser surface in the active workspace,
 *   then navigates to the URL.
 * - Anything that makes the panel impossible (no workspace, no pane) falls back
 *   to the system browser rather than dropping the click.
 */
export function openInWmuxBrowser(url: string, opts?: { invert?: boolean }): void {
  const state = useStore.getState();

  if (linkOpensExternally(state.browserPrefs.openLinksExternally, opts?.invert)) {
    window.wmux?.system?.openExternal?.(url);
    return;
  }

  const wsId = state.activeWorkspaceId as WorkspaceId;
  if (!wsId) {
    window.wmux?.system?.openExternal?.(url);
    return;
  }

  const ws = state.workspaces.find(w => w.id === wsId);
  if (!ws) {
    window.wmux?.system?.openExternal?.(url);
    return;
  }

  // Check if a browser surface already exists in this workspace
  const allSurfaces = getAllSurfaces(ws.splitTree);
  const browserSurface = allSurfaces.find(s => s.type === 'browser');

  if (browserSurface) {
    // Browser exists — just navigate
    window.dispatchEvent(new CustomEvent('wmux:browser-navigate', { detail: { url, surfaceId: browserSurface.id } }));
    return;
  }

  // No browser — split a new pane to the right with a browser surface
  const paneIds = getAllPaneIds(ws.splitTree);
  const targetPaneId = paneIds[0];
  if (!targetPaneId) {
    window.wmux?.system?.openExternal?.(url);
    return;
  }

  const newPaneId = `pane-${uuid()}` as PaneId;
  const newTree = splitNode(ws.splitTree, targetPaneId, newPaneId, 'browser', 'horizontal');
  state.updateSplitTree(wsId, newTree);

  // Resolve the surfaceId of the newly created browser pane from the updated tree
  const newSurfaceId = findLeaf(newTree, newPaneId)?.surfaces[0]?.id;

  // Wait for React to mount the BrowserPane + webview dom-ready, then navigate
  // 600ms covers: React render (~16ms) + webview init (~200-500ms)
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('wmux:browser-navigate', { detail: { url, surfaceId: newSurfaceId } }));
  }, 600);
}
