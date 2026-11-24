import type { AppLockError, AppLockResult } from '../../shared/types';
import type { TranslationKey } from '../i18n';

/**
 * The renderer's half of the password lock (issue #473). Main owns the state
 * (`src/main/app-lock.ts`); nothing here remembers whether wmux is locked.
 */

/** Fired on `document` to open Settings on a given tab. App.tsx listens. */
export const OPEN_SETTINGS_EVENT = 'wmux:open-settings';

/**
 * "Lock now", from the shortcut, the palette and Settings. With no password
 * set there is nothing to lock with, so it opens the place where one is set
 * instead of doing nothing.
 */
export async function lockAppNow(): Promise<void> {
  let result: AppLockResult | undefined;
  try {
    result = await window.wmux?.appLock?.lock?.();
  } catch {
    return;
  }
  if (result && !result.ok && result.error === 'not_configured') {
    document.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { tab: 'General' } }));
  }
}

/** The whole seconds a person has to wait, never 0 for a wait that is not over. */
export function retrySeconds(retryAfterMs: number | undefined): number {
  return retryAfterMs && retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0;
}

/**
 * What the lock screen says for a refused unlock. A wrong password that also
 * started a wait says the wait: "wrong password" alone would invite a retry
 * that cannot count.
 */
export function unlockErrorKey(error: AppLockError | undefined, retryAfterMs: number | undefined): TranslationKey {
  if (error === 'throttled') return 'appLock.throttled';
  if (error === 'wrong_password') return retrySeconds(retryAfterMs) > 0 ? 'appLock.wrongPasswordWait' : 'appLock.wrongPassword';
  return 'appLock.failed';
}

/** What Settings says for a refused change of password. */
export function passwordChangeErrorKey(error: AppLockError | undefined): TranslationKey {
  switch (error) {
    case 'wrong_password': return 'settings.general.lockWrongCurrent';
    case 'throttled': return 'appLock.throttled';
    case 'too_short': return 'settings.general.lockTooShort';
    default: return 'settings.general.lockSaveFailed';
  }
}

/** Mirrors `MIN_PASSWORD_LENGTH` in main, which is the one that decides. */
export const MIN_PASSWORD_LENGTH = 4;
