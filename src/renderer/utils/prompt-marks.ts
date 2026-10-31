import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';

/**
 * The terminal-side half of the prompt log (issue #207): xterm markers,
 * decorations, and the buffer reads that turn a boundary into text.
 *
 * Kept out of the store on purpose. An `IMarker` is a live emulator object with
 * an identity and a disposal contract — it is not serialisable, it must not be
 * compared by value, and holding one past its terminal's disposal is a crash
 * waiting for the next render. So the store holds the FACTS about a prompt
 * (text, ordinal, timestamp, resolved line) and this module holds the objects,
 * keyed by surface exactly like `surfaceMouseModes` and `surfaceTerminalRegistry`.
 *
 * Two properties of xterm markers do the bookkeeping for us and are the reason
 * this file is as small as it is:
 *
 *   • A marker disposes ITSELF when its line is trimmed out of the scrollback,
 *     and `marker.line` reports -1 once that has happened. So an entry that has
 *     scrolled out of history stops being jumpable without anyone pruning it.
 *   • A decoration is owned by its marker, so disposing the marker disposes the
 *     highlight with it. There is no separate highlight lifetime to get wrong.
 *
 * The one thing markers do NOT survive is the serialize/replay of a terminal
 * that really is rebuilt, which since #346 a split-tree restructure no longer
 * does (`snapshotSurfaceBuffer` → `terminal.write(snapshot)`, issue #49): the
 * replacement terminal has the same TEXT but none of the marker objects. That
 * is handled by forgetting the surface's marks on unmount and letting every
 * entry fall back to `line: null` — the outline still lists the prompts, it just
 * cannot jump to the ones from before the rebuild. Faking
 * a line there would scroll the user somewhere arbitrary, which is worse than
 * an honestly disabled jump.
 */

interface MarkRecord {
  marker: IMarker;
  decorations: IDecoration[];
  /** A re-validation is already queued; see `applyHighlight`'s `onRender`. */
  revalidating?: boolean;
  /**
   * First-row probe for re-validation. `onRender` runs for every visible
   * decoration on every viewport render; re-scanning a whole prompt block there
   * would turn each PTY frame into up to 200 full-buffer scans (issue #141).
   * One row slice answers the same question the old single-row needle did.
   */
  blockCheck?: { start: number; text: string };
}

/** surfaceId → entryId → mark. */
const marks = new Map<string, Map<string, MarkRecord>>();

/**
 * How far from the raw submit-time cursor `refineMark` will look for the
 * prompt's echoed text.
 *
 * Asymmetric, because the two directions mean different things. BACK covers the
 * normal case: an agent TUI has already drawn the prompt above its input box,
 * and the hook — a separate node process talking over a pipe — reaches wmux
 * some tens of milliseconds later, by which time output has pushed it up.
 * FORWARD covers a TUI that commits the prompt into scrollback only after
 * submission. Both are bounded so the scan stays a few dozen `getLine` calls,
 * on a path that runs once per user prompt.
 */
const REFINE_BACK_ROWS = 120;
const REFINE_FORWARD_ROWS = 40;

/** Shortest needle worth matching; below this a scan finds noise, not a prompt. */
const MIN_NEEDLE = 6;
/** Longest needle. A whole line rarely survives an agent's own wrapping/styling. */
const MAX_NEEDLE = 32;

function recordsFor(surfaceId: string): Map<string, MarkRecord> {
  let map = marks.get(surfaceId);
  if (!map) {
    map = new Map();
    marks.set(surfaceId, map);
  }
  return map;
}

/** Absolute buffer line of the cursor. */
function cursorLine(terminal: Terminal): number {
  const buf = terminal.buffer.active;
  return buf.baseY + buf.cursorY;
}

/**
 * The line the cursor is on RIGHT NOW.
 *
 * An agent's composer ends at the cursor. That is what decides whether a block
 * is the live input region, and unlike the submit-time line it stays true while
 * a multi-line prompt grows upward: the cursor remains on the last composer row,
 * not on the first one.
 */
export function liveLine(terminal: Terminal): number {
  return cursorLine(terminal);
}

/** Text of one absolute buffer line, trimmed of trailing blanks. */
export function lineText(terminal: Terminal, absoluteLine: number): string {
  try {
    return terminal.buffer.active.getLine(absoluteLine)?.translateToString(true) ?? '';
  } catch {
    return '';
  }
}

/**
 * The one spelling both sides of a needle test are reduced to.
 *
 * A needle is built from the prompt as the USER typed it; the haystack is a
 * terminal row as some program RE-typed it. `git   status` typed becomes
 * `git status` in the needle (whitespace-collapsed, see `buildNeedle`) and
 * stays `git   status` on the row, so a raw `includes` misses a prompt that is
 * verbatim on screen. Collapsing both is what makes the comparison mean
 * "same words", which is the only thing either side can honestly claim.
 */
