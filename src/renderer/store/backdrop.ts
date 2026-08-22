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

/** A custom background layer is configured and switched on. */
export function hasCustomBackground(a: AppearancePrefs): boolean {
  return a.customBackgroundEnabled && !!(a.customBackground || '').trim();
}

/**
 * The window itself is actually see-through right now.
 *
 * `transparencyPending` is why the pref alone will not do: until a Clear-mode
 * change is restarted into, the window is still opaque, and alpha would only
 * reveal its flat backgroundColor.
 */
export function hasTransparentWindow(a: AppearancePrefs, transparencyPending: boolean): boolean {
  return a.windowTransparency && !transparencyPending;
}

/** Anything behind the terminal worth showing — either backdrop. */
export function hasBackdrop(a: AppearancePrefs, transparencyPending: boolean): boolean {
  return hasCustomBackground(a) || hasTransparentWindow(a, transparencyPending);
}

/**
 * Alpha for the terminal background — the xterm theme colour, and the fill
 * behind pane padding and the gutters between panes.
 *
 * One definition for all three because they have to agree exactly: any
 * disagreement renders as a seam at the edge of a pane.
 *
 * A custom background REPLACES this colour rather than sitting behind it, which
 * is how both references treat it: Ghostty composites `background-image` over
 * the background colour, and Windows Terminal draws `backgroundImage` over it
 * at full strength by default. Fading the terminal's own colour toward a
 * custom background instead — the old behaviour — meant the background was only
 * ever visible in proportion to how transparent the window was, so at 100% it
 * was perfectly hidden behind the theme's flat grey. Setting a background and
 * seeing no background is not a defensible reading of the setting.
 *
 * Users who want the old blended look still have it: `customBackground` is raw
 * CSS, so a translucent gradient layer composites exactly the same way.
 */
export function terminalBgAlpha(a: AppearancePrefs, transparencyPending: boolean): number {
  if (hasCustomBackground(a)) return 0;
  return hasTransparentWindow(a, transparencyPending) ? opacityToAlpha(a.terminalBgOpacity) : 1;
}

/**
 * Alpha for the custom background LAYER.
 *
 * Deliberately a narrower condition than the terminal's: this layer only fades
 * when there is a transparent window behind it. With an opaque window it is
 * itself the backdrop, and fading it would just reveal --ui-bg-1.
 */
export function customBgLayerAlpha(a: AppearancePrefs, transparencyPending: boolean): number {
  return hasTransparentWindow(a, transparencyPending) ? opacityToAlpha(a.terminalBgOpacity) : 1;
}
