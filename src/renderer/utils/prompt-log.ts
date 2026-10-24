import type { Terminal } from '@xterm/xterm';
import { useStore } from '../store';
import type { PromptEntry, PromptSource } from '../store/prompt-slice';
import { nextPromptSeq, normalizePromptText } from '../store/prompt-slice';
import { parsePromptMark } from './osc133';
import { noteCommandEnd, noteCommandStart, notePromptStart } from './alt-screen-owner';
import * as anchor from './prompt-anchor';
import * as marks from './prompt-marks';

/**
 * The single producer of prompt boundaries (issue #207).
 *
 * Two sources feed it and neither knows about the other:
 *
 *   • `recordAgentPrompt` — Claude Code's UserPromptSubmit hook, arriving via
 *     App.tsx. Carries the text verbatim.
 *   • `handlePromptMark` — OSC 133 from wmux's shell integration, arriving via
 *     the xterm parser in useTerminal. Carries a boundary; the text is read back
 *     out of the buffer.
 *
 * Both end in `commit`, so the four views downstream cannot tell them apart
 * except by `entry.source` — which is the point. A feature that behaved
 * differently in an agent pane and a shell pane would have to be learned twice.
 */

/** Where a shell's prompt/input marks landed, between OSC 133 A and C. */
interface ShellMarkState {
  /** Absolute line the prompt began on (`133;A`). */
  promptLine: number | null;
  /** Absolute line + column where the user's input begins (`133;B`). */
  inputLine: number | null;
  inputCol: number;
}

const shellState = new Map<string, ShellMarkState>();

/**
 * Ignore an agent prompt that arrives within this many ms of an identical one
 * on the same surface.
 *
 * Not paranoia: Claude Code fires UserPromptSubmit per submission, but the hook
 * is its own process racing every other hook process, and a resumed session can
 * replay one. Two entries for one prompt would put two jump marks on the same
 * line and make the outline lie about how much work a session did.
 */
const AGENT_DEDUPE_MS = 1500;
const lastAgentPrompt = new Map<string, { text: string; at: number }>();

function promptPrefs() {
  return useStore.getState().promptPrefs;
}

/**
 * Pending refine retries, keyed by entry id.
 *
 * A retry is about resolving the LINE, not about the tint: an anchor-only setup
 * needs the echo located just as much as a highlighted one, and the line can
 * settle while the highlight stays off. The budget is bounded so a TUI that
 * never paints a recognisable echo leaves the ruler tick rather than a timer.
 */
const tintRetries = new Map<string, ReturnType<typeof setInterval>>();
const TINT_RETRY_MS = 150;
const TINT_RETRY_BUDGET_MS = 5_000;

/**
 * Commit an entry: register the mark, tell the store, then let the enabled
 * views act on it.
 *
 * Order matters. The mark is opened FIRST, against the buffer as it is right
 * now, because every later step needs a line and the buffer keeps moving — a
 * store write that triggers a React render before the marker exists would let
 * output scroll in between and put the mark on the wrong row.
 */
function commit(
  terminal: Terminal,
  surfaceId: string,
  source: PromptSource,
  text: string,
  rows: number,
  at: number,
  line: number | null,
): PromptEntry | null {
  const prefs = promptPrefs();
  if (!prefs?.enabled) return null;

  const store = useStore.getState();
  const seq = nextPromptSeq(store.prompts[surfaceId]);
  const id = `${surfaceId}:${seq}`;

  // A caller that already knows the line (the shell path, which marked it at
  // `133;A` several writes ago) passes it; the agent path takes the cursor.
  const resolved = line !== null
    ? marks.openMarkAt(terminal, surfaceId, id, line)
    : marks.openMark(terminal, surfaceId, id);

  const entry: PromptEntry = {
    id,
    surfaceId,
    seq,
    text: normalizePromptText(text),
    source,
    at,
    line: resolved,
    rows: Math.max(1, Math.floor(rows) || 1),
  };
  store.recordPrompt(entry);
  // The store bounds itself (200 prompts per surface, 64 surfaces); the marker
  // registry does not bound itself at all, and a live marker costs something on
  // every trimmed line. Reconciling right after the write keeps the two from
  // drifting without either eviction rule having to be mirrored — see
  // prompt-marks.reconcile.
  marks.reconcile(useStore.getState().prompts);
  return entry;
}

/**
 * What `applyHighlight` needs to decide whether a band on these rows is honest
 * (issue #230).
 *
 * The needle is the prompt's own distinctive fragment, so the check is "does
 * this row still say what the prompt said". `confirmed` is what the SOURCE can
 * promise when the needle cannot decide — a shell's row was named by OSC 133
 * and is never rewritten, an agent's row is a guess `refineMark` may have
 * failed to place, and a guess in the middle of a TUI's repaint zone is the
 * band-over-the-spinner this issue reported.
 */
