// ─── Side-panel width arithmetic ─────────────────────────────────────────────
// The main row is: sidebar │ terminals │ explorer │ browser. Every member but
// the terminal column is flexShrink:0 and fixed-width, so the terminals are the
// only thing that can be squeezed — which is exactly why a side panel's width
// has to be clamped rather than trusted.
//
// This lives outside App.tsx so BOTH clamps use the same numbers: the drag
// clamp, and the render clamp for a width that was restored rather than
// dragged. Restore is the one path where the user never chose the bad width —
// a panel sized on a 3840px monitor comes back verbatim on a 1366px laptop,
// with a second unclamped panel beside it.
//
// What this deliberately does NOT do: decide which panel yields first when even
// the floor cannot be met. Both panels stay flexShrink:0 and neither
// auto-collapses; each is simply capped at the space left over once the other
// one, the sidebar and the terminal floor are accounted for. That ordering is
// reserved for Derek and is not implied here.

/** Floor for the terminal column — the only flexible member of the row. */
export const TERMINAL_MIN_WIDTH = 400;

/** Width of a panel's drag handle, counted when the panel is open. */
export const PANEL_HANDLE_WIDTH = 4;

export const EXPLORER_MIN_WIDTH = 200;
export const BROWSER_MIN_WIDTH = 250;

/**
 * Horizontal space a side panel may not take: the terminal floor, the sidebar
 * if it is visible, and the OTHER panel plus its handle if that one is open.
 */
export function panelReservedWidth(opts: {
  sidebarWidth: number;
  otherPanelOpen: boolean;
  otherPanelWidth: number;
}): number {
  return TERMINAL_MIN_WIDTH
    + opts.sidebarWidth
    + (opts.otherPanelOpen ? PANEL_HANDLE_WIDTH + opts.otherPanelWidth : 0);
}

/**
 * Clamp a panel width into what the viewport can actually spare.
 *
 * The minimum wins over the maximum on purpose. On a viewport too narrow to
 * satisfy both, `viewportWidth - reserved` can go below the panel's own minimum
 * (even negative); returning that would collapse the panel to a sliver or
 * invert it. Holding the minimum instead overflows the row, which is visible
 * and recoverable, and — unlike collapsing one panel — expresses no opinion
 * about which panel should give way.
 */
export function clampPanelWidth(
  width: number,
  opts: { reserved: number; min: number; viewportWidth: number },
): number {
  return Math.max(opts.min, Math.min(opts.viewportWidth - opts.reserved, width));
}
