import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import type { PaneId, SplitNode, SurfaceId, SurfaceRef, WorkspaceInfo } from '../../src/shared/types';
import { getWorkspaceLabel } from '../../src/renderer/components/Sidebar/workspace-label';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { DEFAULT_TERMINAL_PREFS, DEFAULT_WORKSPACE_PREFS } from '../../src/renderer/store/settings-slice';

// ─────────────────────────────────────────────────────────────────────────────
// A workspace wmux named by default follows the window title its terminal's
// program sets, the way a tab has since #221. A name somebody chose never does.
// ─────────────────────────────────────────────────────────────────────────────

let n = 0;
function s(patch: Partial<SurfaceRef> = {}): SurfaceRef {
  return { id: `surf-${++n}` as SurfaceId, type: 'terminal', ...patch };
}
function leaf(surfaces: SurfaceRef[], activeSurfaceIndex = 0): SplitNode {
  return { type: 'leaf', paneId: `pane-${++n}` as PaneId, surfaces, activeSurfaceIndex };
}
function branch(a: SplitNode, b: SplitNode): SplitNode {
  return { type: 'branch', direction: 'horizontal', ratio: 0.5, children: [a, b] };
}
function titles(map: Record<string, string>): (surfaceId: string) => string | undefined {
  return (surfaceId) => map[surfaceId];
}
type Labelled = Pick<WorkspaceInfo, 'title' | 'titleIsDefault' | 'splitTree'>;

describe('getWorkspaceLabel', () => {
  it('shows the program\'s window title on a workspace wmux named', () => {
    const agent = s();
    const ws: Labelled = { title: 'Workspace 4', titleIsDefault: true, splitTree: leaf([agent]) };
    expect(getWorkspaceLabel(ws, titles({ [agent.id]: 'Fix the login bug' }))).toBe('Fix the login bug');
  });

  it('keeps a name somebody chose, whatever the program announces', () => {
    const agent = s();
    for (const titleIsDefault of [undefined, false]) {
      const ws: Labelled = { title: 'api work', titleIsDefault, splitTree: leaf([agent]) };
      expect(getWorkspaceLabel(ws, titles({ [agent.id]: 'Fix the login bug' }))).toBe('api work');
    }
  });

  it('keeps the default name while no terminal has set a title', () => {
    const ws: Labelled = { title: 'Workspace 4', titleIsDefault: true, splitTree: branch(leaf([s()]), leaf([s()])) };
    expect(getWorkspaceLabel(ws, titles({}))).toBe('Workspace 4');
  });

  it('takes the first titled pane in split-tree order', () => {
    const shell = s();
    const first = s();
    const second = s();
    const ws: Labelled = {
      title: 'Workspace 1',
      titleIsDefault: true,
      splitTree: branch(leaf([shell]), branch(leaf([first]), leaf([second]))),
    };
    expect(getWorkspaceLabel(ws, titles({ [first.id]: 'first', [second.id]: 'second' }))).toBe('first');
  });

  it('reads only the tab each pane is showing', () => {
    const hidden = s();
    const shown = s();
    const other = s();
    const ws: Labelled = {
      title: 'Workspace 1',
      titleIsDefault: true,
      splitTree: branch(leaf([hidden, shown], 1), leaf([other])),
    };
    expect(getWorkspaceLabel(ws, titles({ [hidden.id]: 'hidden', [other.id]: 'other' }))).toBe('other');
  });

  it('ignores a title arriving for a surface that is not a terminal', () => {
    const browser = s({ type: 'browser' });
    const ws: Labelled = { title: 'Workspace 1', titleIsDefault: true, splitTree: leaf([browser]) };
    expect(getWorkspaceLabel(ws, titles({ [browser.id]: 'confused' }))).toBe('Workspace 1');
  });
});

describe('titleIsDefault — which workspace names may follow the window title', () => {
  function store() {
    return create<WorkspaceSlice>()((...args) => ({
      ...createWorkspaceSlice(...args),
      workspacePrefs: DEFAULT_WORKSPACE_PREFS,
      savedLayouts: [{
        id: 'L1', name: 'dev', createdAt: 0,
        splitTree: { type: 'leaf', paneId: 'pane-a', activeSurfaceIndex: 0, surfaces: [{ id: 'surf-a', type: 'terminal' }] },
      }],
    }) as any);
  }
  const find = (st: ReturnType<typeof store>, id: string) => st.getState().workspaces.find((w) => w.id === id)!;

  it('marks a title wmux picked', () => {
    const st = store();
    expect(find(st, st.getState().createWorkspace()).titleIsDefault).toBe(true);
    expect(find(st, st.getState().createWorkspace({ cwd: 'C:\\src\\api' })).titleIsDefault).toBe(true);
    expect(find(st, st.getState().createWorkspaceFromLayout('L1')!).titleIsDefault).toBe(true);
  });

  it('does not mark a title the caller gave', () => {
    const st = store();
    expect(find(st, st.getState().createWorkspace({ title: 'X' })).titleIsDefault).toBeUndefined();
  });

  it('forgets the mark on a rename, from the sidebar or the pipe alike', () => {
    const st = store();
    const id = st.getState().createWorkspace();
    st.getState().renameWorkspace(id, 'mine');
    expect(find(st, id).title).toBe('mine');
    expect(find(st, id).titleIsDefault).toBeUndefined();
  });

  it('survives a restore, and a session saved before the mark keeps its names fixed', () => {
    const st = store();
    st.getState().replaceAllWorkspaces([
      { title: 'Workspace 1', titleIsDefault: true },
      { title: 'Workspace 2' },
      {},
    ]);
    expect(st.getState().workspaces.map((w) => w.titleIsDefault)).toEqual([true, undefined, true]);
  });
});

describe('the switch', () => {
  it('is on by default, like the tab label', () => {
    expect(DEFAULT_TERMINAL_PREFS.oscTitleWorkspaces).toBe(true);
  });
});
