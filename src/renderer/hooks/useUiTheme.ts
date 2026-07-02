import { useEffect } from 'react';
import { useStore } from '../store';

/**
 * Resolves `appearancePrefs.uiTheme` ('system' | 'dark' | 'light') to a
 * concrete 'dark' | 'light' and reflects it as `data-ui-theme` on <html>,
 * which theme-vars.css keys off of (issue #67).
 *
 * 'system' polls the Windows setting once via IPC and then stays live —
 * nativeTheme pushes an update whenever the user flips it in Windows Settings.
 */
export function useUiTheme(): void {
  const uiTheme = useStore((s) => s.appearancePrefs.uiTheme);

  useEffect(() => {
    const root = document.documentElement;

    if (uiTheme !== 'system') {
      root.dataset.uiTheme = uiTheme;
      return;
    }

    // Default to dark while the async IPC round-trip resolves, matching the
    // pre-0.15 shipped appearance so there's no light-mode flash on launch.
    root.dataset.uiTheme = 'dark';

    const sys = (window as any).wmux?.system;
    if (!sys?.getShouldUseDarkColors) return;

    let cancelled = false;
    sys.getShouldUseDarkColors()
      .then((shouldUseDarkColors: boolean) => {
        if (!cancelled) root.dataset.uiTheme = shouldUseDarkColors ? 'dark' : 'light';
      })
      .catch(() => { /* keep dark default */ });

    const unsub = sys.onNativeThemeUpdated?.((shouldUseDarkColors: boolean) => {
      root.dataset.uiTheme = shouldUseDarkColors ? 'dark' : 'light';
    });

    return () => {
      cancelled = true;
      try { unsub?.(); } catch { /* no-op */ }
    };
  }, [uiTheme]);
}
