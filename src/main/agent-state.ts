/**
 * Declared agent state per surface (issue #128).
 *
 * wmux already infers "is this agent busy?" two ways, and both are guesses:
 *   - claude-observer.ts scrapes the Claude Code TUI with regexes
 *   - claude-session-view.ts calls a surface `working` while a hook/observer
 *     signal is younger than 5s, and `idle` once it goes quiet
 *
 * That inference cannot represent the one state that actually matters: an agent
 * PARKED ON A HUMAN. A permission prompt makes the agent go silent, so after the
 * 5s window it decays to `idle` — indistinguishable from a finished turn. With
 * ten panes open, the pane that needs you looks exactly like the nine that don't.
 *
 * This module holds *declared* state instead: the agent (or a hook acting for
 * it) states what it is doing, and wmux stores it verbatim. No screen scraping,
 * no timing heuristic. The transport is the existing V2 pipe — wmux already
 * injects WMUX=1 / WMUX_SURFACE_ID / WMUX_PIPE / WMUX_PIPE_TOKEN into every
 * spawned shell, which is herdr's three-env-var activation plus authentication.
 *
 * Two facts, three states — `blocked` and a run refcount:
 *   awaitingHuman        -> 'blocked'
 *   runDepth > 0         -> 'working'
 *   otherwise            -> 'idle'
 * Never reported / released -> 'unknown' (absent from the map).
 *
 * runDepth is a refcount, not a boolean, so nested subagents don't let an inner
 * completion clear the outer run.
 */

import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, SurfaceId } from '../shared/types';

export type AgentRunState = 'blocked' | 'working' | 'idle' | 'unknown';

/**
 * One answer a blocked agent will accept (issue #128, the back-channel).
 *
 * The agent declares BOTH the human-readable label and the exact bytes that
 * pick it. wmux deliberately does not know how to answer a Claude Code
 * permission prompt, an OpenCode menu, or anyone's custom TUI — it is a relay,
 * not an interpreter. That is the same reasoning that made `blocked` a declared
 * fact rather than a scraped one: the moment wmux guesses at another program's
 * interface, it acquires a dependency on that interface not changing, and the
 * failure lands silently on the user.
 *
 * `key` goes through the same name table as `surface.send_key` ("enter", "1",
 * "esc", …); `text` is written literally. A choice carrying neither is
 * unanswerable and is rejected at report time — a button that cannot do
 * anything is worse than no button.
 */
export interface AgentChoice {
  /** Stable id the answer refers to. */
  id: string;
  /** What the human reads. */
  label: string;
  /** Key name to send, in the `surface.send_key` vocabulary. */
  key?: string;
  /** Literal text to send, as an alternative to `key`. */
  text?: string;
  /** Picked by an answer that names no choice. */
  isDefault?: boolean;
}

export interface AgentMetadata {
  model?: string;
  /** Percentage of the context window consumed, 0-100. */
  contextPct?: number;
  tokens?: string;
  /** Wall-clock ms after which these values are stale and must not be shown. */
  expiresAt?: number;
}

export interface AgentStateRecord {
  surfaceId: SurfaceId;
  state: AgentRunState;
  /** True while the agent is parked on a human (permission, question, menu). */
  awaitingHuman: boolean;
  /** Nested run refcount — >0 means a turn is in flight. */
  runDepth: number;
  /** What the agent is waiting for, when it told us. */
  blockedReason: string | null;
  /**
   * The answers the agent will accept, when it declared them (issue #128).
   * Empty means "blocked, but wmux has no way to answer from outside" — still
   * a useful signal, just not an actionable one.
   */
  choices: AgentChoice[];
  /**
   * When an answer was last relayed into the pane, or null.
   *
   * Kept so the UI can say "sent — waiting for the agent" rather than either
   * pretending the prompt is gone or offering the buttons again. It is
   * deliberately NOT a state: see answerAgent for why answering does not clear
   * `awaitingHuman`.
   */
  answeredAt: number | null;
  /** Resumable session handle (a file/id), not a PID — survives a restart. */
  sessionId: string | null;
  metadata: AgentMetadata;
  /** Highest `seq` accepted so far — replays and retries are dropped. */
  lastSeq: number;
  updatedAt: number;
}

/** Metadata with no explicit TTL is trusted this long before it stops being shown. */
export const DEFAULT_METADATA_TTL_MS = 60_000;

