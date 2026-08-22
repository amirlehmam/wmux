import { useEffect } from 'react';
import { useStore } from '../store';

/**
 * Drives window transparency: the desktop showing through the terminal.
 *
 * Two halves have to agree, which is why they live in one hook:
 *
 *  - Main process — a zero-alpha window `backgroundColor`, plus either
 *    `transparent: true` (plain alpha) or a Win11 backdrop material (blurred).
 *  - Renderer — the `wmux-transparent` class, which stops <html>/<body>/#root
 *    painting so the now-transparent window is actually visible through them.
 *
 * The main process reads the same pref off settings.json when it CREATES a
 * window, so launch already comes up right; this hook applies later changes to
 * windows that are already open.
 *
 * Publishes `transparencyNeedsRestart` to the store — entering or leaving
 * plain-alpha mode needs the window rebuilt, because Electron fixes
 * `transparent` at construction and offers no setter. It goes to the store
 * rather than to a caller because Settings renders inside the same tree as
 * App: calling this hook a second time to read the answer would apply every
 * backdrop change twice.
 *
 * Call this exactly once, from App.
 */
export function useWindowTransparency(): void {
  const enabled = useStore((s) => s.appearancePrefs.windowTransparency);
  const material = useStore((s) => s.appearancePrefs.windowMaterial);
  const setNeedsRestart = useStore((s) => s.setTransparencyNeedsRestart);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const caps = await window.wmux?.window?.supportsBackdrop?.();
      if (cancelled) return;

      // A blur material on Windows 10 would leave the window transparent with
      // nothing drawn behind it, i.e. black — so that combination is treated as
      // unsupported rather than applied.
      const available = material === 'clear'
        ? caps?.transparency === true
        : caps?.materials === true;
      const on = available && enabled;

      const result = await window.wmux?.window?.setBackdrop?.(on, material);
      if (cancelled) return;

      // Class follows what the WINDOW actually is, not what the pref says. With
      // a restart pending the window is still opaque, and unpainting the root
      // then would just expose its backgroundColor — a flat slab where the
      // terminal used to be, which reads as a bug rather than as "pending".
      const pending = result?.needsRestart === true;
      document.documentElement.classList.toggle('wmux-transparent', on && !pending);
      setNeedsRestart(pending);
    })();

    return () => { cancelled = true; };
  }, [enabled, material, setNeedsRestart]);
}
