/**
 * Drag-to-reorder geometry for the workspace list.
 *
 * The old drop handler removed the dragged id and re-inserted it at the hovered
 * row's index. Going *up* that lands the row above the target; going *down* the
 * removal shifts every later index by one, so the same code lands it *below*.
 * The insert marker was drawn above the hovered row either way, so it told the
 * truth in one direction and lied in the other (issue #124).
 *
 * The fix is to stop deriving the landing spot from the drag direction at all.
 * The pointer picks an edge — top half of the row means "before it", bottom half
 * means "after it" — the marker draws on that edge, and the drop lands exactly
 * there. Direction stops mattering, which also removes the awkward "aim one row
 * past where you want it" that the direction-dependent version forced.
 */

export type DropEdge = 'above' | 'below';

/** Which edge of `rect` the pointer at `clientY` is closest to. */
export function edgeForPointer(clientY: number, rect: { top: number; height: number }): DropEdge {
  return clientY < rect.top + rect.height / 2 ? 'above' : 'below';
}

/**
 * The list after dropping `draggedId` on the given edge of `targetId`, or null
 * when the drop is a no-op (unknown ids, or an edge the row already sits on) —
 * callers skip the store write entirely rather than churn a re-render.
 */
export function reorderByDrop<T>(
  ids: readonly T[],
  draggedId: T,
  targetId: T,
  edge: DropEdge,
): T[] | null {
  const from = ids.indexOf(draggedId);
  const target = ids.indexOf(targetId);
  if (from === -1 || target === -1) return null;

  // Landing slot in the ORIGINAL list, then corrected for the removal of an
  // earlier element — the off-by-one that made downward drops disagree with
  // the marker in the first place.
  let insertAt = edge === 'below' ? target + 1 : target;
  if (from < insertAt) insertAt--;
  if (insertAt === from) return null;

  const next = [...ids];
  next.splice(from, 1);
  next.splice(insertAt, 0, draggedId);
  return next;
}
