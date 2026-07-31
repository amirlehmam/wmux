// ─── Shared "click, then press a combo" capture hook ──────────────────────────
// Backs both ShortcutRecorder (rebinds a shortcut) and ShortcutFilterCapture
// (filters the Settings list by an exact binding) — same interaction, two
// different things done with the result, so the DOM plumbing lives here once.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShortcutBinding } from '../store/settings-slice';
import { bindingFromEvent } from '../utils/shortcut-binding';

// ─── Single-capture coordinator ──────────────────────────────────────────────
// At most ONE control may be listening for a raw key combo at a time. Both a
// per-row ShortcutRecorder and the Settings shortcut filter attach a
// capture-phase keydown listener on `document`, and stopPropagation() does
// NOT stop a sibling listener on the same target from also firing — only
// stopImmediatePropagation() does, and even that runs in *attach* order, not
// "whichever the user clicked last". So exclusivity is enforced structurally
// here instead: starting a capture cancels the previous one, whose effect
// cleanup then removes its listener, leaving exactly one attached.
//
// Transient UI coordination, never persisted — deliberately not in the store.

let activeCancel: (() => void) | null = null;

function acquire(cancel: () => void): void {
  if (activeCancel && activeCancel !== cancel) activeCancel();
  activeCancel = cancel;
}

function release(cancel: () => void): void {
  // Guarded: a pre-empted capture's cleanup runs *after* the new owner
  // registered, and must not clear it.
  if (activeCancel === cancel) activeCancel = null;
}

export interface KeyCaptureOptions {
  /** A complete (non-modifier) combo was pressed. Capture has already stopped. */
  onCapture: (binding: ShortcutBinding, event: KeyboardEvent) => void;
  /** Escape, pre-emption by another capture, or unmount while listening. */
  onCancel?: () => void;
}

export interface KeyCapture {
  capturing: boolean;
  start: () => void;
  cancel: () => void;
}

export function useKeyCapture({ onCapture, onCancel }: KeyCaptureOptions): KeyCapture {
  const [capturing, setCapturing] = useState(false);

  // Callbacks read through a ref so the document listener is attached exactly
  // once per capture session, however often the caller re-renders.
  const cbs = useRef({ onCapture, onCancel });
  useEffect(() => { cbs.current = { onCapture, onCancel }; });

  // Stable identity — this closure is the coordinator's token.
  const cancel = useCallback(() => {
    setCapturing(false);
    cbs.current.onCancel?.();
  }, []);

  const start = useCallback(() => {
    acquire(cancel); // cancels whoever was listening before
    setCapturing(true);
  }, [cancel]);

  useEffect(() => {
    if (!capturing) return;

    function handleKeyDown(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(false); cbs.current.onCancel?.(); return; }
      const binding = bindingFromEvent(e);
      if (!binding) return; // bare modifier — keep listening
      setCapturing(false);
      cbs.current.onCapture(binding, e);
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      release(cancel); // covers stop, Escape, pre-emption and unmount alike
    };
  }, [capturing, cancel]);

  return { capturing, start, cancel };
}
