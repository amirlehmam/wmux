/** Desktop-only website dictation. Audio and credentials never cross this bridge. */
export type DictationPhase = 'idle' | 'starting' | 'recording' | 'processing' | 'cancelling' | 'error';
export type DictationAccount = 'unknown' | 'signed-out' | 'signed-in';
export type DictationError = 'login-required' | 'page-changed' | 'draft-not-empty' | 'microphone-unavailable' | 'transcription-failed' | 'timeout' | 'target-closed' | 'no-terminal' | 'unsafe-text' | 'cancelled';
export interface DictationDevice { id: string; label: string }
export interface DictationState {
  phase: DictationPhase;
  account: DictationAccount;
  surfaceId?: string;
  error?: DictationError;
  transcript?: string;
  deviceId: string;
}
export interface DictationResult { id: string; surfaceId: string; binding: string; text: string }
export type DictationCommand =
  | { action: 'state' | 'refresh' | 'stop' | 'cancel' | 'account' | 'devices' }
  | { action: 'start'; surfaceId: string; binding: string }
  | { action: 'device'; deviceId: string };
export interface DictationBridge {
  command(command: DictationCommand): Promise<DictationState | DictationDevice[]>;
  onState(callback: (state: DictationState) => void): () => void;
}
export function dictationError(error: unknown): DictationError {
  const message = error instanceof Error ? error.message : '';
  const known: DictationError[] = ['login-required','page-changed','draft-not-empty','microphone-unavailable','transcription-failed','timeout','target-closed','no-terminal','unsafe-text','cancelled'];
  return known.find(code => message === code) ?? 'transcription-failed';
}

/** Flatten line breaks: even shells without bracketed paste must never execute. */
export function safeDictationText(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 100_000) throw new Error('unsafe-text');
  const text = raw.replace(/\r\n?|\n|\t/g, ' ').trim();
  // Reject C0/C1 controls, including Escape and the bracketed-paste terminator.
  if ([...text].some(c => { const n = c.charCodeAt(0); return n < 32 || (n >= 127 && n <= 159); })) throw new Error('unsafe-text');
  if (!text) throw new Error('transcription-failed');
  return text;
}
