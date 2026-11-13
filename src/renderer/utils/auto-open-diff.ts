/**
 * Where the "Auto-open diff tab on agent edits" setting puts its tab, if
 * anywhere (issues #63, #66, #141, #440).
 *
 * Kept out of App.tsx so the whole decision is testable without mounting the
 * app: App only feeds it the hook event's tool, the owning workspace and the two
 * user facts (the pref, and whether the user closed this workspace's diff tab).
 */
import type { PaneId, SplitNode, WorkspaceInfo } from '../../shared/types';
import { isFileEditTool } from '../../shared/agent-tools';
import { isPaneLocked, unlockedPaneIds } from '../store/pane-lock';

/** The bottom-most pane in the split tree (follows the last child of vertical splits). */
export function findBottomPane(node: SplitNode): PaneId {
  if (node.type === 'leaf') return node.paneId;
  if (node.direction === 'vertical') return findBottomPane(node.children[1]);
  return findBottomPane(node.children[0]);
}

function findLeaf(node: SplitNode, paneId: PaneId): (SplitNode & { type: 'leaf' }) | null {
  if (node.type === 'leaf') return node.paneId === paneId ? node : null;
  return findLeaf(node.children[0], paneId) || findLeaf(node.children[1], paneId);
}

export interface AutoOpenDiffContext {
  /** `workspacePrefs.autoOpenDiffTab`. */
  enabled: boolean;
  /** The user closed this workspace's diff tab and has not asked for one since (#141). */
  dismissed: boolean;
}

/**
 * The pane to add a diff tab to for one finished tool call, or null for none.
 *
 * The tool is matched with `isFileEditTool`, which accepts every agent's
 * spelling: pi reports `edit` / `write` in lower case, and a gate that only knew
 * Claude's `Edit` / `Write` never opened the tab for it (#440).
 */
export function autoOpenDiffPane(tool: unknown, ws: WorkspaceInfo, ctx: AutoOpenDiffContext): PaneId | null {
  if (!ctx.enabled || ctx.dismissed || !isFileEditTool(tool)) return null;
  const hasDiff = (id: PaneId) => findLeaf(ws.splitTree, id)?.surfaces.some((s) => s.type === 'diff') ?? false;
  const bottom = findBottomPane(ws.splitTree);
  // One diff tab per target pane: a second edit refreshes the one already open.
  if (!findLeaf(ws.splitTree, bottom) || hasDiff(bottom)) return null;
  if (!isPaneLocked(ws.splitTree, bottom)) return bottom;
  const fallback = unlockedPaneIds(ws.splitTree).at(-1);
  return fallback && !hasDiff(fallback) ? fallback : null;
}
