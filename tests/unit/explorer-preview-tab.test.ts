import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { openInPreviewTab } from '../../src/renderer/components/Explorer/open-preview';
import { splitNode } from '../../src/renderer/store/split-utils';

// `readFile` is the JAILED markdown read (explorer.readMarkdown) — the one the
// tree uses and the one that mints a save grant. The unjailed
// `markdown.readFile` is still mocked beside it so a test can assert the tree
// never calls it.
const readFile = vi.fn();
(globalThis as any).window = (globalThis as any).window ?? {};
const readCode = vi.fn();
const readMarkdownUnjailed = vi.fn();
(window as any).wmux = {
  markdown: { readFile: readMarkdownUnjailed },
  explorer: { readMarkdown: readFile },
  code: { readFile: readCode },
};

function setup(): { ws: any; pane: any } {
  const ws = useStore.getState().createWorkspace({ title: 'ws', shell: 'pwsh' });
  const workspace = useStore.getState().workspaces.find((w) => w.id === ws)!;
  const pane = (workspace.splitTree as any).paneId;
  useStore.getState().setFocusedPane?.(pane);
  return { ws, pane };
}

function surfacesOf(ws: any): any[] {
  const workspace = useStore.getState().workspaces.find((w) => w.id === ws)!;
  return (workspace.splitTree as any).surfaces ?? [];
}

/** Both jailed reads are addressed by (surfaceId, relPath); every fixture file
 *  in this suite is flat under C:\repo\, so this is the whole mapping. */
const abs = (relPath: string): string => `C:\\repo\\${relPath}`;

beforeEach(() => {
  readFile.mockReset();
  readMarkdownUnjailed.mockReset();
  readFile.mockImplementation(async (_surfaceId: string, relPath: string) => ({
    filePath: abs(relPath), content: `# ${abs(relPath)}`, mtimeMs: 1,
  }));
  readCode.mockReset();
  readCode.mockImplementation(async (_surfaceId: string, relPath: string) => ({
    filePath: `C:\\repo\\${relPath}`, content: 'export {}', mtimeMs: 1,
  }));
});

describe('openInPreviewTab', () => {
  it('creates one ephemeral markdown tab on the first click', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    expect(md[0].ephemeral).toBe(true);
    expect(md[0].markdownFilePath).toBe('C:\\repo\\a.md');
    expect(md[0].markdownFileName).toBe('a.md');
  });

  it('REUSES the preview tab for a second file instead of stacking tabs', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    await openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' });
    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    expect(md[0].markdownFilePath).toBe('C:\\repo\\b.md');
    // fileName must be passed through, or the tab keeps the previous label.
    expect(md[0].markdownFileName).toBe('b.md');
  });

  it('focuses an already-open tab for the same path rather than reloading it', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: true, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    readFile.mockClear();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    expect(readFile).not.toHaveBeenCalled();
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(1);
  });

  it('PROMOTES a dirty preview instead of discarding the edit', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    const first = surfacesOf(ws).find((s) => s.type === 'markdown')!;
    useStore.getState().updateSurface(ws, pane, first.id, { markdownDirty: true, markdownContent: 'edited' });

    await openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' });
    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(2);
    const promoted = md.find((s) => s.id === first.id)!;
    expect(promoted.ephemeral).toBeUndefined();
    expect(promoted.markdownContent).toBe('edited');
    expect(md.find((s) => s.id !== first.id)!.ephemeral).toBe(true);
  });

  it('a keep:true open clears ephemeral so the next click opens a fresh preview', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: true, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    expect(surfacesOf(ws).find((s) => s.type === 'markdown')!.ephemeral).toBeUndefined();
    await openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(2);
  });

  it('does nothing when the read fails, leaving no empty tab behind', async () => {
    const { ws, pane } = setup();
    readFile.mockResolvedValueOnce({ error: 'File not found', code: 'not_found' });
    await openInPreviewTab(ws, pane, 'C:\\repo\\gone.md', 'gone.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'gone.md' });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(0);
  });

  it('falls back to the first leaf pane when the target pane is gone', async () => {
    const { ws } = setup();
    await openInPreviewTab(ws, 'pane-does-not-exist' as any, 'C:\\repo\\a.md', 'a.md', {
      keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md',
    });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(1);
  });

  it('two rapid opens with no existing preview create exactly ONE ephemeral surface', async () => {
    const { ws, pane } = setup();
    // Neither await lands before the second call starts — this is the race:
    // with no preview open yet, both calls could pass the "find a reusable
    // preview" check before either has created one.
    const p1 = openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    const p2 = openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' });
    await Promise.all([p1, p2]);

    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    // The later click wins the final label/content.
    expect(md[0].markdownFilePath).toBe('C:\\repo\\b.md');
  });

  it('a slow first read does not overwrite a faster/newer second one', async () => {
    const { ws, pane } = setup();
    // Get a preview tab open first so both calls below hit the "reuse the
    // existing preview" path, where the described race is a stale WRITE
    // rather than a duplicate tab.
    await openInPreviewTab(ws, pane, 'C:\\repo\\first.md', 'first.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'first.md' });

    let resolveA!: (value: { filePath: string; content: string; mtimeMs: number }) => void;
    readFile.mockReset();
    readFile.mockImplementation(async (_surfaceId: string, relPath: string) => {
      if (relPath === 'a.md') {
        return new Promise((resolve) => { resolveA = resolve; });
      }
      return { filePath: abs(relPath), content: `# ${abs(relPath)}`, mtimeMs: 1 };
    });

    const p1 = openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' }); // slow
    const p2 = openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' }); // fast, clicked after
    // Let the slow first read land only now — after both opens are in flight.
    resolveA({ filePath: 'C:\\repo\\a.md', content: '# a', mtimeMs: 1 });
    await Promise.all([p1, p2]);

    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    // The later-CLICKED file must win, regardless of which read landed first.
    expect(md[0].markdownFilePath).toBe('C:\\repo\\b.md');
  });
});

