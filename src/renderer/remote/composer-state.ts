/**
 * The composer and the key bar as pure state machines (#254).
 *
 * The composer is where a phone types into somebody's agent, so the two
 * failure modes it must not have are "typed twice" and "typed into a question
 * it did not see". Both are decided here, without a DOM:
 *
 *   idle ──submit──▶ sending ──ack ok──▶ acked            (draft cleared HERE, and only here)
 *     │                 ├──ack confirm──▶ confirm(kind) ──accept──▶ sending (same nonce, force)
 *     │                 └──ack refused──▶ failed(code)       └──cancel──▶ idle
 *     └──submit while blocked──▶ confirm('blocked')   (client pre-arm; Insert = force, no Enter)
 *
 * "Draft cleared only on ack ok" is the send-once half: a `sending` that never
 * hears back (socket died mid-flight) keeps the text in the box AND keeps the
 * frame pending in ws-client, which resends it with the same nonce — so the
 * worst case is a duplicate ack, never a duplicate write and never lost text.
 *
 * Why "Insert" while blocked: a blocked agent is waiting on a choice, and text
 * followed by Enter is exactly the keystroke that answers it. The server
 * guards the same case (`confirm:'blocked'`, #128), but only for DECLARED
 * blocked state; a DETECTED one has no record in main to guard (spec §0.10),
 * so the client pre-arms from the roster as the second layer. Insert types the
 * text without the trailing Enter, which leaves the answer to the human.
 */

import type { AckCode, ConfirmKind, RemoteAgentState, RemoteKey } from '../../shared/remote-console-protocol';

// ── Composer ──────────────────────────────────────────────────────────────

/**
 * What will be (re)sent. Held across a confirm so the resend is byte-identical
 * but for `force` — the confirms accepted so far, one per kind. Accepting one
 * never waives another: the server asks each question on its own (#254).
 */
export interface ComposerFrame {
  nonce: string;
  text: string;
  submit: boolean;
  force: ConfirmKind[];
}

export type ComposerPhase = 'idle' | 'sending' | 'acked' | 'confirm' | 'failed';

/**
 * Why a send failed. `unconfirmed` is not an AckCode: no ack ever came, and the
 * frame was too old to resend (ws-client rule 4) — it may have been typed.
 */
export type ComposerFailure = AckCode | 'unconfirmed';

export interface ComposerState {
  phase: ComposerPhase;
  draft: string;
  frame: ComposerFrame | null;
  confirm: ConfirmKind | null;
  code: ComposerFailure | null;
  /** The last send landed but its Enter was withheld (the agent went blocked meanwhile). */
  submitSkipped: boolean;
}

export type ComposerAction =
  | { type: 'edit'; text: string }
  /**
   * `maxText`: the welcome's limit. Checked HERE, before any frame exists: a
   * text past it is refused locally as `too-long`, the way the server would —
   * except that the server never gets the chance for a long enough paste,
   * because ws closes the socket (1009) on a frame over 64 KiB before the
   * session reads it, and ws-client then resent it after every reconnect.
   */
  | { type: 'submit'; nonce: string; blocked: boolean; maxText?: number }
  | { type: 'ack'; nonce: string; ok: boolean; code?: AckCode; confirm?: ConfirmKind; submitSkipped?: boolean }
  | { type: 'accept' }
  | { type: 'cancel' }
  /**
   * The request itself failed; the text stays. `unconfirmed`: it was sent and
   * never acked, so it may have landed (ws-client rule 4) — the UI must not
   * call that "could not send", or the user types it a second time.
   */
  | { type: 'error'; unconfirmed?: boolean };

export const initialComposer = (draft = ''): ComposerState => ({
  phase: 'idle', draft, frame: null, confirm: null, code: null, submitSkipped: false,
});

/** Can the button be pressed at all? */
export function canSubmit(s: ComposerState, blocked: boolean): boolean {
  if (s.phase === 'sending' || s.phase === 'confirm') return false;
  // An empty Send is a bare Enter, which is a useful thing to send; an empty
  // Insert types nothing and would only arm a confirm for no reason.
  return !(blocked && s.draft.length === 0);
}

export type ComposerLabel = 'send' | 'insert' | 'sending' | 'enter';

/**
 * What the button IS. `enter` (#266): the agent is waiting on an answer and
 * the box is empty, so there is nothing to insert — and the button used to sit
 * there disabled, in the one place a phone user looks for "send", while the
 * agent's own menu said "enter select". It is the key bar's Enter instead: the
 * same frame, the same arming, the same server guards (see AttachScreen), so
 * this adds a place to press it and no new way to answer.
 */