/** Longest a `working` claim is trusted without any further report. */
export const WORKING_TRUST_MS = 15 * 60_000;

const records = new Map<SurfaceId, AgentStateRecord>();

/** Guards against a hostile or buggy reporter growing the map without bound. */
const MAX_TRACKED_SURFACES = 256;

function blank(surfaceId: SurfaceId): AgentStateRecord {
  return {
    surfaceId,
    state: 'unknown',
    awaitingHuman: false,
    runDepth: 0,
    blockedReason: null,
    choices: [],
    answeredAt: null,
    sessionId: null,
    metadata: {},
    lastSeq: 0,
    updatedAt: Date.now(),
  };
}

function getOrCreate(surfaceId: SurfaceId): AgentStateRecord {
  let record = records.get(surfaceId);
  if (!record) {
    if (records.size >= MAX_TRACKED_SURFACES) {
      // Evict the least recently updated entry rather than refusing new ones —
      // a live pane matters more than a stale one.
      let oldest: AgentStateRecord | null = null;
      for (const candidate of records.values()) {
        if (!oldest || candidate.updatedAt < oldest.updatedAt) oldest = candidate;
      }
      if (oldest) records.delete(oldest.surfaceId);
    }
    record = blank(surfaceId);
    records.set(surfaceId, record);
  }
  return record;
}

/**
 * Monotonic sequence gate. Reporters stamp every message with an increasing
 * `seq`; wmux drops anything it has already seen. Without this a retried
 * message replays a stale state — the classic "agent finished but the pane
 * still says working" ghost, caused by a re-delivered older frame landing
 * after the newer one.
 *
 * A reporter that omits `seq` opts out (every message is accepted in order).
 */
function acceptSeq(record: AgentStateRecord, seq: number | undefined): boolean {
  if (seq === undefined || seq === null || !Number.isFinite(seq)) return true;
  if (seq <= record.lastSeq) return false;
  record.lastSeq = seq;
  return true;
}

/**
 * Resolve the two stored facts into the state the sidebar renders.
 *
 * `now` is passed in rather than read from the clock so this stays a pure
 * function of the record — which is what makes the expiry rules testable.
 */
export function resolveState(record: AgentStateRecord, now: number): AgentRunState {
  // A pane parked on a human keeps saying so until the agent itself moves on.
  // This signal is the entire point of the feature: it must never time out,
  // because an agent waiting for you emits nothing while it waits, and a
  // decaying `blocked` would silently become `idle` — the exact bug this
  // module exists to remove.
  if (record.awaitingHuman) return 'blocked';

  // A `working` claim is a promise to report again. If a process is killed
  // mid-run it never sends its release, so an un-bounded `working` would be a
  // permanent lie. Past the trust window we admit we do not know rather than
  // keep asserting a run that may be long dead.
  if (record.runDepth > 0) {
    return now - record.updatedAt > WORKING_TRUST_MS ? 'unknown' : 'working';
  }

  return 'idle';
}

/** Metadata is dropped once stale so a crashed process can't keep lying. */
export function liveMetadata(record: AgentStateRecord, now: number): AgentMetadata {
  const { expiresAt } = record.metadata;
  if (expiresAt !== undefined && now >= expiresAt) return {};
  return record.metadata;
}

export interface ReportAgentParams {
  seq?: number;
  /** True when the agent is parked on a human; false when it resumes. */
  awaitingHuman?: boolean;
  /** Why it is parked ("permission: Bash", "question", …). */
  reason?: string | null;
  /** Refcount delta for nested runs: +1 on run start, -1 on run end. */
  runDelta?: number;
  /** Absolute refcount, for reporters that track it themselves. */
  runDepth?: number;
  /**
   * The answers wmux may offer for this block (issue #128). Omitted leaves any
   * previously declared set alone; an empty array clears it.
   */
  choices?: AgentChoice[];
}

/**
 * Keep only the choices wmux can actually deliver.
 *
 * A choice with no `key` and no `text` cannot be relayed, and rendering it as a
 * button would produce the worst outcome available: the user clicks "Allow",
 * nothing reaches the agent, and the pane sits blocked while they believe they
 * have answered it. Dropping it is the honest failure — and the count comes
 * back in the RPC result, so a misbehaving reporter learns immediately rather
 * than discovering it through a confused human.
 */
