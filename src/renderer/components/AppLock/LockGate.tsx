import { useEffect, useState, type ReactNode } from 'react';
import { useAppLock } from '../../hooks/useAppLock';
import LockScreen from './LockScreen';
import '../../styles/app-lock.css';

/**
 * The password lock's place in the tree (issue #473): ABOVE the app.
 *
 * - Until main has said whether wmux is locked, nothing is rendered.
 * - Locked at startup: only the lock screen. The app is not mounted, so the
 *   session is not restored and no shell starts until the password is given.
 * - Locked later ("Lock now"): the app stays mounted, because its terminals
 *   and agents keep running, but it is `inert` (no focus, no click) under an
 *   opaque lock screen.
 *
 * Keys are stopped here, in the capture phase on `window`, rather than in
 * every handler that listens for them: useKeyboardShortcuts listens on
 * `document` and would otherwise run a split or open the palette from behind
 * the lock screen, including for keys typed into the password field. Stopping
 * propagation does not stop the browser's own handling, so typing, Tab and the
 * form's submit on Enter still work.
 */
export default function LockGate({ children }: { children: ReactNode }) {
  const state = useAppLock();
  const locked = state?.locked ?? true;
  // Once the app has been mounted it stays mounted across a later lock.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (state && !state.locked) setMounted(true);
  }, [state]);

  useEffect(() => {
    if (!state?.locked) return undefined;
    const stop = (e: Event) => e.stopImmediatePropagation();
    const events = ['keydown', 'keyup', 'keypress'] as const;
    for (const name of events) window.addEventListener(name, stop, true);
    // Whatever had the focus (a terminal, a field in Settings) gives it up.
    (document.activeElement as HTMLElement | null)?.blur?.();
    return () => {
      for (const name of events) window.removeEventListener(name, stop, true);
    };
  }, [state?.locked]);

  if (state === null) return null;
  return (
    <>
      {(mounted || !locked) && (
        <div className="app-lock__app" inert={locked} aria-hidden={locked}>
          {children}
        </div>
      )}
      {locked && <LockScreen running={mounted} />}
    </>
  );
}
