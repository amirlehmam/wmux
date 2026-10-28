import type { IBufferCell, Terminal } from '@xterm/xterm';
import type { SerializeAddon } from '@xterm/addon-serialize';
import {
  HISTORY_ATTRIBUTES,
  TERMINAL_HISTORY_VERSION,
  isTerminalHistoryGeometry,
  validateTerminalHistory,
  type TerminalHistoryBridge,
  type TerminalHistoryBinding,
  type TerminalHistoryState,
  type TerminalHistoryColor,
  type TerminalHistoryRecord,
  type TerminalHistoryRun,
  type TerminalHistoryStyle,
  type TerminalHistoryValidationError,
  type TerminalHistoryValidationResult,
} from '../../shared/terminal-history';
import { ReplayHold } from './replay-hold';
import type { RemountSnapshot } from './remount-snapshot';

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

/** A disposed xterm need not deliver its queued callbacks; cancellation must still settle. */
function write(
  terminal: Terminal,
  text: string,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const cancel = () => { resolve(false); };
    if (!current()) { resolve(false); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      terminal.write(text, () => {
        signal?.removeEventListener('abort', cancel);
        resolve(current());
      });
    } catch (error) {
      signal?.removeEventListener('abort', cancel);
      reject(error);
    }
  });
}

export type TerminalHistoryReplayResult =
  | { ok: true; restored: boolean }
  | { ok: false; error: TerminalHistoryValidationError | 'cancelled' };

/**
 * Only for a fresh, unattached xterm. No PTY or registry is touched here. The
 * owner must route concurrent fit requests through the supplied ReplayHold;
 * fitCurrentSize runs after drawing drains and must not spawn/write a PTY.
 * A fit deferred during the tail requires another clean viewport at that new
 * size; scrolling before clearing keeps any newly exposed history intact.
 * The owner supplies identity/consent checks, including inside write callbacks.
 */
export async function replayTerminalHistory(
  terminal: Terminal,
  value: unknown,
  hold: ReplayHold,
  fitCurrentSize: () => void,
  lifecycle: { signal?: AbortSignal; isCurrent?: () => boolean; beforeTail?: () => Promise<void> } = {},
): Promise<TerminalHistoryReplayResult> {
  const current = () => !lifecycle.signal?.aborted && (lifecycle.isCurrent?.() ?? true);
  const cancelled = { ok: false, error: 'cancelled' } as const;
  if (!current()) return cancelled;
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
    if (!await write(terminal, drawing, current, lifecycle.signal) || !current()) return cancelled;
  } finally {
    hold.release();
  }
  // Authorization can involve IPC. Finish it BEFORE the final geometry/tail
  // loop, so no later await can expose old rows after the viewport is cleaned.
  if (lifecycle.beforeTail) {
    if (!current()) return cancelled;
    await lifecycle.beforeTail();
    if (!current()) return cancelled;
  }
  let divider = `[New terminal session | checkpoint ${checkpoint}]`;
  let fitOwed: boolean;
  do {
    if (!current()) return cancelled;
    fitCurrentSize();
    if (!current()) return cancelled;
    hold.hold();
    try {
      // The tail is geometry-dependent too. Keep its size through parsing,
      // then honour any deferred fit without printing a duplicate divider.
      // Scroll all current rows before ED, including history exposed by a fit.
      if (!await write(terminal, RESET + `\x1b[${terminal.rows};1H` + divider
        + '\r\n'.repeat(terminal.rows) + '\x1b[H\x1b[2J', current, lifecycle.signal)
        || !current()) return cancelled;
    } finally {
      fitOwed = hold.release();
    }
    divider = '';
  } while (fitOwed);
  return { ok: true, restored: true };
}

type PendingPtyEvent = { kind: 'data'; data: string } | { kind: 'exit'; code: number };

interface HistoryPtyEvents {
  onData(id: string, callback: (data: string) => void): () => void;
  onExit(id: string, callback: (code: number) => void): () => void;
}

export interface RetainedTerminalEvents {
  readonly exited: boolean;
  attach(data: (data: string) => void, exit: (code: number) => void,
    fence: (callback: () => void) => void): () => void;
  dispose(): void;
}

/**
 * Keep one subscription across the create/authorization gap and its successor.
 * Only the initial backlog is queued; adoption switches these same listeners to
 * the normal handlers. An exit needs the preceding drawing parsed before its
 * normal reset handler inspects the active buffer.
 */
