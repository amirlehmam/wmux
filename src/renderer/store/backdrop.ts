import type { AppearancePrefs } from './settings-slice';

/**
 * Floor for terminal opacity, as a percentage.
 *
 * 0 was reachable and turned out to be too far. In Clear mode there is no blur
 * behind the terminal, so a fully transparent background leaves text floating
 * on the desktop with nothing to sit on.
 *
 * 15 is borrowed rather than guessed: Ghostty enforces exactly this threshold
 * on `unfocused-split-opacity`, with the reason spelled out — "because 0 is not
 * useful (it makes the window look very weird), the minimum value is 0.15".
 *
 * Worth being straight about the precedent: neither Ghostty's
 * `background-opacity` nor Windows Terminal's `opacity` actually clamps at 0 in
 * config — both accept it. Only the reasoning is borrowed; the floor is ours.
 */
export const MIN_TERMINAL_OPACITY_PCT = 15;

/** The stored percentage as a usable 0..1 alpha, floored and clamped. */
export function opacityToAlpha(pct: number | undefined): number {
  const value = typeof pct === 'number' && Number.isFinite(pct) ? pct : 88;
  return Math.max(MIN_TERMINAL_OPACITY_PCT, Math.min(100, value)) / 100;
}

/**
 * Whether there is anything behind the terminal worth showing: the in-app
 * custom background layer, or the desktop through a transparent window.
 *
 * `transparencyPending` is why the window matters as well as the pref — until a
 * Clear-mode change is restarted into, the window is still opaque and alpha
 * would only reveal its flat backgroundColor.
 */
export function hasBackdrop(a: AppearancePrefs, transparencyPending: boolean): boolean {
  const customBg = a.customBackgroundEnabled && !!(a.customBackground || '').trim();
  return customBg || (a.windowTransparency && !transparencyPending);
}

/**
 * Alpha for the terminal background — the xterm theme colour, and the fill
 * behind pane padding and the gutters between panes.
 *
 * One definition for all three because they have to agree exactly: any
 * disagreement renders as a seam at the edge of a pane.
 */
export function terminalBgAlpha(a: AppearancePrefs, transparencyPending: boolean): number {
  return hasBackdrop(a, transparencyPending) ? opacityToAlpha(a.terminalBgOpacity) : 1;
}

/**
 * Alpha for the custom background LAYER.
 *
 * Deliberately a narrower condition than the terminal's: this layer only fades
 * when there is a transparent window behind it. With an opaque window it is
 * itself the backdrop, and fading it would just reveal --ui-bg-1.
 */
export function customBgLayerAlpha(a: AppearancePrefs, transparencyPending: boolean): number {
  return a.windowTransparency && !transparencyPending ? opacityToAlpha(a.terminalBgOpacity) : 1;
}
