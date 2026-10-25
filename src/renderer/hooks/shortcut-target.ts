// ─── Editable-focus guard for global shortcuts (issue #116) ──────────────────
// Split out of useKeyboardShortcuts so it can be unit-tested without mounting
// React or a DOM: the functions only touch a handful of properties on the event
// target, which a plain object can stand in for.

import type { ShortcutAction } from '../store/settings-slice';

/**
 * Actions that still fire while a text field has focus. Everything else defers
 * to the field, so typing in a settings input, the tab-rename box or a markdown
 * pane isn't hijacked by a global binding — and, just as importantly, isn't
 * swallowed by the document-level preventDefault in the shortcut handler.
 *
 * Deliberately short: window/workspace-level navigation, none of which means
 * anything to a text field.
 */
export const GLOBAL_IN_EDITOR: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'commandPalette',
  'openSettings',
  'newWindow',
  'closeWindow',
  'nextWorkspace',
  'prevWorkspace',
  'toggleSidebar',
  'toggleShortcutCheatSheet',
  'showNotifications',
  // The prompt outline's own filter box is a text field (issue #207), so
  // without this its toggle stops working the moment the panel it opened takes
  // focus — the one place a user is most likely to press it again.
  'togglePromptOutline',
  // Tab cycling (#249). Its default is now Ctrl+Tab, which no text field uses,
  // and a browser switches tabs on it from inside a textarea — which is where a
  // user editing a code or markdown tab is standing when they reach for it.
  'nextSurface',
  'prevSurface',
]);

/** The subset of an event target this guard needs; keeps the tests DOM-free. */
export interface EditableTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/**
 * True when a keystroke is destined for a real text field.
 *
 * The subtlety this exists for: xterm.js renders its focus target as a
 * `<textarea class="xterm-helper-textarea">`. A naive `tagName === 'TEXTAREA'`
 * check would therefore classify every focused terminal as an editor and
 * disable the entire global shortcut set — i.e. the normal case. Anything
 * inside `.xterm` is excluded before the tag check for exactly that reason.
 */
export function isEditableTarget(target: EditableTargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.closest?.('.xterm')) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
}

/**
 * Actions a held chord must run once, not once per auto-repeat keydown.
 *
 * Most bindings want the repeat (resizing a pane, stepping the font size), so
 * this is opt-in. Reset terminal state is in it because a second press within
 * a few seconds of one that kept the alternate screen forces it off (#357),
 * and Windows starts repeating a held key well inside that window: holding
 * Ctrl+Shift+R would force a live program off its screen, which is #347.
 */
export const IGNORES_KEY_REPEAT: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'resetTerminal',
]);
