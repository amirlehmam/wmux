import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { serializeRemountSnapshot } from '../../src/renderer/utils/remount-snapshot';

/**
 * A remount while a fullscreen TUI (Claude Code, opencode, vim) is on the
 * alternate screen. The PTY and the TUI survive it; the xterm instance does
 * not. If the replacement comes up on the NORMAL buffer, every frame the TUI
 * draws afterwards lands in the shell's scrollback, and the TUI's exit
 * `ESC[?1049l` has no alternate screen to leave — only its restoreCursor() runs,
 * homing the cursor, so the shell's prompt is printed over row 1.
 *
 * Real xterm and the real SerializeAddon, no DOM needed for the buffer.
 */

const ESC = '\x1b';
const COLS = 40;
const ROWS = 8;

function makeTerminal(): { terminal: Terminal; serializer: SerializeAddon } {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  return { terminal, serializer };
}

function write(t: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => t.write(data, resolve));
}

function viewport(t: Terminal): string[] {
  const b = t.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < t.rows; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  return out;
}

/** Shell output, then a TUI that switched to the alternate screen and drew. */
async function tuiOnAltScreen(): Promise<{ terminal: Terminal; serializer: SerializeAddon }> {
  const t = makeTerminal();
  await write(t.terminal, 'MAIN-1\r\nMAIN-2\r\nPS> claude\r\n');
  await write(t.terminal, `${ESC}[?1049h${ESC}[H`);
  await write(t.terminal, 'TUI-FRAME-1\r\nTUI-FRAME-2');
  return t;
}

/** Dispose-and-rebuild, the way useTerminal's unmount and mount do it. */
async function remount(source: { terminal: Terminal; serializer: SerializeAddon }): Promise<Terminal> {
  const text = serializeRemountSnapshot(source.serializer);
  source.terminal.dispose();
  const { terminal } = makeTerminal();
  await write(terminal, text);
  return terminal;
}

describe('serializeRemountSnapshot', () => {
  it('brings a terminal on the alternate screen back on the alternate screen', async () => {
    const replacement = await remount(await tuiOnAltScreen());

    expect(replacement.buffer.active.type).toBe('alternate');
    expect(viewport(replacement).slice(0, 2)).toEqual(['TUI-FRAME-1', 'TUI-FRAME-2']);
  });

  it('keeps the TUI frames out of the shell scrollback after the remount', async () => {
    const replacement = await remount(await tuiOnAltScreen());

    await write(replacement, `${ESC}[H${ESC}[2JTUI-FRAME-3`);

    expect(replacement.buffer.normal.length).toBeLessThanOrEqual(ROWS);
    const normal: string[] = [];
    for (let y = 0; y < replacement.buffer.normal.length; y++) {
      normal.push(replacement.buffer.normal.getLine(y)?.translateToString(true) ?? '');
    }
    expect(normal.join('\n')).not.toContain('TUI-FRAME');
  });

  it("restores the shell's screen and cursor when the TUI exits after a remount", async () => {
    const replacement = await remount(await tuiOnAltScreen());

    await write(replacement, `${ESC}[?1049lPS> `);

    expect(replacement.buffer.active.type).toBe('normal');
    expect(viewport(replacement).slice(0, 4)).toEqual(['MAIN-1', 'MAIN-2', 'PS> claude', 'PS> ']);
  });

  it('still carries a plain shell across unchanged', async () => {
    const source = makeTerminal();
    await write(source.terminal, 'MAIN-1\r\nMAIN-2\r\nPS> ');

    const replacement = await remount(source);

    expect(replacement.buffer.active.type).toBe('normal');
    expect(viewport(replacement).slice(0, 3)).toEqual(['MAIN-1', 'MAIN-2', 'PS> ']);
    expect(replacement.buffer.active.cursorX).toBe(4);
    expect(replacement.buffer.active.cursorY).toBe(2);
  });
});

describe('useTerminal wiring', () => {
  const USE_TERMINAL = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'),
    'utf8',
  );

  it('takes the remount snapshot through serializeRemountSnapshot', () => {
    expect(USE_TERMINAL).toMatch(/const text = serializeRemountSnapshot\(serializeAddon\);/);
    expect(USE_TERMINAL).not.toMatch(/\.serialize\(\{\s*excludeAltBuffer/);
  });
});
