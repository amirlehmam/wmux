import { useEffect } from 'react';
import { useStore } from '../store';

/**
 * Drives real window transparency: the desktop showing through the terminal,
 * blurred by a Windows 11 backdrop material.
 *
 * Two halves have to agree, which is why they live in one hook:
 *
 *  - Main process — `setBackgroundMaterial` plus a zero-alpha window
 *    `backgroundColor`. Without the material the window is transparent but
 *    unblurred (black); without the alpha the material is painted over.
 *  - Renderer — the `wmux-transparent` class, which stops <html>/<body>/#root
 *    painting so the now-transparent window is actually visible through them.
 *
 * The main process reads the same pref off settings.json when it CREATES a
 * window, so launch already comes up with the right backdrop; this hook is what
 * makes toggling it apply live to windows that are already open.
 *
 * Non-Win11 hosts never get the class: `setBackdrop` is a no-op there, so
 * unpainting the root would leave a black window rather than a transparent one.
 */
export function useWindowTransparency(): void {
  const enabled = useStore((s) => s.appearancePrefs.windowTransparency);
  const material = useStore((s) => s.appearancePrefs.windowMaterial);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const supported = (await window.wmux?.window?.supportsBackdrop?.()) === true;
      if (cancelled) return;

      const on = supported && enabled;
      document.documentElement.classList.toggle('wmux-transparent', on);
      window.wmux?.window?.setBackdrop?.(on, material);
    })();

    return () => { cancelled = true; };
  }, [enabled, material]);
}
