import { afterEach, describe, expect, it } from 'vitest';
import type { PaneId, SplitNode, SurfaceId, WorkspaceInfo } from '../../src/shared/types';
import { useStore } from '../../src/renderer/store';
import {
  getStoredWorkspaceLabel,
  selectWorkspaceLabel,
} from '../../src/renderer/components/SplitPane/use-osc-title';

// ─────────────────────────────────────────────────────────────────────────────
// Every place that names a workspace asks the store for the same label the
// sidebar shows (#343). getWorkspaceLabel has its own tests; these pin the
// store-facing half the non-React call sites share: the pref gate and the
// title map are read from the one place.
// ─────────────────────────────────────────────────────────────────────────────

type Labelled = Pick<WorkspaceInfo, 'title' | 'titleIsDefault' | 'splitTree'>;

const surfaceId = 'surf-label' as SurfaceId;
const tree: SplitNode = {
  type: 'leaf',
  paneId: 'pane-label' as PaneId,
  activeSurfaceIndex: 0,
  surfaces: [{ id: surfaceId, type: 'terminal' }],
};
const named: Labelled = { title: 'Workspace 3', titleIsDefault: true, splitTree: tree };

function announce(title: string, oscTitleWorkspaces = true): void {
  useStore.setState((state) => ({
    terminalPrefs: { ...state.terminalPrefs, oscTitleWorkspaces },
    oscTitles: { [surfaceId]: { title, at: 0 } },
  }));
}

describe('workspace label from the store', () => {
  const before = useStore.getState();
  afterEach(() => useStore.setState({ terminalPrefs: before.terminalPrefs, oscTitles: before.oscTitles }));

  it('gives the window title a workspace wmux named, to a caller outside React', () => {
    announce('Fix login bug');
    expect(getStoredWorkspaceLabel(named)).toBe('Fix login bug');
    expect(selectWorkspaceLabel(useStore.getState(), named)).toBe('Fix login bug');
  });

  it('keeps the stored name when the sidebar pref is off', () => {
    announce('Fix login bug', false);
    expect(getStoredWorkspaceLabel(named)).toBe('Workspace 3');
  });

  it('keeps a name somebody chose', () => {
    announce('Fix login bug');
    expect(getStoredWorkspaceLabel({ ...named, titleIsDefault: undefined })).toBe('Workspace 3');
  });
});
