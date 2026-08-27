import { useStore } from './index';
import { release as releaseAnchor } from '../utils/prompt-anchor';
import { surfaceTerminalRegistry } from '../hooks/useTerminal';
import type { PromptEntry } from './prompt-slice';

/**
 * The three prompt-log commands (issue #207), as functions of a surface id.
 *
 * Split out of `useKeyboardShortcuts` because there are two entry points, and
 * they were about to disagree. The keyboard path resolves the focused surface
 * from the split tree inside a closure; the command palette resolves it in
 * App.tsx from different state. Everything AFTER that — which store fields to
 * read, what "toggle" means when the preference is off, whether pinning also
 * turns the sticky header on — is one decision each, and one decision belongs
 * in one place.
 *
 * That mattered immediately: the palette hands every action it does not
 * recognise to a `console.log`, so an action wired only into the keyboard table
 * appears in the palette, is selectable, and silently does nothing.
 */

/** Open the outline on this surface, or close it if it is already open here. */
export function togglePromptOutlineFor(surfaceId: string | null): void {
  if (!surfaceId) return;
  const state = useStore.getState();
  if (!state.promptPrefs.enabled || !state.promptPrefs.outline) return;
  // Opening on a second pane closes the first: two open outlines would both
  // answer Escape and the arrow keys, and there is one keyboard.
  state.setPromptOutlineSurface(state.promptOutlineSurface === surfaceId ? null : surfaceId);
}

/**
 * The one place that says what "pin this prompt" DOES.
 *
 * Turning the sticky header on when it is off is half of the meaning, not a
 * courtesy: a gesture whose only effect is to set a preference the user must
 * then find in Settings before anything appears is a gesture that looks broken
 * — and the user who made it has just said what they want. `pin` ships off by
 * default (see DEFAULT_PROMPT_PREFS), so on a fresh install this is the branch
 * that runs, every time.
 *
 * Private, and every entry point below goes through it, because that rule was
 * written down in exactly one of the two callers and the outline's 📌 button
 * therefore did nothing at all on default settings (#207 review).
 */
function pinEntry(surfaceId: string, entry: PromptEntry): void {
  const state = useStore.getState();
  state.setPinnedPrompt(surfaceId, entry);
  if (!state.promptPrefs.pin) state.setPromptPrefs({ pin: true });
}

/**
 * Pin the latest prompt by hand, or drop an existing hand-pin.
 *
 * The keyboard/palette entry point, so it has no entry to name: ANY hand-pin on
 * this surface is what its "toggle" undoes.
 */
export function togglePinnedPromptFor(surfaceId: string | null): void {
  if (!surfaceId) return;
  const state = useStore.getState();
  if (!state.promptPrefs.enabled) return;
  if (state.pinnedPrompts[surfaceId]) {
    state.setPinnedPrompt(surfaceId, null);
    return;
  }
  const entries = state.prompts[surfaceId] ?? [];
  const latest = entries[entries.length - 1];
  if (!latest) return;
  pinEntry(surfaceId, latest);
}

/**
 * Pin one NAMED prompt by hand, or unpin it when it is already the pinned one.
 *
 * The outline's per-row entry point. It differs from the command above in one
 * way only — which prompt "toggle" is about — and that difference is the reason
 * it exists rather than being folded in: a row's 📌 must undo THAT row, not
 * whatever pin happens to be current, or clicking a second row would silently
 * clear the first instead of moving the pin.
 */
export function togglePinnedPromptEntry(surfaceId: string | null, entry: PromptEntry): void {
  if (!surfaceId) return;
  const state = useStore.getState();
  if (!state.promptPrefs.enabled) return;
  if (state.pinnedPrompts[surfaceId]?.id === entry.id) {
    state.setPinnedPrompt(surfaceId, null);
    return;
  }
  pinEntry(surfaceId, entry);
}

/**
 * Give up an anchored viewport and follow output again.
 *
 * Unconditional on the preference: `anchor` governs whether new prompts anchor,
 * not whether the user may escape one that already has. A user who turns the
 * preference off while a pane is held would otherwise be stuck.
 */
export function followOutputFor(surfaceId: string | null): void {
  if (!surfaceId) return;
  releaseAnchor(surfaceId, surfaceTerminalRegistry.get(surfaceId));
}
