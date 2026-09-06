// ─── KeyboardPrefs write path ────────────────────────────────────────────────
// applyIndexModifiers is the chokepoint both loadKeyboardPrefs and
// setKeyboardPrefs funnel through. It used to coerce only on the load side, so
// a caller-supplied patch (the CLI, a settings import) could seat a value that
// was never in IndexModifiers. MODIFIER_TRIPLE[thatValue] is undefined, and
// matchIndexShortcut read .ctrl off it on EVERY keydown -> the root
// ErrorBoundary blanked the renderer. Observed in the wild as
// "Cannot read properties of undefined (reading 'ctrl')" from handleIndexKey.

import { describe, it, expect } from 'vitest';
import { applyIndexModifiers, DEFAULT_KEYBOARD_PREFS, type KeyboardPrefs } from '../../src/renderer/store/settings-slice';
import { INDEX_MODIFIER_CHOICES, type IndexModifiers } from '../../src/renderer/utils/index-shortcuts';

const valid = (p: KeyboardPrefs) =>
  INDEX_MODIFIER_CHOICES.includes(p.workspaceIndexModifiers) &&
  INDEX_MODIFIER_CHOICES.includes(p.surfaceIndexModifiers);

const junk = ['ctrl-shift-alt', '', 'CTRL', 'Ctrl', null, 42, {}] as unknown as IndexModifiers[];

describe('applyIndexModifiers', () => {
  it('never lets an unknown patch value into the result', () => {
    for (const bad of junk) {
      const out = applyIndexModifiers(DEFAULT_KEYBOARD_PREFS, { workspaceIndexModifiers: bad });
      expect(valid(out), `patch workspace=${String(bad)}`).toBe(true);
      const out2 = applyIndexModifiers(DEFAULT_KEYBOARD_PREFS, { surfaceIndexModifiers: bad });
      expect(valid(out2), `patch surface=${String(bad)}`).toBe(true);
    }
  });

  it('heals a base that is already poisoned', () => {
    // The session this was found in had a bad value seated in the live store,
    // not in settings.json — so the next write must clean it, not preserve it.
    const poisoned = { workspaceIndexModifiers: 'bogus', surfaceIndexModifiers: 'off' } as unknown as KeyboardPrefs;
    const out = applyIndexModifiers(poisoned, {});
    expect(valid(out)).toBe(true);
    expect(out.workspaceIndexModifiers).toBe(DEFAULT_KEYBOARD_PREFS.workspaceIndexModifiers);
  });

  it('still passes through every legitimate value', () => {
    for (const good of INDEX_MODIFIER_CHOICES) {
      const out = applyIndexModifiers(DEFAULT_KEYBOARD_PREFS, { workspaceIndexModifiers: good });
      expect(out.workspaceIndexModifiers).toBe(good);
    }
  });

  it('keeps the collision swap working (undefined still means "not set")', () => {
    // reconcileIndexModifiers keys its swap on which field the caller omitted,
    // so coercion must not turn an absent field into a present one.
    const base: KeyboardPrefs = { workspaceIndexModifiers: 'ctrl', surfaceIndexModifiers: 'ctrl-alt' };
    const out = applyIndexModifiers(base, { surfaceIndexModifiers: 'ctrl' });
    expect(out.surfaceIndexModifiers).toBe('ctrl');
    expect(out.workspaceIndexModifiers).toBe('ctrl-alt'); // swapped, not duplicated
  });
});
