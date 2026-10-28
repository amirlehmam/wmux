import type { IBufferCell, Terminal } from '@xterm/xterm';
import type { SerializeAddon } from '@xterm/addon-serialize';
import {
  HISTORY_ATTRIBUTES,
  TERMINAL_HISTORY_VERSION,
  isTerminalHistoryGeometry,
  validateTerminalHistory,
  type TerminalHistoryColor,
  type TerminalHistoryRecord,
  type TerminalHistoryRun,
  type TerminalHistoryStyle,
  type TerminalHistoryValidationError,
  type TerminalHistoryValidationResult,
} from '../../shared/terminal-history';
import { ReplayHold } from './replay-hold';

const RESET = '\x1b[0m';

function cellColor(cell: IBufferCell, foreground: boolean): TerminalHistoryColor {
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return { kind: 'rgb', value };
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return { kind: 'palette', value };
  return { kind: 'default' };
}

function cellStyle(cell: IBufferCell): TerminalHistoryStyle {
  const flags = HISTORY_ATTRIBUTES;
  return {
    foreground: cellColor(cell, true),
    background: cellColor(cell, false),
    attributes: (cell.isBold() ? flags.bold : 0) | (cell.isDim() ? flags.dim : 0)
      | (cell.isItalic() ? flags.italic : 0) | (cell.isUnderline() ? flags.underline : 0)
      | (cell.isBlink() ? flags.blink : 0) | (cell.isInverse() ? flags.inverse : 0)
      | (cell.isInvisible() ? flags.invisible : 0) | (cell.isStrikethrough() ? flags.strikethrough : 0)
      | (cell.isOverline() ? flags.overline : 0),
  };
}

/** Public cells preserve background-only blanks and combining text without reviving a TUI. */
function captureAlternate(terminal: Terminal): NonNullable<TerminalHistoryRecord['alternate']> {
  const lines: TerminalHistoryRun[][] = [];
  const buffer = terminal.buffer.alternate;
  const cell = buffer.getNullCell();
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(y);
    if (!line) throw new Error('Missing alternate history row');
    const runs: TerminalHistoryRun[] = [];
    let previousStyle = '';
    for (let x = 0; x < terminal.cols; x++) {
      const current = line.getCell(x, cell);
      if (!current) throw new Error('Missing alternate history cell');
      const chars = current.getChars();
      const width = current.getWidth();
      if (width === 0 && !chars) continue;
      // A leading standalone combining mark owns a slot but has no base glyph.
      // Give it a blank base so the next printable cell cannot overwrite it.
      const text = width === 0 ? ' ' + chars : chars || ' ';
      // A resize can leave a wide glyph's placeholder beyond the right edge.
      // Count only its visible source slot, but retain the glyph: replay may
      // soft-wrap it rather than dropping text or joining the next frame row.
      const columns = Math.min(width || 1, terminal.cols - x);
      const style = cellStyle(current);
      const styleKey = JSON.stringify(style);
      const previous = runs[runs.length - 1];
      if (previous && styleKey === previousStyle) {
        previous.text += text;
        previous.columns += columns;
      } else {
        runs.push({ text, columns, style });
        previousStyle = styleKey;
      }
    }
    lines.push(runs);
  }
  return { lines };
}

/**
 * The caller owns the existing serializer and the xterm write fence. Trim
 * source rows, never ANSI bytes. In addon 0.14 an explicit range suppresses
 * final cursor repositioning (unlike its scrollback option).
 */
export function captureTerminalHistory(
  terminal: Terminal,
  serializer: Pick<SerializeAddon, 'serialize'>,
  scrollback: number,
  capturedAt = Date.now(),
): TerminalHistoryValidationResult {
  if (!isTerminalHistoryGeometry(terminal.cols, terminal.rows)
    || !Number.isSafeInteger(scrollback) || scrollback < 0
    || !Number.isSafeInteger(scrollback + terminal.rows)) return { ok: false, error: 'invalid-record' };
  const end = terminal.buffer.normal.length - 1;
  const start = Math.max(0, end + 1 - scrollback - terminal.rows);
  const record: TerminalHistoryRecord = {
    version: TERMINAL_HISTORY_VERSION,
    capturedAt,
    cols: terminal.cols,
    rows: terminal.rows,
    normal: {
      startLine: start,
      lineCount: end - start + 1,
      ansi: serializer.serialize({ range: { start, end }, excludeModes: true, excludeAltBuffer: true }),
    },
  };
  if (terminal.buffer.active.type === 'alternate') record.alternate = captureAlternate(terminal);
  return validateTerminalHistory(record);
}

