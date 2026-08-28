// ─── Explorer: keyboard-navigation decision logic ────────────────────────────
// Pure key -> outcome mapping over the same flattened row list flattenVisible()
// produces, kept apart from ExplorerTree.tsx for the same reason
// explorer-state.ts and split-utils.ts are — this is where the unit tests
// point. No React, no DOM, no `window`.
//
// Deliberately does NOT check `row.entry.viewable` for Enter/'activate' — that
// gate belongs at the call site, exactly where the mouse click handler in
// ExplorerTree.tsx already checks it before invoking onActivate. Baking it in
// here would make this module's 'activate' outcome mean two different things
// depending on caller, instead of always meaning "this key means: open it".

import type { ExplorerRow } from './explorer-state';

export type ExplorerKeyNavOutcome =
  | { type: 'move'; index: number }
  | { type: 'expand'; index: number }
  | { type: 'collapse'; index: number }
  | { type: 'activate'; index: number }
  | { type: 'focus-terminal' }
  | { type: 'none' };

const NONE: ExplorerKeyNavOutcome = { type: 'none' };

/**
 * Decide what a key press does to the tree, given the currently visible rows
 * (in display order, as returned by flattenVisible) and which row is
 * currently focused (roving tabIndex).
 */
export function computeKeyNavOutcome(
  rows: ExplorerRow[],
  focusedIndex: number,
  key: string,
): ExplorerKeyNavOutcome {
  // Escape always returns focus to the terminal, independent of row state.
  if (key === 'Escape') return { type: 'focus-terminal' };

  if (rows.length === 0) return NONE;

  if (key === 'Home') return { type: 'move', index: 0 };
  if (key === 'End') return { type: 'move', index: rows.length - 1 };

  if (focusedIndex < 0 || focusedIndex >= rows.length) return NONE;
  const row = rows[focusedIndex];

  switch (key) {
    case 'ArrowDown':
      return focusedIndex < rows.length - 1
        ? { type: 'move', index: focusedIndex + 1 }
        : NONE;

    case 'ArrowUp':
      return focusedIndex > 0
        ? { type: 'move', index: focusedIndex - 1 }
        : NONE;

    case 'ArrowRight': {
      if (row.entry.kind !== 'dir') return NONE;
      if (!row.expanded) return { type: 'expand', index: focusedIndex };
      const next = rows[focusedIndex + 1];
      return next && next.depth === row.depth + 1
        ? { type: 'move', index: focusedIndex + 1 }
        : NONE;
    }

    case 'ArrowLeft': {
      if (row.entry.kind === 'dir' && row.expanded) {
        return { type: 'collapse', index: focusedIndex };
      }
      // Walk back to the nearest preceding shallower row — in a depth-first
      // flattened list, that is always the direct parent.
      for (let i = focusedIndex - 1; i >= 0; i--) {
        if (rows[i].depth < row.depth) return { type: 'move', index: i };
      }
      return NONE;
    }

    case 'Enter':
      // On a directory, Enter toggles expansion (matching arrow behavior),
      // never activates — activation is a file-only concept here.
      if (row.entry.kind === 'dir') {
        return row.expanded
          ? { type: 'collapse', index: focusedIndex }
          : { type: 'expand', index: focusedIndex };
      }
      return { type: 'activate', index: focusedIndex };

    default:
      return NONE;
  }
}
