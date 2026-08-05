/**
 * key-remaps.ts — the renderer's live view of `~/.wmux/config.toml`'s `[keys]`
 * section (issue #146).
 *
 * Deliberately a module-level list rather than store state: every terminal's
 * xterm key handler reads it on each keydown, and routing it through Zustand
 * would rebuild the terminal effect (and its PTY wiring) whenever the config
 * reloads. A getter keeps the read cheap and always current — the same reason
 * the dev-port config in App.tsx is a module variable.
 */
import { findKeyRemap, KeyRemap, ChordEvent } from '../shared/key-sequence';

let remaps: readonly KeyRemap[] = [];

/**
 * Replace the active remaps. Called with the whole list (never a patch) so
 * `wmux reload-config` is idempotent: deleting `[keys]` from the file really
 * does remove the bindings instead of leaving the last run's values sticky.
 */
export function setKeyRemaps(next: readonly KeyRemap[] | undefined): void {
  remaps = next ?? [];
}

export function getKeyRemaps(): readonly KeyRemap[] {
  return remaps;
}

/**
 * The bytes a remapped key should send, or null when the key is not remapped.
 *
 * Note the distinction the caller depends on: `''` is a real answer meaning
 * "swallow this key", while `null` means "not ours — let xterm handle it".
 */
export function remapKey(event: ChordEvent): string | null {
  if (remaps.length === 0) return null;
  return findKeyRemap(event, remaps)?.send ?? null;
}

/** The bits of a DOM KeyboardEvent the terminal-side handler cancels through. */
export interface RemapKeyEvent extends ChordEvent {
  type: string;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Terminal-side entry point: emit a remapped key and cancel the DOM event.
 * Returns true when the key was handled, so callers can
 * `if (applyKeyRemap(...)) return false;` out of xterm's key handler.
 *
 * Both cancellations matter and neither is redundant:
 *  - preventDefault stops the browser firing `keypress`, which xterm would
 *    otherwise turn into a second, un-remapped character (the duplicate-input
 *    bug issue #119 fixed for Shift+Enter).
 *  - stopPropagation stops the document-level shortcut listener, so remapping a
 *    chord that is also a wmux shortcut actually replaces it inside a terminal
 *    instead of doing both things.
 */
export function applyKeyRemap(event: RemapKeyEvent, emit: (data: string) => void): boolean {
  if (event.type !== 'keydown') return false;
  const send = remapKey(event);
  if (send === null) return false;
  event.preventDefault();
  event.stopPropagation();
  if (send) emit(send);
  return true;
}
