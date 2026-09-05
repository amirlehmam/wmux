import { describe, it, expect } from 'vitest';
import { DEFAULT_BROWSER_PREFS } from '../../src/renderer/store/settings-slice';

/**
 * Pins the ONE decision in #219 that is invisible in the code it changed.
 *
 * #219 promoted dev-server auto-open from a module-level runtime value to a
 * persisted pref, and proposed defaulting it OFF — a defensible policy for a
 * NEW feature, and the wrong one here, because the behaviour predates the pref.
 * Prefs persist as whole blocks and a new field is filled from DEFAULTS
 * (`{...DEFAULTS, ...stored}`), so a `false` here does not present a choice to
 * anybody: it silently switches auto-open off for every existing install on
 * upgrade. The pref's job is to give the people it bothers a way out, not to
 * take it from the people it doesn't.
 *
 * That reasoning lives in a comment, and the value it defends is a single
 * word that reads like an oversight — exactly the shape of thing a later
 * tidy-up flips back. Hence a test: changing this default is allowed, but it
 * has to be a decision someone makes on purpose, not a diff nobody notices.
 */
describe('browser prefs — auto-open default (#219)', () => {
  it('defaults dev-server auto-open ON, so upgrading never revokes it', () => {
    expect(DEFAULT_BROWSER_PREFS.autoOpenDevServer).toBe(true);
  });

  // The whole argument rests on the field being absent from stored prefs and
  // therefore taking the default. Pin the merge itself, not just the constant.
  it('fills the field from DEFAULTS for prefs stored before the field existed', () => {
    const storedBeforeThisRelease = {
      searchEngine: 'google',
      devToolsIcon: 'default',
      openOnStartup: true,
      openLinksExternally: false,
      defaultUrl: '',
    };
    const merged = { ...DEFAULT_BROWSER_PREFS, ...storedBeforeThisRelease };
    expect(merged.autoOpenDevServer).toBe(true);
  });

  // ...and that an explicit opt-out survives the same merge, or the toggle is
  // decorative: a stored `false` must beat the `true` default.
  it('lets a stored opt-out win over the default', () => {
    const merged = { ...DEFAULT_BROWSER_PREFS, ...{ autoOpenDevServer: false } };
    expect(merged.autoOpenDevServer).toBe(false);
  });
});