export function sanitizeChoices(raw: unknown): AgentChoice[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AgentChoice[] = [];
  for (const item of raw) {
    const choice = toChoice(item);
    // An id is what an answer names, so a duplicate would make the answer
    // ambiguous — first one wins rather than silently shadowing.
    if (!choice || seen.has(choice.id)) continue;
    seen.add(choice.id);
    out.push(choice);
    if (out.length >= MAX_CHOICES) break;
  }
  return out;
}

/** One raw entry → a deliverable choice, or null if wmux could not act on it. */
function toChoice(item: unknown): AgentChoice | null {
  if (!item || typeof item !== 'object') return null;
  const c = item as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

  const id = str(c.id)?.trim();
  const label = str(c.label)?.trim();
  if (!id || !label) return null;

  const key = str(c.key);
  const text = str(c.text);
  if (key === undefined && text === undefined) return null;

  return {
    id,
    label,
    ...(key ? { key } : {}),
    ...(text ? { text } : {}),
    ...(c.isDefault ? { isDefault: true } : {}),
  };
}

/** A prompt with more buttons than this is a menu, not a question wmux can usefully mirror. */
const MAX_CHOICES = 12;

/**
 * Apply the blocked half of a report.
 *
 * The one rule worth stating: ANY transition of `awaitingHuman` invalidates the
 * declared answers. Unblocking ends the prompt they belonged to; a fresh block
 * starts a different one. Carrying them across either edge would arm
 * "Allow / Deny" from the previous question against the current one, so a click
 * would send a keystroke the agent never declared for the prompt it is actually
 * showing — or worse, inject into a shell that is not asking anything at all.
 * A report that declares choices for the NEW prompt re-populates them in the
 * same call, via applyChoices below.
 */
function applyBlocked(record: AgentStateRecord, params: ReportAgentParams): void {
  if (params.awaitingHuman === undefined) {
    if (params.reason !== undefined) record.blockedReason = params.reason;
    return;
  }

  const wasAwaiting = record.awaitingHuman;
  record.awaitingHuman = !!params.awaitingHuman;
  // Leaving the blocked state clears the reason with it, so a stale "waiting
  // for permission: Bash" can't outlive the prompt it described.
  record.blockedReason = record.awaitingHuman ? (params.reason ?? null) : null;

  if (wasAwaiting !== record.awaitingHuman) {
    record.choices = [];
    record.answeredAt = null;
  }
}

/** Apply the declared answers. Omitted leaves them alone; an empty array clears them. */
function applyChoices(record: AgentStateRecord, params: ReportAgentParams): void {
  if (params.choices === undefined) return;
  record.choices = record.awaitingHuman ? sanitizeChoices(params.choices) : [];
  // Re-declaring the answers means this is a live question again, so the
  // buttons come back — which is also how a user retries an answer the agent
  // evidently did not act on.
  if (record.choices.length > 0) record.answeredAt = null;
}

/** Apply the run refcount, absolute value winning over a delta. */
function applyRunDepth(record: AgentStateRecord, params: ReportAgentParams): void {
  if (params.runDepth !== undefined && Number.isFinite(params.runDepth)) {
    record.runDepth = Math.max(0, Math.trunc(params.runDepth));
  } else if (params.runDelta !== undefined && Number.isFinite(params.runDelta)) {
    // Clamped at zero: an unbalanced -1 (a subagent whose start we missed)
    // must not drive the count negative and mask a genuine outer run.
    record.runDepth = Math.max(0, record.runDepth + Math.trunc(params.runDelta));
  }
}

/**
 * `pane.report_agent` — the whole point of the protocol.
 * Returns the record when the report was accepted, null when deduped.
 */
export function reportAgent(surfaceId: SurfaceId, params: ReportAgentParams): AgentStateRecord | null {
  const record = getOrCreate(surfaceId);
  if (!acceptSeq(record, params.seq)) return null;

  // Order matters: applyBlocked may clear the answers of a prompt that has just
  // ended, and applyChoices then installs the ones declared for the new prompt.
  applyBlocked(record, params);
  applyChoices(record, params);
  applyRunDepth(record, params);

  return commit(record);
}