function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Which of the rows a highlight covers carries the prompt, as an offset from
 * the first — or null if none of them does.
 *
 * An OFFSET rather than a boolean because the answer is re-asked on every
 * render of a visible decoration. Re-scanning all `height` rows there would be
 * up to `MAX_HIGHLIGHT_ROWS` `translateToString` calls per decoration per
 * frame, and a screen of them at PTY speed is issue #141's shape again. The
 * offset is stable under scrollback trimming (the whole block shifts with the
 * marker), so the re-check is one row. Reflow CAN move it — wrapping inserts
 * rows inside the block — and that is one of the two reasons `refreshHighlights`
 * runs on resize, which re-scans and re-establishes it.
 */
function needleRow(
  terminal: Terminal,
  from: number,
  height: number,
  needle: string,
): number | null {
  for (let offset = 0; offset < height; offset++) {
    if (normalizeForMatch(lineText(terminal, from + offset)).includes(needle)) return offset;
  }
  return null;
}

/**
 * Read an inclusive absolute line range back out of the buffer.
 *
 * This is how a SHELL-sourced prompt learns its text: wmux's integration marks
 * the boundary with OSC 133 but deliberately does not send the command line
 * over the pipe. Main already refuses to broadcast `report_command` to a
 * renderer for exactly that reason — a command line is the one place a
 * credential reliably shows up — so the text is lifted from the buffer the
 * renderer is ALREADY displaying instead. Nothing new crosses a process
 * boundary, and a pane the user cannot see cannot leak a prompt they cannot
 * see either.
 */
export function readRange(terminal: Terminal, from: number, to: number): string {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '';
  const lines: string[] = [];
  for (let y = from; y <= to && lines.length <= 64; y++) lines.push(lineText(terminal, y));
  // trimEnd(), not /\s+$/: the input is up to 64 joined terminal rows, and an
  // end-anchored greedy whitespace class over a long run of blanks is the
  // classic super-linear backtrack. A blank-padded screen is the normal case
  // here, not an adversarial one.
  return lines.join('\n').trimEnd();
}

/** Register a marker at an absolute line, or null if the line is unreachable. */
function markerAt(terminal: Terminal, absoluteLine: number): IMarker | null {
  try {
    const offset = absoluteLine - cursorLine(terminal);
    return terminal.registerMarker(offset) ?? null;
  } catch {
    return null;
  }
}

/**
 * Open a mark for `entryId` at the current cursor line.
 *
 * Returns the absolute line, or null when the terminal would not give us a
 * marker (disposed, or a buffer that cannot hold one). A null here is a normal
 * outcome the caller records as `line: null`, not an error to report.
 */
export function openMark(terminal: Terminal, surfaceId: string, entryId: string): number | null {
  return openMarkAt(terminal, surfaceId, entryId, cursorLine(terminal));
}

/**
 * Open a mark at a line resolved earlier.
 *
 * The shell path needs this: it learns the prompt's line at the `133;A` mark
 * but cannot commit an entry until `133;C`, several writes later, by which
 * point the cursor is somewhere else entirely.
 */
export function openMarkAt(
  terminal: Terminal,
  surfaceId: string,
  entryId: string,
  absoluteLine: number,
): number | null {
  const marker = markerAt(terminal, absoluteLine);
  if (!marker) return null;
  const records = recordsFor(surfaceId);
  records.get(entryId)?.marker.dispose();
  records.set(entryId, { marker, decorations: [] });
  return marker.line;
}

/**
 * Move an existing mark onto the line where the prompt's text actually appears.
 *
 * The submit-time cursor is an approximation — for an agent it is wherever the
 * TUI's input box happened to be when a hook process finally reached us. Since
 * the agent source hands us the prompt VERBATIM, we can do better than an
 * approximation: find the row the text was echoed on and move the mark there.
 *
 * Returns the new absolute line, or the existing one when nothing matched. A
 * miss is expected and harmless: a prompt whose first words the TUI reflowed,
 * abbreviated or styled beyond recognition keeps the cursor-time line, which is
 * within a screen of the truth.
 */
export function refineMark(
  terminal: Terminal,
  surfaceId: string,
  entryId: string,
  text: string,
): number | null {
  const record = marks.get(surfaceId)?.get(entryId);
  if (!record || record.marker.line < 0) return null;

  const needle = buildNeedle(text);
  if (!needle) return record.marker.line;

  const origin = record.marker.line;
  const buf = terminal.buffer.active;
  const lowest = Math.max(0, origin - REFINE_BACK_ROWS);
  const highest = Math.min(buf.baseY + terminal.rows - 1, origin + REFINE_FORWARD_ROWS);

  // Nearest match wins, searched outward from the origin, so a prompt the user
  // has typed twice resolves to the occurrence belonging to THIS submission
  // rather than to the first one in the scan window.
  let best: number | null = null;
  for (let delta = 0; delta <= REFINE_BACK_ROWS + REFINE_FORWARD_ROWS; delta++) {
    const back = origin - delta;
    if (back >= lowest && needleRow(terminal, back, 1, needle) !== null) { best = back; break; }
    const fwd = origin + delta;
    if (delta > 0 && fwd <= highest && needleRow(terminal, fwd, 1, needle) !== null) { best = fwd; break; }
  }
  if (best === null || best === origin) return origin;

  return moveMark(terminal, surfaceId, entryId, record, best) ?? origin;
}

