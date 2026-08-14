/**
 * What counts as "the user dealt with this pane" for the attention ring.
 *
 * Extracted from PaneWrapper for the same reason as workspace-status.ts: the
 * rule is the part worth testing, and it is invisible in a type check. The ring
 * is a claim that a pane wants you; anything that dismisses it is asserting the
 * user has seen it, so a rule that is too eager silently swallows the one signal
 * the feature exists to deliver.
 */

/**
 * Keys that are only ever pressed on the way to something else.
 *
 * A bare modifier is not an interaction with the pane — it is the first half of
 * a chord, and plenty of those (Ctrl+Alt+arrow to switch panes, Alt to reach a
 * menu) are the user leaving rather than engaging. Dismissing on keydown of the
 * modifier itself would clear the ring a beat before the user's attention
 * actually arrives, which is the failure this set exists to prevent.
 *
 * The chord's own terminating key still dismisses, and that is correct: it was
 * typed into this pane.
 */
const BARE_MODIFIERS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS',
  'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super',
]);

/** True when a keydown of `key` should clear the pane's attention ring. */
export function keyDismissesAttention(key: string): boolean {
  return !!key && !BARE_MODIFIERS.has(key);
}