function retainTerminalEvents(source: HistoryPtyEvents, id: string): RetainedTerminalEvents {
  let queue: PendingPtyEvent[] = [];
  let target: { data(data: string): void; exit(code: number): void } | undefined;
  let disposed = false;
  let draining = false;
  let exited = false;
  const receive = (event: PendingPtyEvent) => {
    if (disposed) return;
    if (event.kind === 'exit') exited = true;
    if (!target || draining) queue.push(event);
    else if (event.kind === 'data') target.data(event.data);
    else target.exit(event.code);
  };
  const offData = source.onData(id, (data) => receive({ kind: 'data', data }));
  const offExit = source.onExit(id, (code) => receive({ kind: 'exit', code }));
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    queue = [];
    target = undefined;
    offData();
    offExit();
  };
  return {
    get exited() { return exited; },
    dispose,
    attach(data, exit, fence) {
      if (disposed) return () => {};
      target = { data, exit };
      draining = true;
      let index = 0;
      const drain = () => {
        while (!disposed && target && index < queue.length) {
          const event = queue[index++];
          if (event.kind === 'data') target.data(event.data);
          else {
            fence(() => {
              if (disposed || !target) return;
              target.exit(event.code);
              drain();
            });
            return;
          }
        }
        // New events can arrive after replay/data were queued but before xterm
        // parsed them. Keep retaining until that fence drains too, or an early
        // EXIT would inspect the pre-replay buffer and miss the alternate screen.
        fence(() => {
          if (disposed) return;
          if (index < queue.length) { drain(); return; }
          queue = [];
          draining = false;
        });
      };
      drain();
      return dispose;
    },
  };
}

interface PendingHistoryCreation {
  settled: Promise<void>;
  finish(): void;
  binding: TerminalHistoryBinding;
  snapshot: RemountSnapshot | null;
  events?: RetainedTerminalEvents;
  waiters: number;
  confirmed: boolean;
  fresh: boolean;
}

// Only the create/response gap is coordinated here, not terminal or PTY lifetimes.
const pendingHistoryCreations = new Map<string, PendingHistoryCreation>();

/** No mounted owner means no raw-output archive, even if its IPC never settles. */
function claimHistoryHandoff(pending: PendingHistoryCreation, signal: AbortSignal): () => void {
  pending.waiters++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    pending.waiters--;
    // StrictMode sets up its replacement synchronously after cleanup. Let that
    // mount claim the backlog, but never retain it waiting for a later Retry.
    queueMicrotask(() => {
      if (pending.waiters) return;
      pending.events?.dispose();
      pending.events = undefined;
    });
  };
  if (signal.aborted) release();
  else signal.addEventListener('abort', release, { once: true });
  return release;
}

/** Closing a surface must revoke even a handoff whose create response is still pending. */
export function forgetPendingTerminalHistoryCreation(surfaceId: string): void {
  pendingHistoryCreations.get(surfaceId)?.events?.dispose();
  pendingHistoryCreations.delete(surfaceId);
}

/**
 * A discarded creator cannot vouch for consent after it unsubscribes. The new
 * owner revalidates the exact lifetime and generation before adopting its buffer.
 */
async function authorizeHistoryHandoff(
  bridge: TerminalHistoryBridge,
  surfaceId: string,
  pending: PendingHistoryCreation,
  current: () => boolean,
  signal: AbortSignal,
): Promise<boolean> {
  let state: TerminalHistoryState | undefined;
  let events = 0;
  let invalidated = false;
  const unsubscribe = bridge.onState((next) => {
    events++;
    state = next;
    if (!next.enabled || next.generation !== pending.binding.generation) invalidated = true;
  });
  signal.addEventListener('abort', unsubscribe, { once: true });
  try {
    const seedVersion = events;
    const seed = await bridge.getState();
    if (!current()) return false;
    if (seedVersion === events && seed.ok) state = seed.value;
    if (invalidated || !state?.enabled || state.generation !== pending.binding.generation) return false;
    const issued = await bridge.getBinding(surfaceId);
    return current() && !invalidated && !!state?.enabled && state.generation === pending.binding.generation
      && issued.ok && sameBinding(issued.value.binding, pending.binding);
  } catch {
    return false;
  } finally {
    signal.removeEventListener('abort', unsubscribe);
    unsubscribe();
  }
}