/**
 * Move a mark to the nearest row carrying the prompt strictly ABOVE `before`.
 *
 * The submit-time cursor is inside the agent's live input region, and the composer
 * still shows the prompt when the hook arrives, so a plain nearest-match search
 * resolves to the composer. This search excludes it: only rows above the live
 * line can be the echo, and "closest above" is the one that belongs to this
 * submission rather than an older identical prompt.
 *
 * Returns the new line, or null when the echo is not there yet — the caller
 * retries while the TUI paints it.
 */
export function refineMarkAbove(
  terminal: Terminal,
  surfaceId: string,
  entryId: string,
  text: string,
  before: number,
): number | null {
  const record = marks.get(surfaceId)?.get(entryId);
  if (!record || record.marker.line < 0) return null;

  if (!buildNeedle(text)) return null;

  const buf = terminal.buffer.active;
  // Never search at or above an EARLIER prompt's mark. Re-sending the same text
  // ("continue", "run the tests again") is common, and while this turn's echo
  // is not painted yet the nearest match above the composer is the previous
  // turn's — settling there would tint and anchor last turn's question.
  let floor = 0;
  for (const [id, other] of marks.get(surfaceId) ?? []) {
    const line = other.marker.line;
    if (id !== entryId && line >= 0 && line < before) floor = Math.max(floor, line + 1);
  }
  const lowest = Math.max(floor, before - REFINE_BACK_ROWS);
  const highest = Math.min(before - 1, buf.baseY + terminal.rows - 1);
  for (let line = highest; line >= lowest; line--) {
    // The block matcher is what makes a WRAPPED first line findable: a row can
    // carry only part of it, and the single-row needle cannot see that. The
    // block must end ABOVE the live line; a block that reaches it is the
    // composer, whose first rows are above the cursor but are still input.
    const block = locatePromptBlock(terminal, line, text);
    if (block && block.line + block.rows - 1 < before) {
      return moveMark(terminal, surfaceId, entryId, record, block.line);
    }
  }
  return null;
}

/** Re-anchor a record's marker and drop the decorations bound to the old row. */
function moveMark(
  terminal: Terminal,
  surfaceId: string,
  entryId: string,
  record: MarkRecord,
  line: number,
): number | null {
  const moved = markerAt(terminal, line);
  if (!moved) return null;
  for (const decoration of record.decorations) decoration.dispose();
  record.marker.dispose();
  marks.get(surfaceId)?.set(entryId, { marker: moved, decorations: [] });
  return moved.line;
}

/**
 * The distinctive fragment of a prompt to look for in the buffer.
 *
 * Lower-cased and whitespace-collapsed because a TUI re-wraps and re-indents
 * what it echoes; taken from the first non-empty line because that is the only
 * part guaranteed to be on one row. Rejected when too short to be distinctive —
 * matching "yes" against a screen of output finds the wrong row confidently,
 * and a confidently wrong jump mark is worse than none.
 */
export function buildNeedle(text: string): string | null {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const collapsed = normalizeForMatch(first);
  if (collapsed.length < MIN_NEEDLE) return null;
  return collapsed.slice(0, MAX_NEEDLE);
}

/** Current absolute line of a mark, or null once it has scrolled out of history. */
export function lineOf(surfaceId: string, entryId: string): number | null {
  const marker = marks.get(surfaceId)?.get(entryId)?.marker;
  if (!marker) return null;
  return marker.line >= 0 ? marker.line : null;
}

/**
 * Whether this prompt's echoed block is entirely above the live input region.
 *
 * Used when the highlight is off but the anchor is on: the anchor still needs a
 * line, and the composer is not it.
 */
export function promptAboveLive(
  terminal: Terminal,
  surfaceId: string,
  entryId: string,
  text: string,
): boolean {
  const record = marks.get(surfaceId)?.get(entryId);
  if (!record || record.marker.line < 0) return false;
  const block = locatePromptBlock(terminal, record.marker.line, text);
  return block !== null && block.line + block.rows - 1 < cursorLine(terminal);
}

export interface PromptBlock {
  /** Absolute line of the first row carrying the prompt's text. */
  line: number;
  /** Rows the text actually occupies, wrapping included. */
  rows: number;
  /** First raw column that carries the prompt's text. */
  startCol: number;
  /** Rightmost raw column that carries any of the prompt's text, inclusive. */
  endCol: number;
  /** Row that carries `endCol`; `startCol` is on `line`. */
  endLine: number;
}

const promptPatterns = new Map<string, { chars: string; firstToken: string }>();
const MAX_PROMPT_PATTERNS = 256;