export function composerLabel(s: ComposerState, blocked: boolean): ComposerLabel {
  if (s.phase === 'sending') return 'sending';
  if (!blocked) return 'send';
  return s.draft.length === 0 && s.phase !== 'confirm' ? 'enter' : 'insert';
}

function onSubmit(s: ComposerState, nonce: string, blocked: boolean, maxText?: number): ComposerState {
  if (!canSubmit(s, blocked)) return s;
  // The same count the session makes (UTF-16 code units, before sanitising).
  if (maxText !== undefined && s.draft.length > maxText) {
    return { ...s, phase: 'failed', code: 'too-long', confirm: null, frame: null, submitSkipped: false };
  }
  if (blocked) {
    return {
      ...s,
      phase: 'confirm',
      confirm: 'blocked',
      code: null,
      frame: { nonce, text: s.draft, submit: false, force: [] },
    };
  }
  return {
    ...s,
    phase: 'sending',
    confirm: null,
    code: null,
    frame: { nonce, text: s.draft, submit: true, force: [] },
  };
}

function onAck(s: ComposerState, a: Extract<ComposerAction, { type: 'ack' }>): ComposerState {
  // A late ack for a frame the user already moved past is not ours to act on.
  if (s.phase !== 'sending' || !s.frame || s.frame.nonce !== a.nonce) return s;
  // Clear what was SENT, not what is in the box: text typed while the frame
  // was in flight is a new draft, and wiping it would lose it.
  if (a.ok) {
    const draft = s.draft === s.frame.text ? '' : s.draft;
    return { ...s, phase: 'acked', draft, frame: null, confirm: null, code: null, submitSkipped: a.submitSkipped === true };
  }
  if (a.code === 'confirm' && a.confirm) {
    return { ...s, phase: 'confirm', confirm: a.confirm, code: null };
  }
  return { ...s, phase: 'failed', code: a.code ?? 'write-failed', confirm: null };
}

function onAccept(s: ComposerState): ComposerState {
  if (s.phase !== 'confirm' || !s.frame) return s;
  // A blocked confirm becomes an Insert: the text lands, the Enter does not.
  // Multiline and interrupt keep what the user asked for, plus force.
  const submit = s.confirm === 'blocked' ? false : s.frame.submit;
  const force = s.confirm && !s.frame.force.includes(s.confirm) ? [...s.frame.force, s.confirm] : s.frame.force;
  return { ...s, phase: 'sending', frame: { ...s.frame, submit, force }, confirm: null };
}

export function composerReducer(s: ComposerState, a: ComposerAction): ComposerState {
  switch (a.type) {
    case 'edit': {
      // Typing after a result returns to idle; typing DURING a send only edits
      // the box (the in-flight frame already carries its own copy of the text).
      const settled = s.phase === 'acked' || s.phase === 'failed';
      return settled ? { ...s, draft: a.text, phase: 'idle', code: null, submitSkipped: false } : { ...s, draft: a.text };
    }
    case 'submit':
      return onSubmit(s, a.nonce, a.blocked, a.maxText);
    case 'ack':
      return onAck(s, a);
    case 'accept':
      return onAccept(s);
    case 'cancel':
      return s.phase === 'confirm' ? { ...s, phase: 'idle', frame: null, confirm: null } : s;
    case 'error':
      return s.phase === 'sending'
        ? { ...s, phase: 'failed', code: a.unconfirmed ? 'unconfirmed' : 'write-failed', frame: null }
        : s;
  }
}

// ── Draft persistence ─────────────────────────────────────────────────────

/** The subset of Storage used; injected so the tests need no DOM. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DRAFT_PREFIX = 'wmux-remote-draft:';

/**
 * Every access in try/catch: private browsing, a full quota, or blocked site
 * data all make Storage throw, and a draft is a convenience — losing it must
 * never take the composer down with it.
 */