// ─── Failure reporting ───────────────────────────────────────────────────────
// A bare `if (!read || 'error' in read) return;` is what made the Git Bash
// absolute-path bug invisible: every click was a no-op with no message. It also
// hides the ordinary case of clicking a file that was deleted out from under
// the tree. The failure is now returned as an explorer error CODE — never the
// sibling `error` string, which stays English for main-process callers.
describe('openInPreviewTab failure reporting', () => {
  it('returns null on success', async () => {
    const { ws, pane } = setup();
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' }))
      .resolves.toBeNull();
  });

  it('maps a not_found read onto the explorer code of the same name', async () => {
    const { ws, pane } = setup();
    readFile.mockResolvedValue({ error: 'File not found', code: 'not_found' });
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\gone.md', 'gone.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'gone.md' }))
      .resolves.toBe('not_found');
  });

  it('maps the markdown-only codes onto invalid_path', async () => {
    const { ws, pane } = setup();
    for (const code of ['no_path', 'unsupported_type', 'symlink', 'not_regular_file']) {
      readFile.mockResolvedValue({ error: 'nope', code });
      await expect(openInPreviewTab(ws, pane, 'C:\\repo\\x.md', 'x.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'x.md' }))
        .resolves.toBe('invalid_path');
    }
  });

  it('falls back to read_failed for an unknown or absent code', async () => {
    const { ws, pane } = setup();
    readFile.mockResolvedValue({ error: 'boom', code: 'something_new' });
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\x.md', 'x.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'x.md' }))
      .resolves.toBe('read_failed');
    readFile.mockResolvedValue(undefined);
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\y.md', 'y.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'y.md' }))
      .resolves.toBe('read_failed');
  });

  it('leaves no empty tab behind when the read fails', async () => {
    const { ws, pane } = setup();
    readFile.mockResolvedValue({ error: 'File not found', code: 'not_found' });
    await openInPreviewTab(ws, pane, 'C:\\repo\\gone.md', 'gone.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'gone.md' });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(0);
  });

  it('reports NOTHING for an open a newer click superseded', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\first.md', 'first.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'first.md' });

    let resolveA!: (value: any) => void;
    readFile.mockReset();
    readFile.mockImplementation(async (_surfaceId: string, relPath: string) => {
      if (relPath === 'a.md') return new Promise((r) => { resolveA = r; });
      return { filePath: abs(relPath), content: '# b', mtimeMs: 1 };
    });
    const p1 = openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    const p2 = openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' });
    resolveA({ filePath: 'C:\\repo\\a.md', content: '# a', mtimeMs: 1 });
    // Superseded is not a failure — flashing an error for a file the user has
    // already navigated away from would be noise.
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
  });

  it('does not wedge later opens behind a rejected one', async () => {
    const { ws, pane } = setup();
    readFile.mockRejectedValueOnce(new Error('ipc blew up'));
    const bad = openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    await expect(bad).rejects.toThrow('ipc blew up');
    // The next open must still run rather than inheriting the rejection.
    readFile.mockImplementation(async (_surfaceId: string, relPath: string) => ({
      filePath: abs(relPath), content: '# ok', mtimeMs: 1,
    }));
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' }))
      .resolves.toBeNull();
    expect(surfacesOf(ws).some((s) => s.markdownFilePath === 'C:\\repo\\b.md')).toBe(true);
  });
});