interface CreatedTerminal {
  id: string;
  reused: boolean;
}

interface TerminalHistoryConnection<T extends CreatedTerminal> {
  terminal: Terminal;
  surfaceId?: string;
  bridge?: TerminalHistoryBridge;
  hold: ReplayHold;
  signal: AbortSignal;
  isCurrent(): boolean;
  has?: () => Promise<boolean>;
  create(): Promise<T>;
  fit(): void;
  captureCompleted?(): RemountSnapshot | null;
  events?: HistoryPtyEvents;
  restoreLive(reused: boolean, completed?: RemountSnapshot): void;
  attach(id: string, created?: T, retained?: RetainedTerminalEvents): void;
  abandoned(created: T): void;
  report(error: string): void;
}

function sameBinding(left: TerminalHistoryBinding | null, right: TerminalHistoryBinding): boolean {
  return !!left && left.incarnation === right.incarnation && left.generation === right.generation
    && left.recordId === right.recordId;
}

/**
 * Startup grants already exist in main before renderer load. Keep the provisional
 * grant local to this mount: reading does not consume a replacement's opportunity.
 * Nothing from disk touches a live PTY, and create's authoritative reuse answer
 * wins over the preliminary lookup. The caller retains the existing remount path.
 */
export async function connectTerminalWithHistory<T extends CreatedTerminal>(
  options: TerminalHistoryConnection<T>,
): Promise<void> {
  const { terminal, surfaceId, bridge, hold, signal } = options;
  const current = () => !signal.aborted && options.isCurrent();
  if (!current()) return;
  const inherited = surfaceId ? pendingHistoryCreations.get(surfaceId) : undefined;
  const releaseInherited = inherited ? claimHistoryHandoff(inherited, signal) : undefined;
  try {
    if (inherited) {
      await inherited.settled;
      if (!current()) return;
    }
    const exists = options.has ? await options.has() : false;
    if (!current()) return;
    const ownsHandoff = () => current() && !!surfaceId && !!inherited
      && pendingHistoryCreations.get(surfaceId) === inherited;
    // A confirmed create already started this child. A later false has() means
    // it may have exited; it is not permission to spawn the open surface again.
    if (surfaceId && (exists || (ownsHandoff() && inherited?.confirmed))) {
      const adopt = inherited?.fresh && inherited.snapshot && bridge && ownsHandoff()
        && await authorizeHistoryHandoff(bridge, surfaceId, inherited, ownsHandoff, signal);
      if (!current()) return;
      const completed = adopt && inherited && ownsHandoff() ? inherited.snapshot : undefined;
      const retained = ownsHandoff() ? inherited?.events : undefined;
      // Only the current replacement consumes the entry. A disposed waiter must
      // leave it available to the next mount, and a close may already have revoked it.
      if (inherited && pendingHistoryCreations.get(surfaceId) === inherited) {
        pendingHistoryCreations.delete(surfaceId);
      }
      if (completed) {
        options.restoreLive(true, completed);
      } else options.restoreLive(true);
      options.attach(surfaceId, undefined, retained);
      if (inherited) inherited.events = undefined;
      return;
    }
    if (inherited && surfaceId && pendingHistoryCreations.get(surfaceId) === inherited) {
      forgetPendingTerminalHistoryCreation(surfaceId);
    }
  } finally {
    releaseInherited?.();
  }

  let state: TerminalHistoryState | undefined;
  let stateEvents = 0;
  let invalidated = false;
  let binding: TerminalHistoryBinding | null = null;
  let provisional = false;
  let restored = false;
  let unsubscribe: (() => void) | undefined;
  let pendingCreation: PendingHistoryCreation | undefined;
  let releasePending: (() => void) | undefined;
  const removePending = () => {
    if (surfaceId && pendingCreation && pendingHistoryCreations.get(surfaceId) === pendingCreation) {
      pendingHistoryCreations.delete(surfaceId);
    }
  };
  const eligible = () => current() && !invalidated && !!binding && !!state?.enabled
    && state.generation === binding.generation;
  const discard = () => {
    restored = false;
    if (!provisional || !current()) return;
    // Replay has drained its callbacks before reaching here. Reset alone would
    // not cancel queued drawing, so never discard while a replay is in flight.
    terminal.reset();
    options.fit();
    provisional = false;
  };
  const unsubscribeOnAbort = () => { unsubscribe?.(); unsubscribe = undefined; };
  signal.addEventListener('abort', unsubscribeOnAbort, { once: true });
  let reported = false;
  const report = (error: string) => {
    if (current() && !reported) { reported = true; options.report(error); }
  };
  try {
    if (bridge && surfaceId) {
      try {
        unsubscribe = bridge.onState((next) => {
          stateEvents++;
          state = next;
          if (!next.enabled || (binding && next.generation !== binding.generation)) {
            invalidated = true;
            // Consent revokes disk history, not the running child's live events.
            if (pendingCreation) pendingCreation.snapshot = null;
          }
        });
        const seedVersion = stateEvents;
        const seed = await bridge.getState();
        if (!current()) return;
        if (seedVersion === stateEvents && seed.ok) state = seed.value;
        if (state?.enabled && !invalidated) {
          const issued = await bridge.getBinding(surfaceId);
          if (!current()) return;
          if (issued.ok) binding = issued.value.binding;
          // Ordinary new terminals have no association until PTY_CREATE. This
          // unauthorized outcome is not a restore failure or a new grant request.
          if (eligible()) {
            const read = await bridge.read(surfaceId, binding!);
            if (!current()) return;
            if (eligible() && read.ok) {
              const authorized = await bridge.getBinding(surfaceId);
              if (!current()) return;
              if (!authorized.ok || !sameBinding(authorized.value.binding, binding!)) invalidated = true;
              if (eligible()) {
                const validated = validateTerminalHistory(read.value);
                if (!validated.ok) report(validated.error);
                else if (validated.hasContent) {
                  provisional = true;
                  const replay = await replayTerminalHistory(terminal, validated.record, hold, options.fit,
                    { signal, isCurrent: eligible, beforeTail: async () => {
                      try {
                        const latest = await bridge.getBinding(surfaceId);
                        if (!current()) return;
                        if (!latest.ok || !sameBinding(latest.value.binding, binding!)) invalidated = true;
                      } catch { invalidated = true; report('read'); }
                    } });
                  if (!current()) return;
                  restored = replay.ok && replay.restored;
                  if (!replay.ok && replay.error !== 'cancelled') report(replay.error);
                }
              }
            } else if (!read.ok && !['missing', 'disabled', 'stale', 'unauthorized'].includes(read.error)) {
              report(read.error);
            }
          }
        }
      } catch {
        report('replay');
      }
      if (!current()) return;
      if (!restored || !eligible()) discard();
      if (!current()) return;
    }

    if (surfaceId && restored && eligible() && options.captureCompleted) {
      try {
        const snapshot = options.captureCompleted();
        if (snapshot) {
          let finish!: () => void;
          const settled = new Promise<void>((resolve) => { finish = resolve; });
          pendingCreation = { settled, finish, snapshot, binding: binding!, confirmed: false, fresh: false, waiters: 0,
            events: options.events ? retainTerminalEvents(options.events, surfaceId) : undefined };
          pendingHistoryCreations.set(surfaceId, pendingCreation);
          releasePending = claimHistoryHandoff(pendingCreation, signal);
        }
      } catch { report('capture'); }
    }
    if (!current()) return;
    // create() computes dimensions now, not before the disk read/current fit.
    const created = await options.create();
    if (pendingCreation) {
      pendingCreation.confirmed = true;
      pendingCreation.fresh = !created.reused;
    }
    if (!current()) { options.abandoned(created); return; }
    removePending();
    // Consent can change while the create request is in flight. Output listeners
    // are not attached yet, so a pending provisional buffer is still disposable.
    if (created.reused || (provisional && !eligible())) discard();
    if (!current()) { options.abandoned(created); return; }
    options.restoreLive(created.reused);
    const retained = pendingCreation?.events;
    options.attach(created.id, created, retained);
    if (pendingCreation) pendingCreation.events = undefined;
  } finally {
    // Unconfirmed/reused creates never grant a remount snapshot. A confirmed
    // fresh create can outlive this mount, but only its current successor may
    // consume the locally captured completed buffer after reauthorization.
    if (pendingCreation) {
      if (current() || !pendingCreation.confirmed || (!pendingCreation.fresh && !pendingCreation.events)) {
        removePending();
        pendingCreation.events?.dispose();
      }
      pendingCreation.finish();
    }
    releasePending?.();
    unsubscribe?.();
    signal.removeEventListener('abort', unsubscribeOnAbort);
  }
}
