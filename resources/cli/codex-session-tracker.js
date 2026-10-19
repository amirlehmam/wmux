"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexSessionTracker = void 0;
/** Observe only replies to this terminal's requests, never background thread events. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const THREAD_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork']);
/**
 * Codex's reply to resuming a thread that has no conversation behind it
 * (0.163: JSON-RPC -32600 "no rollout found for thread id <id>"). A thread
 * whose history was migrated out of its rollout file still resumes; only one
 * that never had a turn answers this.
 */
const MISSING_THREAD = /\bno rollout found\b/i;
/** Bounds bookkeeping even if a broken client never receives replies. */
const MAX_TRACKED = 128;
/**
 * Requests that put something into a thread (app-server protocol v2: each
 * requires `threadId`). A message is the usual first one; /review, a `!` shell
 * command and injected items count too, so a real conversation is never missed.
 */
const FIRST_CONTENT = new Set(['turn/start', 'review/start', 'thread/shellCommand', 'thread/inject_items']);
class CodexSessionTracker {
    onSession;
    onMissing;
    pending = new Map();
    /**
     * Threads this client started that have not had a turn yet. Codex writes a
     * new conversation only once something is in it, so a thread reported at
     * `thread/start` — a tab opened on Codex and left empty — saved an id that no
     * `codex resume` could ever open. It is reported at its first turn instead.
     */
    unborn = new Set();
    sessionId;
    constructor(onSession, 
    /** A `thread/resume` this client asked for named a thread Codex does not have. */
    onMissing) {
        this.onSession = onSession;
        this.onMissing = onMissing;
    }
    request(text) {
        try {
            const message = JSON.parse(text);
            if (FIRST_CONTENT.has(message.method)) {
                const threadId = message.params?.threadId;
                if (typeof threadId === 'string' && this.unborn.delete(threadId))
                    this.adopt(threadId);
                return;
            }
            if (!THREAD_METHODS.has(message.method) || message.params?.ephemeral === true)
                return;
            if (typeof message.id !== 'string' && typeof message.id !== 'number')
                return;
            if (this.pending.size >= MAX_TRACKED)
                this.pending.delete(this.pending.keys().next().value);
            const threadId = message.params?.threadId;
            this.pending.set(message.id, { method: message.method, threadId: typeof threadId === 'string' ? threadId : undefined });
        }
        catch { /* Transport validation belongs to Codex. */ }
    }
    response(text) {
        try {
            const message = JSON.parse(text);
            const asked = this.pending.get(message.id);
            if (!asked)
                return;
            this.pending.delete(message.id);
            if (message.error) {
                const reason = String(message.error?.message ?? '');
                // Only the exact thread asked for, named in Codex's own answer.
                if (asked.method === 'thread/resume' && asked.threadId && MISSING_THREAD.test(reason) &&
                    reason.includes(asked.threadId))
                    this.onMissing?.(asked.threadId);
                return;
            }
            const thread = message.result?.thread;
            if (!thread || thread.ephemeral === true || thread.parentThreadId ||
                (typeof thread.source === 'object' && thread.source?.subAgent))
                return;
            if (typeof thread.id !== 'string' || !SESSION_ID.test(thread.id))
                return;
            if (asked.method === 'thread/start') {
                if (this.unborn.size >= MAX_TRACKED)
                    this.unborn.delete(this.unborn.values().next().value);
                this.unborn.add(thread.id);
                return;
            }
            this.adopt(thread.id);
        }
        catch { /* An unrecognised response must never erase a saved handle. */ }
    }
    // No dedupe here: a relay runs one tracker per connection and keeps ONE
    // saved id, so a tracker that skipped "the thread I saw last" would miss
    // the TUI switching back to A after a picker connection resumed B. The
    // caller dedupes against the id it actually saves.
    adopt(id) {
        this.sessionId = id;
        this.onSession(id);
    }
}
exports.CodexSessionTracker = CodexSessionTracker;
