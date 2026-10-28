import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { ProgressAddon } from '@xterm/addon-progress';
import type { HistoryResult, TerminalHistoryBridge, TerminalHistoryRecord, TerminalHistoryState } from '../../src/shared/terminal-history';
import { captureTerminalHistory, connectTerminalWithHistory, forgetPendingTerminalHistoryCreation, type RetainedTerminalEvents } from '../../src/renderer/utils/terminal-history';
import { ReplayHold } from '../../src/renderer/utils/replay-hold';
import { RemountSnapshotCache, type RemountSnapshot } from '../../src/renderer/utils/remount-snapshot';
import { applyMouseModeSequences, emptyMouseModeState, type MouseModeState } from '../../src/renderer/utils/mouse-modes';
import { resetTerminalModes } from '../../src/renderer/utils/terminal-reset';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const terminals: Terminal[] = [];
function make(cols = 30, rows = 5) {
  const terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true,
    windowsPty: { backend: 'conpty', buildNumber: 26200 }, reflowCursorLine: true });
  terminals.push(terminal);
  return terminal;
}
afterEach(() => {
  forgetPendingTerminalHistoryCreation('surf-history');
  for (const terminal of terminals.splice(0)) terminal.dispose();
  vi.restoreAllMocks();
});

function write(terminal: Terminal, text: string) {
  return new Promise<void>((resolve) => terminal.write(text, resolve));
}
function text(terminal: Terminal) {
  return Array.from({ length: terminal.buffer.normal.length }, (_, y) =>
    terminal.buffer.normal.getLine(y)!.translateToString(true)).join('\n');
}
function viewport(terminal: Terminal) {
  return Array.from({ length: terminal.rows }, (_, y) =>
    terminal.buffer.normal.getLine(terminal.buffer.normal.baseY + y)!.translateToString(true));
}
async function record() {
  const source = make(24, 4);
  const serializer = new SerializeAddon();
  source.loadAddon(serializer);
  await write(source, '\x1b[31mretained-before-restart\x1b[0m\r\n' + 'wide界e\u0301'.repeat(5) + '\r\nretained-last');
  const captured = captureTerminalHistory(source, serializer, 100, 1234);
  if (!captured.ok) throw new Error(captured.error);
  return captured.record;
}

/** Real parsing can be delayed separately from delivery of xterm's write callback. */
function gateWrites(terminal: Terminal) {
  type Job = { text: string; draw(): Promise<() => void> };
  const jobs: Job[] = [];
  let waiting: ((job: Job) => void) | undefined;
  const realWrite = terminal.write.bind(terminal);
  vi.spyOn(terminal, 'write').mockImplementation((data, callback) => {
    const job: Job = { text: String(data), draw: () => new Promise((resolve) => {
      realWrite(data, () => resolve(() => callback?.()));
    }) };
    if (waiting) { const deliver = waiting; waiting = undefined; deliver(job); }
    else jobs.push(job);
  });
  return {
    next: () => jobs.length ? Promise.resolve(jobs.shift()!) : new Promise<Job>((resolve) => { waiting = resolve; }),
    realWrite,
    jobs,
  };
}

function eventSource() {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(code: number) => void>();
  return {
    onData: vi.fn((_id: string, callback: (data: string) => void) => {
      dataListeners.add(callback);
      return () => { dataListeners.delete(callback); };
    }),
    onExit: vi.fn((_id: string, callback: (code: number) => void) => {
      exitListeners.add(callback);
      return () => { exitListeners.delete(callback); };
    }),
    data: (data: string) => { for (const callback of [...dataListeners]) callback(data); },
    exit: (code = 0) => { for (const callback of [...exitListeners]) callback(code); },
    listeners: () => [dataListeners.size, exitListeners.size],
  };
}

function setup(history: TerminalHistoryRecord, terminal = make(), source?: ReturnType<typeof eventSource>) {
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  const controller = new AbortController();
  const hold = new ReplayHold();
  let current = true;
  let attached = false;
  let stateListener: ((state: TerminalHistoryState) => void) | undefined;
  const binding = { recordId: 'record-startup', generation: 7, incarnation: 'lifetime-startup' };
  const enabled = { enabled: true, generation: 7, error: null } as const;
  const unsubscribe = vi.fn(() => { stateListener = undefined; });
  const bridge: TerminalHistoryBridge = {
    getState: vi.fn(async () => ({ ok: true, value: enabled })),
    onState: vi.fn((callback) => { stateListener = callback; return unsubscribe; }),
    setEnabled: vi.fn(),
    getBinding: vi.fn(async () => ({ ok: true, value: { binding, incarnation: binding.incarnation } })),
    read: vi.fn(async () => ({ ok: true, value: history })),
    checkpoint: vi.fn(), forget: vi.fn(),
  };
  const fit = vi.fn(() => terminal.resize(30, 5));
  const has = vi.fn(async () => false);
  const create = vi.fn(async () => ({ id: 'surf-history', reused: false }));
  const remounts = new RemountSnapshotCache({ capacity: 2, isOpen: () => current });
  const restoreLive = vi.fn((reused: boolean, completed?: RemountSnapshot) => {
    if (completed) remounts.retire('surf-history', () => completed);
    const snapshot = remounts.take('surf-history', reused);
    if (!snapshot) return;
    hold.hold();
    terminal.resize(snapshot.cols, snapshot.rows);
    terminal.write(snapshot.text, () => {
      hold.release();
      if (!controller.signal.aborted && current) fit();
    });
  });
  const delivered: string[] = [];
  const mouse = new Map<string, MouseModeState>();
  let progress = 0;
  if (source) {
    const addon = new ProgressAddon();
    terminal.loadAddon(addon);
    addon.onChange(({ state }) => { progress = state; });
  }
  const exitDelivered = deferred<void>();
  const onData = vi.fn((data: string) => {
    delivered.push(data);
    const modes = mouse.get('surf-history') ?? emptyMouseModeState();
    mouse.set('surf-history', modes);
    applyMouseModeSequences(modes, data);
    terminal.write(data);
  });
  const onExit = vi.fn((_code: number) => {
    delivered.push('EXIT');
    resetTerminalModes(terminal);
    terminal.writeln('\r\n\x1b[2m[process exited]\x1b[0m');
    mouse.delete('surf-history');
    progress = 0;
    exitDelivered.resolve();
  });
  const subscriptions: Array<() => void> = [];
  controller.signal.addEventListener('abort', () => { for (const off of subscriptions) off(); });
  const attach = vi.fn((id: string, _created?: { id: string; reused: boolean }, retained?: RetainedTerminalEvents) => {
    attached = true;
    if (retained) subscriptions.push(retained.attach(onData, onExit, (callback) => {
      terminal.write('', () => { if (!controller.signal.aborted && current) callback(); });
    }));
    else if (source) subscriptions.push(source.onData(id, onData), source.onExit(id, onExit));
  });
  const abandoned = vi.fn();
  const report = vi.fn();
  const ptyWrite = vi.fn();
  terminal.onData((data) => { if (attached && !hold.isHolding) ptyWrite(data); });
  const options: Parameters<typeof connectTerminalWithHistory>[0] = { terminal, surfaceId: 'surf-history', bridge, hold, signal: controller.signal,
    isCurrent: () => current, has, create, fit, restoreLive, attach, abandoned, report, events: source,
    captureCompleted: () => ({ text: serializer.serialize(), cols: terminal.cols, rows: terminal.rows }) };
  return { terminal, controller, hold, bridge, binding, enabled, unsubscribe, fit, has, create,
    restoreLive, attach, abandoned, report, ptyWrite, options, onData, onExit, delivered, mouse, exitDelivered,
    progress: () => progress,
    run: () => connectTerminalWithHistory(options),
    replace: () => { current = false; },
    state: (next: TerminalHistoryState) => stateListener?.(next),
  };
}

