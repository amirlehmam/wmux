import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import type { PaneId, SplitNode, SurfaceId, SurfaceRef, WorkspaceInfo } from '../../src/shared/types';
import { getWorkspaceLabel } from '../../src/renderer/components/Sidebar/workspace-label';
import { getSurfaceLabel } from '../../src/renderer/components/SplitPane/surface-label';
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

  describe('with a detected agent', () => {
    const agents = (...ids: string[]) => (surfaceId: string) => ids.includes(surfaceId);

    it('prefers an agent pane over a titled shell earlier in tree order', () => {
      const shell = s();
      const claude = s();
      const ws: Labelled = { title: 'Workspace 1', titleIsDefault: true, splitTree: branch(leaf([shell]), leaf([claude])) };
      const oscTitleFor = titles({ [shell.id]: 'MINGW64:/c/repo', [claude.id]: 'Fix the login bug' });
      expect(getWorkspaceLabel(ws, oscTitleFor, agents(claude.id))).toBe('Fix the login bug');
    });

    it('falls back to tree order when no pane has an agent', () => {
      const shell = s();
      const other = s();
      const ws: Labelled = { title: 'Workspace 1', titleIsDefault: true, splitTree: branch(leaf([shell]), leaf([other])) };
      const oscTitleFor = titles({ [shell.id]: 'shell', [other.id]: 'other' });
      expect(getWorkspaceLabel(ws, oscTitleFor, agents())).toBe('shell');
    });

    it('takes the first agent pane in tree order when several have one', () => {
      const shell = s();
      const first = s();
      const second = s();
      const ws: Labelled = {
        title: 'Workspace 1',
        titleIsDefault: true,
        splitTree: branch(leaf([shell]), branch(leaf([first]), leaf([second]))),
      };
      const oscTitleFor = titles({ [shell.id]: 'shell', [first.id]: 'first', [second.id]: 'second' });
      expect(getWorkspaceLabel(ws, oscTitleFor, agents(first.id, second.id))).toBe('first');
    });

    it('skips an agent pane that has no title', () => {
      const shell = s();
      const silent = s();
      const ws: Labelled = { title: 'Workspace 1', titleIsDefault: true, splitTree: branch(leaf([shell]), leaf([silent])) };
      expect(getWorkspaceLabel(ws, titles({ [shell.id]: 'shell' }), agents(silent.id))).toBe('shell');
    });

    it('still skips a hidden tab, agent or not', () => {
      const hiddenAgent = s();
      const shown = s();
      const shell = s();
      const ws: Labelled = {
        title: 'Workspace 1',
        titleIsDefault: true,
        splitTree: branch(leaf([hiddenAgent, shown], 1), leaf([shell])),
      };
      const oscTitleFor = titles({ [hiddenAgent.id]: 'hidden', [shell.id]: 'shell' });
      expect(getWorkspaceLabel(ws, oscTitleFor, agents(hiddenAgent.id))).toBe('shell');
    });

    it('does not override a name somebody chose', () => {
      const claude = s();
      const ws: Labelled = { title: 'api work', titleIsDefault: false, splitTree: leaf([claude]) };
      expect(getWorkspaceLabel(ws, titles({ [claude.id]: 'x' }), agents(claude.id))).toBe('api work');
    });
  });
});

describe("getWorkspaceLabel — an agent's status glyph", () => {
  // Claude Code animates a glyph at the start of its title while it works, and
  // titles reach the store up to five times a second. A spinner frame must not
  // rename the workspace: every place that names it would re-render with it.
  it('names the workspace the same on every spinner frame', () => {
    const claude = s();
    const ws: Labelled = { title: 'Workspace 2', titleIsDefault: true, splitTree: leaf([claude]) };
    const frames = ['◐', '◑', '◒', '◓', '⠋', '⠙', '✳'].map((g) =>
      getWorkspaceLabel(ws, titles({ [claude.id]: `${g} Hello greeting reply` })));
    expect(new Set(frames)).toEqual(new Set(['Hello greeting reply']));
  });

  it('treats a pane titled with nothing but a glyph as untitled', () => {
    const shell = s();
    const claude = s();
    const lone: Labelled = { title: 'Workspace 2', titleIsDefault: true, splitTree: leaf([claude]) };
    expect(getWorkspaceLabel(lone, titles({ [claude.id]: '✳' }))).toBe('Workspace 2');
    const both: Labelled = { title: 'Workspace 2', titleIsDefault: true, splitTree: branch(leaf([claude]), leaf([shell])) };
    expect(getWorkspaceLabel(both, titles({ [claude.id]: '⠋', [shell.id]: 'pwsh' }))).toBe('pwsh');
  });

  it('leaves the tab its raw title', () => {
    // Guard: the glyph is the tab's live status, and only the workspace NAME drops it.
    expect(getSurfaceLabel(s(), undefined, undefined, undefined, '◐ Hello greeting reply')).toBe('◐ Hello greeting reply');
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