function patternFor(text: string): { chars: string; firstToken: string } {
  const cached = promptPatterns.get(text);
  if (cached) return cached;
  const expected = normalizeForMatch(text);
  const pattern = {
    chars: expected.replace(/ /g, ''),
    firstToken: (expected.split(' ')[0] ?? '').slice(0, 8),
  };
  if (promptPatterns.size >= MAX_PROMPT_PATTERNS) {
    const oldest = promptPatterns.keys().next().value;
    if (oldest !== undefined) promptPatterns.delete(oldest);
  }
  promptPatterns.set(text, pattern);
  return pattern;
}

/**
 * Where a prompt's own text sits in the buffer (issue #230 follow-up).
 *
 * The old estimate sized a band from the TERMINAL's width, which is not the
 * width the agent rendered into: OpenCode puts a session sidebar in the same
 * grid, and wraps the transcript in the column beside it. A prompt that wraps
 * there is taller than the estimate, and a full-row band paints through the
 * sidebar. Both are geometry questions the text itself can answer.
 *
 * The prompt is matched as a stream of non-space characters, one row at a time.
 * Whitespace is ignored because a TUI re-wraps and re-indents what it echoes;
 * characters are not, because that is the only part a TUI cannot invent. The
 * first token locates the start (after any sidebar), and the rest of the stream
 * decides where the block ends and how many rows it covers.
 *
 * Null is the honest answer when the rows no longer carry the text: the caller
 * keeps the ruler tick and drops the band rather than guessing.
 */
export function locatePromptBlock(
  terminal: Terminal,
  from: number,
  text: string,
): PromptBlock | null {
  const { chars, firstToken } = patternFor(text);
  if (!chars || !firstToken) return null;

  const row = lineText(terminal, from);
  const lower = row.toLowerCase();
  // Try every occurrence: a sidebar session title can contain the same word,
  // and only one of them is followed by the rest of the prompt.
  for (let at = lower.indexOf(firstToken); at >= 0; at = lower.indexOf(firstToken, at + 1)) {
    const block = consumeBlock(terminal, from, at, chars);
    if (block) return block;
  }
  return null;
}

/**
 * Walk rows from `startCol` until every non-space character of the prompt has
 * been met. Returns where the stream ended, or null when the row diverges from
 * the text before it is complete.
 *
 * Continuation rows restart a little to the left of the first row's column:
 * wrapped text keeps its indent, but a hard newline may be indented by the TUI
 * differently, and a couple of cells of slack costs nothing. Where a row
 * stops — the text's end, or the chat column's edge — is `consumeRow`'s call.
 */
function consumeBlock(
  terminal: Terminal,
  from: number,
  startCol: number,
  chars: string,
): PromptBlock | null {
  const span = { ptr: 0, start: -1, end: -1, endLine: from };
  const continuationCol = Math.max(0, startCol - 2);

  for (let offset = 0; offset < MAX_HIGHLIGHT_ROWS; offset++) {
    const raw = lineText(terminal, from + offset);
    if (!raw) continue;
    const row = consumeRow(raw, offset === 0 ? startCol : continuationCol, chars, span.ptr);
    if (!row) return null;
    extendSpan(span, row, from + offset);
    if (span.ptr === chars.length) {
      return { line: from, rows: offset + 1, startCol: span.start, endCol: span.end, endLine: span.endLine };
    }
  }

  // A prompt longer than the band may cover is still a prompt: keep the block
  // it managed to verify, capped, rather than dropping the highlight entirely.
  if (span.ptr === 0 || span.start < 0) return null;
  return { line: from, rows: MAX_HIGHLIGHT_ROWS, startCol: span.start, endCol: span.end, endLine: span.endLine };
}

/** Fold one consumed row into the block's running extent. */
function extendSpan(
  span: { ptr: number; start: number; end: number; endLine: number },
  row: { ptr: number; first: number; last: number },
  line: number,
): void {
  span.ptr = row.ptr;
  if (span.start < 0) span.start = row.first;
  if (row.last >= 0 && row.last >= span.end) {
    span.end = row.last;
    span.endLine = line;
  }
}

/**
 * Consume one row of the prompt's character stream, starting at column `i`.
 *
 * A mismatch is not always a divergence. A soft-wrapped row ENDS at the chat
 * column's edge, and in a layout with a sidebar on the right the row goes on
 * past that edge with the sidebar's own text. So once this row has matched
 * something, a mismatch behind a gap (two or more blanks) or on a border glyph
 * is the column boundary: the row is done and the stream continues below. A
 * mismatch anywhere else is a different text, and answers null.
 */