function highlightOptionsFor(entry: PromptEntry) {
  const prefs = promptPrefs();
  return {
    color: prefs.highlightColor,
    rows: entry.rows,
    ruler: prefs.ruler,
    needle: marks.buildNeedle(entry.text),
    confirmed: entry.source !== 'agent',
    text: entry.source === 'agent' ? entry.text : undefined,
  };
}

/** Highlight + anchor an entry according to the current preferences. */
function applyViews(terminal: Terminal, entry: PromptEntry): boolean {
  const prefs = promptPrefs();
  let settled = entry.source !== 'agent';
  if (prefs.highlight) {
    settled = marks.applyHighlight(terminal, entry.surfaceId, entry.id, highlightOptionsFor(entry)).settled;
  } else if (entry.source === 'agent' && entry.text) {
    settled = marks.promptAboveLive(terminal, entry.surfaceId, entry.id, entry.text);
  }
  // Anchoring is deliberately last and deliberately conditional on a resolved
  // line: an anchor is the one view that changes what the terminal DOES rather
  // than how it looks, so it must never engage on a guess.
  //
  // An AGENT line is only settled once the echo is entirely above the live input
  // region. The composer holds the prompt text too, so a marker there would
  // satisfy the text check and anchor the view to the composer while the answer
  // streams past underneath — the same mistake the tint now refuses to make.
  //
  // The anchor is given a RESOLVER, not the line — `entry.line` is a snapshot
  // and the row moves once the scrollback starts trimming. The marker is the
  // thing that tracks it, and its disappearance is the anchor's cue to let go.
  //
  // `anchorScope` keeps the default narrow: a shell that follows its own output
  // is not the problem issue #207 describes, and holding `npm run build` back
  // from streaming would read as a freeze rather than as a feature.
  const inScope = prefs.anchorScope === 'all' || entry.source === 'agent';
  // Only the newest prompt may own the anchor. A retry for an older prompt can
  // settle seconds after the user has asked the next question; letting it
  // re-anchor would yank the view back to the previous turn.
  const latest = useStore.getState().prompts[entry.surfaceId]?.at(-1)?.id === entry.id;
  if (prefs.anchor && inScope && settled && latest && entry.line !== null) {
    anchor.anchorAt(terminal, entry.surfaceId, marks.lineResolver(entry.surfaceId, entry.id));
  }
  return settled;
}

/** Cancel one entry's pending retry, if any. */
function cancelTintRetry(entryId: string): void {
  const timer = tintRetries.get(entryId);
  if (timer === undefined) return;
  clearInterval(timer);
  tintRetries.delete(entryId);
}

/**
 * Re-run the refine while an agent TUI paints the echo above its composer.
 *
 * The first refine happens the moment the hook arrives, when the composer still
 * shows the text; a nearest-match search therefore stays on the live row. This
 * searches only above that row, so it cannot resolve back to the composer, and
 * it stops as soon as the band is actually on the text. The budget is bounded:
 * a TUI that never echoes the prompt (or echoes it unrecognizably) keeps the
 * ruler tick rather than a timer forever.
 */
function scheduleTintRetry(
  terminal: Terminal,
  surfaceId: string,
  entryId: string,
  text: string,
): void {
  cancelTintRetry(entryId);
  const started = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - started >= TINT_RETRY_BUDGET_MS) {
      cancelTintRetry(entryId);
      return;
    }
    const moved = marks.refineMarkAbove(
      terminal,
      surfaceId,
      entryId,
      text,
      marks.liveLine(terminal),
    );
    if (moved === null) return;
    const store = useStore.getState();
    const entry = store.prompts[surfaceId]?.find((candidate) => candidate.id === entryId);
    if (!entry) {
      cancelTintRetry(entryId);
      return;
    }
    // `updatePrompt` always replaces the array; skip it when the marker is
    // already on the row so a retry that is waiting on the anchor does not
    // re-render every prompt consumer four times a second.
    if (entry.line !== moved) store.updatePrompt(surfaceId, entryId, { line: moved });
    if (applyViews(terminal, { ...entry, line: moved })) cancelTintRetry(entryId);
  }, TINT_RETRY_MS);
  tintRetries.set(entryId, timer);
}

/**
 * Which surface a hook event belongs to (issue #304).
 *
 * One `hook.event`, two producers, two spellings of "which pane": Claude Code's
 * `wmux-hook.js` talks JSON-RPC itself and sends `surfaceId`; the OpenCode
 * plugin goes through `wmux hook`, whose transport stamps the calling pane as
 * `caller` — the same `$WMUX_SURFACE_ID` the browser verbs route by (issue
 * #62).
 *
 * The two are deliberately NOT collapsed any earlier than here. Main's hook
 * consumers gate on `surfaceId`, and only some of them want this event: a v2
 * OpenCode `UserPromptSubmit` has no `Stop` behind it, so the declared-state
 * bridge would set `runDepth: 1` and leave it there — the pane reading
 * "working" for the full trust window after every prompt. The prompt log is
 * the one consumer that does want it, and it asks here.
 */
