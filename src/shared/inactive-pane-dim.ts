/**
 * How strongly unfocused panes are dimmed, as a percentage of black laid over
 * them (`.pane-wrapper__unfocused-overlay`). Shared because both sides check
 * it: main validates `[appearance] inactive-pane-dim`, the renderer clamps the
 * stored pref, which settings.json makes user-editable.
 *
 * 20 is the alpha the overlay was hard-coded to before this was a setting.
 * 0 turns dimming off — Ghostty's `unfocused-split-opacity` answers the same
 * request. The ceiling stays under focus mode's 0.62: that mode exists to dim
 * harder, and the everyday setting must not be able to out-dim it.
 */
export const DEFAULT_INACTIVE_PANE_DIM_PCT = 20;
export const MAX_INACTIVE_PANE_DIM_PCT = 60;

/** The stored percentage as a 0..1 overlay alpha, clamped to the setting's range. */
export function inactivePaneDimAlpha(pct: number | undefined): number {
  const value = typeof pct === 'number' && Number.isFinite(pct) ? pct : DEFAULT_INACTIVE_PANE_DIM_PCT;
  return Math.max(0, Math.min(MAX_INACTIVE_PANE_DIM_PCT, value)) / 100;
}
