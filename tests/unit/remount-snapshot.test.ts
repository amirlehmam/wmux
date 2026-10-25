import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
  RemountSnapshotCache,
  serializeRemountSnapshot,
  type RemountSnapshot,
} from '../../src/renderer/utils/remount-snapshot';

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

/**
 * Since #346 a surface's xterm lives as long as the surface, so a snapshot is
 * only ever taken by a terminal that is torn down — usually because its pane
 * was closed. The PTY it was serialized for is then gone, and the surface id
 * can come back (Load session keeps saved ids) on a FRESH shell.
 */
describe('RemountSnapshotCache', () => {
  const SURFACE = 'surf-1';

  function cacheFor(open: Set<string>): RemountSnapshotCache {
    return new RemountSnapshotCache({ capacity: 32, isOpen: (id) => open.has(id) });
  }

  function captureOf(t: { terminal: Terminal; serializer: SerializeAddon }): () => RemountSnapshot {
    return () => ({ text: serializeRemountSnapshot(t.serializer), cols: t.terminal.cols, rows: t.terminal.rows });
  }

  async function replayInto(snapshot: RemountSnapshot | undefined): Promise<Terminal> {
    const { terminal } = makeTerminal();
    if (snapshot) await write(terminal, snapshot.text);
    return terminal;
  }

  it('does not replay a closed surface into a fresh PTY that reuses its id', async () => {
    const open = new Set([SURFACE]);
    const cache = cacheFor(open);
    const source = await tuiOnAltScreen();
    // Torn down while still open (a rebuild nothing consumed), then closed.
    cache.retire(SURFACE, captureOf(source));
    source.terminal.dispose();
    open.delete(SURFACE);

    // Load session brings the id back; the lookup finds no PTY and spawns one.
    open.add(SURFACE);
    const fresh = await replayInto(cache.take(SURFACE, false));
    await write(fresh, 'PS> ');

    expect(fresh.buffer.active.type).toBe('normal');
    expect(viewport(fresh)[0]).toBe('PS> ');
    // And the stale entry is gone, not merely skipped once.
    expect(cache.take(SURFACE, true)).toBeUndefined();
  });

  it('restores the buffer and the alternate screen on a reused PTY (#345)', async () => {
    const cache = cacheFor(new Set([SURFACE]));
    const source = await tuiOnAltScreen();
    cache.retire(SURFACE, captureOf(source));
    source.terminal.dispose();

    const replacement = await replayInto(cache.take(SURFACE, true));

    expect(replacement.buffer.active.type).toBe('alternate');
    expect(viewport(replacement).slice(0, 2)).toEqual(['TUI-FRAME-1', 'TUI-FRAME-2']);
    await write(replacement, `${ESC}[?1049lPS> `);
    expect(viewport(replacement).slice(0, 4)).toEqual(['MAIN-1', 'MAIN-2', 'PS> claude', 'PS> ']);
  });

  it('neither serializes nor caches a terminal whose surface was closed', () => {
    const open = new Set<string>();
    const cache = cacheFor(open);
    const capture = vi.fn((): RemountSnapshot => ({ text: 'BUFFER', cols: COLS, rows: ROWS }));

    cache.retire(SURFACE, capture);

    expect(capture).not.toHaveBeenCalled();
    expect(cache.take(SURFACE, true)).toBeUndefined();
  });

  it('drops an earlier snapshot when the surface is then closed', () => {
    const open = new Set([SURFACE]);
    const cache = cacheFor(open);
    cache.retire(SURFACE, () => ({ text: 'OLD', cols: COLS, rows: ROWS }));

    open.delete(SURFACE);
    cache.retire(SURFACE, () => ({ text: 'NEW', cols: COLS, rows: ROWS }));

    expect(cache.take(SURFACE, true)).toBeUndefined();
  });

  it('stays bounded, dropping the oldest entry first', () => {
    const cache = new RemountSnapshotCache({ capacity: 2, isOpen: () => true });
    for (const id of ['a', 'b', 'c']) cache.retire(id, () => ({ text: id, cols: COLS, rows: ROWS }));

    expect(cache.take('a', true)).toBeUndefined();
    expect(cache.take('b', true)?.text).toBe('b');
    expect(cache.take('c', true)?.text).toBe('c');
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

  it('replays a snapshot only once the PTY lookup says whether the PTY was reused', () => {
    // Nothing reads the cache at mount, before the lookup has answered.
    expect(USE_TERMINAL).not.toMatch(/surfaceBufferCache\.get\(/);
    // Each attach is preceded by the restore, told what the lookup found.
    expect(USE_TERMINAL).toMatch(/restoreSurfaceState\(true\);\s*attachToPty\(surfaceId!\);/);
    const created = USE_TERMINAL.match(/restoreSurfaceState\(created\.reused\);[\s\S]{0,200}?attachToPty\(created\.id\);/g);
    expect(created).toHaveLength(2);
  });

  it('replays mouse modes on the same decision, and forgets them for a fresh PTY', () => {
    expect(USE_TERMINAL).toMatch(/takeMouseModeReplay\(surfaceMouseModes, surfaceId, ptyReused\)/);
    expect(USE_TERMINAL).toMatch(/if \(!ptyReused\) wheelLineAccum\.delete\(surfaceId\);/);
    expect(USE_TERMINAL).not.toMatch(/mouseModeReplaySequence\(surfaceMouseModes\.get\(surfaceId\)\)/);
  });
});
