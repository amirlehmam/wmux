import type { SplitNode, WorkspaceInfo } from '../../../shared/types';

/**
 * The window title a workspace's terminals announce, for its sidebar name: the
 * first pane in split-tree order whose SHOWN tab is a terminal with a title.
 *
 * Tree order rather than the focused pane: focus is App-local state that only
 * exists for the active workspace, and a name that changed every time the user
 * clicked between panes would be harder to find in the sidebar, not easier.
 * Hidden tabs are skipped for the same reason the tab bar shows only one per pane.
 */
function firstTerminalTitle(
  node: SplitNode,
  oscTitleFor: (surfaceId: string) => string | undefined,
): string | undefined {
  if (node.type === 'branch') {
    return firstTerminalTitle(node.children[0], oscTitleFor) ?? firstTerminalTitle(node.children[1], oscTitleFor);
  }
  const surface = node.surfaces[node.activeSurfaceIndex];
  // Only a terminal has a program that can set a title; see getSurfaceLabel.
  return surface?.type === 'terminal' ? oscTitleFor(surface.id) : undefined;
}

/**
 * What the sidebar calls a workspace. A name somebody chose always wins; a name
 * wmux picked gives way to the window title the workspace's program sets, the
 * same rank the tab label gives it (#221).
 *
 * @param oscTitleFor Returns undefined when the feature is off or the surface
 *   has no title, which is what makes this fall through to the stored name.
 */
export function getWorkspaceLabel(
  workspace: Pick<WorkspaceInfo, 'title' | 'titleIsDefault' | 'splitTree'>,
  oscTitleFor: (surfaceId: string) => string | undefined,
): string {
  if (!workspace.titleIsDefault) return workspace.title;
  return firstTerminalTitle(workspace.splitTree, oscTitleFor) ?? workspace.title;
}
