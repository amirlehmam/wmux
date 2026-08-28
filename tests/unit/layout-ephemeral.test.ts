// SurfaceRef.ephemeral says "never persisted", and there are FOUR places a live
// split tree is captured: the two session mappers in App.tsx, and the two saved-
// layout mappers here. The session mappers were wrapped; these two were not.
//
// A saved layout is the worse leak of the two. instantiateLayout spreads every
// surface field through verbatim, so an explorer preview tab left in a layout is
// reborn — ephemeral flag, previewed file path and buffered content and all — in
// EVERY workspace created from it. Set that layout as the default and every new
// workspace opens with a phantom italic tab, which the next explorer click then
// recycles as if the user had put it there.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { instantiateLayout } from '../../src/renderer/store/split-utils';

function leafOf(tree: any): any {
  return tree.type === 'leaf' ? tree : leafOf(tree.children[0]);
}

function activeLeaf(ws: any): any {
  const workspace = useStore.getState().workspaces.find((w) => w.id === ws)!;
  return leafOf(workspace.splitTree);
}

/** A workspace whose pane carries one kept terminal plus one ephemeral preview. */
function setupWithPreview(dirty = false): { ws: any; pane: any } {
  const ws = useStore.getState().createWorkspace({ title: 'ws', shell: 'pwsh' });
  useStore.getState().selectWorkspace(ws);
  const pane = activeLeaf(ws).paneId;
  const surfaceId = useStore.getState().addSurface(ws, pane, 'markdown', { ephemeral: true })!;
  useStore.getState().setMarkdownContent(surfaceId, '# preview', {
    filePath: 'C:\\repo\\PREVIEW.md',
    fileName: 'PREVIEW.md',
    mtimeMs: 1,
  });
  if (dirty) useStore.getState().updateSurface(ws, pane, surfaceId, { markdownDirty: true });
  return { ws, pane };
}

function savedLayouts(): any[] {
  return (useStore.getState() as any).savedLayouts ?? [];
}

beforeEach(() => {
  for (const w of [...useStore.getState().workspaces]) useStore.getState().closeWorkspace(w.id);
  (useStore.getState() as any).setSavedLayouts?.([]);
});

describe('saveCurrentLayoutAsPreset', () => {
  it('does not persist an ephemeral preview tab into the layout', () => {
    const { ws } = setupWithPreview();
    // Sanity: it really is live on the workspace before the capture.
    expect(activeLeaf(ws).surfaces.some((s: any) => s.ephemeral)).toBe(true);

    const id = useStore.getState().saveCurrentLayoutAsPreset('with-preview');
    expect(id).toBeTruthy();

    const layout = savedLayouts().find((l) => l.id === id)!;
    const surfaces = leafOf(layout.splitTree).surfaces;
    expect(surfaces.some((s: any) => s.ephemeral)).toBe(false);
    // The buffered content of the previewed file must not ride along either.
    expect(surfaces.some((s: any) => s.markdownFilePath === 'C:\\repo\\PREVIEW.md')).toBe(false);
  });

  it('does not resurrect the preview in workspaces instantiated from the layout', () => {
    const { ws } = setupWithPreview();
    const id = useStore.getState().saveCurrentLayoutAsPreset('with-preview');
    const layout = savedLayouts().find((l) => l.id === id)!;

    const fresh = instantiateLayout(layout.splitTree);
    expect(leafOf(fresh).surfaces.some((s: any) => s.ephemeral)).toBe(false);
    expect(activeLeaf(ws).surfaces.some((s: any) => s.ephemeral)).toBe(true); // live one untouched
  });

  it('KEEPS a dirty preview, promoted — an unsaved edit is never discarded', () => {
    const { ws } = setupWithPreview(true);
    const id = useStore.getState().saveCurrentLayoutAsPreset('dirty-preview');
    const surfaces = leafOf(savedLayouts().find((l) => l.id === id)!.splitTree).surfaces;
    const md = surfaces.find((s: any) => s.type === 'markdown');
    expect(md).toBeTruthy();
    expect(md.ephemeral).toBeUndefined();
    expect(md.markdownDirty).toBe(true);
    expect(ws).toBeTruthy();
  });
});

describe('updateLayoutFromCurrent', () => {
  it('does not persist an ephemeral preview tab when overwriting a layout', () => {
    // A layout captured with no preview open...
    const ws = useStore.getState().createWorkspace({ title: 'clean', shell: 'pwsh' });
    useStore.getState().selectWorkspace(ws);
    const id = useStore.getState().saveCurrentLayoutAsPreset('base')!;

    // ...then a preview is opened, and the layout is updated from that state.
    const pane = activeLeaf(ws).paneId;
    useStore.getState().addSurface(ws, pane, 'markdown', { ephemeral: true });
    expect(activeLeaf(ws).surfaces.some((s: any) => s.ephemeral)).toBe(true);

    expect(useStore.getState().updateLayoutFromCurrent(id)).toBe(true);
    const surfaces = leafOf(savedLayouts().find((l) => l.id === id)!.splitTree).surfaces;
    expect(surfaces.some((s: any) => s.ephemeral)).toBe(false);
  });
});