/** Both mounts share the real production connection path and one unbuffered IPC source. */
async function pendingCreation(history: TerminalHistoryRecord, source: ReturnType<typeof eventSource>) {
  const original = setup(history, make(), source);
  const response = deferred<{ id: string; reused: boolean }>();
  const creating = deferred<void>();
  original.create.mockImplementation(() => { creating.resolve(); return response.promise; });
  const first = original.run();
  await creating.promise;
  return { original, response, first, retire: () => {
    original.controller.abort();
    original.terminal.dispose();
  } };
}

describe('fresh terminal history lifecycle with real xterm', () => {
  it('waits for the authorized disk read, drawing and tail callbacks before spawning at the CURRENT size', async () => {
    const s = setup(await record());
    const disk = deferred<HistoryResult<TerminalHistoryRecord>>();
    const reading = deferred<void>();
    vi.mocked(s.bridge.read).mockImplementation(() => { reading.resolve(); return disk.promise; });
    const writes = gateWrites(s.terminal);
    const connect = s.run();
    await reading.promise;
    expect(s.create).not.toHaveBeenCalled();
    disk.resolve({ ok: true, value: await record() });
    const drawing = await writes.next();
    expect([s.terminal.cols, s.terminal.rows]).toEqual([24, 4]);
    expect(s.hold.request()).toBe(false);
    const finishDrawing = await drawing.draw();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.fit).not.toHaveBeenCalled();
    finishDrawing();
    const tail = await writes.next();
    expect([s.terminal.cols, s.terminal.rows]).toEqual([30, 5]);
    s.fit.mockImplementation(() => s.terminal.resize(18, 8));
    expect(s.hold.request()).toBe(false);
    const finishTail = await tail.draw();
    expect(s.create).not.toHaveBeenCalled();
    finishTail();
    const resizedTail = await writes.next();
    expect(resizedTail.text).not.toContain('New terminal session');
    expect([s.terminal.cols, s.terminal.rows]).toEqual([18, 8]);
    (await resizedTail.draw())();
    s.create.mockImplementation(async () => {
      expect([s.terminal.cols, s.terminal.rows]).toEqual([18, 8]);
      expect(viewport(s.terminal).join('')).toContain('[New terminal session');
      return { id: 'surf-history', reused: false };
    });
    await connect;
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.attach).toHaveBeenCalledOnce();
    expect(s.restoreLive).toHaveBeenCalledExactlyOnceWith(false);
    expect(s.create).toHaveBeenCalledExactlyOnceWith(true);
    expect(s.hold.isHolding).toBe(false);
    expect(text(s.terminal)).toContain('retained-before');
    expect(s.ptyWrite).not.toHaveBeenCalled();
  });

  it('never attaches or requests history after disposal while the PTY lookup is pending', async () => {
    const s = setup(await record());
    const lookup = deferred<boolean>();
    s.has.mockReturnValue(lookup.promise);
    const connect = s.run();
    s.controller.abort();
    lookup.resolve(true);
    await connect;
    expect(s.attach).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.bridge.getState).not.toHaveBeenCalled();
  });

  it('never spawns after close while the read is pending, and unsubscribes immediately', async () => {
    const s = setup(await record());
    const disk = deferred<HistoryResult<TerminalHistoryRecord>>();
    const reading = deferred<void>();
    vi.mocked(s.bridge.read).mockImplementation(() => { reading.resolve(); return disk.promise; });
    const reset = vi.spyOn(s.terminal, 'reset');
    const connect = s.run();
    await reading.promise;
    s.controller.abort();
    expect(s.unsubscribe).toHaveBeenCalledOnce();
    s.terminal.dispose();
    disk.resolve({ ok: true, value: await record() });
    await connect;
    expect(reset).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.attach).not.toHaveBeenCalled();
  });

  it.each(['dispose', 'replacement'] as const)('ignores a late drawing callback after %s and retains the replacement restore opportunity', async (reason) => {
    const history = await record();
    const s = setup(history);
    const writes = gateWrites(s.terminal);
    const connect = s.run();
    const drawing = await writes.next();
    const lateCallback = await drawing.draw();
    if (reason === 'dispose') { s.controller.abort(); s.terminal.dispose(); }
    else s.replace();
    lateCallback();
    await connect;
    expect(s.hold.isHolding).toBe(false);
    expect(s.fit).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.attach).not.toHaveBeenCalled();
    const replacement = setup(history);
    // The grant is unchanged and still readable; no restore call consumes it.
    replacement.bridge.read = s.bridge.read;
    await replacement.run();
    expect(replacement.bridge.read).toHaveBeenCalledTimes(2);
    expect(text(replacement.terminal)).toContain('retained-before-restart');
    expect(replacement.create).toHaveBeenCalledOnce();
  });

  it('settles disposal even when xterm never delivers the queued write callback', async () => {
    const s = setup(await record());
    const writes = gateWrites(s.terminal);
    const connect = s.run();
    await writes.next();
    s.controller.abort();
    s.terminal.dispose();
    await connect;
    expect(s.hold.isHolding).toBe(false);
    expect(s.create).not.toHaveBeenCalled();
  });

  it.each(['drawing', 'tail'] as const)('discards provisional history after disable during %s without stopping the fresh shell', async (phase) => {
    const s = setup(await record());
    const writes = gateWrites(s.terminal);
    const connect = s.run();
    const drawing = await writes.next();
    const finishDrawing = await drawing.draw();
    let finish = finishDrawing;
    if (phase === 'tail') { finishDrawing(); finish = await (await writes.next()).draw(); }
    s.state({ enabled: false, generation: 8, error: null });
    s.state({ enabled: true, generation: 8, error: null });
    finish();
    await connect;
    expect(s.hold.isHolding).toBe(false);
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.attach).toHaveBeenCalledOnce();
    expect(text(s.terminal)).not.toContain('retained');
    expect(text(s.terminal)).not.toContain('New terminal session');
    expect(s.report).not.toHaveBeenCalled();
  });

  it('discards a late read after disable without ever drawing or blocking the fresh shell', async () => {
    const history = await record();
    const s = setup(history);
    const disk = deferred<HistoryResult<TerminalHistoryRecord>>();
    const reading = deferred<void>();
    vi.mocked(s.bridge.read).mockImplementation(() => { reading.resolve(); return disk.promise; });
    const reset = vi.spyOn(s.terminal, 'reset');
    const connect = s.run();
    await reading.promise;
    s.state({ enabled: false, generation: 8, error: null });
    disk.resolve({ ok: true, value: history });
    await connect;
    expect(reset).not.toHaveBeenCalled();
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.attach).toHaveBeenCalledOnce();
    expect(text(s.terminal).trim()).toBe('');
  });

  it('does not allow a late enabled seed to override a newer disable event', async () => {
    const s = setup(await record());
    const seed = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(s.bridge.getState).mockReturnValue(seed.promise);
    const connect = s.run();
    await Promise.resolve();
    s.state({ enabled: false, generation: 8, error: null });
    seed.resolve({ ok: true, value: s.enabled });
    await connect;
    expect(s.bridge.read).not.toHaveBeenCalled();
    expect(s.create).toHaveBeenCalledOnce();
  });

  it('finishes asynchronous post-draw authorization before placing the divider at the current size', async () => {
    const s = setup(await record());
    const authorizing = deferred<void>();
    const authorization = deferred<Awaited<ReturnType<TerminalHistoryBridge['getBinding']>>>();
    let calls = 0;
    vi.mocked(s.bridge.getBinding).mockImplementation(async () => {
      if (++calls === 3) { authorizing.resolve(); return authorization.promise; }
      return { ok: true, value: { binding: s.binding, incarnation: s.binding.incarnation } };
    });
    const connect = s.run();
    await authorizing.promise;
    expect(s.create).not.toHaveBeenCalled();
    s.terminal.resize(75, 12);
    s.fit.mockImplementation(() => s.terminal.resize(75, 12));
    authorization.resolve({ ok: true, value: { binding: s.binding, incarnation: s.binding.incarnation } });
    await connect;
    expect([s.terminal.cols, s.terminal.rows]).toEqual([75, 12]);
    expect(viewport(s.terminal)).toContain('retained-last');
    expect(text(s.terminal)).toContain('retained-before-restart');
    const promptRow = s.terminal.buffer.normal.cursorY;
    await write(s.terminal, 'fresh-shell>');
    expect(viewport(s.terminal)[promptRow]).toBe('fresh-shell>');
    expect(viewport(s.terminal)).toContain('retained-last');
  });

  it('rechecks the lifetime token after a deferred read, not just the surface ID', async () => {
    const s = setup(await record());
    vi.mocked(s.bridge.getBinding).mockResolvedValueOnce({ ok: true,
      value: { binding: s.binding, incarnation: s.binding.incarnation } }).mockResolvedValue({ ok: true,
      value: { binding: { ...s.binding, incarnation: 'replacement' }, incarnation: 'replacement' } });
    await s.run();
    expect(text(s.terminal)).not.toContain('retained');
    expect(s.create).toHaveBeenCalledOnce();
  });

  it('discards disk state when has(false) loses to create(reused:true), then queues ONLY the live remount before attaching', async () => {
    const s = setup(await record());
    const snapshot = new RemountSnapshotCache({ capacity: 2, isOpen: () => true });
    snapshot.retire('surf-history', () => ({ text: 'LIVE NORMAL\x1b[?1049h\x1b[HLIVE TUI', cols: 28, rows: 6 }));
    s.create.mockResolvedValue({ id: 'surf-history', reused: true });
    s.restoreLive.mockImplementation((reused) => {
      const live = snapshot.take('surf-history', reused)!;
      expect(text(s.terminal)).not.toContain('retained');
      s.hold.hold();
      s.terminal.resize(live.cols, live.rows);
      s.terminal.write(live.text + '\x1b[?1003h\x1b[?1006h', () => s.hold.release());
    });
    s.attach.mockImplementation(() => { expect(s.hold.isHolding).toBe(true); });
    await s.run();
    await write(s.terminal, '');
    expect(s.restoreLive).toHaveBeenCalledExactlyOnceWith(true);
    expect(s.attach).toHaveBeenCalledOnce();
    expect(s.restoreLive.mock.invocationCallOrder[0]).toBeLessThan(s.attach.mock.invocationCallOrder[0]);
    expect(s.terminal.buffer.active.type).toBe('alternate');
    expect(s.terminal.modes.mouseTrackingMode).toBe('any');
    expect(s.terminal.buffer.alternate.getLine(0)!.translateToString(true)).toContain('LIVE TUI');
    expect(text(s.terminal)).toContain('LIVE NORMAL');
    expect(text(s.terminal)).not.toContain('retained');
  });

  it('leaves a same-live-PTY terminal alone: no bridge calls, reset, disk replay, or fresh create', async () => {
    const s = setup(await record());
    await write(s.terminal, 'LIVE\x1b[?1049h\x1b[HTUI\x1b[?2004h');
    const reset = vi.spyOn(s.terminal, 'reset');
    s.has.mockResolvedValue(true);
    await s.run();
    expect(s.bridge.getState).not.toHaveBeenCalled();
    expect(s.bridge.getBinding).not.toHaveBeenCalled();
    expect(s.bridge.read).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.restoreLive).toHaveBeenCalledExactlyOnceWith(true);
    expect(s.terminal.buffer.active.type).toBe('alternate');
    expect(s.terminal.modes.bracketedPasteMode).toBe(true);
  });

  it.each(['missing', 'invalid', 'empty', 'io', 'throw', 'unauthorized', 'absent'] as const)('starts a clean fresh shell on %s history, without a misleading divider', async (outcome) => {
    const history = await record();
    const s = setup(history);
    if (outcome === 'absent') s.options.bridge = undefined;
    else if (outcome === 'unauthorized') vi.mocked(s.bridge.getBinding).mockResolvedValue({ ok: false, error: 'unauthorized' });
    else if (outcome === 'invalid') vi.mocked(s.bridge.read).mockResolvedValue({ ok: true,
      value: { ...history, normal: { ...history.normal, ansi: '\x1b]2;old title\x07' } } });
    else if (outcome === 'empty') vi.mocked(s.bridge.read).mockResolvedValue({ ok: true,
      value: { ...history, normal: { ...history.normal, ansi: '' } } });
    else if (outcome === 'throw') vi.mocked(s.bridge.read).mockRejectedValue(new Error('sensitive payload must never be reported'));
    else vi.mocked(s.bridge.read).mockResolvedValue({ ok: false, error: outcome });
    await s.run();
    expect(s.create).toHaveBeenCalledExactlyOnceWith(false);
    expect(s.attach).toHaveBeenCalledOnce();
    expect(text(s.terminal).trim()).toBe('');
    expect(s.hold.isHolding).toBe(false);
    expect(s.terminal.buffer.active.type).toBe('normal');
    expect(s.report).toHaveBeenCalledTimes(['invalid', 'io', 'throw'].includes(outcome) ? 1 : 0);
    expect(JSON.stringify(s.report.mock.calls)).not.toContain('sensitive');
  });

  it('recovers from a replay write failure, releases the hold and reports only a category', async () => {
    const s = setup(await record());
    vi.spyOn(s.terminal, 'write').mockImplementationOnce(() => { throw new Error('secret'); });
    await s.run();
    expect(s.report).toHaveBeenCalledExactlyOnceWith('replay');
    expect(s.hold.isHolding).toBe(false);
    expect(s.create).toHaveBeenCalledOnce();
    expect(text(s.terminal).trim()).toBe('');
  });

  it('hands completed history to the remount when fresh create confirmation arrives after disposal', async () => {
    const history = await record();
    const original = setup(history);
    const response = deferred<{ id: string; reused: boolean }>();
    const creating = deferred<void>();
    original.create.mockImplementation(() => { creating.resolve(); return response.promise; });
    const first = original.run();
    await creating.promise;
    original.controller.abort();
    original.terminal.dispose();
    const replacement = setup(history);
    replacement.has.mockResolvedValue(true);
    replacement.fit.mockImplementation(() => replacement.terminal.resize(18, 8));
    replacement.attach.mockImplementation(() => { expect(replacement.hold.isHolding).toBe(true); });
    const second = replacement.run();
    await Promise.resolve();
    const attachedBeforeConfirmation = replacement.attach.mock.calls.length;
    response.resolve({ id: 'surf-history', reused: false });
    await Promise.all([first, second]);
    await write(replacement.terminal, '');
    expect(attachedBeforeConfirmation).toBe(0);
    expect(text(replacement.terminal).replaceAll('\n', '').match(/retained-before-restart/g)).toHaveLength(1);
    expect([replacement.terminal.cols, replacement.terminal.rows]).toEqual([18, 8]);
    expect(viewport(replacement.terminal).join('')).toContain('[New terminal session');
    expect(replacement.create).not.toHaveBeenCalled();
    expect(replacement.attach).toHaveBeenCalledOnce();
    expect(original.create).toHaveBeenCalledOnce();
    expect(original.abandoned).toHaveBeenCalledExactlyOnceWith({ id: 'surf-history', reused: false });
    expect(replacement.bridge.read).not.toHaveBeenCalled();
    expect(replacement.ptyWrite).not.toHaveBeenCalled();
    // Consumption is one-shot: a later live mount uses only ordinary snapshots.
    const later = setup(history);
    later.has.mockResolvedValue(true);
    await later.run();
    expect(later.restoreLive).toHaveBeenCalledExactlyOnceWith(true);
    expect(text(later.terminal)).not.toContain('retained');
  });

  it.each(['reused', 'closed', 'disabled', 'incarnation'] as const)(
    'does not adopt the completed buffer when the pending handoff is %s', async (invalidated) => {
      const history = await record();
      const original = setup(history);
      const response = deferred<{ id: string; reused: boolean }>();
      const creating = deferred<void>();
      original.create.mockImplementation(() => { creating.resolve(); return response.promise; });
      const first = original.run();
      await creating.promise;
      original.controller.abort();
      original.terminal.dispose();
      const replacement = setup(history);
      replacement.has.mockResolvedValue(true);
      const authorizing = deferred<void>();
      const issued = deferred<Awaited<ReturnType<TerminalHistoryBridge['getBinding']>>>();
      vi.mocked(replacement.bridge.getBinding).mockImplementation(() => { authorizing.resolve(); return issued.promise; });
      const second = replacement.run();
      response.resolve({ id: 'surf-history', reused: invalidated === 'reused' });
      if (invalidated !== 'reused') {
        await authorizing.promise;
        expect(replacement.attach).not.toHaveBeenCalled();
        if (invalidated === 'closed') forgetPendingTerminalHistoryCreation('surf-history');
        if (invalidated === 'disabled') replacement.state({ enabled: false, generation: 8, error: null });
        const binding = invalidated === 'incarnation'
          ? { ...replacement.binding, incarnation: 'new-lifetime' } : replacement.binding;
        issued.resolve({ ok: true, value: { binding, incarnation: binding.incarnation } });
      }
      await Promise.all([first, second]);
      await write(replacement.terminal, '');
      expect(replacement.restoreLive).toHaveBeenCalledExactlyOnceWith(true);
      expect(replacement.attach).toHaveBeenCalledOnce();
      expect(replacement.create).not.toHaveBeenCalled();
      expect(text(replacement.terminal)).not.toContain('retained');
    });

  it('leaves a pending handoff for the current mount when an earlier waiter is disposed during authorization', async () => {
    const history = await record();
    const original = setup(history);
    const response = deferred<{ id: string; reused: boolean }>();
    const creating = deferred<void>();
    original.create.mockImplementation(() => { creating.resolve(); return response.promise; });
    const first = original.run();
    await creating.promise;
    original.controller.abort();
    original.terminal.dispose();
    const obsolete = setup(history);
    obsolete.has.mockResolvedValue(true);
    const authorizing = deferred<void>();
    const issued = deferred<Awaited<ReturnType<TerminalHistoryBridge['getBinding']>>>();
    vi.mocked(obsolete.bridge.getBinding).mockImplementation(() => { authorizing.resolve(); return issued.promise; });
    const second = obsolete.run();
    response.resolve({ id: 'surf-history', reused: false });
    await authorizing.promise;
    obsolete.controller.abort();
    obsolete.terminal.dispose();
    const replacement = setup(history);
    replacement.has.mockResolvedValue(true);
    await replacement.run();
    await write(replacement.terminal, '');
    issued.resolve({ ok: true, value: { binding: obsolete.binding, incarnation: obsolete.binding.incarnation } });
    await Promise.all([first, second]);
    expect(obsolete.attach).not.toHaveBeenCalled();
    expect(obsolete.restoreLive).not.toHaveBeenCalled();
    expect(text(replacement.terminal).match(/retained-before-restart/g)).toHaveLength(1);
    expect(replacement.attach).toHaveBeenCalledOnce();
    expect(replacement.create).not.toHaveBeenCalled();
  });

  it.each([false, true])('retains live TUI startup through create and authorization waits (exit:%s)', async (exits) => {
    const history = await record();
    const source = eventSource();
    const pending = await pendingCreation(history, source);
    expect(source.listeners()).toEqual([1, 1]);
    source.data('\x1b[?1049h\x1b[HLIVE-STARTUP-TUI\x1b[?1003h\x1b[?1006h\x1b]9;4;1;42\x07');
    const replacement = setup(history, make(), source);
    replacement.has.mockResolvedValue(true);
    const authorizing = deferred<void>();
    const issued = deferred<Awaited<ReturnType<TerminalHistoryBridge['getBinding']>>>();
    vi.mocked(replacement.bridge.getBinding).mockImplementation(() => { authorizing.resolve(); return issued.promise; });
    const second = replacement.run();
    pending.retire();
    // The first DECSET arrives even before inherited.settled/has can complete.
    expect(replacement.attach).not.toHaveBeenCalled();
    pending.response.resolve({ id: 'surf-history', reused: false });
    await authorizing.promise;
    source.data('\r\nDURING-AUTHORIZATION');
    if (exits) source.exit(9);
    expect(source.listeners()).toEqual([1, 1]);
    expect(replacement.onData).not.toHaveBeenCalled();
    issued.resolve({ ok: true, value: { binding: replacement.binding, incarnation: replacement.binding.incarnation } });
    await Promise.all([pending.first, second]);
    if (exits) await replacement.exitDelivered.promise;
    await write(replacement.terminal, '');
    expect(text(replacement.terminal).match(/retained-before-restart/g)).toHaveLength(1);
    expect(replacement.create).not.toHaveBeenCalled();
    expect(replacement.attach).toHaveBeenCalledOnce();
    expect(source.onData).toHaveBeenCalledOnce();
    expect(source.onExit).toHaveBeenCalledOnce();
    expect(replacement.onData).toHaveBeenCalledTimes(2);
    if (exits) {
      expect(replacement.delivered[2]).toBe('EXIT');
      expect(replacement.onExit).toHaveBeenCalledExactlyOnceWith(9);
      expect(replacement.terminal.buffer.active.type).toBe('normal');
      expect(replacement.terminal.modes.mouseTrackingMode).toBe('none');
      expect(replacement.mouse.has('surf-history')).toBe(false);
      expect(replacement.progress()).toBe(0);
      expect(text(replacement.terminal).match(/\[process exited\]/g)).toHaveLength(1);
    } else {
      expect(replacement.terminal.buffer.active.type).toBe('alternate');
      expect(replacement.terminal.buffer.alternate.getLine(0)!.translateToString(true)).toContain('LIVE-STARTUP-TUI');
      expect(replacement.terminal.buffer.alternate.getLine(1)!.translateToString(true)).toContain('DURING-AUTHORIZATION');
      expect(replacement.terminal.modes.mouseTrackingMode).toBe('any');
      expect(replacement.progress()).toBe(1);
    }
    source.data('\r\nLIVE-AFTER-ATTACH');
    await write(replacement.terminal, '');
    expect(replacement.onData).toHaveBeenCalledTimes(3);
    expect(replacement.ptyWrite).not.toHaveBeenCalled();
    replacement.controller.abort();
    expect(source.listeners()).toEqual([0, 0]);
  });

  it('keeps retaining DATA/EXIT after attachment until the queued replay and live drawing are parsed', async () => {
    const history = await record();
    const source = eventSource();
    const pending = await pendingCreation(history, source);
    source.data('\x1b[?1049h\x1b[HLIVE-TUI\x1b[?1003h');
    const replacement = setup(history, make(), source);
    replacement.has.mockResolvedValue(true);
    const attach = replacement.options.attach;
    let exitedBeforeParsing = -1;
    replacement.options.attach = (...args) => {
      attach(...args);
      // Snapshot and initial DATA have been queued, not parsed. These events
      // must join that same ordered backlog, not jump into the normal handlers.
      source.data('\r\nLATE-LIVE-DATA');
      source.exit(4);
      exitedBeforeParsing = replacement.onExit.mock.calls.length;
    };
    const second = replacement.run();
    pending.retire();
    pending.response.resolve({ id: 'surf-history', reused: false });
    await Promise.all([pending.first, second]);
    await replacement.exitDelivered.promise;
    await write(replacement.terminal, '');
    expect(exitedBeforeParsing).toBe(0);
    expect(replacement.delivered).toEqual(['\x1b[?1049h\x1b[HLIVE-TUI\x1b[?1003h', '\r\nLATE-LIVE-DATA', 'EXIT']);
    expect(replacement.onExit).toHaveBeenCalledExactlyOnceWith(4);
    expect(replacement.terminal.buffer.active.type).toBe('normal');
    expect(replacement.terminal.modes.mouseTrackingMode).toBe('none');
    expect(replacement.mouse.has('surf-history')).toBe(false);
    expect(text(replacement.terminal).match(/retained-before-restart/g)).toHaveLength(1);
    expect(text(replacement.terminal).match(/\[process exited\]/g)).toHaveLength(1);
    expect(source.onData).toHaveBeenCalledOnce();
    replacement.controller.abort();
    expect(source.listeners()).toEqual([0, 0]);
  });

  it.each([false, true])('keeps an exited-but-open child when has(false) follows a retained exit (reused:%s)', async (reused) => {
    const history = await record();
    const source = eventSource();
    const pending = await pendingCreation(history, source);
    source.data('\x1b[?1049h\x1b[HSHORT-LIVED-TUI\x1b[?1003h\x1b]9;4;1;42\x07');
    source.exit(3);
    source.data('AFTER-EXIT');
    const replacement = setup(history, make(), source);
    replacement.has.mockResolvedValue(false);
    const second = replacement.run();
    pending.retire();
    pending.response.resolve({ id: 'surf-history', reused });
    await Promise.all([pending.first, second]);
    await replacement.exitDelivered.promise;
    await write(replacement.terminal, '');
    expect(pending.original.create).toHaveBeenCalledOnce();
    expect(replacement.create).not.toHaveBeenCalled();
    expect(replacement.delivered).toEqual([
      '\x1b[?1049h\x1b[HSHORT-LIVED-TUI\x1b[?1003h\x1b]9;4;1;42\x07', 'EXIT', 'AFTER-EXIT',
    ]);
    expect(replacement.terminal.buffer.active.type).toBe('normal');
    expect(replacement.terminal.modes.mouseTrackingMode).toBe('none');
    expect(replacement.progress()).toBe(0);
    const output = text(replacement.terminal);
    expect(output).toContain('[process exited]');
    expect(output.indexOf('AFTER-EXIT')).toBeGreaterThan(output.indexOf('[process exited]'));
    if (reused) expect(output).not.toContain('retained-before-restart');
    else expect(output.match(/retained-before-restart/g)).toHaveLength(1);
    expect(source.onData).toHaveBeenCalledOnce();
    expect(source.onExit).toHaveBeenCalledOnce();
    replacement.controller.abort();
    expect(source.listeners()).toEqual([0, 0]);
  });

  it('preserves queued live events for the current waiter when authorization is cancelled and history disabled', async () => {
    const history = await record();
    const source = eventSource();
    const pending = await pendingCreation(history, source);
    const obsolete = setup(history, make(), source);
    obsolete.has.mockResolvedValue(true);
    const authorizing = deferred<void>();
    const issued = deferred<Awaited<ReturnType<TerminalHistoryBridge['getBinding']>>>();
    vi.mocked(obsolete.bridge.getBinding).mockImplementation(() => { authorizing.resolve(); return issued.promise; });
    const second = obsolete.run();
    pending.retire();
    pending.response.resolve({ id: 'surf-history', reused: false });
    await authorizing.promise;
    source.data('\x1b[?1049h\x1b[HLIVE-BEFORE-CANCEL');
    const replacement = setup(history, make(), source);
    replacement.has.mockResolvedValue(true);
    vi.mocked(replacement.bridge.getState).mockResolvedValue({ ok: true,
      value: { enabled: false, generation: 8, error: null } });
    const third = replacement.run();
    obsolete.controller.abort();
    obsolete.terminal.dispose();
    source.data('\r\nLIVE-BETWEEN-WAITERS');
    await third;
    await write(replacement.terminal, '');
    issued.resolve({ ok: true, value: { binding: obsolete.binding, incarnation: obsolete.binding.incarnation } });
    await Promise.all([pending.first, second]);
    expect(obsolete.attach).not.toHaveBeenCalled();
    expect(obsolete.onData).not.toHaveBeenCalled();
    expect(text(replacement.terminal)).not.toContain('retained');
    expect(replacement.terminal.buffer.active.type).toBe('alternate');
    expect(replacement.terminal.buffer.alternate.getLine(0)!.translateToString(true)).toContain('LIVE-BEFORE-CANCEL');
    expect(replacement.onData).toHaveBeenCalledTimes(2);
    expect(source.listeners()).toEqual([1, 1]);
    source.exit();
    await replacement.exitDelivered.promise;
    await write(replacement.terminal, '');
    expect(replacement.terminal.buffer.active.type).toBe('normal');
    expect(text(replacement.terminal)).toContain('[process exited]');
    expect(source.onData).toHaveBeenCalledOnce();
    replacement.controller.abort();
    expect(source.listeners()).toEqual([0, 0]);
  });

  it('releases an ownerless create backlog but keeps its finite history for a later Retry', async () => {
    const history = await record();
    const source = eventSource();
    const pending = await pendingCreation(history, source);
    source.data('UNOWNED-BACKLOG');
    pending.retire();
    await Promise.resolve();
    expect(source.listeners()).toEqual([0, 0]);
    pending.response.resolve({ id: 'surf-history', reused: false });
    await pending.first;
    expect(source.listeners()).toEqual([0, 0]);
    for (let i = 0; i < 50_000; i++) source.data('UNOWNED-LATER-' + 'x'.repeat(480));
    source.exit();

    const replacement = setup(history, make(), source);
    // Confirmation still owns this surface even if the child exited while the
    // error boundary was showing: Retry must not start another process.
    replacement.has.mockResolvedValue(false);
    await replacement.run();
    await write(replacement.terminal, '');
    expect(text(replacement.terminal).match(/retained-before-restart/g)).toHaveLength(1);
    expect(text(replacement.terminal)).not.toContain('UNOWNED');
    expect(replacement.onData).not.toHaveBeenCalled();
    expect(replacement.onExit).not.toHaveBeenCalled();
    expect(replacement.create).not.toHaveBeenCalled();
    expect(pending.original.create).toHaveBeenCalledOnce();
    expect(source.listeners()).toEqual([1, 1]);
    source.data('NEW-OWNED-OUTPUT');
    await write(replacement.terminal, '');
    expect(replacement.onData).toHaveBeenCalledExactlyOnceWith('NEW-OWNED-OUTPUT');
    replacement.controller.abort();
    expect(source.listeners()).toEqual([0, 0]);

    const later = setup(history);
    later.has.mockResolvedValue(true);
    await later.run();
    expect(later.restoreLive).toHaveBeenCalledExactlyOnceWith(true);
    expect(text(later.terminal)).not.toContain('retained');
  });

  it('keeps the backlog across synchronous StrictMode cleanup and replacement setup', async () => {
    const history = await record();
    const source = eventSource();
    const pending = await pendingCreation(history, source);
    source.data('BEFORE-STRICTMODE-CLEANUP');
    pending.retire();
    const replacement = setup(history, make(), source);
    replacement.has.mockResolvedValue(true);
    const second = replacement.run();
    await Promise.resolve();
    expect(source.listeners()).toEqual([1, 1]);
    pending.response.resolve({ id: 'surf-history', reused: false });
    await Promise.all([pending.first, second]);
    await write(replacement.terminal, '');
    expect(replacement.onData).toHaveBeenCalledExactlyOnceWith('BEFORE-STRICTMODE-CLEANUP');
    expect(text(replacement.terminal)).toContain('retained-before-restart');
    expect(source.onData).toHaveBeenCalledOnce();
    replacement.controller.abort();
    expect(source.listeners()).toEqual([0, 0]);
  });

  it.each(['getState', 'getBinding'] as const)(
    'releases the last waiter on abort without waiting for pending %s authorization', async (method) => {
      const history = await record();
      const source = eventSource();
      const pending = await pendingCreation(history, source);
      const obsolete = setup(history, make(), source);
      obsolete.has.mockResolvedValue(true);
      const authorizing = deferred<void>();
      const seed = deferred<Awaited<ReturnType<TerminalHistoryBridge['getState']>>>();
      const issued = deferred<Awaited<ReturnType<TerminalHistoryBridge['getBinding']>>>();
      if (method === 'getState') vi.mocked(obsolete.bridge.getState).mockImplementation(() => {
        authorizing.resolve(); return seed.promise;
      });
      else vi.mocked(obsolete.bridge.getBinding).mockImplementation(() => {
        authorizing.resolve(); return issued.promise;
      });
      let settled = false;
      const second = obsolete.run().then(() => { settled = true; });
      pending.retire();
      pending.response.resolve({ id: 'surf-history', reused: false });
      await authorizing.promise;
      source.data('CANCELLED-AUTHORIZATION-BACKLOG');
      obsolete.controller.abort();
      obsolete.terminal.dispose();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(source.listeners()).toEqual([0, 0]);
      expect(obsolete.unsubscribe).toHaveBeenCalledOnce();
      source.data('AFTER-CANCELLED-AUTHORIZATION');
      source.exit();

      const replacement = setup(history, make(), source);
      replacement.has.mockResolvedValue(true);
      await replacement.run();
      await write(replacement.terminal, '');
      expect(text(replacement.terminal)).toContain('retained-before-restart');
      expect(text(replacement.terminal)).not.toContain('AUTHORIZATION');
      expect(replacement.onData).not.toHaveBeenCalled();
      expect(replacement.onExit).not.toHaveBeenCalled();
      expect(replacement.create).not.toHaveBeenCalled();
      seed.resolve({ ok: true, value: obsolete.enabled });
      issued.resolve({ ok: true, value: { binding: obsolete.binding, incarnation: obsolete.binding.incarnation } });
      await Promise.all([pending.first, second]);
      expect(obsolete.attach).not.toHaveBeenCalled();
      expect(obsolete.restoreLive).not.toHaveBeenCalled();
      replacement.controller.abort();
      expect(source.listeners()).toEqual([0, 0]);
    });

  it('drops history but retains DATA/EXIT when disable reaches the original mount during create', async () => {
    const history = await record();
    const source = eventSource();
    const original = setup(history, make(), source);
    const response = deferred<{ id: string; reused: boolean }>();
    const creating = deferred<void>();
    original.create.mockImplementation(() => { creating.resolve(); return response.promise; });
    const first = original.run();
    await creating.promise;
    source.data('\x1b[?1049h\x1b[HLIVE-WHILE-DISABLED\x1b[?1003h\x1b]9;4;1;42\x07');
    original.state({ enabled: false, generation: 8, error: null });
    source.exit(7);
    expect(source.listeners()).toEqual([1, 1]);
    response.resolve({ id: 'surf-history', reused: false });
    await first;
    await original.exitDelivered.promise;
    await write(original.terminal, '');
    expect(text(original.terminal)).not.toContain('retained');
    expect(text(original.terminal)).toContain('[process exited]');
    expect(original.onData).toHaveBeenCalledOnce();
    expect(original.onExit).toHaveBeenCalledExactlyOnceWith(7);
    expect(original.terminal.buffer.active.type).toBe('normal');
    expect(original.terminal.modes.mouseTrackingMode).toBe('none');
    expect(original.progress()).toBe(0);
    expect(original.create).toHaveBeenCalledOnce();
    original.controller.abort();
    expect(source.listeners()).toEqual([0, 0]);
  });

  it('disposes queued events and both listeners on deliberate forget, without leaking them to a reopened surface', async () => {
    const history = await record();
    const source = eventSource();
    const pending = await pendingCreation(history, source);
    source.data('\x1b[?1049hSTALE-TUI');
    const obsolete = setup(history, make(), source);
    obsolete.has.mockResolvedValue(true);
    const second = obsolete.run();
    pending.retire();
    obsolete.controller.abort();
    forgetPendingTerminalHistoryCreation('surf-history');
    expect(source.listeners()).toEqual([0, 0]);
    source.data('STALE-AFTER-CLOSE');
    source.exit();
    pending.response.resolve({ id: 'surf-history', reused: false });
    await Promise.all([pending.first, second]);
    expect(obsolete.attach).not.toHaveBeenCalled();
    const reopened = setup(history, make(), source);
    reopened.has.mockResolvedValue(true);
    await reopened.run();
    source.data('NEW-LIVE');
    await write(reopened.terminal, '');
    expect(text(reopened.terminal)).toContain('NEW-LIVE');
    expect(text(reopened.terminal)).not.toContain('STALE');
    expect(text(reopened.terminal)).not.toContain('retained');
    expect(reopened.onExit).not.toHaveBeenCalled();
    expect(reopened.onData).toHaveBeenCalledExactlyOnceWith('NEW-LIVE');
    reopened.controller.abort();
    expect(source.listeners()).toEqual([0, 0]);
  });

  it('has no historical work left when the fresh shell emits its first output', async () => {
    const s = setup(await record());
    s.attach.mockImplementation(() => {
      expect(s.hold.isHolding).toBe(false);
      s.terminal.write('fresh-shell> immediate');
    });
    await s.run();
    await write(s.terminal, '');
    expect(text(s.terminal)).toContain('retained-before-restart');
    expect(viewport(s.terminal)).toContain('fresh-shell> immediate');
    expect(viewport(s.terminal).join('')).toContain('retained-last');
    expect(s.ptyWrite).not.toHaveBeenCalled();
    expect(s.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not clear the live buffer if consent changes after attachment', async () => {
    const s = setup(await record());
    await s.run();
    await write(s.terminal, 'live-shell-output');
    s.state({ enabled: false, generation: 8, error: null });
    expect(text(s.terminal)).toContain('live-shell-output');
    expect(text(s.terminal)).toContain('retained-before-restart');
  });

  it.each([false, true])('hands an in-flight create(reused:%s) back to the owner on disposal, without attaching or restoring', async (reused) => {
    const s = setup(await record());
    const created = deferred<{ id: string; reused: boolean }>();
    const creating = deferred<void>();
    s.create.mockImplementation(() => { creating.resolve(); return created.promise; });
    const connect = s.run();
    await creating.promise;
    s.controller.abort();
    created.resolve({ id: 'surf-history', reused });
    await connect;
    expect(s.abandoned).toHaveBeenCalledExactlyOnceWith({ id: 'surf-history', reused });
    expect(s.attach).not.toHaveBeenCalled();
    expect(s.restoreLive).not.toHaveBeenCalled();
  });
});

