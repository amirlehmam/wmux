/**
 * The translator returned for a language must be referentially stable.
 *
 * `useT()` feeds `t` into `useCallback`/`useEffect` dependency arrays all over
 * the renderer. A fresh closure per render silently invalidates every one of
 * them, which is how the diff pane's 2s poll degenerated into a render-speed
 * loop that spawned `git.exe` faster than git could answer (issue #141).
 */
import { describe, it, expect } from 'vitest';
import { makeT, translate } from '../../src/renderer/i18n/core';

describe('makeT', () => {
  it('returns the same function identity for the same language', () => {
    expect(makeT('en')).toBe(makeT('en'));
    expect(makeT('fr')).toBe(makeT('fr'));
  });

  it('returns a different translator per language', () => {
    expect(makeT('en')).not.toBe(makeT('fr'));
  });

  it('translates identically to translate()', () => {
    const t = makeT('fr');
    expect(t('diffPane.changed', 'Changed')).toBe(translate('fr', 'diffPane.changed', 'Changed'));
  });

  it('honours the fallback for an unknown key', () => {
    const t = makeT('en');
    expect(t('not.a.real.key' as never, 'Fallback')).toBe('Fallback');
  });
});
