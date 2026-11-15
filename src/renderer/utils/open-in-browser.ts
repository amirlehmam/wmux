import { useStore } from '../store';
import { splitNode, getAllPaneIds } from '../store/split-utils';
import { unlockedPaneIds } from '../store/pane-lock';
import { PaneId, SplitNode, SurfaceRef, WorkspaceId } from '../../shared/types';
import { v4 as uuid } from 'uuid';

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
  const split = splitNode(ws.splitTree, targetPaneId, newPaneId, 'browser', 'horizontal');
  // Mount the pane ON the target, rather than racing a navigate event at it.
  //
  // This used to split first and then dispatch `wmux:browser-navigate` after a
  // 600 ms timer, on the reasoning that React render (~16 ms) plus webview init
  // (~200-500 ms) would be done by then. A timer tuned to an observation is not
  // a guarantee: on a loaded machine, or when the listener had not attached yet,
  // the navigate landed on nothing and the pane was left showing BrowserPane's
  // default page — which is how a browser tab the user never asked for appeared
  // on wmux's own GitHub repo (#232). Handing the surface its url up front
  // removes the window entirely; there is nothing left to be late for.
  state.updateSplitTree(wsId, withLeafSurfaceUrl(split, newPaneId, url));
}

/**
 * Return `tree` with the sole surface of `paneId` carrying `url`.
 *
 * Immutable, like every other split-tree mutation (see split-utils.ts) — the
 * renderer re-renders off object identity, so patching a leaf in place gives a
 * pane whose props never update.
 */
export function withLeafSurfaceUrl(tree: SplitNode, paneId: PaneId, url: string): SplitNode {
  if (tree.type === 'leaf') {
    if (tree.paneId !== paneId) return tree;
    return { ...tree, surfaces: tree.surfaces.map((s, i) => (i === 0 ? { ...s, url } : s)) };
  }
  const [left, right] = tree.children;
  const newLeft = withLeafSurfaceUrl(left, paneId, url);
  const newRight = withLeafSurfaceUrl(right, paneId, url);
  if (newLeft === left && newRight === right) return tree;
  return { ...tree, children: [newLeft, newRight] };
}

/**
 * The pane a new browser tab goes into when the caller has none of its own —
 * the workspace's side panel has no tab bar (#439). The first pane already
 * holding a browser tab, so links collect beside each other; else the first
 * pane. Locked panes never qualify. Null when no pane does.
 */
export function newBrowserTabPane(tree: SplitNode): PaneId | null {
  const unlocked = new Set(unlockedPaneIds(tree));
  const leaves: Extract<SplitNode, { type: 'leaf' }>[] = [];
  const walk = (node: SplitNode): void => {
    if (node.type === 'leaf') {
      if (unlocked.has(node.paneId)) leaves.push(node);
    } else { walk(node.children[0]); walk(node.children[1]); }
  };
  walk(tree);
  const withBrowser = leaves.find((leaf) => leaf.surfaces.some((s) => s.type === 'browser'));
  return (withBrowser ?? leaves[0])?.paneId ?? null;
}

/**
 * "Open link in new tab" from a browser that is not itself a tab (the side
 * panel, #439): a new browser tab in the active workspace, never a navigation
 * of an existing one. False when there is nowhere to put it.
 */
export function openInNewBrowserTab(url: string): boolean {
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return false;
  const paneId = newBrowserTabPane(ws.splitTree);
  if (!paneId) return false;
  return state.addSurface(ws.id, paneId, 'browser', { url }) !== null;
}