function colorParameters(color: TerminalHistoryColor, foreground: boolean): number[] {
  if (color.kind === 'default') return [];
  const prefix = foreground ? 38 : 48;
  return color.kind === 'palette' ? [prefix, 5, color.value]
    : [prefix, 2, (color.value >>> 16) & 255, (color.value >>> 8) & 255, color.value & 255];
}

function renderStyle(style: TerminalHistoryStyle): string {
  const parameters = [0, ...colorParameters(style.foreground, true), ...colorParameters(style.background, false)];
  const flags = HISTORY_ATTRIBUTES;
  for (const [flag, sgr] of [
    [flags.bold, 1], [flags.dim, 2], [flags.italic, 3], [flags.underline, 4], [flags.blink, 5],
    [flags.inverse, 7], [flags.invisible, 8], [flags.strikethrough, 9], [flags.overline, 53],
  ]) {
    if (style.attributes & flag) parameters.push(sgr);
  }
  return `\x1b[${parameters.join(';')}m`;
}

/** Hard breaks freeze alternate rows instead of allowing them to join as soft wraps. */
function renderAlternate(frame: NonNullable<TerminalHistoryRecord['alternate']>): string {
  return frame.lines.map((line) => line.map((run) => renderStyle(run.style) + run.text).join('') + RESET).join('\r\n');
}

function write(terminal: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve));
}

export type TerminalHistoryReplayResult =
  | { ok: true; restored: boolean }
  | { ok: false; error: TerminalHistoryValidationError };

/**
 * Only for a fresh, unattached xterm. No PTY or registry is touched here. The
 * owner must route concurrent fit requests through the supplied ReplayHold;
 * fitCurrentSize runs after drawing drains and must not spawn/write a PTY.
 * A fit deferred during the tail requires another clean viewport at that new
 * size; scrolling before clearing keeps any newly exposed history intact.
 * Lifecycle cancellation and instance ownership belong to the caller.
 */
export async function replayTerminalHistory(
  terminal: Terminal,
  value: unknown,
  hold: ReplayHold,
  fitCurrentSize: () => void,
): Promise<TerminalHistoryReplayResult> {
  const validated = validateTerminalHistory(value);
  if (!validated.ok) return validated;
  if (!validated.hasContent) return { ok: true, restored: false };
  const record = validated.record;
  const checkpoint = new Date(record.capturedAt).toISOString();
  // These wrappers are trusted code, never part of the on-disk drawing language.
  let drawing = RESET + record.normal.ansi + RESET + `\x1b[${record.rows};1H\r\n`;
  if (record.alternate) drawing += `[Frozen alternate screen | checkpoint ${checkpoint}]\r\n`
    + renderAlternate(record.alternate) + RESET + '\r\n';
  hold.hold();
  try {
    terminal.reset();
    terminal.resize(record.cols, record.rows);
    await write(terminal, drawing);
  } finally {
    hold.release();
  }
  let divider = `[New terminal session | checkpoint ${checkpoint}]`;
  let fitOwed: boolean;
  do {
    fitCurrentSize();
    hold.hold();
    try {
      // The tail is geometry-dependent too. Keep its size through parsing,
      // then honour any deferred fit without printing a duplicate divider.
      // Scroll all current rows before ED, including history exposed by a fit.
      await write(terminal, RESET + `\x1b[${terminal.rows};1H` + divider
        + '\r\n'.repeat(terminal.rows) + '\x1b[H\x1b[2J');
    } finally {
      fitOwed = hold.release();
    }
    divider = '';
  } while (fitOwed);
  return { ok: true, restored: true };
}
