import { useEffect } from 'react';
import { useStore } from '../store';
import { fetchTheme, withBgAlpha } from './useTerminal';

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
 */
export function usePaneFill(): void {
  const themeName = useStore((s) => s.terminalPrefs.theme);
  const schemeBg = useStore((s) => s.terminalPrefs.userColorSchemes?.[s.terminalPrefs.theme]?.background);
  const appearance = useStore((s) => s.appearancePrefs);
  const pending = useStore((s) => s.transparencyNeedsRestart);

  // Same condition as bgAlpha in useTerminal — the fill has to track the panes
  // exactly, or closing the gaps just moves the seam.
  const hasBackdrop =
    (appearance.customBackgroundEnabled && !!appearance.customBackground) ||
    (appearance.windowTransparency && !pending);
  const alpha = hasBackdrop
    ? Math.max(0, Math.min(1, (appearance.terminalBgOpacity ?? 88) / 100))
    : 1;

  useEffect(() => {
    let cancelled = false;
    fetchTheme(themeName)
      .then((base) => {
        if (cancelled) return;
        const bg = schemeBg || base.background;
        document.documentElement.style.setProperty('--wmux-pane-fill', withBgAlpha(bg, alpha));
      })
      .catch(() => { /* theme unavailable — the gaps stay as they were */ });
    return () => { cancelled = true; };
  }, [themeName, schemeBg, alpha]);
}