/** `pane.report_agent_session` — tie the pane to a resumable session handle. */
export function reportAgentSession(
  surfaceId: SurfaceId,
  params: { seq?: number; sessionId: string | null },
): AgentStateRecord | null {
  const record = getOrCreate(surfaceId);
  if (!acceptSeq(record, params.seq)) return null;
  record.sessionId = params.sessionId || null;
  return commit(record);
}

/** `pane.report_metadata` — model / context% / tokens, with a TTL. */
export function reportMetadata(
  surfaceId: SurfaceId,
  params: { seq?: number; model?: string; contextPct?: number; tokens?: string; ttlMs?: number },
): AgentStateRecord | null {
  const record = getOrCreate(surfaceId);
  if (!acceptSeq(record, params.seq)) return null;

  const ttl = Number.isFinite(params.ttlMs) ? Math.max(0, Number(params.ttlMs)) : DEFAULT_METADATA_TTL_MS;
  record.metadata = {
    ...record.metadata,
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.contextPct !== undefined ? { contextPct: params.contextPct } : {}),
    ...(params.tokens !== undefined ? { tokens: params.tokens } : {}),
    expiresAt: Date.now() + ttl,
  };
  return commit(record);
}

/**
 * Which choice an answer means.
 *
 * A named id is looked up directly. An UNNAMED answer resolves only when there
 * is no ambiguity: the agent declared a default, or there is exactly one thing
 * to say. Anything else returns undefined so the caller refuses — guessing
 * between "Allow" and "Deny" on the user's behalf is not a convenience.
 */
function pickChoice(choices: AgentChoice[], wanted: string | undefined): AgentChoice | undefined {
  if (wanted) return choices.find(c => c.id === wanted);
  const declaredDefault = choices.find(c => c.isDefault);
  if (declaredDefault) return declaredDefault;
  return choices.length === 1 ? choices[0] : undefined;
}

export type AnswerFailure =
  | 'unknown-surface'   // nothing has ever reported for this pane
  | 'not-blocked'       // the pane is not asking anything right now
  | 'no-choices'        // blocked, but the agent declared no answers
  | 'unknown-choice';   // the named choice is not on offer

export type AnswerResult =
  | { ok: true; choice: AgentChoice | null; key?: string; text?: string }
  | { ok: false; reason: AnswerFailure };

/**
 * `pane.answer_agent` — the back-channel, and the first method here that is not
 * a `report_*` (issue #128).
 *
 * herdr's protocol is strictly one-way: the multiplexer observes and cannot
 * talk back. This is the other direction — answer the pane that needs you
 * without leaving the pane you are in. It resolves a declared choice into the
 * bytes the agent asked for; the CALLER performs the PTY write, which keeps
 * this module free of any terminal coupling and leaves the resolution testable
 * on its own.
 *
 * Three rules, each of which exists to stop this from becoming a keystroke
 * injection primitive:
 *
 * 1. **Only a pane that is actually asking can be answered.** A pane the agent
 *    has moved on from may well have a human typing in it, and a stale click on
 *    a button the UI has not repainted yet must not push characters into their
 *    shell. `not-blocked` is a refusal, not a no-op.
 *
 * 2. **Only the agent's own declared payloads are sent** for a choice. wmux
 *    never invents a keystroke for someone else's prompt. (Free-form text is a
 *    separate, explicit call — it is `surface.send_text`, which has always
 *    existed and grants nothing new.)
 *
 * 3. **Answering does NOT clear `blocked`.** This is the important one. The
 *    agent must confirm by reporting, exactly as it would if a human had typed
 *    the answer into the pane. Clearing optimistically would mean a mis-declared
 *    key silently stops the pane asking for help while the agent is still stuck
 *    — reintroducing the precise ghost this module exists to remove, in the
 *    dangerous direction. A pane that keeps saying "needs you" after a failed
 *    answer is annoying; one that goes quiet is a bug you find hours later.
 *
 * The choices are consumed on success so a button cannot be answered twice.
 * When the agent re-declares them, they come back.
 */
