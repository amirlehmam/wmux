import type { WorkspaceInfo } from '../../../shared/types';
import { useStore } from '../../store';
import { getWorkspaceLabel } from '../Sidebar/workspace-label';

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

/**
 * A workspace's sidebar name: its stored title, or — while wmux picked that
 * title — the window title its terminal's program sets. Gated by its own pref,
 * `oscTitleWorkspaces`, so the tabs can follow the title while the sidebar keeps
 * its names.
 *
 * Selects the finished STRING rather than the title map, so a row re-renders
 * only when its own name changes, not on every title any pane in any workspace
 * emits.
 */
export function useWorkspaceLabel(workspace: Pick<WorkspaceInfo, 'title' | 'titleIsDefault' | 'splitTree'>): string {
  return useStore((state) => getWorkspaceLabel(
    workspace,
    (surfaceId) => (state.terminalPrefs.oscTitleWorkspaces ? state.oscTitles[surfaceId]?.title : undefined),
  ));
}
