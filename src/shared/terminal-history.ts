/**
 * Disk history is drawing data, never a terminal session or a trusted escape stream.
 * Keep this boundary usable by both main and renderer without importing xterm.
 */
export const TERMINAL_HISTORY_VERSION = 1;

export interface TerminalHistoryReference {
  recordId: string;
  generation: number;
}

export interface TerminalHistoryBinding extends TerminalHistoryReference {
  incarnation: string;
}

export type TerminalHistoryStoreError =
  | 'disabled' | 'unauthorized' | 'stale' | 'missing' | 'invalid-record'
  | 'invalid-target' | 'io' | 'settings' | 'cleanup' | 'session';

export type HistoryResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: TerminalHistoryStoreError };

export interface TerminalHistoryState {
  enabled: boolean;
  generation: number;
  error: TerminalHistoryStoreError | null;
}

export interface TerminalHistoryBridge {
  getState(): Promise<HistoryResult<TerminalHistoryState>>;
  onState(callback: (state: TerminalHistoryState) => void): () => void;
  setEnabled(enabled: boolean): Promise<HistoryResult<TerminalHistoryState>>;
  getBinding(surface: string): Promise<HistoryResult<{ binding: TerminalHistoryBinding | null; incarnation: string }>>;
  read(surface: string, binding: TerminalHistoryBinding): Promise<HistoryResult<TerminalHistoryRecord>>;
  checkpoint(surface: string, binding: TerminalHistoryBinding, revision: number,
    record: TerminalHistoryRecord): Promise<HistoryResult<{ revision: number }>>;
  forget(surface: string, incarnation: string): Promise<HistoryResult>;
}

export type TerminalHistoryColor =
  | { kind: 'default' }
  | { kind: 'palette'; value: number }
  | { kind: 'rgb'; value: number };

/** Bits follow SGR's ordinary boolean attributes, not xterm's internal flags. */
export const HISTORY_ATTRIBUTES = {
  bold: 1, dim: 2, italic: 4, underline: 8, blink: 16,
  inverse: 32, invisible: 64, strikethrough: 128, overline: 256,
} as const;

export interface TerminalHistoryStyle {
  foreground: TerminalHistoryColor;
  background: TerminalHistoryColor;
  attributes: number;
}

export interface TerminalHistoryRun {
  text: string;
  /** Visible source slots, not UTF-16 length; a clipped wide glyph counts only its on-screen slot. */
  columns: number;
  style: TerminalHistoryStyle;
}

export interface TerminalHistoryRecord {
  version: typeof TERMINAL_HISTORY_VERSION;
  capturedAt: number;
  cols: number;
  rows: number;
  normal: { startLine: number; lineCount: number; ansi: string };
  /** Hard-separated rows, including background-filled blanks, at captured geometry. */
  alternate?: { lines: TerminalHistoryRun[][] };
}

export type TerminalHistoryValidationError = 'unsupported-version' | 'invalid-record' | 'unsafe-content';
export type TerminalHistoryValidationResult =
  | { ok: true; record: TerminalHistoryRecord; hasContent: boolean }
  | { ok: false; error: TerminalHistoryValidationError };

