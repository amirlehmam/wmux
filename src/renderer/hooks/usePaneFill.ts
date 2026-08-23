import { useEffect } from 'react';
import { useStore } from '../store';
import { fetchTheme, withBgAlpha } from './useTerminal';

/** #rgb / #rrggbb → channels, or null for anything else. */
function parseHex(color: string): [number, number, number] | null {
  const hex = (color || '').trim();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return [
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16),
      parseInt(hex[3] + hex[3], 16),
    ];
  }
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }
  return null;
}

/** The `r, g, b` triple behind --ui-accent-rgb, which follows the UI theme. */
function accentRgb(): [number, number, number] | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-accent-rgb');
  const parts = raw.split(',').map((n) => Number(n.trim()));
  return parts.length === 3 && parts.every((n) => Number.isFinite(n))
    ? [parts[0], parts[1], parts[2]]
    : null;
}

/** How much accent the focus ring carries — matches the opaque-mode rule. */
const RING_ACCENT = 0.3;
import { terminalBgAlpha } from '../store/backdrop';

/**
 * Publishes `--wmux-pane-fill`: the global terminal background at the current
 * opacity, for the chrome BETWEEN panes — the 6px split dividers and the 1px
 * pane borders.
 *
 * Those are transparent by default, which was invisible while the window was
 * opaque and is not once it is not: panes render at 80% while the gutters
 * between them render at 0%, so a split reads as bright seams cutting through
 * the terminal rather than as one translucent surface.
 *
 * Deliberately the GLOBAL theme rather than any pane's: a divider lies between
 * two panes that may carry different `--color-scheme` overrides, and there is
 * no per-pane answer to which one a shared edge belongs to.
 *
 * Also publishes `--wmux-pane-ring`: the focus accent mixed into that colour at
 * FULL opacity, for the focused pane's 1px border.
 *
 * The ring is the one edge that cannot match its neighbours by tracking the
 * pane, because its neighbours disagree. It surrounds the whole pane, and the
 * top 28px of that is the surface tab bar — opaque chrome. A ring at the pane's
 * alpha therefore runs translucent between the opaque titlebar above and the
 * opaque tab bar below, and reads as a slot cut across the top of the pane.
 * There is no border-color that matches opaque chrome on one edge and a
 * translucent terminal on the others, so the ring stops trying: it is a focus
 * indicator, which is chrome, and chrome in wmux is opaque.
 *
 * Mixed rather than plain accent so it stays the colour the design already
 * uses — 30% accent, the same ratio the opaque-mode rule composites to.
 */
export function usePaneFill(): void {
  const themeName = useStore((s) => s.terminalPrefs.theme);
  const schemeBg = useStore((s) => s.terminalPrefs.userColorSchemes?.[s.terminalPrefs.theme]?.background);
  const appearance = useStore((s) => s.appearancePrefs);
  const pending = useStore((s) => s.transparencyNeedsRestart);

  // The same function the panes use — the fill has to track them exactly, or
  // closing the gaps just moves the seam.
  const alpha = terminalBgAlpha(appearance, pending);

  useEffect(() => {
    let cancelled = false;
    fetchTheme(themeName)
      .then((base) => {
        if (cancelled) return;
        const bg = schemeBg || base.background;
        const root = document.documentElement;
        root.style.setProperty('--wmux-pane-fill', withBgAlpha(bg, alpha));

        // Left unset rather than wrong in the two cases where the theme colour
        // is not what the ring would be sitting against: one we cannot parse,
        // and a custom background, where the fill is fully transparent because
        // that layer is the surface — mixing into a colour that is never drawn
        // would just pick an arbitrary one. The CSS falls back to the plain
        // accent rule, which is right in both.
        const rgb = parseHex(bg);
        const accent = accentRgb();
        if (rgb && accent && alpha > 0) {
          const mix = rgb.map((c, i) =>
            Math.round(accent[i] * RING_ACCENT + c * (1 - RING_ACCENT)));
          root.style.setProperty('--wmux-pane-ring', `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`);
        } else {
          root.style.removeProperty('--wmux-pane-ring');
        }
      })
      .catch(() => { /* theme unavailable — the gaps stay as they were */ });
    return () => { cancelled = true; };
  }, [themeName, schemeBg, alpha]);
}