describe('useTerminal history ownership wiring', () => {
  const source = readFileSync(new URL('../../src/renderer/hooks/useTerminal.ts', import.meta.url), 'utf8');
  it('uses the behavioral connection helper, guards input and never snapshots provisional disk state', () => {
    expect(source).toContain('void connectTerminalWithHistory({');
    expect(source).toContain('if (liveAttached) snapshotSurfaceBuffer(surfaceId, serializeAddon, terminal)');
    expect(source).toContain('if (!isCurrent() || !liveAttached || replayHold.isHolding || !ptyIdRef.current) return;');
    expect(source).toContain('preparation.abort()');
    expect(source).toContain('forgetPendingTerminalHistoryCreation(surfaceId)');
    expect(source).toContain('if (completed) surfaceBufferCache.retire(surfaceId, () => completed)');
    expect(source).toContain('retained.attach(onData, onExit, (callback) =>');
    expect(source).toContain('window.wmux.pty.onData(id, onData), window.wmux.pty.onExit(id, onExit)');
    expect(source).toContain('const reflows = !!ptyIdRef.current &&');
    expect(source).toMatch(/create: \(inheritCursor\) => \{[\s\S]*?inheritCursor \? terminal : proposeInitialDims\(fitAddon\)/);
    expect(source).toContain('conptyInheritCursor: inheritCursor');
  });
  it('only reaps an abandoned new process for a closed surface with no replacement owner', () => {
    expect(source).toContain('if (!created.reused && !open && (!replacement || replacement === terminal)) window.wmux.pty.kill(created.id)');
  });
});