export function hookEventSurface(event: { surfaceId?: unknown; caller?: unknown } | null | undefined): string {
  const explicit = typeof event?.surfaceId === 'string' ? event.surfaceId : '';
  if (explicit) return explicit;
  return typeof event?.caller === 'string' ? event.caller : '';
}

/**
 * A user prompt submitted to an in-pane agent.
 *
 * `text` is the only free-text body wmux forwards from a hook payload besides a
 * Notification's message, and it is the user's own words to their own agent,
 * already on screen in this very renderer — but it is still text crossing a
 * process boundary into a web context, so it is length-capped
 * (`normalizePromptText`) and never persisted to disk.
 */
export function recordAgentPrompt(
  terminal: Terminal,
  surfaceId: string,
  text: string,
  at: number,
): void {
  const clean = normalizePromptText(text);
  const previous = lastAgentPrompt.get(surfaceId);
  if (previous && previous.text === clean && at - previous.at < AGENT_DEDUPE_MS) return;
  lastAgentPrompt.set(surfaceId, { text: clean, at });

  const entry = commit(terminal, surfaceId, 'agent', clean, estimateRows(terminal, clean), at, null);
  if (!entry) return;

  // Move the mark onto the row where the TUI actually echoed the prompt. Only
  // possible for this source, because only this source knows the text. Done
  // after the store write so a slow scan cannot delay the entry appearing.
  if (entry.line !== null && clean) {
    const refined = marks.refineMark(terminal, surfaceId, entry.id, clean);
    if (refined !== null && refined !== entry.line) {
      entry.line = refined;
      useStore.getState().updatePrompt(surfaceId, entry.id, { line: refined });
    }
  }
  const settled = applyViews(terminal, entry);

  // The composer still holds the prompt when the hook lands, so the refine
  // above can legitimately resolve to a row that is still the live input. Wait
  // — on a timer, not on a repaint — for the TUI to paint the echo entirely
  // above the cursor. Retry for the anchor too: a line that never settles is a
  // wrong anchor even when the tint is switched off.
  const prefs = promptPrefs();
  if (!settled && (prefs.highlight || prefs.anchor) && marks.buildNeedle(clean)) {
    scheduleTintRetry(terminal, surfaceId, entry.id, clean);
  }
}

/**
 * How many terminal rows a prompt of this text occupies.
 *
 * An estimate, and knowingly so: an agent TUI adds its own prefix, indent and
 * wrapping, none of which wmux can see. It only sizes a highlight, so being a
 * row out is a cosmetic error — which is why it is worth doing at all rather
 * than highlighting a single row for a ten-line prompt.
 */
function estimateRows(terminal: Terminal, text: string): number {
  if (!text) return 1;
  const cols = Math.max(20, terminal.cols || 80);
  return text
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / cols)), 0);
}

/**
 * Feed one OSC 133 payload for a surface. Returns true when it was ours.
 *
 * The `A → B → C` sequence is a state machine and not three independent events:
 * a boundary is only worth recording once the command has actually been
 * submitted, because that is the first moment the text exists. A shell that
 * emits A and B and then the user presses Ctrl+C leaves state behind that the
 * NEXT `A` overwrites — which is why A resets rather than accumulates.
 */
export function handlePromptMark(terminal: Terminal, surfaceId: string, data: string): boolean {
  const mark = parsePromptMark(data);
  if (!mark) return false;

  const buf = terminal.buffer.active;
  switch (mark.kind) {
    case 'prompt-start':
      shellState.set(surfaceId, { promptLine: buf.baseY + buf.cursorY, inputLine: null, inputCol: 0 });
      // A prompt on the alternate screen is also what tells Reset terminal
      // state that the program which entered it is gone (#357). Reported from
      // here so the mark is parsed once, and regardless of the prompt prefs.
      notePromptStart(surfaceId, buf.type);
      return true;
    case 'input-start': {
      const state = shellState.get(surfaceId);
      if (!state) return true;
      state.inputLine = buf.baseY + buf.cursorY;
      state.inputCol = buf.cursorX;
      return true;
    }
    case 'output-start':
      // A command run from a prompt on the alternate screen may draw there
      // without entering it (#357).
      noteCommandStart(surfaceId, buf.type);
      commitShellPrompt(terminal, surfaceId);
      return true;
    case 'command-end':
      // The exit status is parsed and deliberately not stored. Nothing in issue
      // #207 asks for it, and a field kept "just in case" would have to be
      // maintained by every view. The parse still has to happen so the mark is
      // consumed rather than falling through to another OSC 133 consumer.
      shellState.delete(surfaceId);
      noteCommandEnd(surfaceId, buf.type);
      return true;
    default:
      return false;
  }
}

