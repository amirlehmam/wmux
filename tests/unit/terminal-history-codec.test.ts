import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal, type IBufferCell } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
  validateTerminalHistory,
  type TerminalHistoryRecord,
} from '../../src/shared/terminal-history';
import { captureTerminalHistory, replayTerminalHistory } from '../../src/renderer/utils/terminal-history';
import { ReplayHold } from '../../src/renderer/utils/replay-hold';

const terminals: Terminal[] = [];
function make(cols = 16, rows = 4) {
  const terminal = new Terminal({
    cols, rows, scrollback: 1000, allowProposedApi: true,
    windowsPty: { backend: 'conpty', buildNumber: 26200 }, reflowCursorLine: true,
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  terminals.push(terminal);
  return { terminal, serializer };
}
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose(); });

function write(terminal: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve));
}

function capture(source: ReturnType<typeof make>, scrollback = 20): TerminalHistoryRecord {
  const result = captureTerminalHistory(source.terminal, source.serializer, scrollback, 1234);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.record;
}

function lines(terminal: Terminal): string[] {
  return Array.from({ length: terminal.buffer.normal.length }, (_, y) =>
    terminal.buffer.normal.getLine(y)!.translateToString(true));
}

function logicalLines(terminal: Terminal): { text: string; row: number }[] {
  const output: { text: string; row: number }[] = [];
  for (let y = 0; y < terminal.buffer.normal.length; y++) {
    const line = terminal.buffer.normal.getLine(y)!;
    if (line.isWrapped && output.length > 0) output[output.length - 1].text += line.translateToString(true);
    else output.push({ text: line.translateToString(true), row: y });
  }
  return output;
}

function cellState(cell: IBufferCell, normalizeBlank = false) {
  return {
    text: cell.getChars() || (normalizeBlank ? ' ' : ''), width: cell.getWidth(),
    fg: [cell.getFgColorMode(), cell.getFgColor()], bg: [cell.getBgColorMode(), cell.getBgColor()],
    attributes: [cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isBlink(),
      cell.isInverse(), cell.isInvisible(), cell.isStrikethrough(), cell.isOverline()].map(Boolean),
  };
}

function emptyRecord(): TerminalHistoryRecord {
  return { version: 1, capturedAt: 0, cols: 16, rows: 4, normal: { startLine: 0, lineCount: 4, ansi: '' } };
}

