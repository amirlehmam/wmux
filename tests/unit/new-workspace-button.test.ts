import { describe, expect, it } from 'vitest';
import { upwardMenuPosition } from '../../src/renderer/components/Sidebar/NewWorkspaceButton';

// The sidebar layout menu opens UPWARD from a button at the bottom of the window.

describe('upwardMenuPosition', () => {
  it('sits just above the anchor, aligned with it and at least as wide', () => {
    const pos = upwardMenuPosition({ left: 12, top: 700, width: 180 }, 800);
    expect(pos.left).toBe(12);
    expect(pos.minWidth).toBe(180);
    // bottom is measured from the bottom of the viewport: 100px below the
    // anchor's top, plus the 4px gap.
    expect(pos.bottom).toBe(104);
    // Everything above the anchor, minus the gap and an 8px top margin.
    expect(pos.maxHeight).toBe(688);
  });

  it('honours a custom gap and margin', () => {
    const pos = upwardMenuPosition({ left: 0, top: 500, width: 100 }, 600, 10, 20);
    expect(pos.bottom).toBe(110);
    expect(pos.maxHeight).toBe(470);
  });

  it('never gives a negative height when the anchor is near the top', () => {
    expect(upwardMenuPosition({ left: 0, top: 6, width: 100 }, 600).maxHeight).toBe(0);
  });
});
