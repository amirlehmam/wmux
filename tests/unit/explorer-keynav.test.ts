import { describe, it, expect } from 'vitest';
import { computeKeyNavOutcome } from '../../src/renderer/components/Explorer/explorer-keynav';
import type { ExplorerRow } from '../../src/renderer/components/Explorer/explorer-state';

function row(
  name: string,
  kind: 'dir' | 'file' | 'symlink',
  depth: number,
  expanded = false,
  viewable = true,
): ExplorerRow {
  return {
    entry: { name, kind, size: 0, mtimeMs: 0, viewable },
    relPath: name,
    depth,
    expanded,
  };
}

// A tree shaped like:
// docs/          (dir, expanded)     idx 0, depth 0
//   readme.md    (file)              idx 1, depth 1
//   old/         (dir, collapsed)    idx 2, depth 1
// zzz.exe        (file, !viewable)   idx 3, depth 0
const rows: ExplorerRow[] = [
  row('docs', 'dir', 0, true),
  row('readme.md', 'file', 1),
  row('old', 'dir', 1, false),
  row('zzz.exe', 'file', 0, false, false),
];

describe('computeKeyNavOutcome', () => {
  describe('ArrowDown', () => {
    it('moves to the next visible row', () => {
      expect(computeKeyNavOutcome(rows, 0, 'ArrowDown')).toEqual({ type: 'move', index: 1 });
    });

    it('does nothing on the last row', () => {
      expect(computeKeyNavOutcome(rows, 3, 'ArrowDown')).toEqual({ type: 'none' });
    });
  });

  describe('ArrowUp', () => {
    it('moves to the previous visible row', () => {
      expect(computeKeyNavOutcome(rows, 1, 'ArrowUp')).toEqual({ type: 'move', index: 0 });
    });

    it('does nothing on the first row', () => {
      expect(computeKeyNavOutcome(rows, 0, 'ArrowUp')).toEqual({ type: 'none' });
    });
  });

  describe('ArrowRight', () => {
    it('expands a collapsed directory', () => {
      expect(computeKeyNavOutcome(rows, 2, 'ArrowRight')).toEqual({ type: 'expand', index: 2 });
    });

    it('moves to the first child of an already-expanded directory', () => {
      expect(computeKeyNavOutcome(rows, 0, 'ArrowRight')).toEqual({ type: 'move', index: 1 });
    });

    it('does nothing on a file', () => {
      expect(computeKeyNavOutcome(rows, 1, 'ArrowRight')).toEqual({ type: 'none' });
    });

    it('does nothing on an expanded directory with no loaded children yet', () => {
      const noChildren: ExplorerRow[] = [row('empty', 'dir', 0, true)];
      expect(computeKeyNavOutcome(noChildren, 0, 'ArrowRight')).toEqual({ type: 'none' });
    });
  });

  describe('ArrowLeft', () => {
    it('collapses an expanded directory', () => {
      expect(computeKeyNavOutcome(rows, 0, 'ArrowLeft')).toEqual({ type: 'collapse', index: 0 });
    });

    it('moves to the parent row from a child', () => {
      expect(computeKeyNavOutcome(rows, 1, 'ArrowLeft')).toEqual({ type: 'move', index: 0 });
    });

    it('moves to the parent row from a collapsed child directory', () => {
      expect(computeKeyNavOutcome(rows, 2, 'ArrowLeft')).toEqual({ type: 'move', index: 0 });
    });

    it('does nothing on a top-level row with no parent', () => {
      expect(computeKeyNavOutcome(rows, 3, 'ArrowLeft')).toEqual({ type: 'none' });
    });
  });

  describe('Enter', () => {
    it('expands a collapsed directory instead of activating', () => {
      expect(computeKeyNavOutcome(rows, 2, 'Enter')).toEqual({ type: 'expand', index: 2 });
    });

    it('collapses an expanded directory instead of activating', () => {
      expect(computeKeyNavOutcome(rows, 0, 'Enter')).toEqual({ type: 'collapse', index: 0 });
    });

    it('activates a file row (caller is responsible for the viewable guard)', () => {
      expect(computeKeyNavOutcome(rows, 1, 'Enter')).toEqual({ type: 'activate', index: 1 });
      expect(computeKeyNavOutcome(rows, 3, 'Enter')).toEqual({ type: 'activate', index: 3 });
    });
  });

  describe('Home / End', () => {
    it('Home moves to the first visible row', () => {
      expect(computeKeyNavOutcome(rows, 2, 'Home')).toEqual({ type: 'move', index: 0 });
    });

    it('End moves to the last visible row', () => {
      expect(computeKeyNavOutcome(rows, 0, 'End')).toEqual({ type: 'move', index: 3 });
    });
  });

  describe('Escape', () => {
    it('returns a focus-terminal outcome regardless of focused index', () => {
      expect(computeKeyNavOutcome(rows, 1, 'Escape')).toEqual({ type: 'focus-terminal' });
    });

    it('returns a focus-terminal outcome even with no rows', () => {
      expect(computeKeyNavOutcome([], -1, 'Escape')).toEqual({ type: 'focus-terminal' });
    });
  });

  describe('edge cases', () => {
    it('does nothing for an unrecognized key', () => {
      expect(computeKeyNavOutcome(rows, 0, 'a')).toEqual({ type: 'none' });
    });

    it('does nothing when rows are empty', () => {
      expect(computeKeyNavOutcome([], -1, 'ArrowDown')).toEqual({ type: 'none' });
      expect(computeKeyNavOutcome([], -1, 'Home')).toEqual({ type: 'none' });
    });

    it('does nothing when focusedIndex is out of range', () => {
      expect(computeKeyNavOutcome(rows, -1, 'ArrowDown')).toEqual({ type: 'none' });
      expect(computeKeyNavOutcome(rows, 99, 'ArrowDown')).toEqual({ type: 'none' });
    });
  });
});
