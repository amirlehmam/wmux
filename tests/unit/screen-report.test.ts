import { describe, it, expect, beforeEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  forgetAllScreenEvents,
  readScreenReport,
  screenEventsFor,
  trackScreenEvents,
  SCREEN_EVENT_LIMIT,
  SCREEN_EVENT_SURFACE_LIMIT,
} from '../../src/renderer/utils/screen-report';

/**
 * `wmux read-screen` used to answer text only, so a pane whose fullscreen TUI
 * had lost its frame could not say whether it was still on the alternate
 * buffer, how many rows it had, or whether it had been resized or switched
 * buffers since. Those are the three facts that tell a stale-frame report's two
 * causes apart (an xterm row shrink-then-grow the program never saw, versus the
 * program itself leaving and re-entering the alternate screen), so the report
 * carries them. The real xterm is driven here; no DOM is needed for the buffer.
 */

function makeTerminal(cols = 20, rows = 6): Terminal {
  return new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
}

function write(t: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => t.write(data, resolve));
}

function clock(start = Date.UTC(2026, 9, 24, 19, 0, 0)): () => number {
  let now = start;
  return () => (now += 1000);
}

beforeEach(() => forgetAllScreenEvents());

describe('readScreenReport', () => {
  it('reads the last lines of content, not the last rows of the buffer (#466)', async () => {
    const t = makeTerminal(20, 4);
    await write(t, 'one\r\ntwo\r\nthree');
    expect(readScreenReport(t, 'surf-a', { lines: 3 })).toMatchObject({
      text: 'one\ntwo\nthree',
      lines: 3,
      surfaceId: 'surf-a',
    });
  });

  it('skips the blank rows under the prompt before counting (#466)', async () => {
    // A fresh 24-row pane: a short command's output at the top, every row
    // below the prompt empty. The bottom 12 rows are all blank, and asking for
    // them used to answer nothing at all.
    const t = makeTerminal(40, 24);
    await write(t, 'PS C:\\> echo hi\r\nhi\r\nPS C:\\> ');
    // The space after `>` was written by the shell, so xterm keeps it.
    expect(readScreenReport(t, 'surf-a', { lines: 2 })).toMatchObject({ text: 'hi\nPS C:\\> ', lines: 2 });
    expect(readScreenReport(t, 'surf-a', { lines: 12 })).toMatchObject({
      text: 'PS C:\\> echo hi\nhi\nPS C:\\> ',
      lines: 3,
    });
  });

  it('keeps blank rows that sit between lines of content', async () => {
    const t = makeTerminal(20, 8);
    await write(t, 'a\r\n\r\nb');
    expect(readScreenReport(t, 'surf-a', { lines: 2 })).toMatchObject({ text: '\nb', lines: 2 });
  });

  it('answers empty text for a buffer with nothing in it', () => {
    const t = makeTerminal(20, 6);
    expect(readScreenReport(t, 'surf-a', { lines: 5 })).toMatchObject({ text: '', lines: 0 });
  });

  it('says which buffer is active, its size, and where the cursor is', async () => {
    const t = makeTerminal(20, 6);
    await write(t, 'shell$ ');
    expect(readScreenReport(t, 'surf-a', { lines: 50 })).toMatchObject({
      buffer: 'normal',
      cols: 20,
      rows: 6,
      cursorX: 7,
      cursorY: 0,
    });

    await write(t, '\x1b[?1049h\x1b[3;5Hframe');
    expect(readScreenReport(t, 'surf-a', { lines: 50 })).toMatchObject({
      text: '\n\n    frame',
      buffer: 'alternate',
      cursorX: 9,
      cursorY: 2,
    });
  });

  it('leaves the event history out unless it is asked for', async () => {
    const t = makeTerminal();
    trackScreenEvents('surf-a', t, clock());
    expect(readScreenReport(t, 'surf-a', { lines: 50 })).not.toHaveProperty('screenEvents');
    expect(readScreenReport(t, 'surf-a', { lines: 50, events: true }).screenEvents).toHaveLength(1);
  });
});

describe('trackScreenEvents', () => {
  it('records the mount, each buffer switch and each resize, oldest first, with ISO times', async () => {
    const t = makeTerminal(20, 6);
    const tracking = trackScreenEvents('surf-a', t, clock());
    await write(t, '\x1b[?1049h');
    t.resize(20, 3);
    t.resize(20, 6);
    await write(t, '\x1b[?1049l');
    tracking.dispose();

    expect(readScreenReport(t, 'surf-a', { lines: 50, events: true }).screenEvents).toEqual([
      { at: '2026-10-24T19:00:01.000Z', kind: 'mount', buffer: 'normal', cols: 20, rows: 6 },
      { at: '2026-10-24T19:00:02.000Z', kind: 'buffer', buffer: 'alternate' },
      { at: '2026-10-24T19:00:03.000Z', kind: 'resize', cols: 20, rows: 3 },
      { at: '2026-10-24T19:00:04.000Z', kind: 'resize', cols: 20, rows: 6 },
      { at: '2026-10-24T19:00:05.000Z', kind: 'buffer', buffer: 'normal' },
    ]);
  });

  it('keeps a remounted surface\'s earlier history, so a rebuild shows up as a second mount', () => {
    trackScreenEvents('surf-a', makeTerminal(20, 6), clock()).dispose();
    trackScreenEvents('surf-a', makeTerminal(30, 8), clock()).dispose();
    expect(screenEventsFor('surf-a').map((e) => e.kind)).toEqual(['mount', 'mount']);
  });

  it('stops recording once disposed', async () => {
    const t = makeTerminal();
    trackScreenEvents('surf-a', t, clock()).dispose();
    await write(t, '\x1b[?1049h');
    t.resize(10, 3);
    expect(screenEventsFor('surf-a')).toHaveLength(1);
  });

  it('keeps only the newest events per surface', () => {
    const t = makeTerminal(20, 6);
    trackScreenEvents('surf-a', t, clock());
    for (let i = 0; i < SCREEN_EVENT_LIMIT + 5; i++) t.resize(20, 3 + (i % 2));
    const events = screenEventsFor('surf-a');
    expect(events).toHaveLength(SCREEN_EVENT_LIMIT);
    expect(events[0].kind).toBe('resize');
    expect(events[events.length - 1]).toMatchObject({ kind: 'resize', rows: 3 + ((SCREEN_EVENT_LIMIT + 4) % 2) });
  });

  it('keeps history for a bounded number of surfaces, dropping the least recently active', () => {
    const now = clock();
    for (let i = 0; i <= SCREEN_EVENT_SURFACE_LIMIT; i++) {
      trackScreenEvents(`surf-${i}`, makeTerminal(), now).dispose();
    }
    expect(screenEventsFor('surf-0')).toEqual([]);
    expect(screenEventsFor(`surf-${SCREEN_EVENT_SURFACE_LIMIT}`)).toHaveLength(1);
  });
});