describe('openInPreviewTab — code files', () => {
  const codeOpts = { keep: false, surfaceId: 'surf-1' as any, relPath: 'index.ts' };

  it('creates a code surface for a non-markdown file', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts);
    const code = surfacesOf(ws).filter((s) => s.type === 'code');
    expect(code).toHaveLength(1);
    expect(code[0].ephemeral).toBe(true);
    expect(code[0].codeFilePath).toBe('C:\\repo\\index.ts');
    expect(code[0].codeFileName).toBe('index.ts');
    expect(code[0].codeRelPath).toBe('index.ts');
    expect(code[0].codeContent).toBe('export {}');
  });

  it('still creates a markdown surface for a .md file', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(1);
    expect(surfacesOf(ws).filter((s) => s.type === 'code')).toHaveLength(0);
  });

  it('RECYCLES a markdown preview into a code preview — one tab, not two', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts);
    const previews = surfacesOf(ws).filter((s) => s.type === 'markdown' || s.type === 'code');
    expect(previews).toHaveLength(1);
    expect(previews[0].type).toBe('code');
  });

  it('RECYCLES a code preview back into a markdown preview', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts);
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    const previews = surfacesOf(ws).filter((s) => s.type === 'markdown' || s.type === 'code');
    expect(previews).toHaveLength(1);
    expect(previews[0].type).toBe('markdown');
  });

  it('promotes a DIRTY markdown preview rather than recycling it for a code file', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    const md = surfacesOf(ws).find((s) => s.type === 'markdown')!;
    const wsObj = useStore.getState().workspaces.find((w) => w.id === ws)!;
    const paneId = (wsObj.splitTree as any).paneId;
    useStore.getState().updateSurface(ws, paneId, md.id, { markdownDirty: true });
    await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts);
    const kept = surfacesOf(ws).find((s) => s.type === 'markdown')!;
    expect(kept.ephemeral).toBeUndefined();      // promoted, buffer intact
    expect(surfacesOf(ws).filter((s) => s.type === 'code')).toHaveLength(1);
  });

  it('does NOT destroy the existing preview when the code read fails', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    readCode.mockResolvedValueOnce({ error: 'Not a text file', code: 'binary' });
    const failure = await openInPreviewTab(ws, pane, 'C:\\repo\\logo.png', 'logo.png', {
      keep: false, surfaceId: 'surf-1' as any, relPath: 'logo.png',
    });
    expect(failure).toBe('binary');
    const previews = surfacesOf(ws).filter((s) => s.type === 'markdown' || s.type === 'code');
    expect(previews).toHaveLength(1);
    expect(previews[0].type).toBe('markdown');   // untouched
  });

  it('returns invalid_path when a code file is opened with no relPath', async () => {
    const { ws, pane } = setup();
    // surfaceId present, relPath absent — main addresses a jailed read by BOTH,
    // so half the addressing is still no addressing.
    const failure = await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', {
      keep: false, surfaceId: 'surf-term' as any,
    });
    expect(failure).toBe('invalid_path');
  });

  it('still makes ONE tab from two clicks in the same tick, across a type change', async () => {
    const { ws, pane } = setup();
    await Promise.all([
      openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' }),
      openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts),
    ]);
    const previews = surfacesOf(ws).filter((s) => s.type === 'markdown' || s.type === 'code');
    expect(previews).toHaveLength(1);
  });
});

// ─── Regressions found in review ─────────────────────────────────────────────

