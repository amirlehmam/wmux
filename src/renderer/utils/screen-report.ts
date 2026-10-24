/**
 * What `wmux read-screen` (surface.read_text) answers about a terminal.
 *
 * It used to answer the text and nothing else, and that was not enough to
 * diagnose a fullscreen TUI whose frame went wrong under it: a Claude Code pane
 * was found with its input-box rules, mode line and most of its status line
 * blank, and only the status digits that changed afterwards drawn back in, each
 * at its correct column. Two different mechanisms produce that picture and the
 * text cannot tell them apart:
 *
 * - xterm's rows shrank and grew back while the program never saw a resize.
 *   On the alternate buffer a shrink pops every line below the cursor and a
 *   grow appends blank ones, so a differential renderer keeps painting changed
 *   cells onto rows that are no longer there.
 * - the program left and re-entered the alternate screen itself. `?1049l`
 *   clears the alternate buffer, and a renderer that believes its last frame is
 *   still on screen repaints only what changed.
 *
 * So the report also carries which buffer is active, the size and the cursor,
 * and on request a short history of buffer switches and resizes per surface.
 * That history is the one piece a later look cannot reconstruct.
 */

import type { IDisposable, Terminal } from '@xterm/xterm';

export type ScreenBufferType = 'normal' | 'alternate';

export type ScreenEvent =
  | { at: number; kind: 'mount'; buffer: ScreenBufferType; cols: number; rows: number }
  | { at: number; kind: 'buffer'; buffer: ScreenBufferType }
  | { at: number; kind: 'resize'; cols: number; rows: number };

/** A {@link ScreenEvent} as it crosses the pipe: the time as ISO text. */
export type ReportedScreenEvent = Omit<ScreenEvent, 'at'> & { at: string };

export interface ScreenReport {
  text: string;
  lines: number;
  surfaceId: string;
  buffer: ScreenBufferType;
  cols: number;
  rows: number;
  /** xterm's cursor, 0-based and relative to the viewport. */
  cursorX: number;
  cursorY: number;
  screenEvents?: ReportedScreenEvent[];
}

/** Events kept per surface. A sidebar drag resizes dozens of times, so this is
 *  sized to keep the switches around a drag, not every frame of it. */
export const SCREEN_EVENT_LIMIT = 64;

/** Surfaces with a history. Kept past unmount on purpose — a terminal that was
 *  rebuilt shows up as a second `mount` — so it is bounded instead, dropping
 *  the surface that recorded least recently. */
export const SCREEN_EVENT_SURFACE_LIMIT = 64;

const screenEvents = new Map<string, ScreenEvent[]>();

function recordScreenEvent(surfaceId: string, event: ScreenEvent): void {
  const events = screenEvents.get(surfaceId) ?? [];
  events.push(event);
  if (events.length > SCREEN_EVENT_LIMIT) events.splice(0, events.length - SCREEN_EVENT_LIMIT);
  // Re-insert so Map order is least recently active first.
  screenEvents.delete(surfaceId);
  screenEvents.set(surfaceId, events);
  if (screenEvents.size > SCREEN_EVENT_SURFACE_LIMIT) {
    const oldest = screenEvents.keys().next().value;
    if (oldest !== undefined) screenEvents.delete(oldest);
  }
}

export function screenEventsFor(surfaceId: string): readonly ScreenEvent[] {
  return screenEvents.get(surfaceId) ?? [];
}

/** Test seam: the history is module state shared by every surface. */
export function forgetAllScreenEvents(): void {
  screenEvents.clear();
}

/**
 * Record `terminal`'s buffer switches and resizes under `surfaceId` until the
 * returned handle is disposed. Starts with a `mount` entry holding the state
 * the terminal starts from, so the switches after it can be read on their own.
 */
export function trackScreenEvents(
  surfaceId: string,
  terminal: Terminal,
  now: () => number = Date.now,
): IDisposable {
  recordScreenEvent(surfaceId, {
    at: now(),
    kind: 'mount',
    buffer: terminal.buffer.active.type,
    cols: terminal.cols,
    rows: terminal.rows,
  });
  const onBuffer = terminal.buffer.onBufferChange((buffer) => {
    recordScreenEvent(surfaceId, { at: now(), kind: 'buffer', buffer: buffer.type });
  });
  const onResize = terminal.onResize(({ cols, rows }) => {
    recordScreenEvent(surfaceId, { at: now(), kind: 'resize', cols, rows });
  });
  return {
    dispose: () => {
      onBuffer.dispose();
      onResize.dispose();
    },
  };
}

function reportedEvent(event: ScreenEvent): ReportedScreenEvent {
  return { ...event, at: new Date(event.at).toISOString() };
}

/**
 * Read `terminal`'s ACTIVE buffer — alternate included, so a fullscreen TUI
 * returns what is visible. `lines` counts back from the bottom of the buffer,
 * scrollback included; trailing blank lines are trimmed.
 */
export function readScreenReport(
  terminal: Terminal,
  surfaceId: string,
  options: { lines: number; events?: boolean },
): ScreenReport {
  const buf = terminal.buffer.active;
  const count = Math.min(Math.max(Math.floor(options.lines), 1), 10000);
  const end = buf.length;
  const out: string[] = [];
  for (let i = Math.max(0, end - count); i < end; i++) {
    out.push(buf.getLine(i)?.translateToString(true) ?? '');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const report: ScreenReport = {
    text: out.join('\n'),
    lines: out.length,
    surfaceId,
    buffer: buf.type,
    cols: terminal.cols,
    rows: terminal.rows,
    cursorX: buf.cursorX,
    cursorY: buf.cursorY,
  };
  if (options.events) report.screenEvents = screenEventsFor(surfaceId).map(reportedEvent);
  return report;
}
