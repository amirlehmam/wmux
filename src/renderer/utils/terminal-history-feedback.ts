import type { Translator } from '../i18n/core';

export type TerminalHistoryWarning = 'storage' | 'record' | 'restore' | 'capture' | 'cleanup' | 'settings' | 'state';

/** Only known categories cross into UI text; never forward payloads or exceptions. */
export function terminalHistoryWarning(error: unknown): TerminalHistoryWarning | null {
  switch (error) {
    case 'io': case 'session': case 'invalid-target': case 'checkpoint': case 'revision': return 'storage';
    case 'invalid-record': case 'unsafe-content': case 'unsupported-version': return 'record';
    case 'read': case 'replay': return 'restore';
    case 'capture': return 'capture';
    case 'cleanup': case 'settings': case 'state': return error;
    default: return null;
  }
}

export function terminalHistoryWarningText(category: TerminalHistoryWarning, t: Translator): string {
  switch (category) {
    case 'storage': return t('terminalHistory.storage', 'Terminal output could not be saved or read. Check available disk space and folder permissions; wmux will retry saves.');
    case 'record': return t('terminalHistory.record', 'Some terminal output could not be saved or restored because its format was not supported. Live terminals are unaffected.');
    case 'restore': return t('terminalHistory.restore', 'Some saved terminal output could not be restored. A fresh terminal will open instead.');
    case 'capture': return t('terminalHistory.capture', 'Some terminal output could not be captured for saving. Live terminals are unaffected; wmux will retry.');
    case 'cleanup': return t('terminalHistory.cleanup', 'Saved terminal output was not completely deleted. Old-generation output cannot be restored. Check folder permissions and try turning saving off again.');
    case 'settings': return t('terminalHistory.settings', 'The preference could not be saved. Saving and restoring are off for this run, but the previous preference may apply after restart. Check disk space and permissions, then try again.');
    case 'state': return t('terminalHistory.state', 'Terminal output saving is unavailable. Reopen Settings to retry; if it persists, restart wmux when convenient.');
  }
}

// Lifetime is this renderer session, not a checkpoint or pane. Success elsewhere
// must not re-arm a warning on the next periodic save. Keep early restore errors
// until App installs its bell subscriber.
const seen = new Set<TerminalHistoryWarning>();
const pending = new Set<TerminalHistoryWarning>();
const listeners = new Set<(category: TerminalHistoryWarning) => void>();

export function reportTerminalHistoryFailure(error: unknown): void {
  const category = terminalHistoryWarning(error);
  if (!category || seen.has(category)) return;
  seen.add(category);
  if (!listeners.size) pending.add(category);
  else for (const listener of listeners) listener(category);
}

export function onTerminalHistoryFailure(listener: (category: TerminalHistoryWarning) => void): () => void {
  listeners.add(listener);
  for (const category of pending) listener(category);
  pending.clear();
  return () => { listeners.delete(listener); };
}
