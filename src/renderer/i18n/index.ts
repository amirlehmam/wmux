import { useStore } from '../store';
import { Language, makeT, Translator } from './core';

// Re-export the pure core so components can `import { useT, LANGUAGES, ... }
// from '../i18n'` in one place. The store-free pieces live in ./core to avoid a
// circular import with the settings slice (which imports ./core directly).
export * from './core';

/**
 * React hook: returns a `t(key, fallback?)` bound to the current language.
 * `key` is typed against the English dictionary, so a typo at a call site is a
 * compile error rather than a raw key rendered in the UI.
 *
 * The returned function is referentially stable for a given language — call
 * sites put `t` in `useCallback`/`useEffect` dependency arrays, and a fresh
 * closure per render silently re-runs every one of those effects (issue #141).
 */
export function useT(): Translator {
  const lang = useStore((s) => s.language);
  // Subscribing to the locale revision is what repaints translated UI after
  // `wmux reload-config` swaps in edited ~/.wmux/locales files (issue #147):
  // the dictionaries change in place, so no other store value would tell React
  // to re-render. The value itself is unused — applyUserLocales has already
  // invalidated the translator cache, so makeT hands back a fresh closure.
  useStore((s) => s.localeRevision);
  return makeT(lang as Language);
}
