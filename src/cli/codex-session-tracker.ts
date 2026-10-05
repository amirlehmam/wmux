/** Observe only replies to this terminal's requests, never background thread events. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const THREAD_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork']);

export class CodexSessionTracker {
  private pending = new Set<string | number>();
  sessionId: string | undefined;

  constructor(private readonly onSession: (id: string) => void) {}

  request(text: string): void {
    try {
      const message = JSON.parse(text);
      if (!THREAD_METHODS.has(message.method) || message.params?.ephemeral === true) return;
      if (typeof message.id !== 'string' && typeof message.id !== 'number') return;
      // Bound bookkeeping even if a broken client never receives replies.
      if (this.pending.size >= 128) this.pending.delete(this.pending.values().next().value!);
      this.pending.add(message.id);
    } catch { /* Transport validation belongs to Codex. */ }
  }

  response(text: string): void {
    try {
      const message = JSON.parse(text);
      if (!this.pending.delete(message.id) || message.error) return;
      const thread = message.result?.thread;
      if (!thread || thread.ephemeral === true || thread.parentThreadId ||
          (typeof thread.source === 'object' && thread.source?.subAgent)) return;
      if (typeof thread.id !== 'string' || !SESSION_ID.test(thread.id)) return;
      // No dedupe here: a relay runs one tracker per connection and keeps ONE
      // saved id, so a tracker that skipped "the thread I saw last" would miss
      // the TUI switching back to A after a picker connection resumed B. The
      // caller dedupes against the id it actually saves.
      this.sessionId = thread.id;
      this.onSession(thread.id);
    } catch { /* An unrecognised response must never erase a saved handle. */ }
  }
}
