import { describe, it, expect } from 'vitest';
import { edgeForPointer, reorderByDrop } from '../../src/renderer/components/Sidebar/reorder';

// Issue #124: the insert marker was drawn above the hovered row unconditionally,
// but the drop landed above it only when dragging upwards — downwards the
// removal of the earlier element shifted the insert index and the row landed
// BELOW the marker. Marker and landing spot now come from one source: the edge
// the pointer is on.
describe('sidebar drag-to-reorder (issue #124)', () => {
  const rect = { top: 100, height: 40 };

  describe('edgeForPointer', () => {
    it('picks the edge from the pointer half, not the drag direction', () => {
      expect(edgeForPointer(101, rect)).toBe('above');
      expect(edgeForPointer(119, rect)).toBe('above');
      expect(edgeForPointer(121, rect)).toBe('below');
      expect(edgeForPointer(139, rect)).toBe('below');
    });

    it('treats the exact midpoint as the lower half', () => {
      expect(edgeForPointer(120, rect)).toBe('below');
    });
  });

  describe('reorderByDrop', () => {
    const ids = ['a', 'b', 'c', 'd'];

    it('lands below the target when the marker says below — the old downward bug', () => {
      expect(reorderByDrop(ids, 'a', 'c', 'below')).toEqual(['b', 'c', 'a', 'd']);
    });

    it('lands above the target when the marker says above, dragging downwards', () => {
      // The pre-fix code produced ['b','c','a','d'] here: marker above c, row
      // under c. Now the two agree.
      expect(reorderByDrop(ids, 'a', 'c', 'above')).toEqual(['b', 'a', 'c', 'd']);
    });

    it('lands above the target when the marker says above, dragging upwards', () => {
      expect(reorderByDrop(ids, 'd', 'b', 'above')).toEqual(['a', 'd', 'b', 'c']);
    });

    it('lands below the target when the marker says below, dragging upwards', () => {
      expect(reorderByDrop(ids, 'd', 'b', 'below')).toEqual(['a', 'b', 'd', 'c']);
    });

    it('reaches the very end of the list — below the last row', () => {
      expect(reorderByDrop(ids, 'a', 'd', 'below')).toEqual(['b', 'c', 'd', 'a']);
    });

    it('reaches the very start of the list — above the first row', () => {
      expect(reorderByDrop(ids, 'd', 'a', 'above')).toEqual(['d', 'a', 'b', 'c']);
    });

    it('reports a no-op when the row already sits on that edge', () => {
      // 'a' is already immediately above 'b', and already at the top.
      expect(reorderByDrop(ids, 'a', 'b', 'above')).toBeNull();
      expect(reorderByDrop(ids, 'b', 'a', 'below')).toBeNull();
      expect(reorderByDrop(ids, 'a', 'a', 'below')).toBeNull();
    });

    it('reports a no-op for ids that are not in the list', () => {
      expect(reorderByDrop(ids, 'z', 'b', 'above')).toBeNull();
      expect(reorderByDrop(ids, 'a', 'z', 'above')).toBeNull();
    });

    it('never drops or duplicates a workspace', () => {
      for (const edge of ['above', 'below'] as const) {
        for (const dragged of ids) {
          for (const target of ids) {
            const next = reorderByDrop(ids, dragged, target, edge);
            if (next) expect([...next].sort()).toEqual([...ids].sort());
          }
        }
      }
    });
  });
});
