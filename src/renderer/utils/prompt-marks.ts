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
 * The one thing markers do NOT survive is the serialize/replay a split-tree
 * restructure performs (`snapshotSurfaceBuffer` → `terminal.write(snapshot)`,
 * issue #49): the replacement terminal has the same TEXT but none of the marker
 * objects. That is handled by forgetting the surface's marks on unmount and
 * letting every entry fall back to `line: null` — the outline still lists the
 * prompts, it just cannot jump to the ones from before the restructure. Faking
 * a line there would scroll the user somewhere arbitrary, which is worse than
 * an honestly disabled jump.
 */

interface MarkRecord {
  marker: IMarker;
  decorations: IDecoration[];
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

/** Text of one absolute buffer line, trimmed of trailing blanks. */
export function lineText(terminal: Terminal, absoluteLine: number): string {
  try {
    return terminal.buffer.active.getLine(absoluteLine)?.translateToString(true) ?? '';
  } catch {
    return '';
  }
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
    if (back >= lowest && lineText(terminal, back).toLowerCase().includes(needle)) { best = back; break; }
    const fwd = origin + delta;
    if (delta > 0 && fwd <= highest && lineText(terminal, fwd).toLowerCase().includes(needle)) { best = fwd; break; }
  }
  if (best === null || best === origin) return origin;

  const moved = markerAt(terminal, best);
  if (!moved) return origin;
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
function buildNeedle(text: string): string | null {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const collapsed = first.replace(/\s+/g, ' ').toLowerCase();
  if (collapsed.length < MIN_NEEDLE) return null;
  return collapsed.slice(0, MAX_NEEDLE);
}

/** Current absolute line of a mark, or null once it has scrolled out of history. */
export function lineOf(surfaceId: string, entryId: string): number | null {
  const marker = marks.get(surfaceId)?.get(entryId)?.marker;
  if (!marker) return null;
  return marker.line >= 0 ? marker.line : null;
}

export interface HighlightOptions {
  /** CSS color for the tint and the left rail. */
  color: string;
  /** Rows the prompt occupies. Clamped — a runaway value would tint the screen. */
  rows: number;
  /** Also put a tick on the scrollbar's overview ruler. */
  ruler: boolean;
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
 */
export function applyHighlight(
  terminal: Terminal,
  surfaceId: string,
  entryId: string,
  options: HighlightOptions,
): void {
  const record = marks.get(surfaceId)?.get(entryId);
  if (!record || record.marker.line < 0) return;
  clearHighlight(surfaceId, entryId);

  const height = Math.max(1, Math.min(MAX_HIGHLIGHT_ROWS, Math.floor(options.rows) || 1));
  const tint = blendOverBackground(options.color, backgroundOf(terminal));
  try {
    const decoration = terminal.registerDecoration({
      marker: record.marker,
      x: 0,
      width: terminal.cols,
      height,
      layer: 'bottom',
      ...(tint ? { backgroundColor: tint } : {}),
      ...(options.ruler
        ? { overviewRulerOptions: { color: options.color, position: 'left' as const } }
        : {}),
    });
    if (!decoration) return;
    decoration.onRender((element) => {
      // onRender fires again every time the row is re-laid-out (resize, scroll
      // back into view), so this must be idempotent — classList and a custom
      // property both are.
      element.classList.add('wmux-prompt-mark');
      element.style.setProperty('--wmux-prompt-color', options.color);
      // Only when the blend could not be computed — an unparseable theme
      // background — does the old over-the-glyphs tint come back, because a
      // washed-out hint still beats a rail with nothing beside it.
      element.classList.toggle('wmux-prompt-mark--css-tint', !tint);
    });
    record.decorations.push(decoration);
  } catch {
    // Decorations are proposed API. A future xterm that changes the shape here
    // must degrade to "no highlight", never to a broken pane.
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
