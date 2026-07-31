// ─── Shortcut binding value helpers (pure) ───────────────────────────────────
// One definition of "these two combos are the same", shared by the recorder's
// conflict detection (ShortcutRecorder.tsx) and the Settings shortcut filter
// (ShortcutFilterCapture.tsx). DOM- and React-free so it can be unit-tested in
// the node-environment suite (cf. hooks/shortcut-target.ts).
//
// `formatBinding` (the *display* string, e.g. "Ctrl+Shift+T") deliberately
// stays in KeyboardSettings.tsx — that's presentation, and is imported by the
// F1 cheat-sheet, which this module has no reason to touch.

import type { ShortcutBinding } from '../store/settings-slice';

/** Bare modifiers never complete a combo — they only decorate the next key. */
export const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Control', 'Alt', 'Shift', 'Meta']);

/** The subset of a keydown these helpers read; keeps callers/tests DOM-free. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Normalize a key for comparison. Shift uppercases `e.key` on Windows, so a
 * binding recorded as Ctrl+Shift+N is stored `key: 'N'` while e.g.
 * DEFAULT_SHORTCUTS uses `'n'` — single-character keys must compare
 * case-insensitively. This mirrors the exact rule
 * `useKeyboardShortcuts.ts`'s `matchesBinding` already applies at dispatch
 * time, so "what the filter shows" and "what the key actually does" can't
 * drift apart. Named keys ('ArrowLeft', 'F3', 'PageDown') compare verbatim.
 */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** True when two bindings are the same combo (key + all three modifiers). */
export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return normalizeKey(a.key) === normalizeKey(b.key)
    && !!a.ctrl === !!b.ctrl
    && !!a.shift === !!b.shift
    && !!a.alt === !!b.alt;
}

/** Build a binding from a keydown-like event; null for a bare modifier press. */
export function bindingFromEvent(e: KeyEventLike): ShortcutBinding | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  return {
    key: e.key,
    ctrl: e.ctrlKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
  };
}