describe('openInPreviewTab — the root surface a code tab reloads from', () => {
  it('records codeRootSurfaceId, without which a restored tab cannot re-read', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', {
      keep: true, surfaceId: 'surf-term' as any, relPath: 'index.ts',
    });
    const code = surfacesOf(ws).find((s) => s.type === 'code')!;
    // The TERMINAL's id, never the code surface's own — main only reads for a
    // live, owned terminal, so its own id would answer no_root forever.
    expect(code.codeRootSurfaceId).toBe('surf-term');
    expect(code.codeRootSurfaceId).not.toBe(code.id);
  });
});

describe('openInPreviewTab — the staleness guard is per pane', () => {
  it('does not let an open in one pane cancel an in-flight open in another', async () => {
    const { ws, pane } = setup();
    // Two panes, two independent preview tabs. A single module-level seq made
    // the slower pane's open return null — reported as SUCCESS — and leave its
    // preview showing the previous file.
    const wsObj = () => useStore.getState().workspaces.find((w) => w.id === ws)!;
    useStore.getState().updateSplitTree(
      ws, splitNode(wsObj().splitTree, pane, 'pane-second' as any, 'terminal', 'horizontal'),
    );
    const tree: any = wsObj().splitTree;
    const paneA = tree.children[0].paneId;
    const paneB = tree.children[1].paneId;

    let releaseA!: () => void;
    readFile.mockImplementation(async (_surfaceId: string, relPath: string) => {
      if (relPath.endsWith('a.md')) await new Promise<void>((r) => { releaseA = r; });
      return { filePath: abs(relPath), content: `# ${abs(relPath)}`, mtimeMs: 1 };
    });

    const slowA = openInPreviewTab(ws, paneA, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    await openInPreviewTab(ws, paneB, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' });
    releaseA();

    // null is SUCCESS here (PreviewOpenFailure), and the surface below is what
    // separates a real success from the bug's silent "superseded" null.
    expect(await slowA).toBeNull();
    const leafA = (wsObj().splitTree as any).children[0];
    expect(leafA.surfaces.find((s: any) => s.type === 'markdown')?.markdownFilePath)
      .toBe('C:\\repo\\a.md');
  });
});

// This block used to assert the OPPOSITE: that a .md always went through the
// unjailed `markdown.readFile` and therefore never minted a save grant. That
// was right while the pane was read-only — a jail is a smaller blast radius,
// not the user's consent — and it stopped being right when the pane could edit,
// because it left exactly one of the two file types unsaveable for reasons
// invisible from the UI. The reversal is deliberate; see main/file-grants.ts.
describe('openInPreviewTab — the tree reads through the jail, for both types', () => {
  it('reads a .md through explorer.readMarkdown, addressed by (surfaceId, relPath)', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', {
      keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md',
    });
    expect(readFile).toHaveBeenCalledWith('surf-term', 'a.md');
  });

  // The unjailed read still exists for reload-from-disk and drag-and-drop, and
  // still mints nothing. The tree must never reach it — that is what keeps
  // "a renderer-supplied absolute path is never a grant source" true.
  it('never reaches the unjailed markdown.readFile from the tree', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', {
      keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md',
    });
    expect(readMarkdownUnjailed).not.toHaveBeenCalled();
  });

  // Symmetry is the point: a caller without the addressing gets a reported
  // failure for BOTH types, rather than markdown silently falling back to the
  // unjailed read and coming back unsaveable.
  it('refuses a markdown open with no surfaceId, exactly as it refuses code', async () => {
    const { ws, pane } = setup();
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false }))
      .resolves.toBe('invalid_path');
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\a.ts', 'a.ts', { keep: false }))
      .resolves.toBe('invalid_path');
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown' || s.type === 'code')).toHaveLength(0);
  });
});

