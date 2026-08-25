/**
 * When should the taskbar button flash?
 *
 * Pure, and separate from the component, because the rule is not the obvious
 * one. The naive trigger is "the blocked COUNT went up" — and that is wrong:
 * if one agent unblocks in the same tick another blocks, the count is unchanged
 * and a new pane is nonetheless waiting on the user. Comparing the SETS catches
 * it; comparing cardinalities cannot. That failure only shows up with several
 * agents running at once, which is the exact situation this whole feature is
 * for.
 */

export type BlockedAlert = 'flash' | 'clear' | 'none';

/**
 * Compare two blocked-surface sets.
 *
 * `flash` when a surface is newly blocked, `clear` when nothing is blocked any
 * more, `none` otherwise — including when the same agents are still blocked,
 * so a pane the user has deliberately left waiting does not re-flash forever.
 */
export function blockedAlertTransition(previous: Set<string>, next: Set<string>): BlockedAlert {
  for (const surfaceId of next) {
    if (!previous.has(surfaceId)) return 'flash';
  }
  // Only clear on the edge to empty. Clearing whenever nothing is NEW would
  // cancel a flash the user has not seen yet, one tick after it started.
  if (next.size === 0 && previous.size > 0) return 'clear';
  return 'none';
}
