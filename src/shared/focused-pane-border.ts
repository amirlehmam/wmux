/**
 * How strongly the focused pane's 1px border is tinted with the accent colour,
 * as the percentage of accent mixed into the border an unfocused pane has
 * (issue #471). Shared for the same reason `inactive-pane-dim.ts` is: main
 * validates `[appearance] focused-pane-border`, and the renderer clamps the
 * stored pref, which settings.json makes user-editable.
 *
 * 55 is the ratio `.pane-wrapper--focused` was hard-coded to before this was a
 * setting. 0 mixes in no accent at all, so the focused pane is drawn with the
 * same border as every other pane; 100 is the plain accent colour.
 */
export const DEFAULT_FOCUSED_PANE_BORDER_PCT = 55;
export const MAX_FOCUSED_PANE_BORDER_PCT = 100;

/** The stored percentage clamped to the setting's range; the default for a missing or junk value. */
export function focusedPaneBorderPct(pct: number | undefined): number {
  const value = typeof pct === 'number' && Number.isFinite(pct) ? pct : DEFAULT_FOCUSED_PANE_BORDER_PCT;
  return Math.max(0, Math.min(MAX_FOCUSED_PANE_BORDER_PCT, value));
}

/**
 * The same setting for the ring a transparent window paints. That ring is mixed
 * by `usePaneFill` at `base` (30% there, where the opaque rule uses 55%), so
 * the setting scales it by the same proportion and both windows move together.
 */
export function scaledRingAccent(base: number, pct: number | undefined): number {
  return Math.min(1, base * (focusedPaneBorderPct(pct) / DEFAULT_FOCUSED_PANE_BORDER_PCT));
}
