// ─── Numeric index shortcuts (issue #202) ────────────────────────────────────
// The matcher, the "9 means last" rule and the collision reconciliation are all
// pure, so they're testable without a DOM — same shape as shortcut-binding.

import { describe, it, expect } from 'vitest';
import {
  INDEX_MODIFIER_CHOICES,
  formatIndexShortcut,
  indexDigitFromEvent,
  matchIndexShortcut,
  reconcileIndexModifiers,
  resolveIndexTarget,
  type IndexKeyEventLike,
  type IndexModifiers,
} from '../../src/renderer/utils/index-shortcuts';

function ev(over: Partial<IndexKeyEventLike>): IndexKeyEventLike {
  return { key: '1', code: 'Digit1', ctrlKey: false, altKey: false, shiftKey: false, ...over };
}

describe('indexDigitFromEvent', () => {
  it('reads the physical digit row', () => {
    expect(indexDigitFromEvent(ev({ code: 'Digit4', key: '4' }))).toBe(4);
  });

  it('works on AZERTY, where the unshifted digit row does not emit digits', () => {
    // The old parseInt(e.key) returned NaN here, so Ctrl+1–9 never fired at all
    // for French/Belgian layouts.
    expect(indexDigitFromEvent(ev({ code: 'Digit1', key: '&' }))).toBe(1);
    expect(indexDigitFromEvent(ev({ code: 'Digit2', key: 'é' }))).toBe(2);
  });

  it('reads a shifted US digit row as the digit, not the symbol', () => {
    expect(indexDigitFromEvent(ev({ code: 'Digit1', key: '!', shiftKey: true }))).toBe(1);
  });

  it('still accepts the numpad, whose code is NumpadN', () => {
    expect(indexDigitFromEvent(ev({ code: 'Numpad7', key: '7' }))).toBe(7);
  });

  it('rejects 0 and non-digits', () => {
    expect(indexDigitFromEvent(ev({ code: 'Digit0', key: '0' }))).toBeNull();
    expect(indexDigitFromEvent(ev({ code: 'KeyA', key: 'a' }))).toBeNull();
  });

  it('survives an event with no code at all', () => {
    expect(indexDigitFromEvent({ key: '5', ctrlKey: false, altKey: false, shiftKey: false })).toBe(5);
  });
});

describe('matchIndexShortcut', () => {
  it('matches its own modifier triple', () => {
    expect(matchIndexShortcut(ev({ ctrlKey: true }), 'ctrl')).toBe(1);
    expect(matchIndexShortcut(ev({ altKey: true }), 'alt')).toBe(1);
    expect(matchIndexShortcut(ev({ ctrlKey: true, altKey: true }), 'ctrl-alt')).toBe(1);
    expect(matchIndexShortcut(ev({ ctrlKey: true, shiftKey: true }), 'ctrl-shift')).toBe(1);
    expect(matchIndexShortcut(ev({ altKey: true, shiftKey: true }), 'alt-shift')).toBe(1);
  });

  it('requires an EXACT triple, so the two families never swallow each other', () => {
    // Ctrl+Alt+1 must not read as a Ctrl+1 with an extra modifier — otherwise
    // the workspace family would eat every tab combo.
    expect(matchIndexShortcut(ev({ ctrlKey: true, altKey: true }), 'ctrl')).toBeNull();
    expect(matchIndexShortcut(ev({ ctrlKey: true }), 'ctrl-alt')).toBeNull();
    expect(matchIndexShortcut(ev({ ctrlKey: true, shiftKey: true }), 'ctrl')).toBeNull();
  });

  it('never matches when the family is off', () => {
    for (const mods of INDEX_MODIFIER_CHOICES) {
      const e = ev({ ctrlKey: true, altKey: true, shiftKey: true });
      if (mods === 'off') expect(matchIndexShortcut(e, mods)).toBeNull();
    }
    expect(matchIndexShortcut(ev({ ctrlKey: true }), 'off')).toBeNull();
  });

  it('ignores a bare modifier press', () => {
    expect(matchIndexShortcut(ev({ ctrlKey: true, key: 'Control', code: 'ControlLeft' }), 'ctrl')).toBeNull();
  });
});

describe('formatIndexShortcut', () => {
  it('renders modifiers in the Ctrl+Alt+Shift order the rest of the UI uses', () => {
    expect(formatIndexShortcut('ctrl')).toBe('Ctrl+1…9');
    expect(formatIndexShortcut('ctrl-alt')).toBe('Ctrl+Alt+1…9');
    expect(formatIndexShortcut('alt-shift')).toBe('Alt+Shift+1…9');
  });

  it('has no display string when the family is off', () => {
    expect(formatIndexShortcut('off')).toBeNull();
  });
});

describe('resolveIndexTarget', () => {
  it('maps 1–8 to their zero-based index', () => {
    expect(resolveIndexTarget(1, 5)).toBe(0);
    expect(resolveIndexTarget(5, 5)).toBe(4);
  });

  it('treats 9 as LAST, which is what README always promised', () => {
    expect(resolveIndexTarget(9, 14)).toBe(13);
    expect(resolveIndexTarget(9, 3)).toBe(2);
    // With exactly nine, "ninth" and "last" coincide — the old behaviour.
    expect(resolveIndexTarget(9, 9)).toBe(8);
  });

  it('is a no-op past the end', () => {
    expect(resolveIndexTarget(7, 3)).toBeNull();
    expect(resolveIndexTarget(1, 0)).toBeNull();
    expect(resolveIndexTarget(9, 0)).toBeNull();
  });
});

describe('reconcileIndexModifiers', () => {
  const defaults = { workspace: 'ctrl' as IndexModifiers, surface: 'ctrl-alt' as IndexModifiers };

  it('leaves a non-colliding change alone', () => {
    expect(reconcileIndexModifiers(defaults, { workspace: 'alt' }))
      .toEqual({ workspace: 'alt', surface: 'ctrl-alt' });
  });

  it('swaps rather than creating a dead binding — the issue’s headline case', () => {
    // "Ctrl+1–9 for tabs and Alt+1–9 for workspaces" in one click: giving the
    // surface family Ctrl hands its old Ctrl+Alt back to workspaces.
    expect(reconcileIndexModifiers(defaults, { surface: 'ctrl' }))
      .toEqual({ workspace: 'ctrl-alt', surface: 'ctrl' });
  });

  it('lets both families be off at once', () => {
    const bothOff = reconcileIndexModifiers({ workspace: 'off', surface: 'ctrl-alt' }, { surface: 'off' });
    expect(bothOff).toEqual({ workspace: 'off', surface: 'off' });
  });

  it('does not resurrect a combo when one family is switched off', () => {
    expect(reconcileIndexModifiers(defaults, { workspace: 'off' }))
      .toEqual({ workspace: 'off', surface: 'ctrl-alt' });
  });

  it('disables the surface family when a caller sets both to the same value', () => {
    // No "other" field to move the collision into — a hand-edited settings.json
    // reaches this path. One owner beats two.
    expect(reconcileIndexModifiers(defaults, { workspace: 'alt', surface: 'alt' }))
      .toEqual({ workspace: 'alt', surface: 'off' });
  });

  it('repairs a collision already on disk (empty patch)', () => {
    expect(reconcileIndexModifiers({ workspace: 'ctrl', surface: 'ctrl' }, {}))
      .toEqual({ workspace: 'ctrl', surface: 'off' });
  });
});