/**
 * Which row the prompt really started on.
 *
 * Normally `133;A`, which is the whole point of that mark. But it cannot be
 * trusted unconditionally, and Ctrl+L in PowerShell is the case that proves it:
 * ConPTY passes the OSC through at parse time and only THEN emits PSReadLine's
 * own `ESC[H` repaint, so the stream reads `<A> ESC[H <prompt> <B>` and A was
 * recorded against the pre-clear row — often far BELOW where the prompt then
 * got drawn.
 *
 * So A is used only when it is consistent with B: at or above the input row,
 * and within one screen of it. Anything else means the screen moved between the
 * two marks, and B — emitted after the prompt text and after any repositioning
 * — is the honest answer. Falling back is cheap: the highlight loses the prompt
 * decoration's first rows, which is invisible next to jumping to the wrong row.
 */
function promptStartLine(state: ShellMarkState, rows: number): number {
  const input = state.inputLine as number;
  const prompt = state.promptLine;
  if (prompt === null) return input;
  if (prompt > input) return input;
  return input - prompt < Math.max(1, rows) ? prompt : input;
}

/** Turn a completed A→B→C sequence into an entry. */
function commitShellPrompt(terminal: Terminal, surfaceId: string): void {
  const state = shellState.get(surfaceId);
  shellState.delete(surfaceId);
  if (!state || state.inputLine === null) return;

  const buf = terminal.buffer.active;
  // At `133;C` the shell has already echoed the newline, so the cursor sits on
  // the row AFTER the command. The command is everything up to there.
  const lastInputLine = Math.max(state.inputLine, buf.baseY + buf.cursorY - 1);
  const start = promptStartLine(state, terminal.rows);

  // Everything from the input column onward — the prompt itself shares that
  // first row and is not part of what the user typed.
  const first = marks.lineText(terminal, state.inputLine).slice(state.inputCol);
  const rest = lastInputLine > state.inputLine
    ? marks.readRange(terminal, state.inputLine + 1, lastInputLine)
    : '';
  const text = (rest ? `${first}\n${rest}` : first).trim();
  if (!text) return; // A bare Enter at an empty prompt is not a prompt.

  const entry = commit(
    terminal,
    surfaceId,
    'shell',
    text,
    lastInputLine - start + 1,
    Date.now(),
    start,
  );
  if (entry) applyViews(terminal, entry);
}

/**
 * Re-apply highlights for a surface after a preference change — or a resize.
 *
 * Needed for prefs because a decoration is created once, at commit time, from
 * the prefs as they were then. Without this, turning the highlight on showed
 * nothing until the next prompt — which reads as a broken toggle.
 *
 * Needed for a resize (issue #230) for two reasons that are easy to miss
 * because the marker survives reflow and so the band looks like it should be
 * fine. It is not: a decoration's `width` is `terminal.cols` as it was when it
 * was registered, so widening a pane leaves every band stopping short of the
 * new right edge. And the resize is the moment a TUI redraws everything it
 * owns, which is exactly when a band's row is most likely to stop carrying its
 * prompt — re-applying re-runs that check on every entry at once instead of
 * waiting for each row to be scrolled back into view.
 */
export function refreshHighlights(terminal: Terminal, surfaceId: string): void {
  const prefs = promptPrefs();
  marks.clearAllHighlights(surfaceId);
  if (!prefs.enabled || !prefs.highlight) return;
  for (const entry of useStore.getState().prompts[surfaceId] ?? []) {
    marks.applyHighlight(terminal, surfaceId, entry.id, highlightOptionsFor(entry));
  }
}

/**
 * Drop everything held for a surface.
 *
 * Called on PTY exit and on terminal disposal — NOT on pane close alone, since
 * the store entries are what the outline lists and a closed pane has no view.
 * Marker objects belong to a terminal that is going away, so they must go with
 * it either way.
 */
export function forgetSurface(surfaceId: string): void {
  shellState.delete(surfaceId);
  lastAgentPrompt.delete(surfaceId);
  for (const key of Array.from(tintRetries.keys())) {
    if (key.startsWith(`${surfaceId}:`)) cancelTintRetry(key);
  }
  marks.forgetSurface(surfaceId);
  anchor.forgetSurface(surfaceId);
}

/** Test seam. */
export function __resetPromptLog(): void {
  shellState.clear();
  lastAgentPrompt.clear();
  for (const key of Array.from(tintRetries.keys())) cancelTintRetry(key);
}