function consumeRow(
  raw: string,
  i: number,
  chars: string,
  ptr: number,
): { ptr: number; first: number; last: number } | null {
  let first = -1;
  let last = -1;
  let gap = 0;
  for (; i < raw.length && ptr < chars.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      gap++;
      continue;
    }
    const matches = ch.toLowerCase() === chars[ptr];
    if (!matches && ptr === 0 && isBoxChar(ch)) continue;
    if (!matches) {
      const columnEdge = last >= 0 && (gap >= 2 || isBoxChar(ch));
      return columnEdge ? { ptr, first, last } : null;
    }
    if (first < 0) first = i;
    last = i;
    gap = 0;
    ptr++;
  }
  return { ptr, first, last };
}

/** The vertical borders TUI layouts draw around their regions. */
function isBoxChar(ch: string): boolean {
  return '│┃┆┇┊┋╎╏|║'.includes(ch);
}

/**
 * Convert a string index into an xterm CELL column.
 *
 * `translateToString` speaks UTF-16 code units; a decoration's `x`/`width`
 * speak terminal cells. They agree for ASCII and diverge for exactly the text
 * most likely to sit in a sidebar title: CJK (one unit, two cells) and emoji
 * (two units, two cells). Matching on the string and painting on the string's
 * indices would move the band left of the prompt by the width of that title.
 *
 * `end` asks for the last cell of the glyph, so a wide character at the end is
 * included rather than half-covered.
 */
export function cellColumnAt(
  terminal: Terminal,
  line: number,
  index: number,
  end = false,
): number {
  const bufferLine = terminal.buffer.active.getLine(line) as
    | { length?: number; getCell?: (col: number) => { getChars?: () => string; getWidth?: () => number } | undefined }
    | undefined;
  if (!bufferLine || typeof bufferLine.getCell !== 'function') return index;

  let offset = 0;
  const length = bufferLine.length ?? 0;
  for (let col = 0; col < length; col++) {
    const cell = bufferLine.getCell(col);
    if (!cell) continue;
    const chars = cell.getChars?.() ?? '';
    const width = Math.max(0, cell.getWidth?.() ?? 1);
    // A wide glyph's trailing cell carries no code unit of its own.
    const span = width === 0 ? 0 : Math.max(1, chars.length);
    if (index < offset + span) {
      return end ? col + Math.max(1, width) - 1 : col;
    }
    offset += span;
  }
  return index;
}

export interface HighlightOptions {
  /** CSS color for the tint and the left rail. */
  color: string;
  /** Rows the prompt occupies. Clamped — a runaway value would tint the screen. */
  rows: number;
  /** Also put a tick on the scrollbar's overview ruler. */
  ruler: boolean;
  /**
   * The prompt fragment these rows must still carry for the tint to be honest
   * (issue #230), or null when the prompt has no fragment distinctive enough to
   * check — see `buildNeedle`.
   */
  needle?: string | null;
  /**
   * Whether the row is known to be the prompt's when `needle` cannot decide.
   *
   * True for a shell: OSC 133 names the row and nothing rewrites a command line
   * once it is in scrollback. False for an agent: its row is a guess refined by
   * a text search, so an UNCHECKABLE guess is exactly the case that put a band
   * over a spinner. Defaults to true, so a caller that passes neither field
   * gets the pre-#230 behaviour.
   */
  confirmed?: boolean;
  /**
   * The prompt's full text, when the caller has it. Its presence switches the
   * geometry from the terminal-width estimate to the echoed block: the band
   * covers the text's own columns and rows instead of the whole terminal row.
   */
  text?: string;
}

export interface HighlightResult {
  /** A band was actually registered on the prompt's text. */
  tinted: boolean;
  /**
   * The block is resolved and entirely above the live input region. Only then
   * may the caller anchor the view: the composer holds the prompt text too, and
   * anchoring to it would hold the composer while the answer streams below.
   */
  settled: boolean;
}

/**
 * What a band for this mark would be: its block, its height, and whether it is
 * on the prompt's text (`onTheRow`) and clear of the live composer (`settled`).
 * Pure: nothing is registered here, so `applyHighlight` stays the one writer.
 */
function decideBand(terminal: Terminal, record: MarkRecord, options: HighlightOptions) {
  const block = options.text ? locatePromptBlock(terminal, record.marker.line, options.text) : null;
  // The composer grows UPWARD from the cursor, so "above the cursor" is not a
  // live test on its own: the first row of a multi-line prompt is above it. A
  // block is live when it CONTAINS or reaches the cursor, which is true for the
  // whole composer and false for the echo above it.
  const live = cursorLine(terminal);
  const deferred = block !== null && block.line + block.rows - 1 >= live;
  const settled = options.text ? block !== null && !deferred : true;
  const height = Math.max(1, Math.min(MAX_HIGHLIGHT_ROWS, block?.rows ?? (Math.floor(options.rows) || 1)));
  const needle = options.needle ?? null;
  // An uncheckable prompt falls back to what the SOURCE can promise: a shell's
  // row is named by OSC 133, an agent's is a guess.
  //
  // When the caller supplied the text, the block match IS the check: a wrapped
  // first line is deliberately allowed to span rows, which a single-row needle
  // cannot see.
  const found = needle && !options.text
    ? needleRow(terminal, record.marker.line, height, needle)
    : null;
  const sourceVouches = options.confirmed !== false;
  let onTheRow: boolean;
  if (options.text) onTheRow = settled && (needle !== null || sourceVouches);
  else onTheRow = needle ? found !== null : sourceVouches;
  return { block, settled, height, needle, found, onTheRow };
}

