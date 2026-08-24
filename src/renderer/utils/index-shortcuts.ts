// ─── Numeric index shortcuts (issue #202) — pure ─────────────────────────────
// `Ctrl+1…9` (select workspace N) and `Ctrl+Alt+1…9` (select tab N) used to be
// two hardcoded keydown listeners with no way to rebind or turn them off. The
// source comment gave the reason: nine remappable ShortcutAction entries each
// would have added ~18 rows to Settings for what is really ONE decision per
// family — "which modifiers carry the digit row, if any".
//
// So this is not a ShortcutAction. It is a modifier *mode* per family, which
// buys everything the issue asked for (remap, swap the two, disable either one)
// in two Settings rows instead of eighteen.
//
// DOM-free on purpose (cf. shortcut-binding.ts) so the node-environment Vitest
// suite can exercise the matcher without jsdom.

/**
 * Which modifiers must be held for the digit row to act as an index jump.
 * `'off'` disables that family entirely — the third option the issue asked for,
 * and the only value that lets the digits reach the terminal untouched.
 */
export type IndexModifiers = 'ctrl' | 'alt' | 'ctrl-alt' | 'ctrl-shift' | 'alt-shift' | 'off';

/** Every selectable value, in the order the Settings dropdown lists them. */
export const INDEX_MODIFIER_CHOICES: readonly IndexModifiers[] = [
  'ctrl', 'alt', 'ctrl-alt', 'ctrl-shift', 'alt-shift', 'off',
] as const;

/** The exact modifier triple each mode requires. `off` never matches. */
const MODIFIER_TRIPLE: Record<Exclude<IndexModifiers, 'off'>, { ctrl: boolean; alt: boolean; shift: boolean }> = {
  'ctrl':       { ctrl: true,  alt: false, shift: false },
  'alt':        { ctrl: false, alt: true,  shift: false },
  'ctrl-alt':   { ctrl: true,  alt: true,  shift: false },
  'ctrl-shift': { ctrl: true,  alt: false, shift: true  },
  'alt-shift':  { ctrl: false, alt: true,  shift: true  },
};

/** The subset of a keydown this module reads; keeps callers/tests DOM-free. */
export interface IndexKeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Display string for a mode, e.g. `"Ctrl+Alt+1…9"`. `off` renders as `null`. */
export function formatIndexShortcut(mods: IndexModifiers): string | null {
  if (mods === 'off') return null;
  const triple = MODIFIER_TRIPLE[mods];
  const parts: string[] = [];
  if (triple.ctrl) parts.push('Ctrl');
  if (triple.alt) parts.push('Alt');
  if (triple.shift) parts.push('Shift');
  parts.push('1…9');
  return parts.join('+');
}

/**
 * Which digit (1–9) this event carries, or null.
 *
 * Reads `e.code` first and only falls back to `e.key`. Two reasons, both real:
 *
 *  - `e.key` is layout-dependent. On AZERTY the unshifted digit row emits
 *    `&é"'(-è_ç`, so the old `parseInt(e.key, 10)` returned NaN and Ctrl+1…9
 *    never fired at all for those users.
 *  - Any Shift-carrying mode has the same problem on US layouts (`Shift+1` is
 *    `!`), which would make `ctrl-shift` / `alt-shift` unselectable.
 *
 * The `e.key` fallback is what keeps the NUMPAD working: its physical codes are
 * `Numpad1…9`, but with NumLock on `e.key` is still the plain digit.
 */
export function indexDigitFromEvent(e: IndexKeyEventLike): number | null {
  const fromCode = /^Digit([1-9])$/.exec(e.code ?? '');
  if (fromCode) return Number(fromCode[1]);
  const k = e.key;
  if (k.length === 1 && k >= '1' && k <= '9') return Number(k);
  return null;
}

/**
 * The digit this event selects under `mods`, or null when it isn't an index
 * jump at all. Modifiers must match EXACTLY — `ctrl` mode deliberately rejects
 * Ctrl+Alt+3 so the two families can coexist on the same digit row without one
 * swallowing the other's combos.
 */
export function matchIndexShortcut(e: IndexKeyEventLike, mods: IndexModifiers): number | null {
  if (mods === 'off') return null;
  const triple = MODIFIER_TRIPLE[mods];
  if (e.ctrlKey !== triple.ctrl || e.altKey !== triple.alt || e.shiftKey !== triple.shift) return null;
  return indexDigitFromEvent(e);
}

/**
 * Digit → array index, or null when there is nothing to select.
 *
 * `9` means LAST, not "the ninth". That is what README has always documented
 * ("Ctrl+9 — Jump to last workspace") while the code selected `workspaces[8]`,
 * and it is what every browser and editor does with the same combo. With nine
 * or fewer items the two readings coincide, so this only changes what happens
 * past nine — where selecting the ninth of fourteen was never the useful answer.
 */
export function resolveIndexTarget(digit: number, count: number): number | null {
  if (count <= 0) return null;
  if (digit === 9) return count - 1;
  const idx = digit - 1;
  return idx < count ? idx : null;
}

/**
 * Reconcile a change so the two families can never both own the same combo.
 *
 * Assigning a mode that the other family already holds SWAPS them rather than
 * creating a dead binding. This is the issue's headline scenario — "Ctrl+1–9
 * for tabs and Alt+1–9 for workspaces" — reduced to a single click: picking
 * `ctrl` for tabs hands the tabs' old `ctrl-alt` back to workspaces.
 *
 * `off` is exempt: both families may be off at once, and turning one off must
 * not resurrect a combo on the other.
 */
export function reconcileIndexModifiers(
  prev: { workspace: IndexModifiers; surface: IndexModifiers },
  patch: Partial<{ workspace: IndexModifiers; surface: IndexModifiers }>,
): { workspace: IndexModifiers; surface: IndexModifiers } {
  const next = { ...prev, ...patch };
  if (next.workspace === 'off' || next.surface === 'off') return next;
  if (next.workspace !== next.surface) return next;

  // Collision: whichever field the caller did NOT set gives way to the other's
  // previous value. If the caller set both at once, there is no "other" to move
  // — turn the surface family off rather than leave a combo with two owners.
  if (patch.workspace !== undefined && patch.surface === undefined) return { ...next, surface: prev.workspace };
  if (patch.surface !== undefined && patch.workspace === undefined) return { ...next, workspace: prev.surface };
  return { ...next, surface: 'off' };
}
