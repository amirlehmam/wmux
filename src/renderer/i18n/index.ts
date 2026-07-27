import { useStore } from '../store';
import { Language, TranslationKey, translate } from './core';

// Re-export the pure core so components can `import { useT, LANGUAGES, ... }
// from '../i18n'` in one place. The store-free pieces live in ./core to avoid a
// circular import with the settings slice (which imports ./core directly).
export * from './core';

/**
 * React hook: returns a `t(key, fallback?)` bound to the current language.
 * `key` is typed against the English dictionary, so a typo at a call site is a
 * compile error rather than a raw key rendered in the UI.
 */
export function useT(): (key: TranslationKey, fallback?: string) => string {
  const lang = useStore((s) => s.language);
  return (key: TranslationKey, fallback?: string) => translate(lang as Language, key, fallback);
}
