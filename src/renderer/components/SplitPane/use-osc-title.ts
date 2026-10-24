import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { WorkspaceId, WorkspaceInfo } from '../../../shared/types';
import { useStore, type WmuxStore } from '../../store';
import { getWorkspaceLabel, hasAgentLookup } from '../Sidebar/workspace-label';

/**
 * Read a surface's program-set window title, for the tab label (issue #221).
 *
 * One hook rather than the same two selectors inlined in the tab bar and the
 * split-drag preview: the PREF GATE has to be identical in both, and a preview
 * that labelled a pane differently from the tab it is previewing is exactly the
 * kind of drift that is invisible until someone drags a tab.
 *
 * Returns undefined — not '' — when the feature is off or nothing has set a
 * title, because that is what `getSurfaceLabel` treats as "fall through".
 */
export function useOscTitleLookup(): (surfaceId: string) => string | undefined {
  const enabled = useStore((state) => state.terminalPrefs.oscTitleTabs);
  const oscTitles = useStore((state) => state.oscTitles);
  return (surfaceId: string) => (enabled ? oscTitles[surfaceId]?.title : undefined);
}

type LabelledWorkspace = Pick<WorkspaceInfo, 'title' | 'titleIsDefault' | 'splitTree'>;
/** The store fields a workspace's label is derived from. */
type LabelState = Pick<WmuxStore, 'terminalPrefs' | 'oscTitles' | 'agentIdentities' | 'agentStates'>;

/**
 * The one rule for what a workspace is CALLED, wherever the UI names it: the
 * sidebar, the command palette, a notification, the titlebar. Every reader goes
 * through here so the same workspace cannot be "Fix login bug" in one place and
 * "Workspace 3" in another (#343). Gated by its own pref, `oscTitleWorkspaces`,
 * so the tabs can follow the title while workspace names keep their stored ones.
 * A chosen name is answered first, so it never reads the prefs. A pane with an
 * agent (`hasAgentLookup`: an identity, or a session its hooks reported) is
 * preferred over an earlier shell pane, so an agent session's own title is not
 * hidden behind the shell's.
 *
 * Display only: the CLI's answers (`list-workspaces`, `current-workspace`) keep
 * the stored `title`. The phone's remote roster is a display, and gets this.
 */
export function selectWorkspaceLabel(
  state: LabelState,
  workspace: LabelledWorkspace,
): string {
  if (!workspace.titleIsDefault || !state.terminalPrefs.oscTitleWorkspaces) return workspace.title;
  return getWorkspaceLabel(
    workspace,
    (surfaceId) => state.oscTitles[surfaceId]?.title,
    hasAgentLookup(state),
  );
}

/**
 * Labels for a list of workspaces, by id, from one store snapshot: what
 * `useWorkspaceLabels` answers, for a caller outside React (the remote roster).
 */
export function selectWorkspaceLabels(
  state: LabelState,
  workspaces: readonly WorkspaceInfo[],
): Map<WorkspaceId, string> {
  return new Map(workspaces.map((ws) => [ws.id, selectWorkspaceLabel(state, ws)]));
}

/** The label right now, for callbacks and modules that are not components. */
export function getStoredWorkspaceLabel(workspace: LabelledWorkspace): string {
  return selectWorkspaceLabel(useStore.getState(), workspace);
}

/**
 * A workspace's label, kept current. Selects the finished STRING rather than
 * the title map, so a row re-renders only when its own name changes, not on
 * every title any pane in any workspace emits.
 */
export function useWorkspaceLabel(workspace: LabelledWorkspace): string {
  return useStore((state) => selectWorkspaceLabel(state, workspace));
}

/**
 * Labels for a list of workspaces, by id, for a component that names several
 * (command palette, notification panel). Selects strings and compares them
 * shallowly, so the map is rebuilt — and the caller re-rendered — only when some
 * name actually changes. An agent's spinner frame does not change one
 * (`stripStatusGlyph`), which is what makes this cheap enough for the App root.
 */
export function useWorkspaceLabels(workspaces: readonly WorkspaceInfo[]): ReadonlyMap<WorkspaceId, string> {
  const labels = useStore(useShallow((state) => workspaces.map((ws) => selectWorkspaceLabel(state, ws))));
  return useMemo(() => new Map(workspaces.map((ws, i) => [ws.id, labels[i]])), [workspaces, labels]);
}