// Both of these are races the pre-await snapshot could not see. They are
// written against the real store, with only the IPC boundary faked, so a fix
// that merely re-orders the synchronous part would not make them pass.
describe('openInPreviewTab — races resolved after the read', () => {
  it('does not overwrite a preview tab the user began editing DURING the read', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    const first = surfacesOf(ws).find((s) => s.type === 'markdown');

    // The user starts typing while the SECOND open's read is in flight.
    readFile.mockImplementationOnce(async (_surfaceId: string, relPath: string) => {
      useStore.getState().updateSurface(ws, pane, first.id, { markdownDirty: true });
      return { filePath: abs(relPath), content: `# ${abs(relPath)}`, mtimeMs: 1 };
    });
    await openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' });

    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    const edited = md.find((s) => s.id === first.id)!;
    // The edit survives: still a.md, and promoted out of preview rather than recycled.
    expect(edited.markdownFilePath).toBe('C:\\repo\\a.md');
    expect(edited.ephemeral).toBeUndefined();
    // b.md still opened — in its own tab, not on top of the unsaved edit.
    expect(md).toHaveLength(2);
    expect(md.some((s) => s.markdownFilePath === 'C:\\repo\\b.md')).toBe(true);
  });

  it('serializes two clicks that name different dead panes but land on the same live one', async () => {
    const { ws, pane } = setup();
    // Neither id exists, so both opens fall back to the workspace's only pane.
    // Keyed on the CALLER's pane id these sit in two separate queues and run
    // concurrently; keyed on the RESOLVED one they serialize. Either way the
    // pane ends with a single preview tab, because `seqs` is keyed on the
    // resolved pane too and drops the superseded open — which is why this is a
    // guard on the invariant rather than a reproduction of a live bug.
    const gate: Array<() => void> = [];
    readFile.mockImplementation((_surfaceId: string, relPath: string) =>
      new Promise((resolve) => {
        gate.push(() => resolve({ filePath: abs(relPath), content: `# ${abs(relPath)}`, mtimeMs: 1 }));
      }));

    const a = openInPreviewTab(ws, 'pane-dead-a' as any, 'C:\\repo\\a.md', 'a.md', {
      keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md',
    });
    const b = openInPreviewTab(ws, 'pane-dead-b' as any, 'C:\\repo\\b.md', 'b.md', {
      keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md',
    });
    // Release reads as they arrive rather than all at once: when the two opens
    // ARE serialized the second read does not exist yet, and a single drain
    // would wait forever for it.
    let settled = false;
    Promise.all([a, b]).then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 50 && !settled; i++) {
      while (gate.length) gate.shift()!();
      await Promise.resolve();
    }
    await Promise.all([a, b]);

    // One preview tab, not two: the queue key is the pane the work lands on.
    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    expect(md[0].ephemeral).toBe(true);
    expect(pane).toBeTruthy();
  });

  it('opens a fresh tab when the preview is closed DURING the read', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'a.md' });
    const first = surfacesOf(ws).find((s) => s.type === 'markdown')!;

    // The tab this open was going to reuse is gone by the time the read lands.
    readFile.mockImplementationOnce(async (_surfaceId: string, relPath: string) => {
      useStore.getState().closeSurface(ws, pane, first.id);
      return { filePath: abs(relPath), content: '# ' + abs(relPath), mtimeMs: 1 };
    });
    await openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' });

    // Addressing the update to the dead id would no-op silently and report
    // success, leaving the click with nothing to show for it.
    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    expect(md[0].id).not.toBe(first.id);
    expect(md[0].markdownFilePath).toBe('C:\\repo\\b.md');
  });
});

describe('openInPreviewTab — tab lifecycle', () => {
  it('does not destroy the pane when the SOLE preview changes type', async () => {
    const { ws, pane } = setup();
    // A code preview alone in the pane: the user closed the terminal after
    // opening it, and the explorer tree is still on screen.
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.ts', 'a.ts', {
      keep: false, surfaceId: 'surf-root' as any, relPath: 'a.ts',
    });
    const before = surfacesOf(ws);
    for (const s of before) {
      if (s.type !== 'code') useStore.getState().closeSurface(ws, pane, s.id);
    }
    expect(surfacesOf(ws).filter((s) => s.type === 'code')).toHaveLength(1);

    // Clicking a .md needs a DIFFERENT surface type, so the code preview is
    // replaced. Closing it first would take the last-tab path and close the
    // pane — and with it, a single-pane workspace.
    await openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'b.md' });

    expect(useStore.getState().workspaces.some((w) => w.id === ws)).toBe(true);
    const after = surfacesOf(ws);
    expect(after.filter((s) => s.type === 'markdown')).toHaveLength(1);
    expect(after.filter((s) => s.type === 'code')).toHaveLength(0);
  });

  it('reports an oversized markdown file as too_large, not read_failed', async () => {
    const { ws, pane } = setup();
    readFile.mockImplementationOnce(async () => ({ error: 'too big', code: 'too_large' }));
    const failure = await openInPreviewTab(ws, pane, 'C:\\repo\\huge.md', 'huge.md', { keep: false, surfaceId: 'surf-term' as any, relPath: 'huge.md' });
    expect(failure).toBe('too_large');
  });
});

