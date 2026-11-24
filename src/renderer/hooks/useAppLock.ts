import { useEffect, useState } from 'react';
import type { AppLockState } from '../../shared/types';

/**
 * What a window shows when main cannot be asked. A lock that opens because a
 * question failed is not a lock, so the answer to "no answer" is "locked":
 * the lock screen's own unlock call then reports what is wrong.
 */
const UNKNOWN_IS_LOCKED: AppLockState = { configured: true, locked: true };

/** A build with no lock bridge at all (a test harness, a component preview) has nothing to lock. */
const NO_LOCK: AppLockState = { configured: false, locked: false };

/**
 * The lock state as MAIN holds it (issue #473), or null until main has
 * answered. Null is a third answer on purpose: the caller must not mount the
 * app on a guess, because mounting it is what restores the session.
 */
export function useAppLock(): AppLockState | null {
  const [state, setState] = useState<AppLockState | null>(null);

  useEffect(() => {
    const api = window.wmux?.appLock;
    if (!api?.getState) {
      setState(NO_LOCK);
      return undefined;
    }
    let unmounted = false;
    const accept = (next: AppLockState | undefined): void => {
      if (!unmounted && next) setState(next);
    };
    // Subscribe first: a change that lands between the two calls is not lost.
    const unsubscribe = api.onStateChange?.(accept);
    api.getState().then(accept).catch(() => accept(UNKNOWN_IS_LOCKED));
    return () => {
      unmounted = true;
      unsubscribe?.();
    };
  }, []);

  return state;
}
