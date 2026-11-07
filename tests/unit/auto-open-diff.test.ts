import { describe, it, expect } from 'vitest';
import { autoOpenDiffPane, findBottomPane } from '../../src/renderer/utils/auto-open-diff';
import { isFileEditTool } from '../../src/shared/agent-tools';
import { isEditingTool } from '../../src/renderer/components/Explorer/explorer-diff';
import type { PaneId, SplitNode, SurfaceId, SurfaceRef, WorkspaceInfo } from '../../src/shared/types';

// Issue #440: "Auto-open diff tab on agent edits" never fired under pi, whose
// extension reports its own lower-case tool names (`edit`, `write`) while the
// gate only accepted Claude Code's `Edit` / `Write`.

const TOP = 'pane-top' as PaneId;
const BOTTOM = 'pane-bottom' as PaneId;

function surf(id: string, type: SurfaceRef['type']): SurfaceRef {
  return { id: id as SurfaceId, type };
}

function leaf(paneId: PaneId, surfaces: SurfaceRef[]): SplitNode {
  return { type: 'leaf', paneId, surfaces, activeSurfaceIndex: 0 };
}

function stacked(bottom: SurfaceRef[] = [surf('surf-b', 'terminal')]): SplitNode {
  return {
    type: 'branch',
    direction: 'vertical',
    ratio: 0.5,
    children: [leaf(TOP, [surf('surf-a', 'terminal')]), leaf(BOTTOM, bottom)],
  } as SplitNode;
}

function ws(tree: SplitNode): WorkspaceInfo {
  return { id: 'ws-1', title: 'w', splitTree: tree } as unknown as WorkspaceInfo;
}

const ON = { enabled: true, dismissed: false };

describe('isFileEditTool', () => {
  it('accepts every agent spelling of a file-editing tool', () => {
    // Claude Code / Grok / Qwen (translated), pi, OpenCode, Codex.
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update', 'edit', 'write', 'patch', 'apply_patch']) {
      expect(isFileEditTool(tool)).toBe(true);
    }
  });

  it('rejects tools that only read or run things, and non-strings', () => {
    for (const tool of ['Read', 'read', 'Bash', 'bash', 'Grep', 'ls', 'find', '', undefined, null, 42]) {
      expect(isFileEditTool(tool)).toBe(false);
    }
  });

  it('is the same answer the explorer attribution uses', () => {
    expect(isEditingTool('edit')).toBe(true);
    expect(isEditingTool('read')).toBe(false);
  });
});

describe('autoOpenDiffPane', () => {
  it('opens in the bottom pane for pi\'s lower-case edit and write (#440)', () => {
    expect(autoOpenDiffPane('edit', ws(stacked()), ON)).toBe(BOTTOM);
    expect(autoOpenDiffPane('write', ws(stacked()), ON)).toBe(BOTTOM);
  });

  it('still opens for Claude Code\'s Edit and Write', () => {
    expect(autoOpenDiffPane('Edit', ws(stacked()), ON)).toBe(BOTTOM);
    expect(autoOpenDiffPane('Write', ws(stacked()), ON)).toBe(BOTTOM);
  });

  it('ignores a tool that changed nothing', () => {
    expect(autoOpenDiffPane('bash', ws(stacked()), ON)).toBeNull();
    expect(autoOpenDiffPane('Read', ws(stacked()), ON)).toBeNull();
  });

  it('honours the setting and an earlier dismissal', () => {
    expect(autoOpenDiffPane('edit', ws(stacked()), { enabled: false, dismissed: false })).toBeNull();
    expect(autoOpenDiffPane('edit', ws(stacked()), { enabled: true, dismissed: true })).toBeNull();
  });

  it('does not add a second diff tab to a bottom pane that has one', () => {
    const tree = stacked([surf('surf-b', 'terminal'), surf('surf-d', 'diff')]);
    expect(autoOpenDiffPane('edit', ws(tree), ON)).toBeNull();
  });

  it('uses the only pane of an unsplit workspace', () => {
    expect(autoOpenDiffPane('edit', ws(leaf(TOP, [surf('surf-a', 'terminal')])), ON)).toBe(TOP);
  });
});

describe('findBottomPane', () => {
  it('follows the second child of a vertical split and the first of a horizontal one', () => {
    const horizontal = {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      children: [stacked(), leaf('pane-right' as PaneId, [])],
    } as SplitNode;
    expect(findBottomPane(horizontal)).toBe(BOTTOM);
  });
});
