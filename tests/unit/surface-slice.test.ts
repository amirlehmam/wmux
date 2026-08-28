import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createSurfaceSlice, isDiffTabDismissed, SurfaceSlice } from '../../src/renderer/store/surface-slice';
import { getAllPaneIds, splitNode } from '../../src/renderer/store/split-utils';
import { WorkspaceId, PaneId, SurfaceId, SplitNode } from '../../src/shared/types';

type TestStore = WorkspaceSlice & SurfaceSlice;

function makeStore() {
  return create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createSurfaceSlice(...args),
  }));
}

function leafOf(tree: SplitNode, paneId: PaneId) {
  if (tree.type === 'leaf') return tree.paneId === paneId ? tree : null;
  return leafOf(tree.children[0], paneId) ?? leafOf(tree.children[1], paneId);
}

describe('surface-slice', () => {
  let useStore: ReturnType<typeof makeStore>;
  let workspaceId: WorkspaceId;
  let paneId: PaneId;

  beforeEach(() => {
    useStore = makeStore();
    workspaceId = useStore.getState().createWorkspace({ title: 'Test WS' });
    const tree = useStore.getState().workspaces[0].splitTree;
    paneId = (tree as Extract<SplitNode, { type: 'leaf' }>).paneId;
  });

  function currentLeaf() {
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId)!;
    return leafOf(ws.splitTree, paneId)!;
  }

  describe('renameSurface', () => {
    it('sets customTitle on the target surface', () => {
      const id = currentLeaf().surfaces[0].id;
      useStore.getState().renameSurface(workspaceId, paneId, id, 'My Tab');
      expect(currentLeaf().surfaces[0].customTitle).toBe('My Tab');
    });

    it('clears customTitle when given an empty string', () => {
      const id = currentLeaf().surfaces[0].id;
      useStore.getState().renameSurface(workspaceId, paneId, id, 'X');
      useStore.getState().renameSurface(workspaceId, paneId, id, '');
      expect(currentLeaf().surfaces[0].customTitle).toBeUndefined();
    });
  });

  describe('closeOtherSurfaces', () => {
    it('keeps only the target surface and drops the rest', () => {
      const keep = currentLeaf().surfaces[0].id;
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      expect(currentLeaf().surfaces).toHaveLength(3);

      useStore.getState().closeOtherSurfaces(workspaceId, paneId, keep);

      const surfaces = currentLeaf().surfaces;
      expect(surfaces).toHaveLength(1);
      expect(surfaces[0].id).toBe(keep);
      expect(currentLeaf().activeSurfaceIndex).toBe(0);
    });

    it('is a no-op when the target is the only surface', () => {
      const only = currentLeaf().surfaces[0].id;
      useStore.getState().closeOtherSurfaces(workspaceId, paneId, only);
      expect(currentLeaf().surfaces).toHaveLength(1);
      expect(currentLeaf().surfaces[0].id).toBe(only);
    });

    it('does nothing when the target surface does not exist', () => {
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      expect(currentLeaf().surfaces).toHaveLength(2);
      useStore.getState().closeOtherSurfaces(workspaceId, paneId, 'surf-missing' as SurfaceId);
      expect(currentLeaf().surfaces).toHaveLength(2);
    });
  });

  describe('closeSurfacesToRight', () => {
    it('closes only the surfaces after the target', () => {
      const first = currentLeaf().surfaces[0].id;
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const second = currentLeaf().surfaces[1].id;
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      expect(currentLeaf().surfaces).toHaveLength(4);

      useStore.getState().closeSurfacesToRight(workspaceId, paneId, second);

      const ids = currentLeaf().surfaces.map((s) => s.id);
      expect(ids).toEqual([first, second]);
    });

    it('is a no-op when the target is the last surface', () => {
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const last = currentLeaf().surfaces[1].id;
      useStore.getState().closeSurfacesToRight(workspaceId, paneId, last);
      expect(currentLeaf().surfaces).toHaveLength(2);
    });

    it('clamps the active index to a surface that still exists', () => {
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const first = currentLeaf().surfaces[0].id;
      // active index is 2 (last added); closing to the right of the first drops it
      useStore.getState().closeSurfacesToRight(workspaceId, paneId, first);
      const leaf = currentLeaf();
      expect(leaf.surfaces).toHaveLength(1);
      expect(leaf.activeSurfaceIndex).toBe(0);
    });
  });

  // Issue #4 (continued): closing the pane/tab that reported a PR used to
  // leave its badge on the sidebar row forever. A killed PTY never runs a
  // shell-side exit trap, so `clear_pr` never arrives for a Ctrl+W or `wmux
  // close-pane` — the store has to notice the loss itself, at the same state
  // transition that already reaps the PTY (see pty-teardown.ts).
  describe('PR badge teardown on close', () => {
    function workspace() {
      return useStore.getState().workspaces.find((w) => w.id === workspaceId)!;
    }

    function reportPr(surfaceId: SurfaceId) {
      useStore.getState().updateWorkspaceMetadata(workspaceId, {
        prNumber: 42,
        prStatus: 'open',
        prLabel: 'Fix thing',
        prSurfaceId: surfaceId,
      });
    }

    it('closeSurface clears the badge when the closed surface is the one that reported it', () => {
      // Two tabs so this exercises closeSurface's own branch, not the
      // last-tab delegation to closePane.
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const owner = currentLeaf().surfaces[0].id;
      reportPr(owner);

      useStore.getState().closeSurface(workspaceId, paneId, owner);

      expect(workspace().prNumber).toBeUndefined();
      expect(workspace().prSurfaceId).toBeUndefined();
    });

    it('closeSurface leaves the badge alone when a different surface is closed', () => {
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const owner = currentLeaf().surfaces[0].id;
      const other = currentLeaf().surfaces[1].id;
      reportPr(owner);

      useStore.getState().closeSurface(workspaceId, paneId, other);

      expect(workspace().prNumber).toBe(42);
      expect(workspace().prSurfaceId).toBe(owner);
    });

    it('closePane clears the badge when the reporting surface lives in that pane', () => {
      // Two panes so the workspace survives the close and can be inspected.
      const secondPaneId = `pane-test-2` as PaneId;
      useStore.getState().updateSplitTree(
        workspaceId,
        splitNode(workspace().splitTree, paneId, secondPaneId, 'terminal', 'horizontal'),
      );
      const owner = currentLeaf().surfaces[0].id;
      reportPr(owner);

      useStore.getState().closePane(workspaceId, paneId);

      expect(getAllPaneIds(workspace().splitTree)).toEqual([secondPaneId]);
      expect(workspace().prNumber).toBeUndefined();
      expect(workspace().prSurfaceId).toBeUndefined();
    });

    it('closeOtherSurfaces clears the badge when the reporting surface is among the ones dropped', () => {
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const owner = currentLeaf().surfaces[0].id;
      const keep = currentLeaf().surfaces[1].id;
      reportPr(owner);

      useStore.getState().closeOtherSurfaces(workspaceId, paneId, keep);

      expect(workspace().prNumber).toBeUndefined();
      expect(workspace().prSurfaceId).toBeUndefined();
    });

    it('closeSurfacesToRight clears the badge when the reporting surface is among the ones dropped', () => {
      const first = currentLeaf().surfaces[0].id;
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const owner = currentLeaf().surfaces[1].id;
      reportPr(owner);

      useStore.getState().closeSurfacesToRight(workspaceId, paneId, first);

      expect(workspace().prNumber).toBeUndefined();
      expect(workspace().prSurfaceId).toBeUndefined();
    });

    it('closePane leaves the badge alone when the owner lives in a different pane', () => {
      const secondPaneId = `pane-test-2` as PaneId;
      useStore.getState().updateSplitTree(
        workspaceId,
        splitNode(workspace().splitTree, paneId, secondPaneId, 'terminal', 'horizontal'),
      );
      const owner = currentLeaf().surfaces[0].id;
      reportPr(owner);

      // Close the OTHER pane — the owner's pane is untouched.
      useStore.getState().closePane(workspaceId, secondPaneId);

      expect(workspace().prNumber).toBe(42);
      expect(workspace().prSurfaceId).toBe(owner);
    });

    it('closeOtherSurfaces leaves the badge alone when the owner is the tab being kept', () => {
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const owner = currentLeaf().surfaces[0].id;
      reportPr(owner);

      useStore.getState().closeOtherSurfaces(workspaceId, paneId, owner);

      expect(workspace().prNumber).toBe(42);
      expect(workspace().prSurfaceId).toBe(owner);
    });

    it('closeSurfacesToRight leaves the badge alone when the owner is left of the cut', () => {
      const owner = currentLeaf().surfaces[0].id;
      reportPr(owner);
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const second = currentLeaf().surfaces[1].id;

      // Cut after `second`, which is right of `owner` — owner is never dropped.
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      useStore.getState().closeSurfacesToRight(workspaceId, paneId, second);

      expect(workspace().prNumber).toBe(42);
      expect(workspace().prSurfaceId).toBe(owner);
    });

    it('moveSurface does NOT clear the badge — the surface still exists, just under a different pane', () => {
      const secondPaneId = `pane-test-2` as PaneId;
      useStore.getState().updateSplitTree(
        workspaceId,
        splitNode(workspace().splitTree, paneId, secondPaneId, 'terminal', 'horizontal'),
      );
      const owner = currentLeaf().surfaces[0].id;
      reportPr(owner);

      useStore.getState().moveSurface(workspaceId, paneId, owner, secondPaneId);

      expect(workspace().prNumber).toBe(42);
      expect(workspace().prSurfaceId).toBe(owner);
    });

    // The shell dying inside a still-open tab reaches none of the close
    // transitions above, so the renderer's `pty:exit` handler answers for it
    // through clearPrForSurface — which has only a surface id to go on.
    it('clearPrForSurface clears the badge owned by an exited surface, wherever it lives', () => {
      const owner = currentLeaf().surfaces[0].id;
      reportPr(owner);

      useStore.getState().clearPrForSurface(owner);

      expect(workspace().prNumber).toBeUndefined();
      expect(workspace().prSurfaceId).toBeUndefined();
    });

    it('clearPrForSurface leaves a badge belonging to another surface alone', () => {
      useStore.getState().addSurface(workspaceId, paneId, 'terminal');
      const owner = currentLeaf().surfaces[0].id;
      const other = currentLeaf().surfaces[1].id;
      reportPr(owner);

      useStore.getState().clearPrForSurface(other);

      expect(workspace().prNumber).toBe(42);
      expect(workspace().prSurfaceId).toBe(owner);
    });

    it('clearPrForSurface is a no-op when no workspace owns a badge at all', () => {
      const orphan = currentLeaf().surfaces[0].id;

      expect(() => useStore.getState().clearPrForSurface(orphan)).not.toThrow();
      expect(workspace().prNumber).toBeUndefined();
    });

    // The action above is only useful if the exit handler actually calls it,
    // and that handler lives inside a hook that needs a real xterm instance to
    // exercise. Reading the wiring back out of the source is the cheap half of
    // that: it cannot prove the handler runs, but it does catch the call being
    // dropped in a later edit, which would put the badge straight back to
    // outliving its shell.
    it('is wired into the pty:exit handler, alongside the other stuck-badge heals', () => {
      const hook = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'),
        'utf8',
      );
      const exitHandler = hook.slice(hook.indexOf('window.wmux.pty.onExit('));
      expect(exitHandler).toMatch(/clearPrForSurface\(id/);
    });
  });

  // Issue #141: closing the auto-opened diff tab used to last only until the
  // next Edit/Write hook fired, so it came back minutes later with no user
  // action — and on a large repo its git polling was what made typing lag.
  describe('diff tab dismissal', () => {
    it('is not dismissed before the user closes one', () => {
      expect(isDiffTabDismissed(workspaceId)).toBe(false);
    });

    it('records the dismissal when the diff tab is closed', () => {
      const id = useStore.getState().addSurface(workspaceId, paneId, 'diff', { auto: true })!;
      useStore.getState().closeSurface(workspaceId, paneId, id);
      expect(isDiffTabDismissed(workspaceId)).toBe(true);
    });

    it('records it when the diff tab is swept up by closeOtherSurfaces', () => {
      const keep = currentLeaf().surfaces[0].id;
      useStore.getState().addSurface(workspaceId, paneId, 'diff', { auto: true });
      useStore.getState().closeOtherSurfaces(workspaceId, paneId, keep);
      expect(isDiffTabDismissed(workspaceId)).toBe(true);
    });

    it('records it when the diff tab is swept up by closeSurfacesToRight', () => {
      const first = currentLeaf().surfaces[0].id;
      useStore.getState().addSurface(workspaceId, paneId, 'diff', { auto: true });
      useStore.getState().closeSurfacesToRight(workspaceId, paneId, first);
      expect(isDiffTabDismissed(workspaceId)).toBe(true);
    });

    it('stays dismissed when a later auto-open is attempted', () => {
      const id = useStore.getState().addSurface(workspaceId, paneId, 'diff', { auto: true })!;
      useStore.getState().closeSurface(workspaceId, paneId, id);
      useStore.getState().addSurface(workspaceId, paneId, 'diff', { auto: true });
      expect(isDiffTabDismissed(workspaceId)).toBe(true);
    });

    it('is retracted when the user asks for a diff tab explicitly', () => {
      const id = useStore.getState().addSurface(workspaceId, paneId, 'diff', { auto: true })!;
      useStore.getState().closeSurface(workspaceId, paneId, id);
      useStore.getState().addSurface(workspaceId, paneId, 'diff');
      expect(isDiffTabDismissed(workspaceId)).toBe(false);
    });

    it('does not leak across workspaces', () => {
      const other = useStore.getState().createWorkspace({ title: 'Other' });
      const id = useStore.getState().addSurface(workspaceId, paneId, 'diff', { auto: true })!;
      useStore.getState().closeSurface(workspaceId, paneId, id);
      expect(isDiffTabDismissed(other)).toBe(false);
    });

    it('does not track non-diff surfaces', () => {
      const id = useStore.getState().addSurface(workspaceId, paneId, 'terminal')!;
      useStore.getState().closeSurface(workspaceId, paneId, id);
      expect(isDiffTabDismissed(workspaceId)).toBe(false);
    });
  });

  describe('explorer preview tab (ephemeral)', () => {
    it('setMarkdownContent with dirty:true promotes an ephemeral surface (real markdownContentPatch path)', () => {
      // Through addSurface, not a hand-built object — matches how open-preview.ts creates it.
      const id = useStore.getState().addSurface(workspaceId, paneId, 'markdown', { ephemeral: true })!;
      expect(currentLeaf().surfaces.find((s) => s.id === id)!.ephemeral).toBe(true);

      // The real path: setMarkdownContent → markdownContentPatch, not a direct
      // updateSurface patch. This is what an editor keystroke or an agent's
      // `markdown.set_content` actually calls.
      useStore.getState().setMarkdownContent(id, 'edited content', { dirty: true });

      expect(currentLeaf().surfaces.find((s) => s.id === id)!.ephemeral).toBeFalsy();
    });

    it('does not put a closed ephemeral surface back on the reopen stack (Ctrl+Shift+T)', () => {
      // The reopen stack is LIFO, so if the preview tab's close were pushed
      // like any other, it would come back FIRST — ahead of the terminal
      // closed earlier. Deterministic proof the skip fired: after closing
      // both, Ctrl+Shift+T must restore the terminal, not the preview.
      const terminalId = useStore.getState().addSurface(workspaceId, paneId, 'terminal')!;
      useStore.getState().closeSurface(workspaceId, paneId, terminalId);

      const previewId = useStore.getState().addSurface(workspaceId, paneId, 'markdown', { ephemeral: true })!;
      useStore.getState().closeSurface(workspaceId, paneId, previewId);

      const reopened = useStore.getState().reopenClosedSurface(workspaceId, paneId);
      expect(reopened).not.toBeNull();
      const restored = currentLeaf().surfaces.find((s) => s.id === reopened)!;
      expect(restored.type).toBe('terminal');
    });
  });
});
