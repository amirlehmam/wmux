import { useEffect } from 'react';
import { useStore } from '../store';

/**
 * Reflects `appearancePrefs.uiMode` as `data-ui-mode` on <html>, which
 * trace.css keys off of.
 *
 * Deliberately a separate attribute from `data-ui-theme` rather than a third
 * theme value: TRACE has to compose with both palettes, and an attribute pair
 * lets `:root[data-ui-theme='light'][data-ui-mode='trace']` exist without
 * touching a single existing rule.
 *
 * Settings hydrate synchronously at store creation (a sendSync in the settings
 * slice), so the mode is known before first paint — no flash in either
 * direction on launch.
 */
export function useUiMode(): void {
  const uiMode = useStore((s) => s.appearancePrefs.uiMode);

  useEffect(() => {
    document.documentElement.dataset.uiMode = uiMode;
  }, [uiMode]);

  // One app-wide listener, not one per row: pause every TRACE animation while
  // the window is hidden so a minimised wmux costs nothing.
  //
  // Honest caveat — in Electron `visibilitychange` fires on minimise/hide but
  // NOT reliably when another window merely covers ours, so this is a real win
  // for minimised windows and no help for an occluded one. The blur path covers
  // the common "alt-tabbed away" case.
  useEffect(() => {
    if (uiMode === 'classic') return;

    const root = document.documentElement;
    const sync = () => {
      const paused = document.visibilityState === 'hidden';
      if (paused) root.dataset.anim = 'off';
      else delete root.dataset.anim;
    };

    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      delete root.dataset.anim;
    };
  }, [uiMode]);
}
