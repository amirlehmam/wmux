import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { treeCacheKey } from '../../src/renderer/components/Explorer/explorer-state';

// ─────────────────────────────────────────────────────────────────────────────
// Hidden-file visibility is workspace state, not component state.
//
// It shipped in #210 as a `useState(false)` inside ExplorerPanel, which made it
// the one piece of panel state that did not survive a remount — the width and
// the expansion both persisted, so the toggle silently reverted on a pane
// switch or a session restore while everything beside it held.
//
// The restore path is the half that fails quietly: `replaceAllWorkspaces` names
// every field it carries, so a field it does not name is dropped with no error
// and no type complaint (its input is a Partial). That is #145 exactly, and it
// is why this is tested rather than eyeballed.
// ─────────────────────────────────────────────────────────────────────────────

function makeStore() {
  return create<WorkspaceSlice>()((...args) => ({ ...createWorkspaceSlice(...args) }));
}

describe('explorerShowHidden survives a restore', () => {
  it('is carried through replaceAllWorkspaces', () => {
    const store = makeStore();
    store.getState().replaceAllWorkspaces([
      { title: 'repo', shell: 'pwsh', cwd: 'C:\\repo', explorerShowHidden: true },
    ]);
    expect(store.getState().workspaces[0].explorerShowHidden).toBe(true);
  });

  it('stays undefined for a session saved before the field existed', () => {
    // Read as `!!workspace?.explorerShowHidden` in the panel, so absent means
    // hidden — the behaviour those sessions already had.
    const store = makeStore();
    store.getState().replaceAllWorkspaces([{ title: 'repo', shell: 'pwsh', cwd: 'C:\\repo' }]);
    expect(store.getState().workspaces[0].explorerShowHidden).toBeUndefined();
  });

  it('is per workspace, so one repo showing dotfiles does not drag the next one along', () => {
    const store = makeStore();
    store.getState().replaceAllWorkspaces([
      { title: 'a', shell: 'pwsh', explorerShowHidden: true },
      { title: 'b', shell: 'pwsh' },
    ]);
    const [a, b] = store.getState().workspaces;
    expect(a.explorerShowHidden).toBe(true);
    expect(b.explorerShowHidden).toBeUndefined();
  });

  it('the toggle writes it through updateWorkspaceMetadata', () => {
    const store = makeStore();
    store.getState().replaceAllWorkspaces([{ title: 'repo', shell: 'pwsh' }]);
    const id = store.getState().workspaces[0].id;
    store.getState().updateWorkspaceMetadata(id, { explorerShowHidden: true });
    expect(store.getState().workspaces[0].explorerShowHidden).toBe(true);
    store.getState().updateWorkspaceMetadata(id, { explorerShowHidden: false });
    expect(store.getState().workspaces[0].explorerShowHidden).toBe(false);
  });

  it('still keys the tree cache, so a toggle cannot serve a filtered tree unfiltered', () => {
    // The value moved out of useState; the cache identity it feeds did not.
    expect(treeCacheKey('C:\\repo', true)).not.toBe(treeCacheKey('C:\\repo', false));
  });
});
