import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, type WorkspaceSlice } from '../../src/renderer/store/workspace-slice';

function makeStore(openOnStartup: boolean) {
  return create<WorkspaceSlice & { browserPrefs: { openOnStartup: boolean } }>()((...args) => ({
    ...createWorkspaceSlice(...args),
    browserPrefs: { openOnStartup },
  }));
}

describe('workspace-local browser panel visibility', () => {
  it.each([true, false])('uses openOnStartup=%s for new and legacy workspaces', (openOnStartup) => {
    const store = makeStore(openOnStartup);
    store.getState().createWorkspace();
    expect(store.getState().workspaces[0].browserOpen).toBe(openOnStartup);

    store.getState().replaceAllWorkspaces([{ title: 'Legacy session' }]);
    expect(store.getState().workspaces[0].browserOpen).toBe(openOnStartup);
  });

  it('does not carry a visibility change into another workspace or a new one', () => {
    const store = makeStore(true);
    const first = store.getState().createWorkspace();
    const second = store.getState().createWorkspace();
    store.getState().updateWorkspaceMetadata(first, { browserOpen: false });

    store.getState().selectWorkspace(second);
    expect(store.getState().workspaces.find((ws) => ws.id === second)?.browserOpen).toBe(true);
    store.getState().selectWorkspace(first);
    expect(store.getState().workspaces.find((ws) => ws.id === first)?.browserOpen).toBe(false);

    const third = store.getState().createWorkspace();
    expect(store.getState().workspaces.find((ws) => ws.id === third)?.browserOpen).toBe(true);
  });

  it('restores explicit open and closed states instead of applying the startup preference', () => {
    const store = makeStore(true);
    store.getState().createWorkspace({ browserOpen: false });
    expect(store.getState().workspaces[0].browserOpen).toBe(false);

    const saved = JSON.parse(JSON.stringify([
      { title: 'Closed', browserOpen: false },
      { title: 'Open', browserOpen: true },
    ]));
    store.getState().replaceAllWorkspaces(saved);
    expect(store.getState().workspaces.map((ws) => ws.browserOpen)).toEqual([false, true]);

    store.setState({ browserPrefs: { openOnStartup: false } });
    store.getState().replaceAllWorkspaces(saved);
    expect(store.getState().workspaces.map((ws) => ws.browserOpen)).toEqual([false, true]);
  });
});