describe('reopenClosedSurface', () => {
  it('brings a closed code tab back pointing at its file', async () => {
    const { ws, pane } = setup();
    // `keep` promotes it out of preview — an ephemeral tab is deliberately
    // never pushed onto the reopen stack.
    // The REAL terminal in this pane: a root that does not resolve to a live
    // surface is dropped on reopen, so a placeholder id would not survive.
    const rootId = surfacesOf(ws)[0].id;
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.ts', 'a.ts', {
      keep: true, surfaceId: rootId, relPath: 'a.ts',
    });
    const code = surfacesOf(ws).find((s) => s.type === 'code')!;
    expect(code.codeRelPath).toBe('a.ts');
    useStore.getState().closeSurface(ws, pane, code.id);

    const reopenedId = useStore.getState().reopenClosedSurface(ws, pane);
    const reopened = surfacesOf(ws).find((s) => s.id === reopenedId)!;
    expect(reopened.type).toBe('code');
    // Without the file it reopens as an empty code surface reporting
    // invalid_path, which reads as a bug rather than as an empty tab.
    expect(reopened.codeRelPath).toBe('a.ts');
    expect(reopened.codeFilePath).toBe('C:\\repo\\a.ts');
    expect(reopened.codeRootSurfaceId).toBe(rootId);
    // The buffer is never persisted — CodePane refills it from the path.
    expect(reopened.codeContent).toBeUndefined();
  });

  it('does NOT carry a code root into a different workspace', () => {
    const { ws, pane } = setup();
    // Closed in workspace A...
    const codeId = useStore.getState().addSurface(ws, pane, 'code' as any, {})!;
    useStore.getState().updateSurface(ws, pane, codeId, {
      codeFilePath: 'C:\\repo\\a.ts', codeRelPath: 'a.ts',
      codeRootSurfaceId: 'surf-root-in-a' as any,
    });
    useStore.getState().closeSurface(ws, pane, codeId);

    // ...reopened in workspace B. A's terminal id means nothing here, and
    // installing it would point CodePane at another workspace's pane.
    const other = setup();
    const reopenedId = useStore.getState().reopenClosedSurface(other.ws, other.pane);
    const reopened = surfacesOf(other.ws).find((s) => s.id === reopenedId)!;
    expect(reopened.type).toBe('code');
    expect(reopened.codeRootSurfaceId).toBeUndefined();
    expect(reopened.codeFilePath).toBeUndefined();
  });

  it('drops a code root whose terminal was closed before the reopen', () => {
    const { ws, pane } = setup();
    const rootId = surfacesOf(ws)[0].id;   // the workspace's own terminal
    // A second terminal, so closing the root below removes a SURFACE and not
    // the pane (and with a single-pane workspace, the workspace itself).
    useStore.getState().addSurface(ws, pane, 'terminal' as any, {});
    const codeId = useStore.getState().addSurface(ws, pane, 'code' as any, {})!;
    useStore.getState().updateSurface(ws, pane, codeId, {
      codeFilePath: 'C:\\repo\\a.ts', codeRelPath: 'a.ts', codeRootSurfaceId: rootId,
    });
    // The terminal the tab was rooted at goes first, so the code tab is what
    // Ctrl+Shift+T pops (the stack is LIFO) and its root is already dead.
    useStore.getState().closeSurface(ws, pane, rootId);
    useStore.getState().closeSurface(ws, pane, codeId);
    const reopenedId = useStore.getState().reopenClosedSurface(ws, pane);
    const reopened = surfacesOf(ws).find((s) => s.id === reopenedId)!;
    expect(reopened.codeRelPath).toBe('a.ts');
    // A dead root id makes CodePane wait forever on a cwd that never comes.
    // Absent, it reports invalid_path instead of sitting blank.
    expect(reopened.codeRootSurfaceId).toBeUndefined();
  });
});