// Allocation guards for a viewport, not a history byte/line retention quota.
const MAX_DIMENSION = 4096;
const MAX_VIEWPORT_CELLS = 1_000_000;
const ALL_ATTRIBUTES = 511;
const SIMPLE_SGR = new Set([
  0, 1, 2, 3, 4, 5, 7, 8, 9, 22, 23, 24, 25, 27, 28, 29, 39, 49, 53, 55,
  ...Array.from({ length: 8 }, (_, i) => 30 + i),
  ...Array.from({ length: 8 }, (_, i) => 40 + i),
  ...Array.from({ length: 8 }, (_, i) => 90 + i),
  ...Array.from({ length: 8 }, (_, i) => 100 + i),
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function isTerminalHistoryGeometry(cols: unknown, rows: unknown): boolean {
  return integer(cols, 2, MAX_DIMENSION) && integer(rows, 1, MAX_DIMENSION)
    && cols * rows <= MAX_VIEWPORT_CELLS;
}

/** Reject controls and broken UTF-16 while retaining combining marks and astral text. */
function printableCodePoint(text: string, offset: number): number {
  const code = text.codePointAt(offset)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
    || (code >= 0xd800 && code <= 0xdfff) ? 0 : code > 0xffff ? 2 : 1;
}

function cellText(text: string): boolean {
  for (let i = 0; i < text.length;) {
    const length = printableCodePoint(text, i);
    if (!length) return false;
    i += length;
  }
  return true;
}

/**
 * This is the entire drawing language emitted by SerializeAddon 0.14's range
 * path. Unknown sequences fail the record, rather than being stripped into a
 * different, apparently valid terminal program.
 */
function scanDrawing(text: string, cols: number, rows: number): { hasContent: boolean } | null {
  let hasContent = false;
  const attributes = new Set<number>();
  let background = false;
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === '\r' || char === '\n') { i++; continue; }
    if (char !== '\x1b') {
      const length = printableCodePoint(text, i);
      if (!length) return null;
      if (char !== ' ' || attributes.size > 0 || background) hasContent = true;
      i += length;
      continue;
    }
    if (text[++i] !== '[') return null;
    const start = ++i;
    while (i < text.length && ((text[i] >= '0' && text[i] <= '9') || text[i] === ';')) i++;
    const parameters = text.slice(start, i);
    const command = text[i++];
    if (command === 'm') {
      const parts = parameters === '' ? [0] : parameters.split(';').map((part) => part === '' ? 0 : Number(part));
      if (!parts.every((part) => integer(part, 0))) return null;
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j];
        if (part === 38 || part === 48) {
          const mode = parts[++j];
          const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
          if (!count || j + count >= parts.length) return null;
          for (let k = 0; k < count; k++) if (!integer(parts[++j], 0, 255)) return null;
          if (part === 48) background = true;
        } else {
          if (!SIMPLE_SGR.has(part)) return null;
          if (part === 0) { attributes.clear(); background = false; }
          else if ((part >= 1 && part <= 9) || part === 53) attributes.add(part);
          else if (part === 22) { attributes.delete(1); attributes.delete(2); }
          else if ([23, 24, 25, 27, 28, 29].includes(part)) attributes.delete(part - 20);
          else if (part === 55) attributes.delete(53);
          else if (part === 49) background = false;
          else if ((part >= 40 && part <= 47) || (part >= 100 && part <= 107)) background = true;
        }
      }
    } else if (command && 'ABCDX'.includes(command)) {
      if (parameters.includes(';')) return null;
      const amount = parameters === '' ? 1 : Number(parameters);
      if (!integer(amount, 0, command === 'A' || command === 'B' ? rows : cols)) return null;
      if (command === 'X' && (background || attributes.size > 0)) hasContent = true;
    } else return null;
  }
  return { hasContent };
}

function color(value: unknown): value is TerminalHistoryColor {
  if (!object(value)) return false;
  if (value.kind === 'default') return keys(value, ['kind']);
  return keys(value, ['kind', 'value']) && (
    value.kind === 'palette' ? integer(value.value, 0, 255)
      : value.kind === 'rgb' && integer(value.value, 0, 0xffffff)
  );
}

function style(value: unknown): value is TerminalHistoryStyle {
  return object(value) && keys(value, ['foreground', 'background', 'attributes'])
    && color(value.foreground) && color(value.background) && integer(value.attributes, 0, ALL_ATTRIBUTES);
}

/** Validation errors contain no captured text, so callers can safely report the category. */
export function validateTerminalHistory(value: unknown): TerminalHistoryValidationResult {
  const invalid = { ok: false, error: 'invalid-record' } as const;
  const unsafe = { ok: false, error: 'unsafe-content' } as const;
  if (!object(value)) return invalid;
  if (value.version !== TERMINAL_HISTORY_VERSION) return { ok: false, error: 'unsupported-version' };
  if (!keys(value, ['version', 'capturedAt', 'cols', 'rows', 'normal', 'alternate'])
    || !integer(value.capturedAt, 0, 8_640_000_000_000_000)
    || !isTerminalHistoryGeometry(value.cols, value.rows)) return invalid;
  const cols = value.cols as number;
  const rows = value.rows as number;
  const normal = value.normal;
  if (!object(normal) || !keys(normal, ['startLine', 'lineCount', 'ansi'])
    || !integer(normal.startLine, 0) || !integer(normal.lineCount, 1)
    || !Number.isSafeInteger(normal.startLine + normal.lineCount)
    || typeof normal.ansi !== 'string') return invalid;
  const drawing = scanDrawing(normal.ansi, cols, rows);
  if (!drawing) return unsafe;
  let hasContent = drawing.hasContent;
  if (value.alternate !== undefined) {
    if (!object(value.alternate) || !keys(value.alternate, ['lines'])
      || !Array.isArray(value.alternate.lines) || value.alternate.lines.length !== rows) return invalid;
    for (const line of value.alternate.lines) {
      if (!Array.isArray(line) || line.length < 1 || line.length > cols) return invalid;
      let columns = 0;
      for (const run of line) {
        if (!object(run) || !keys(run, ['text', 'columns', 'style'])
          || typeof run.text !== 'string' || run.text.length === 0
          || !integer(run.columns, 1, cols) || !style(run.style)) return invalid;
        if (!cellText(run.text)) return unsafe;
        columns += run.columns;
        if (columns > cols) return invalid;
        if (/[^ ]/u.test(run.text) || run.style.background.kind !== 'default'
          || run.style.attributes !== 0) hasContent = true;
      }
      if (columns !== cols) return invalid;
    }
  }
  return { ok: true, record: value as unknown as TerminalHistoryRecord, hasContent };
}