describe('terminal history codec with real xterm and SerializeAddon', () => {
  it('keeps restored output visible immediately above the divider and fresh prompt', async () => {
    const source = make(80, 12);
    await write(source.terminal, 'OLD> ls\r\none.txt\r\ntwo.txt');
    const destination = make(80, 12).terminal;
    expect(await replayTerminalHistory(destination, capture(source), new ReplayHold(), () => {}))
      .toEqual({ ok: true, restored: true });
    await write(destination, 'NEW> ');
    const visible = lines(destination).slice(destination.buffer.normal.baseY);
    expect(visible.slice(0, 6)).toEqual([
      'OLD> ls', 'one.txt', 'two.txt', '',
      '[New terminal session | checkpoint 1970-01-01T00:00:01.234Z]', 'NEW> ',
    ]);
    expect(destination.buffer.normal.viewportY).toBe(destination.buffer.normal.baseY);
  });

  it('retains source rows, colours, background blanks, soft wraps and wide/combining text without a final cursor restore', async () => {
    const source = make();
    await write(source.terminal, Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\r\n') + '\r\n');
    await write(source.terminal, '\x1b[38;2;12;34;56m界e\u0301-' + 'wrap'.repeat(6)
      + '\x1b[0m\r\n\x1b[48;5;123m\x1b[8X\x1b[0m\r\nlast');
    // A historical cursor location must not pull subsequent labels back into output.
    await write(source.terminal, '\x1b[2A\x1b[3D');
    const serialize = vi.spyOn(source.serializer, 'serialize');
    const record = capture(source, 4);
    expect(record.normal.lineCount).toBe(8);
    expect(record.normal.startLine).toBe(source.terminal.buffer.normal.length - 8);
    expect(serialize).toHaveBeenCalledWith({
      range: { start: record.normal.startLine, end: source.terminal.buffer.normal.length - 1 },
      excludeAltBuffer: true, excludeModes: true,
    });
    expect(record.normal.ansi).toContain('\x1b[38;2;12;34;56m');
    expect(record.normal.ansi).toContain('48;5;123m');
    expect(record.normal.ansi).toContain('\x1b[8X');
    expect(record.normal.ansi).toMatch(/last(?:\x1b\[[0-9;]*m)?$/);
    const destination = make();
    await write(destination.terminal, record.normal.ansi);
    for (let y = 0; y < record.normal.lineCount; y++) {
      const original = source.terminal.buffer.normal.getLine(record.normal.startLine + y)!;
      const copied = destination.terminal.buffer.normal.getLine(y)!;
      expect(copied.translateToString(true)).toBe(original.translateToString(true));
      if (y > 0) expect(copied.isWrapped).toBe(original.isWrapped);
      for (let x = 0; x < record.cols; x++) {
        expect(cellState(copied.getCell(x)!)).toEqual(cellState(original.getCell(x)!));
      }
    }
    expect(lines(destination.terminal).join('')).not.toContain('line-0');
  });

  it('accepts the addon’s forced-wrap repair, including omitted movement parameters', async () => {
    const source = make(12, 4);
    await write(source.terminal, 'abcdefghijklM\x1b[A\x1b[6C\x1b[5X');
    const record = capture(source);
    expect(record.normal.ansi).toContain('\x1b[A');
    expect(record.normal.ansi).toContain('\x1b[B');
    const destination = make(12, 4);
    await write(destination.terminal, record.normal.ansi);
    expect(lines(destination.terminal)).toEqual(lines(source.terminal));
    expect(destination.terminal.buffer.normal.getLine(1)!.isWrapped).toBe(true);
  });

  it('keeps normal output and a labeled, styled alternate frame as ordinary hard-separated history', async () => {
    const source = make(32, 4);
    await write(source.terminal, 'normal retained\r\nshell> tui');
    await write(source.terminal, '\x1b[?1049h\x1b[H\x1b[38;2;1;2;3;48;5;22m界e\u0301  \x1b[0m'
      + '\x1b[2;3H\x1b[48;2;4;5;6m\x1b[5X\x1b[0m'
      + '\x1b[3;1H\x1b[1;2;3;4;5;7;8;9;53mflags\x1b[0m'
      + '\x1b[?1h\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[?1004h');
    const record = capture(source);
    expect(source.terminal.buffer.active.type).toBe('alternate');
    expect(record.normal.ansi).toContain('normal retained');
    expect(record.normal.ansi).not.toContain('flags');
    expect(record.alternate!.lines[0][0]).toMatchObject({ text: '界e\u0301  ', columns: 5 });
    const destination = make(32, 4).terminal;
    const data = vi.fn();
    const binary = vi.fn();
    destination.onData(data);
    destination.onBinary(binary);
    const defaults = make(32, 4).terminal.modes;
    expect(await replayTerminalHistory(destination, record, new ReplayHold(), () => {}))
      .toEqual({ ok: true, restored: true });
    expect(destination.buffer.active.type).toBe('normal');
    expect(destination.modes).toEqual(defaults);
    expect(data).not.toHaveBeenCalled();
    expect(binary).not.toHaveBeenCalled();
    const output = lines(destination);
    expect(output).toContain('normal retained');
    const logical = logicalLines(destination);
    const time = new Date(record.capturedAt).toISOString();
    const label = logical.find((line) => line.text.includes('[Frozen alternate screen | checkpoint ' + time + ']'))!;
    expect(label.row).toBeGreaterThan(0);
    expect(logical.some((line) => line.text.includes('[New terminal session | checkpoint ' + time + ']'))).toBe(true);
    const frameStart = logical[logical.indexOf(label) + 1].row;
    for (let y = 0; y < source.terminal.rows; y++) {
      const original = source.terminal.buffer.alternate.getLine(y)!;
      const copied = destination.buffer.normal.getLine(frameStart + y)!;
      expect(copied.isWrapped).toBe(false);
      for (let x = 0; x < record.cols; x++) {
        const cell = original.getCell(x)!;
        // Placeholder cells carry no drawing of their own.
        if (cell.getWidth() !== 0) expect(cellState(copied.getCell(x)!, true)).toEqual(cellState(cell, true));
      }
    }
  });

  it.each([[9, 3], [60, 9]])('fits to %ix%i only after the saved-size write callback and protects history from a fresh prompt', async (cols, rows) => {
    const source = make(24, 5);
    await write(source.terminal, 'retained-first\r\n' + 'wrapped-output-'.repeat(4) + '\r\nretained-last');
    const record = capture(source);
    const destination = make(cols, rows).terminal;
    const hold = new ReplayHold();
    let finishDrawing: (() => void) | undefined;
    let parsed!: () => void;
    const drawingParsed = new Promise<void>((resolve) => { parsed = resolve; });
    const realWrite = destination.write.bind(destination);
    let first = true;
    vi.spyOn(destination, 'write').mockImplementation((text, callback) => {
      if (!first) { realWrite(text, callback); return; }
      first = false;
      realWrite(text, () => { finishDrawing = callback; parsed(); });
    });
    const fit = vi.fn(() => {
      expect(hold.isHolding).toBe(false);
      destination.resize(cols, rows);
    });
    const replay = replayTerminalHistory(destination, record, hold, fit);
    await drawingParsed;
    expect([destination.cols, destination.rows]).toEqual([record.cols, record.rows]);
    expect(hold.isHolding).toBe(true);
    expect(hold.request()).toBe(false);
    expect(fit).not.toHaveBeenCalled();
    finishDrawing!();
    expect(await replay).toEqual({ ok: true, restored: true });
    expect(fit).toHaveBeenCalledOnce();
    expect([destination.cols, destination.rows]).toEqual([cols, rows]);
    const before = lines(destination).filter(Boolean);
    expect(before.join('')).toContain('retained-first');
    expect(before.join('')).toContain('wrapped-output-'.repeat(4));
    expect(before.join('')).toContain('retained-last');
    expect(destination.buffer.normal.cursorX).toBe(0);
    expect(lines(destination)[destination.buffer.normal.baseY + destination.buffer.normal.cursorY]).toBe('');
    expect(destination.buffer.normal.viewportY).toBe(destination.buffer.normal.baseY);
    await write(destination, 'PS> ');
    expect(lines(destination).filter(Boolean)).toEqual([...before, 'PS> ']);
  });

  it('holds the asynchronous tail and refits visible history without erasing or duplicating it', async () => {
    const source = make(32, 4);
    await write(source.terminal, 'history1\r\nhistory2\r\nhistory3\r\nhistory4');
    const record = capture(source);
    const destination = make(32, 5).terminal;
    const hold = new ReplayHold();
    let desiredRows = 5;
    const fit = vi.fn(() => { destination.resize(32, desiredRows); });
    const realWrite = destination.write.bind(destination);
    let releaseTail!: () => void;
    let queued!: () => void;
    const tailQueued = new Promise<void>((resolve) => { queued = resolve; });
    let writes = 0;
    vi.spyOn(destination, 'write').mockImplementation((text, callback) => {
      if (++writes !== 2) { realWrite(text, callback); return; }
      releaseTail = () => realWrite(text, () => {
        expect(hold.isHolding).toBe(true);
        callback?.();
      });
      queued();
    });
    const replay = replayTerminalHistory(destination, record, hold, fit);
    await tailQueued;
    desiredRows = 10;
    if (hold.request()) fit();
    expect(destination.rows).toBe(5);
    releaseTail();
    expect(await replay).toEqual({ ok: true, restored: true });
    expect(hold.isHolding).toBe(false);
    expect(destination.rows).toBe(10);
    expect(fit).toHaveBeenCalledTimes(2);
    const output = logicalLines(destination).map((line) => line.text);
    for (const line of ['history1', 'history2', 'history3', 'history4']) expect(output).toContain(line);
    expect(output.filter((line) => line.includes('[New terminal session | checkpoint '))).toHaveLength(1);
    expect(lines(destination).slice(destination.buffer.normal.baseY)).toContain('history4');
    expect(destination.buffer.normal.cursorX).toBe(0);
    const before = lines(destination).filter(Boolean);
    await write(destination, 'PS> ');
    expect(lines(destination).filter(Boolean)).toEqual([...before, 'PS> ']);
    for (const line of ['history1', 'history2', 'history3', 'history4']) expect(lines(destination)).toContain(line);
  });

  it('retains a clipped wide alternate cell and the following hard-separated frame row', async () => {
    const source = make(12, 3);
    await write(source.terminal, 'normal saved\x1b[?1049h\x1b[H123456789\x1b[31m界\x1b[0mZ\r\nnext');
    source.terminal.resize(10, 3);
    const clipped = source.terminal.buffer.alternate.getLine(0)!.getCell(9)!;
    expect([clipped.getChars(), clipped.getWidth()]).toEqual(['界', 2]);
    const record = capture(source);
    expect(record.alternate!.lines[0].reduce((columns, run) => columns + run.columns, 0)).toBe(10);
    const destination = make(10, 3).terminal;
    expect(await replayTerminalHistory(destination, record, new ReplayHold(), () => {})).toEqual({ ok: true, restored: true });
    const logical = logicalLines(destination);
    expect(logical.map((line) => line.text.trimEnd())).toContain('normal saved');
    const first = logical.findIndex((line) => line.text.trimEnd() === '123456789界');
    expect(first).toBeGreaterThan(0);
    expect(logical[first + 1].text.trimEnd()).toBe('next');
    const wideRow = destination.buffer.normal.getLine(logical[first].row + 1)!;
    expect(wideRow.isWrapped).toBe(true);
    expect(wideRow.getCell(0)!.getFgColor()).toBe(1);
  });

  it('preserves a text-bearing width-zero alternate cell on a blank base without shifting its neighbours', async () => {
    const source = make(16, 3);
    await write(source.terminal, 'normal saved\x1b[?1049h\x1b[H\x1b[32m\u0301\x1b[2C\x1b[0mK');
    const leading = source.terminal.buffer.alternate.getLine(0)!.getCell(0)!;
    expect([leading.getChars(), leading.getWidth()]).toEqual(['\u0301', 0]);
    expect(source.terminal.buffer.alternate.getLine(0)!.getCell(3)!.getChars()).toBe('K');
    const record = capture(source);
    expect(record.alternate!.lines[0].map((run) => run.text).join('')).toContain('\u0301');
    const destination = make(16, 3).terminal;
    expect(await replayTerminalHistory(destination, record, new ReplayHold(), () => {})).toEqual({ ok: true, restored: true });
    expect(logicalLines(destination).map((line) => line.text.trimEnd())).toContain('normal saved');
    const frame = logicalLines(destination).find((line) => line.text.includes('\u0301'))!;
    const line = destination.buffer.normal.getLine(frame.row)!;
    expect(line.getCell(0)!.getChars()).toBe(' \u0301');
    expect(line.getCell(0)!.getFgColor()).toBe(2);
    expect(line.getCell(3)!.getChars()).toBe('K');
  });

  it('documents the accepted addon 0.14 loss of a standalone leading combining mark in normal history', async () => {
    const source = make();
    await write(source.terminal, '\u0301\x1b[2CK');
    const original = source.terminal.buffer.normal.getLine(0)!;
    expect(original.getCell(0)!.getChars()).toBe('\u0301');
    expect(original.translateToString(true)).toBe('\u0301  K');
    const record = capture(source);
    const destination = make().terminal;
    await write(destination, record.normal.ansi);
    // The addon skips this text-bearing width-zero cell as if it were a placeholder.
    expect(record.normal.ansi).not.toContain('\u0301');
    expect(destination.buffer.normal.getLine(0)!.translateToString(true)).toBe('  K');
  });

  it.each(['bold', 'dim'] as const)('documents the accepted addon 0.14 bold-plus-dim to %s-only loss without changing text or colour', async (retained) => {
    const source = make();
    await write(source.terminal, `\x1b[31;1;2mA\x1b[22;${retained === 'bold' ? 1 : 2}mB\x1b[0m`);
    const record = capture(source);
    const destination = make().terminal;
    await write(destination, record.normal.ansi);
    const original = source.terminal.buffer.normal.getLine(0)!;
    const copied = destination.buffer.normal.getLine(0)!;
    expect([Boolean(original.getCell(0)!.isBold()), Boolean(original.getCell(0)!.isDim())]).toEqual([true, true]);
    expect([Boolean(copied.getCell(0)!.isBold()), Boolean(copied.getCell(0)!.isDim())]).toEqual([true, true]);
    expect([Boolean(original.getCell(1)!.isBold()), Boolean(original.getCell(1)!.isDim())])
      .toEqual([retained === 'bold', retained === 'dim']);
    // The addon emits 22 without re-enabling the still-active bold or dim flag.
    expect(record.normal.ansi).toContain('\x1b[22mB');
    expect([Boolean(copied.getCell(1)!.isBold()), Boolean(copied.getCell(1)!.isDim())]).toEqual([false, false]);
    expect(copied.translateToString(true)).toBe(original.translateToString(true));
    expect(copied.getCell(1)!.getFgColor()).toBe(original.getCell(1)!.getFgColor());
  });

  it('does not add a divider or resize for empty normal/alternate records, but preserves background-only output', async () => {
    const source = make();
    const destination = make(40, 8).terminal;
    const fit = vi.fn();
    for (const alt of [false, true]) {
      if (alt) await write(source.terminal, '\x1b[?1049h');
      const record = capture(source);
      expect(validateTerminalHistory(record)).toMatchObject({ ok: true, hasContent: false });
      expect(await replayTerminalHistory(destination, record, new ReplayHold(), fit)).toEqual({ ok: true, restored: false });
    }
    const blank = emptyRecord();
    blank.normal.ansi = '\x1b[1;48;5;123m\x1b[0m \r\n\x1b[4m\x1b[24m \x1b[31m \x1b[39m';
    expect(await replayTerminalHistory(destination, blank, new ReplayHold(), fit)).toEqual({ ok: true, restored: false });
    expect(fit).not.toHaveBeenCalled();
    expect([destination.cols, destination.rows]).toEqual([40, 8]);
    expect(lines(destination).every((line) => line === '')).toBe(true);
    await write(source.terminal, '\x1b[?1049l\x1b[48;5;42m\x1b[6X\x1b[0m');
    expect(validateTerminalHistory(capture(source))).toMatchObject({ ok: true, hasContent: true });
  });
});

describe('untrusted history boundary', () => {
  it.each([
    '\x1b]52;c;c2VjcmV0\x07', '\x1b]0;title\x1b\\', '\x1b]133;A\x07', '\x1bPpayload\x1b\\',
    '\x1b[6n', '\x1b[c', '\x1b[?1049h', '\x1b[?2004h', '\x1b[4h', '\x1bc',
    '\x07', '\t', '\b', '\x00', '\x9b31m', '\ud800',
    '\x1b[2J', '\x1b[H', '\x1b[1;2r', '\x1b[?1C', '\x1b[1:2m',
    '\x1b[38;5;256m', '\x1b[48;2;0;0;999m', '\x1b[38;2;1;2m', '\x1b[6m',
    '\x1b[99999999999999999999C', '\x1b[1;2C', '\x1b[', '\x1b',
  ])('rejects the entire record for unsupported or malformed control %j', async (control) => {
    const record = emptyRecord();
    record.normal.ansi = 'readable prefix' + control + 'readable suffix';
    expect(validateTerminalHistory(record)).toEqual({ ok: false, error: 'unsafe-content' });
    const terminal = make().terminal;
    const reset = vi.spyOn(terminal, 'reset');
    expect(await replayTerminalHistory(terminal, record, new ReplayHold(), () => {}))
      .toEqual({ ok: false, error: 'unsafe-content' });
    expect(reset).not.toHaveBeenCalled();
    expect(lines(terminal).every((line) => line === '')).toBe(true);
  });

  it('validates all fields and frame structure before replaying or allocating captured geometry', async () => {
    const source = make();
    await write(source.terminal, '\x1b[?1049hframe');
    const record = capture(source);
    const mutations: ((record: TerminalHistoryRecord) => void)[] = [
      (r) => { r.version = 2 as 1; }, (r) => { r.cols = NaN; }, (r) => { r.rows = Infinity; },
      (r) => { r.cols = 1; }, (r) => { r.rows = 1.5; }, (r) => { r.cols = 4096; r.rows = 4096; },
      (r) => { r.capturedAt = -1; }, (r) => { r.normal.startLine = -1; }, (r) => { r.normal.lineCount = 0; },
      (r) => { r.normal.startLine = Number.MAX_SAFE_INTEGER; },
      (r) => { r.alternate!.lines.pop(); }, (r) => { r.alternate!.lines[0] = []; },
      (r) => { r.alternate!.lines[0][0].columns++; },
      (r) => { r.alternate!.lines[0][0].style.attributes = 512; },
      (r) => { r.alternate!.lines[0][0].style.foreground = { kind: 'palette', value: -1 }; },
      (r) => { r.alternate!.lines[0][0].style.background = { kind: 'rgb', value: 0x1000000 }; },
      (r) => { Object.assign(r, { command: 'not a record field' }); },
    ];
    const terminal = make().terminal;
    const resize = vi.spyOn(terminal, 'resize');
    for (const mutate of mutations) {
      const invalid = structuredClone(record);
      mutate(invalid);
      expect(validateTerminalHistory(invalid).ok).toBe(false);
      expect((await replayTerminalHistory(terminal, invalid, new ReplayHold(), () => {})).ok).toBe(false);
    }
    expect(resize).not.toHaveBeenCalled();
    record.alternate!.lines[0][0].text = '\x1b[31m';
    expect(validateTerminalHistory(record)).toEqual({ ok: false, error: 'unsafe-content' });
    record.alternate!.lines[0][0].text = 'line\nbreak';
    expect(validateTerminalHistory(record)).toEqual({ ok: false, error: 'unsafe-content' });
  });

  it('allows only drawing SGR/color forms, CR/LF and bounded default/explicit movement', () => {
    const record = emptyRecord();
    record.normal.ansi = '\x1b[m\x1b[1;2;3;4;5;7;8;9;53mtext\r\n'
      + '\x1b[22;23;24;25;27;28;29;55m\x1b[38;5;255;48;2;0;127;255m '
      + '\x1b[39;49;30;47;90;107m\x1b[A\x1b[0B\x1b[16C\x1b[D\x1b[X';
    expect(validateTerminalHistory(record)).toMatchObject({ ok: true, hasContent: true });
  });
});