/**
 * The columns a band covers: the matched block's own cells, or the full row
 * when there is no block (a shell prompt, or a ruler-only tick).
 *
 * The rail lives in CSS, inset 4px from the decoration's left edge, so the
 * decoration starts one cell before the text. That keeps the rail in the
 * margin a TUI leaves there instead of covering the first glyph.
 */
function bandColumns(terminal: Terminal, block: PromptBlock | null): { x: number; width: number } {
  if (!block) return { x: 0, width: terminal.cols };
  const startCell = cellColumnAt(terminal, block.line, block.startCol);
  const endCell = cellColumnAt(terminal, block.endLine, block.endCol, true);
  const x = Math.max(0, startCell - 1);
  return { x, width: Math.max(1, Math.min(terminal.cols - x, endCell - x + 1)) };
}

/**
 * The render-time re-check. A block band compares one row slice (see
 * `blockCheck`); a needle band re-runs the needle on the row it matched. A band
 * whose tint rests on the caller's word has nothing to check and stays.
 */
function stillOnTheRow(
  terminal: Terminal,
  record: MarkRecord,
  needleCheck: { needle: string | null; found: number | null } | null,
): boolean {
  if (!needleCheck) {
    const check = record.blockCheck;
    if (!check?.text) return false;
    const row = lineText(terminal, record.marker.line);
    return row.slice(check.start, check.start + check.text.length) === check.text;
  }
  const { needle, found } = needleCheck;
  if (!needle || found === null) return true;
  return needleRow(terminal, record.marker.line + found, 1, needle) !== null;
}

/** Most rows one prompt highlight may cover. */
const MAX_HIGHLIGHT_ROWS = 24;

/**
 * How much of the user's colour goes into the row tint.
 *
 * Only meaningful because the tint is now composited UNDER the glyphs (see
 * `applyHighlight`). The DOM overlay this replaced had to sit at 0.12 or it
 * washed the text out — and at 0.12 over a terminal background every hue
 * collapses to the same grey, which is the whole bug.
 */
const TINT_ALPHA = 0.26;

/** `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` as channels, else null. */
function parseColor(color: string): [number, number, number] | null {
  const value = (color || '').trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    // 3 and 4 digit forms are shorthand; the 4th/8th digits are alpha, which is
    // deliberately dropped — see the note on the translucent case below.
    if (digits.length === 3 || digits.length === 4) {
      return [0, 1, 2].map((i) => parseInt(digits[i] + digits[i], 16)) as [number, number, number];
    }
    if (digits.length === 6 || digits.length === 8) {
      return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
    }
    return null;
  }
  // Split rather than match the whole `rgb()` form. A pattern with `\s*` on both
  // sides of a separator that can ITSELF be a space is ambiguous, and an
  // ambiguous pattern over attacker-shaped input is the super-linear-backtracking
  // trap sonarjs/slow-regex exists to catch. One character class with `+` cannot
  // backtrack against itself.
  const open = value.indexOf('(');
  const close = value.indexOf(')', open + 1);
  const head = open > 0 ? value.slice(0, open).trim().toLowerCase() : '';
  if ((head !== 'rgb' && head !== 'rgba') || close < 0) return null;
  const parts = value.slice(open + 1, close).split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 3).map((p) => Math.round(Number(p)));
  if (channels.some((c) => !Number.isFinite(c) || c < 0 || c > 255)) return null;
  return channels as [number, number, number];
}

/** The terminal's own background, which the tint is mixed into. */
function backgroundOf(terminal: Terminal): string {
  try {
    return terminal.options?.theme?.background ?? '';
  } catch {
    return '';
  }
}

/**
 * The user's colour mixed into the terminal background, as an opaque `#rrggbb`.
 *
 * Opaque because it has to be: xterm's renderers read a decoration's
 * `backgroundColor` and composite it into the CELL background themselves, and
 * they IGNORE its alpha channel — `#ff2d5540` and `#ff2d55` paint identically on
 * both the WebGL and the DOM renderer. So the blend has to happen here, where we
 * still know what it is being mixed into.
 *
 * Null when either colour is unparseable, which is the caller's cue to fall back
 * to the CSS tint rather than guess at a background.
 *
 * On a TRANSLUCENT terminal (issue #89, where the background arrives as
 * `rgba(...)`) the alpha is dropped and the mix is against the RGB alone, so a
 * prompt's rows become an opaque band over the window backdrop. That is a
 * deliberate trade: the alternative is the tint the user configured being
 * invisible, which is the bug this replaced.
 */