export function answerAgent(
  surfaceId: SurfaceId,
  params: { choiceId?: string | null },
): AnswerResult {
  const record = records.get(surfaceId);
  if (!record) return { ok: false, reason: 'unknown-surface' };
  if (!record.awaitingHuman) return { ok: false, reason: 'not-blocked' };
  if (record.choices.length === 0) return { ok: false, reason: 'no-choices' };

  const choice = pickChoice(record.choices, params.choiceId?.trim());
  // An unnamed answer against a multi-way prompt with no declared default is
  // ambiguous, and picking one for the user would be worse than refusing.
  if (!choice) return { ok: false, reason: 'unknown-choice' };

  record.choices = [];
  record.answeredAt = Date.now();
  commit(record);

  return { ok: true, choice, ...(choice.key ? { key: choice.key } : {}), ...(choice.text ? { text: choice.text } : {}) };
}

/**
 * `pane.release_agent` — the agent is deliberately letting go of the pane.
 * The record is removed entirely so the pane reads `unknown` rather than
 * lingering as a ghost `working`.
 */
export function releaseAgent(surfaceId: SurfaceId, params: { seq?: number } = {}): boolean {
  const record = records.get(surfaceId);
  if (!record) return false;
  if (!acceptSeq(record, params.seq)) return false;
  forget(surfaceId);
  return true;
}

/**
 * The PTY exited — whatever the process declared is now a lie.
 *
 * This MUST announce, not just delete: the renderer holds its own copy of the
 * last broadcast state, so a silent delete leaves the sidebar rendering a dead
 * pane as `working` or `blocked` forever. A shell can exit while its tab stays
 * open, so the surface is still on screen to render. Announcing a ghost is the
 * precise failure this whole module exists to prevent.
 */
export function clearAgentState(surfaceId: SurfaceId): void {
  if (records.has(surfaceId)) forget(surfaceId);
}

/**
 * Drop a surface's record and tell the renderer it is now `unknown`.
 *
 * `unknown` is sent explicitly rather than by snapshotting a blank record: a
 * blank record resolves to `idle`, and `idle` is a CLAIM — the sidebar gives a
 * declared state precedence over its own inference. A forgotten pane has made
 * no claim at all, so it must fall back to the heuristic, not be pinned idle.
 */
function forget(surfaceId: SurfaceId): void {
  records.delete(surfaceId);
  send({
    surfaceId,
    state: 'unknown',
    blockedReason: null,
    choices: [],
    answeredAt: null,
    sessionId: null,
    runDepth: 0,
    metadata: {},
    updatedAt: Date.now(),
  });
}

export interface AgentStateSnapshot {
  surfaceId: SurfaceId;
  state: AgentRunState;
  blockedReason: string | null;
  /** Answers the sidebar may offer for this pane — empty unless the agent declared them. */
  choices: AgentChoice[];
  /** When an answer was last relayed, so the UI can say "sent" instead of re-offering. */
  answeredAt: number | null;
  sessionId: string | null;
  runDepth: number;
  metadata: AgentMetadata;
  updatedAt: number;
}

function snapshot(record: AgentStateRecord, now = Date.now()): AgentStateSnapshot {
  return {
    surfaceId: record.surfaceId,
    state: resolveState(record, now),
    blockedReason: record.blockedReason,
    // Only ever offered for a pane that is genuinely asking: a snapshot taken
    // mid-transition must not arm a button for a prompt that has closed.
    choices: resolveState(record, now) === 'blocked' ? record.choices : [],
    answeredAt: record.answeredAt,
    sessionId: record.sessionId,
    runDepth: record.runDepth,
    metadata: liveMetadata(record, now),
    updatedAt: record.updatedAt,
  };
}

export function getAgentState(surfaceId: SurfaceId): AgentStateSnapshot | undefined {
  const record = records.get(surfaceId);
  return record ? snapshot(record) : undefined;
}

export function listAgentStates(): AgentStateSnapshot[] {
  const now = Date.now();
  return [...records.values()].map(r => snapshot(r, now));
}

/** Panes currently parked on a human — what "which one needs me?" resolves to. */
export function listBlocked(): AgentStateSnapshot[] {
  return listAgentStates().filter(s => s.state === 'blocked');
}

function commit(record: AgentStateRecord): AgentStateRecord {
  record.updatedAt = Date.now();
  record.state = resolveState(record, record.updatedAt);
  broadcast(record);
  return record;
}

function broadcast(record: AgentStateRecord): void {
  send(snapshot(record));
}

function send(payload: AgentStateSnapshot): void {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.AGENT_STATE, payload);
  });
}

/** Test seam — drops all tracked state. */
export function resetAgentState(): void {
  records.clear();
}