export function loadDraft(storage: DraftStorage | null, surfaceId: string): string {
  if (!storage) return '';
  try {
    return storage.getItem(DRAFT_PREFIX + surfaceId) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(storage: DraftStorage | null, surfaceId: string, text: string): void {
  if (!storage) return;
  try {
    if (text) storage.setItem(DRAFT_PREFIX + surfaceId, text);
    else storage.removeItem(DRAFT_PREFIX + surfaceId);
  } catch { /* see loadDraft */ }
}

/**
 * An ack ok that arrives after the composer is gone (the user tapped Back
 * while "Sending…"; ws-client still resends and resolves the frame). The
 * reducer never sees it, so the STORED draft would still hold the sent text,
 * reappear on the next open, and one tap on Send would type it twice. Clears
 * the stored draft only if it is still exactly what was sent.
 */
export function clearSentDraft(storage: DraftStorage | null, surfaceId: string, sentText: string): void {
  if (!storage || !sentText) return;
  try {
    if (storage.getItem(DRAFT_PREFIX + surfaceId) === sentText) storage.removeItem(DRAFT_PREFIX + surfaceId);
  } catch { /* see loadDraft */ }
}

// ── Key arming ────────────────────────────────────────────────────────────

export const ARM_WINDOW_MS = 1500;

/**
 * The keys the SERVER treats as answering a blocked prompt (session.ts,
 * `REMOTE_ANSWERING_KEYS`). Mirrored here so the phone warns on the first tap
 * instead of learning it from a `confirm` round trip.
 */
const ANSWERING_KEYS: ReadonlySet<RemoteKey> = new Set<RemoteKey>(['enter', 'y', 'n', 'esc', 'tab', 'shift-tab', 'backspace', 'ctrl-c', 'ctrl-d']);

/**
 * Every confirm a key needs, from the roster alone, in the order the server
 * asks them — the last one is what the armed key says it will do.
 *
 * ESC and ^C while an agent is working end its run. On a BLOCKED agent the
 * server asks two separate questions: `blocked` for any answering key (ESC
 * included), and `interrupt` for ESC/^C while a run is open — which it usually
 * is, since a permission prompt appears mid-run. Arming only one of them cost
 * three taps for one Esc, the middle one labelled "answer". So both are
 * accepted up front and the key says the graver thing: interrupt. Arrows never
 * arm — menu navigation must stay one tap.
 */
export function keyArmKinds(key: RemoteKey, state: RemoteAgentState | null): ConfirmKind[] {
  const interrupts = key === 'esc' || key === 'ctrl-c';
  if (state === 'working') return interrupts ? ['interrupt'] : [];
  if (state !== 'blocked') return [];
  const kinds: ConfirmKind[] = ANSWERING_KEYS.has(key) ? ['blocked'] : [];
  if (interrupts) kinds.push('interrupt');
  return kinds;
}

/** The confirm an armed key is labelled with: the last (gravest) of `keyArmKinds`, or null. */
export function keyNeedsArming(key: RemoteKey, state: RemoteAgentState | null): ConfirmKind | null {
  return keyArmKinds(key, state).at(-1) ?? null;
}

/**
 * The prompt a `blocked` waiver may name after the server asked: the one this
 * phone is DISPLAYING, and only if the server asked about that same one. The
 * server's ack names its live prompt at refusal time; adopting it made the
 * waiver cover a question the phone had never shown. When they differ the
 * waiver names nothing, the server asks again, and by then the roster shows
 * the new question.
 */
export function waivablePrompt(ackPrompt: number | undefined, displayed: number | null): number | null {
  if (displayed === null) return null;
  return ackPrompt === undefined || ackPrompt === displayed ? displayed : null;
}

export interface KeyArm {
  key: RemoteKey;
  nonce: string;
  until: number;
  /** The confirms the second tap accepts: the question this arm asked, plus any earlier one for the same nonce. */
  force: ConfirmKind[];
}

export type KeyTapResult =
  | { action: 'send'; nonce: string; force: ConfirmKind[]; arm: null }
  | { action: 'arm'; arm: KeyArm };

/**
 * One tap. The second tap inside the window resends the SAME nonce with force,
 * so a first tap that the SERVER confirmed (and did not execute) and a second
 * one that it executes are, to its nonce LRU, one action.
 */
export function tapKey(
  arm: KeyArm | null,
  key: RemoteKey,
  state: RemoteAgentState | null,
  now: number,
  mintNonce: () => string,
): KeyTapResult {
  if (arm && arm.key === key && now < arm.until) {
    return { action: 'send', nonce: arm.nonce, force: arm.force, arm: null };
  }
  const nonce = mintNonce();
  const kinds = keyArmKinds(key, state);
  if (kinds.length > 0) return { action: 'arm', arm: { key, nonce, until: now + ARM_WINDOW_MS, force: kinds } };
  return { action: 'send', nonce, force: [], arm: null };
}

/**
 * A server `confirm` ack for a key arms it with the nonce it refused and the
 * kind it asked about. `waived` is what that refused frame already carried:
 * a forced Enter the server stops again for a DIFFERENT reason keeps the first
 * acceptance and adds the new one, rather than trading one for the other.
 */
export function armFromConfirm(
  key: RemoteKey, nonce: string, now: number, kind: ConfirmKind, waived: readonly ConfirmKind[] = [],
): KeyArm {
  const force = waived.includes(kind) ? [...waived] : [...waived, kind];
  return { key, nonce, until: now + ARM_WINDOW_MS, force };
}

export function isArmed(arm: KeyArm | null, key: RemoteKey, now: number): boolean {
  return arm !== null && arm.key === key && now < arm.until;
}