function blendOverBackground(color: string, background: string): string | null {
  const fg = parseColor(color);
  const bg = parseColor(background);
  if (!fg || !bg) return null;
  const mix = (i: number) => Math.round(fg[i] * TINT_ALPHA + bg[i] * (1 - TINT_ALPHA));
  return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Tint the prompt's rows and draw a rail down their left edge (idea 1).
 *
 * ─── Why the tint is a decoration OPTION and not a CSS rule ──────────────────
 *
 * It used to be CSS: a `::before` on the decoration's DOM element at `opacity:
 * .12`, with `layer: 'bottom'` believed to put it under the glyphs. It does not,
 * and cannot. xterm gives its decoration container `z-index: 6` while the
 * renderer's canvas is `z-index: 2`, so a DOM decoration ALWAYS paints over the
 * text; `layer` only orders decorations against each other. The 0.12 was there
 * to stop the tint washing out the text it sat on — and at 0.12 over a terminal
 * background every hue collapses to the same near-neutral grey. Users reported
 * exactly that: "the rail is always the default grey, whatever colour I pick."
 * The colour was being applied perfectly; it just could not be seen.
 *
 * So the tint is handed to the RENDERER instead, via `backgroundColor`, which
 * both the WebGL and DOM renderers composite into the cell background before
 * drawing glyphs on top. That is the layer the CSS was only pretending to be on,
 * and being genuinely underneath is what lets the tint be strong enough to carry
 * a hue while the text stays crisp.
 *
 * The rail stays in CSS, where it is the one thing showing the user's colour at
 * full saturation, and the custom property still carries it so `prompt-marks.css`
 * owns the width.
 *
 * ─── Why the tint is checked against the row's CONTENT (issue #230) ──────────
 *
 * A marker anchors a decoration to a buffer LINE, and for a shell that is the
 * same thing as anchoring it to content: the row a command was typed on is
 * never rewritten again. An agent TUI breaks that equivalence. It repaints its
 * input box and its status row over the same lines several times a second, and
 * the submit-time cursor — the only line wmux has when the `UserPromptSubmit`
 * hook arrives — sits right inside that region. `refineMark` gets out of it by
 * finding the row the prompt was echoed on, but it can MISS: a prompt shorter
 * than `MIN_NEEDLE`, or one the TUI reflowed beyond recognition, leaves the
 * mark where it started. Nothing then re-checked it, so the band went on
 * tinting a row whose text had since become `✳ Germinating… (1m 15s)`.
 *
 * So the tint is a claim about content and is treated as one, twice:
 *
 *   • before registering — a band that would be wrong is never painted, rather
 *     than painted and retracted a frame later;
 *   • on every render — `onRender` fires when the row is laid out, and only
 *     then, so a decoration in scrollback costs nothing and a visible one is
 *     re-checked exactly as often as it is seen. That is the difference between
 *     this and a timer, which is what issue #141 is a standing warning against.
 *
 * A failed check drops the tint and the rail, keeping the ruler tick: the mark
 * is still roughly where the prompt is (which is what a tick claims), it is
 * just no longer on the row (which is what a band claims).
 */
export function applyHighlight(
  terminal: Terminal,
  surfaceId: string,
  entryId: string,
  options: HighlightOptions,
): HighlightResult {
  const record = marks.get(surfaceId)?.get(entryId);
  if (!record || record.marker.line < 0) return { tinted: false, settled: false };
  clearHighlight(surfaceId, entryId);

  const { block, settled, height, needle, found, onTheRow } = decideBand(terminal, record, options);
  const tint = onTheRow ? blendOverBackground(options.color, backgroundOf(terminal)) : null;
  // Nothing left to draw: no band, and no tick asked for.
  if (!onTheRow && !options.ruler) return { tinted: false, settled };

  const bounded = onTheRow ? block : null;
  record.blockCheck = bounded
    ? {
      start: bounded.startCol,
      text: lineText(terminal, record.marker.line).slice(bounded.startCol, bounded.startCol + 24),
    }
    : undefined;
  const { x, width } = bandColumns(terminal, bounded);

  try {
    const decoration = terminal.registerDecoration({
      marker: record.marker,
      x,
      width,
      height,
      layer: 'bottom',
      ...(tint ? { backgroundColor: tint } : {}),
      ...(options.ruler
        ? { overviewRulerOptions: { color: options.color, position: 'left' as const } }
        : {}),
    });
    if (!decoration) return { tinted: false, settled };
    if (onTheRow) {
      decoration.onRender((element) => {
        // onRender fires again every time the row is re-laid-out (resize, scroll
        // back into view), so this must be idempotent: classList and a custom
        // property both are.
        element.classList.add('wmux-prompt-mark');
        element.style.setProperty('--wmux-prompt-color', options.color);
        // Only when the blend could not be computed — an unparseable theme
        // background — does the old over-the-glyphs tint come back, because a
        // washed-out hint still beats a rail with nothing beside it.
        element.classList.toggle('wmux-prompt-mark--css-tint', !tint);
        // Nothing to re-check when the tint rests on the caller's word rather
        // than on the row's text.
        if (stillOnTheRow(terminal, record, options.text ? null : { needle, found })) return;
        // The row stopped carrying the prompt. Re-deciding means disposing this
        // decoration, which must not happen from inside xterm's own render pass
        // — it is iterating the decoration list right now. One deferred pass per
        // record, so a decoration re-rendering at PTY speed queues one re-apply
        // and not one per frame; the re-apply lands on the ruler-only branch,
        // which registers no `onRender`, so this terminates.
        if (record.revalidating) return;
        record.revalidating = true;
        setTimeout(() => {
          record.revalidating = false;
          applyHighlight(terminal, surfaceId, entryId, options);
        }, 0);
      });
    }
    record.decorations.push(decoration);
    return { tinted: onTheRow, settled };
  } catch {
    // Decorations are proposed API. A future xterm that changes the shape here
    // must degrade to "no highlight", never to a broken pane.
    return { tinted: false, settled };
  }
}

/** Drop a mark's decorations, keeping the marker (and so the jump target). */
export function clearHighlight(surfaceId: string, entryId: string): void {
  const record = marks.get(surfaceId)?.get(entryId);
  if (!record) return;
  for (const decoration of record.decorations) {
    try { decoration.dispose(); } catch { /* already gone with its marker */ }
  }
  record.decorations = [];
}

/**
 * A resolver for prompt-anchor: where is this prompt's row RIGHT NOW?
 *
 * Handed over as a function rather than a number because an absolute buffer line
 * stops meaning the same row once the scrollback fills and lines are trimmed off
 * the top. The marker tracks that; a snapshot does not. Null means the prompt
 * has left the scrollback, which is the anchor's cue to give up rather than hold
 * whatever has since taken that index.
 */
export function lineResolver(surfaceId: string, entryId: string): () => number | null {
  return () => lineOf(surfaceId, entryId);
}

/** Drop every highlight on a surface, leaving the marks jumpable. */
export function clearAllHighlights(surfaceId: string): void {
  const records = marks.get(surfaceId);
  if (!records) return;
  for (const entryId of records.keys()) clearHighlight(surfaceId, entryId);
}

/**
 * Scroll a prompt to the top of the viewport. Returns the line, or null when
 * the mark no longer exists — the caller must not silently scroll somewhere.
 */
export function jumpTo(terminal: Terminal, surfaceId: string, entryId: string): number | null {
  const line = lineOf(surfaceId, entryId);
  if (line === null) return null;
  try {
    terminal.scrollToLine(line);
    return line;
  } catch {
    return null;
  }
}

/** Release every marker (and so every decoration) held for a surface. */
export function forgetSurface(surfaceId: string): void {
  const records = marks.get(surfaceId);
  if (!records) return;
  for (const entryId of Array.from(records.keys())) disposeRecord(records, entryId);
  marks.delete(surfaceId);
}

function disposeRecord(records: Map<string, MarkRecord>, entryId: string): void {
  const record = records.get(entryId);
  if (!record) return;
  for (const decoration of record.decorations) {
    try { decoration.dispose(); } catch { /* already gone with its marker */ }
  }
  try { record.marker.dispose(); } catch { /* already self-disposed on trim */ }
  records.delete(entryId);
}

/**
 * Bring the mark registry back in line with the store's prompt log.
 *
 * The header above argues that self-disposing markers mean nobody has to prune.
 * That is true of CORRECTNESS and false of COST, which the #207 review caught: a
 * marker whose row is still inside the scrollback stays live, and every live
 * marker registers listeners on the buffer's line list, so trimming one line is
 * O(live markers). The store bounds itself at 200 prompts per surface and 64
 * surfaces; without this the registry kept every mark a long-lived pane had ever
 * made — easily thousands — and left decorations painted for prompts no view can
 * list any more.
 *
 * Reconciling against the store rather than tracking evictions at each call site
 * is deliberate: there are two eviction rules (a per-surface ring and a
 * least-recently-written surface cap) and they would have to be mirrored here
 * exactly. Asking "what does the store still have?" cannot drift from the answer.
 * It runs once per user prompt, over at most a few thousand ids.
 */
export function reconcile(live: Record<string, ReadonlyArray<{ id: string }>>): void {
  for (const surfaceId of Array.from(marks.keys())) {
    const entries = live[surfaceId];
    if (!entries) {
      forgetSurface(surfaceId);
      continue;
    }
    const keep = new Set(entries.map((e) => e.id));
    const records = marks.get(surfaceId);
    if (!records) continue;
    for (const entryId of Array.from(records.keys())) {
      if (!keep.has(entryId)) disposeRecord(records, entryId);
    }
  }
}

/** Test seam. */
export function __markCount(surfaceId: string): number {
  return marks.get(surfaceId)?.size ?? 0;
}
