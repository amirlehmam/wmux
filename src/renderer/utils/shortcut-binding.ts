// ─── Shortcut binding value helpers (pure) ───────────────────────────────────
// One definition of "these two combos are the same", shared by the recorder's
// conflict detection (ShortcutRecorder.tsx) and the Settings shortcut filter
// (ShortcutFilterCapture.tsx). DOM- and React-free so it can be unit-tested in
// the node-environment suite (cf. hooks/shortcut-target.ts).
//
// `formatBinding` (the *display* string, e.g. "Ctrl+Shift+T") deliberately
// stays in KeyboardSettings.tsx — that's presentation, and is imported by the
// F1 cheat-sheet, which this module has no reason to touch.

import { matchIndexShortcut, type IndexKeyEventLike } from './index-shortcuts';
import type { ShortcutBinding, ShortcutAction, KeyboardPrefs } from '../store/settings-slice';

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

// ─── "Does wmux claim this keystroke?" (issue: Ctrl+N dead over a terminal) ──
// Lives here, next to bindingsEqual, because TWO callers must agree on the
// answer or keys get swallowed by neither side:
//
//   1. useKeyboardShortcuts' document-level keydown listener, which decides
//      whether to run an action, and
//   2. useTerminal's xterm custom key handler, which decides whether to let the
//      event bubble out of the terminal at all.
//
// If (2) releases a key that (1) then declines, the keystroke reaches nothing.
// One predicate, imported by both, makes that state unrepresentable.

/**
 * Bare-Ctrl keys wmux takes even when a terminal has focus.
 *
 * Every other `Ctrl+<key>` with no Shift/Alt belongs to the shell: Ctrl+A/E
 * (line start/end), Ctrl+R (reverse search), Ctrl+U/K (kill line) and friends
 * are muscle memory, and a global binding that ate them would make the terminal
 * unusable. Ctrl+Shift+* and Ctrl+Alt+* are free by construction — a terminal
 * has no meaning for them.
 */
export const SAFE_CTRL_KEYS: ReadonlySet<string> = new Set(['b', 'd', 'n', 't', 'w', 'f', ',']);

/** True when intercepting `e` would not steal a keystroke the shell needs. */
export function isSafeToIntercept(e: KeyEventLike): boolean {
  if (!e.ctrlKey) return true; // Not a Ctrl combo — always safe

  // Ctrl+Shift+* and Ctrl+Alt+* are safe (terminal uses bare Ctrl combos)
  if (e.shiftKey || e.altKey) return true;

  // Ctrl+PageDown / Ctrl+PageUp are safe
  if (e.key === 'PageDown' || e.key === 'PageUp') return true;

  // Ctrl+F2 is safe (rename)
  if (e.key === 'F2') return true;

  // Ctrl+F12 is safe (dev tools)
  if (e.key === 'F12') return true;

  // Ctrl+= / Ctrl+- / Ctrl+0 are safe (font size)
  if (e.key === '=' || e.key === '-' || e.key === '0') return true;

  // Specifically whitelisted bare Ctrl keys
  if (SAFE_CTRL_KEYS.has(e.key.toLowerCase())) return true;

  return false;
}

/** A keydown as both matchers read it — `code` only matters to the digit row. */
export type ShortcutKeyEvent = KeyEventLike & { code?: string };

/**
 * True when some document-level wmux listener will act on this keystroke.
 *
 * Covers both families that live on `document`: the rebindable ShortcutAction
 * table, and the numeric index rows (`Ctrl+1…9` / `Ctrl+Alt+1…9`). The index
 * check comes FIRST and deliberately skips `isSafeToIntercept`, mirroring its
 * listener — that handler preventDefaults an index combo unconditionally, so
 * digits like Ctrl+3 (which xterm would otherwise turn into ESC) are claimed
 * even though `3` is not a "safe" bare-Ctrl key.
 */
export function claimsKeyEvent(
  e: ShortcutKeyEvent,
  shortcuts: Readonly<Partial<Record<ShortcutAction, ShortcutBinding>>>,
  keyboardPrefs: Pick<KeyboardPrefs, 'workspaceIndexModifiers' | 'surfaceIndexModifiers'>,
): boolean {
  const indexEvent = e as IndexKeyEventLike;
  if (matchIndexShortcut(indexEvent, keyboardPrefs.workspaceIndexModifiers) !== null) return true;
  if (matchIndexShortcut(indexEvent, keyboardPrefs.surfaceIndexModifiers) !== null) return true;

  // Bare function keys included. Three bindings are bare (F1 cheat sheet,
  // F3/Shift+F3 find next/previous) and xterm turns those into escape
  // sequences, so they were dead over a focused terminal exactly like Ctrl+N.
  //
  // F1 is the case that decides this. It opens the shortcut cheat sheet — the
  // one screen whose entire job is telling you what the other keys do — and a
  // terminal is where you are standing when you need it. Leaving it to the PTY
  // makes the feature undiscoverable in the app's default state, which is worse
  // than the cost: F1 is also "help" in some full-screen TUIs, and they no
  // longer receive it. The binding is deliberate and documented, so it should
  // work where it is documented to work.
  // A bare key may only be claimed if it is a NAMED key (F1, F3, PageUp...).
  // Single-character keys are what typing is made of, and useKeyCapture happily
  // records a bare letter as a binding — with no modifier required and no
  // warning — so without this a rebind to `a` would swallow every `a` the user
  // types into the shell. Named keys carry no such risk: nothing types F3.
  if (!e.ctrlKey && !e.altKey && e.key.length === 1) return false;

  if (!isSafeToIntercept(e)) return false;
  const pressed = bindingFromEvent(e);
  if (!pressed) return false;
  return Object.values(shortcuts).some((b) => !!b && bindingsEqual(pressed, b));
}
