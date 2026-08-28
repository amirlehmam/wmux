import { describe, it, expect } from 'vitest';
import { dropCodeContent } from '../../src/renderer/store/split-utils';
import { samePath } from '../../src/renderer/components/Code/CodePane';

const leaf = (surfaces: any[]): any => ({
  type: 'leaf', paneId: 'pane-1', surfaces, activeSurfaceIndex: 0,
});

describe('dropCodeContent', () => {
  it('strips codeContent but keeps the path fields that let it be re-read', () => {
    const tree = leaf([{
      id: 's1', type: 'code',
      codeContent: 'export {}',
      codeFilePath: 'C:\\repo\\index.ts',
      codeRelPath: 'index.ts',
      codeFileName: 'index.ts',
      codeRootSurfaceId: 'surf-term',
    }]);
    const out: any = dropCodeContent(tree);
    expect(out.surfaces[0].codeContent).toBeUndefined();
    expect(out.surfaces[0].codeFilePath).toBe('C:\\repo\\index.ts');
    expect(out.surfaces[0].codeRelPath).toBe('index.ts');
    expect(out.surfaces[0].codeFileName).toBe('index.ts');
    // The root terminal id has to survive: without it the restored tab has no
    // id main will read for, which is the bug that made every restored code
    // tab come back blank.
    expect(out.surfaces[0].codeRootSurfaceId).toBe('surf-term');
  });

  it('never touches a markdown buffer — that one IS persisted on purpose', () => {
    const tree = leaf([{ id: 's1', type: 'markdown', markdownContent: '# hi' }]);
    const out: any = dropCodeContent(tree);
    expect(out.surfaces[0].markdownContent).toBe('# hi');
  });

  it('recurses into both children of a split', () => {
    const tree: any = {
      type: 'split', direction: 'horizontal', ratio: 0.5,
      children: [
        leaf([{ id: 'a', type: 'code', codeContent: 'x' }]),
        leaf([{ id: 'b', type: 'code', codeContent: 'y' }]),
      ],
    };
    const out: any = dropCodeContent(tree);
    expect(out.children[0].surfaces[0].codeContent).toBeUndefined();
    expect(out.children[1].surfaces[0].codeContent).toBeUndefined();
  });
});

// ─── The reloaded file is the SAME file ──────────────────────────────────────
// A restored tab re-reads by (root terminal, relPath), and that root moves — the
// shell can cd, or come back somewhere else. The pane compares what main
// returned against the absolute path the surface was opened with, so a moved
// root shows not_found instead of a different file under the old tab label.

describe('samePath', () => {
  it('accepts the same path spelled differently by Windows', () => {
    expect(samePath('C:\\repo\\src\\index.ts', 'C:/repo/src/index.ts')).toBe(true);
    expect(samePath('C:\\Repo\\SRC\\Index.TS', 'C:\\repo\\src\\index.ts')).toBe(true);
    expect(samePath('C:\\repo\\src\\\\index.ts', 'C:\\repo\\src\\index.ts')).toBe(true);
  });

  it('rejects the same relPath resolved under a different root', () => {
    expect(samePath('C:\\other\\src\\index.ts', 'C:\\repo\\src\\index.ts')).toBe(false);
    expect(samePath('C:\\repo\\src\\other.ts', 'C:\\repo\\src\\index.ts')).toBe(false);
  });
});
