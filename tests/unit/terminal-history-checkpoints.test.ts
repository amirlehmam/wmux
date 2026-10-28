import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { HistoryResult, TerminalHistoryBridge, TerminalHistoryRecord, TerminalHistoryState } from '../../src/shared/terminal-history';
import { TerminalHistoryCheckpoints } from '../../src/renderer/utils/terminal-history-checkpoints';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function write(terminal: Terminal, text: string) {
  return new Promise<void>((resolve) => terminal.write(text, resolve));
}
function setup(enabled = true, seed?: Promise<HistoryResult<TerminalHistoryState>>) {
  const terminals = new Map<string, Terminal>();
  const serializers = new Map<string, SerializeAddon>();
  const floors = new Map<string, number>();
  const records: { surface: string; record: TerminalHistoryRecord; revision: number }[] = [];
  const listeners = new Set<(state: TerminalHistoryState) => void>();
  let generation = 1;
  let lines = 20;
  const report = vi.fn();
  const bridge: TerminalHistoryBridge = {
    getState: vi.fn(async () => seed ?? ({ ok: true, value: { enabled, generation, error: null } })),
    onState: (callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    setEnabled: vi.fn(), read: vi.fn(),
    getBinding: vi.fn(async (surface) => ({ ok: true, value: {
      binding: { incarnation: 'live', recordId: `hist-${surface}`, generation }, incarnation: 'live',
      revisionFloor: floors.get(surface) ?? 0,
    } })),
    checkpoint: vi.fn(async (surface, _binding, revision, record) => {
      floors.set(surface, revision);
      records.push({ surface, revision, record });
      return { ok: true, value: { revision } };
    }),
  };
  const coordinator = new TerminalHistoryCheckpoints({ terminals: () => terminals,
    serializer: (surface) => serializers.get(surface), bridge: () => bridge, lines: () => lines, report });
  const stop = coordinator.start();
  cleanups.push(stop);
  function add(surface: string, ready = () => true) {
    const terminal = new Terminal({ cols: 30, rows: 4, scrollback: 100, allowProposedApi: true });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    terminals.set(surface, terminal);
    serializers.set(surface, serializer);
    cleanups.push(() => terminal.dispose());
    const unobserve = coordinator.observe(terminal, ready);
    cleanups.push(unobserve);
    return { terminal, serializer, unobserve };
  }
  return { coordinator, bridge, terminals, serializers, floors, records, report, add, stop,
    listenerCount: () => listeners.size,
    lineLimit: (next: number) => { lines = next; for (const term of terminals.values()) coordinator.lineLimitChanged(term); },
    state: (next: boolean) => {
      enabled = next;
      if (!next) generation++;
      for (const listener of listeners) listener({ enabled, generation, error: null });
    },
  };
}

/** The real parser drains one queued write before exposing the next callback. */
function gate(terminal: Terminal) {
  const real = terminal.write.bind(terminal);
  const jobs: { data: string | Uint8Array; callback?: () => void }[] = [];
  const arrived = deferred<void>();
  vi.spyOn(terminal, 'write').mockImplementation((data, callback) => {
    jobs.push({ data, callback });
    arrived.resolve();
  });
  return { jobs, arrived: arrived.promise, async drain() {
    const job = jobs.shift();
    if (!job) throw new Error('No queued write');
    await new Promise<void>((resolve, reject) => real(job.data, () => {
      try { job.callback?.(); resolve(); } catch (error) { reject(error); }
    }));
  } };
}

describe('dirty terminal checkpoints', () => {
  it('captures normal and alternate at the fence, leaving later output dirty', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    await write(terminal, 'normal-before\x1b[?1049halt-before');
    const queue = gate(terminal);
    const first = kit.coordinator.request();
    await queue.arrived;
    terminal.write('\r\nalt-after');
    expect(queue.jobs.map((job) => job.data)).toEqual(['', '\r\nalt-after']);
    await queue.drain();
    // Serialization happens inside the empty callback, before the next write.
    expect(kit.records[0].record.normal.ansi).toContain('normal-before');
    expect(JSON.stringify(kit.records[0].record.alternate)).toContain('alt-before');
    expect(JSON.stringify(kit.records[0].record.alternate)).not.toContain('alt-after');
    await queue.drain();
    await expect(first).resolves.toBe(true);
    const second = kit.coordinator.request();
    await vi.waitFor(() => expect(queue.jobs).toHaveLength(1));
    await queue.drain();
    await expect(second).resolves.toBe(true);
    expect(JSON.stringify(kit.records[1].record.alternate)).toContain('alt-after');
    expect(terminal.buffer.normal.getLine(0)!.translateToString(true)).toBe('normal-before');
    expect(terminal.buffer.active.type).toBe('alternate');
  });

  it('does not serialize or write an idle second checkpoint, including empty parse fences', async () => {
    const kit = setup();
    const { terminal, serializer } = kit.add('a');
    await write(terminal, 'hello');
    const serialize = vi.spyOn(serializer, 'serialize');
    expect(await kit.coordinator.request()).toBe(true);
    await write(terminal, '');
    expect(await kit.coordinator.request()).toBe(true);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('contains serializer exceptions inside xterm callbacks and retries without new output', async () => {
    const kit = setup();
    const { terminal, serializer } = kit.add('a');
    await write(terminal, 'before-error');
    const serialize = vi.spyOn(serializer, 'serialize').mockImplementationOnce(() => { throw new Error('fixture'); });
    expect(await kit.coordinator.request()).toBe(false);
    expect(kit.bridge.checkpoint).not.toHaveBeenCalled();
    expect(await kit.coordinator.request()).toBe(true);
    expect(serialize).toHaveBeenCalledTimes(2);
    await write(terminal, '\r\nparser-still-running');
    expect(terminal.buffer.active.getLine(1)!.translateToString(true)).toBe('parser-still-running');
  });

  it('includes hidden/inactive/exited open instances and skips provisional replay', async () => {
    const kit = setup();
    let ready = false;
    const provisional = kit.add('preparing', () => ready);
    for (const id of ['hidden-tab', 'inactive-workspace', 'exited-open']) {
      const { terminal } = kit.add(id);
      await write(terminal, id);
    }
    await write(provisional.terminal, 'not-yet-live');
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.records.map((row) => row.surface)).toEqual(['hidden-tab', 'inactive-workspace', 'exited-open']);
    ready = true;
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.records.at(-1)?.surface).toBe('preparing');
  });

  it('tracks renderer notices, exit/reset, clear, resize/reflow and line-limit changes', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    await write(terminal, Array.from({ length: 30 }, (_, i) => `row-${i}`).join('\r\n'));
    await kit.coordinator.request();
    terminal.writeln('\r\n[process exited]');
    await kit.coordinator.request();
    expect(kit.records.at(-1)!.record.normal.ansi).toContain('[process exited]');
    terminal.resize(15, 5);
    await kit.coordinator.request();
    expect(kit.records.at(-1)!.record.cols).toBe(15);
    kit.lineLimit(2);
    await kit.coordinator.request();
    expect(kit.records.at(-1)!.record.normal.lineCount).toBe(7);
    terminal.clear();
    await kit.coordinator.request();
    terminal.reset();
    await kit.coordinator.request();
    expect(kit.records).toHaveLength(6);
  });

  it('leaves failed disk/link writes dirty and retries without new output', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    await write(terminal, 'retain');
    vi.mocked(kit.bridge.checkpoint).mockResolvedValueOnce({ ok: false, error: 'session' });
    expect(await kit.coordinator.request()).toBe(false);
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(2);
    expect(kit.records[0].record.normal.ansi).toBe('retain');
  });

  it('uses the main revision floor after remount or renderer recovery, not reset local counters', async () => {
    const kit = setup();
    const old = kit.add('a');
    await write(old.terminal, 'old');
    kit.floors.set('a', 8000);
    await kit.coordinator.request();
    expect(kit.records[0].revision).toBe(8001);
    const replacement = kit.add('a');
    old.unobserve();
    await write(replacement.terminal, 'replacement');
    await kit.coordinator.request();
    expect(kit.records[1].revision).toBe(8002);
    kit.state(false);
    kit.floors.set('a', 0);
    kit.state(true);
    await kit.coordinator.request();
    expect(kit.records[2].revision).toBe(1);
  });

  it('does no serialization while disabled and re-enabling captures live contents', async () => {
    const kit = setup(false);
    const { terminal, serializer } = kit.add('a');
    const serialize = vi.spyOn(serializer, 'serialize');
    await write(terminal, 'still-visible');
    expect(await kit.coordinator.request()).toBe(true);
    expect(serialize).not.toHaveBeenCalled();
    expect(kit.bridge.getBinding).not.toHaveBeenCalled();
    kit.state(true);
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.records[0].record.normal.ansi).toBe('still-visible');
  });

  it('disable during a queued fence prevents serialization and completes the disabled branch', async () => {
    const kit = setup();
    const { terminal, serializer } = kit.add('a');
    await write(terminal, 'live');
    const serialize = vi.spyOn(serializer, 'serialize');
    const queue = gate(terminal);
    const result = kit.coordinator.request(Date.now() + 1000);
    await queue.arrived;
    kit.state(false);
    expect(await result).toBe(true);
    await queue.drain();
    expect(serialize).not.toHaveBeenCalled();
    expect(kit.records).toHaveLength(0);
  });

  it('disable during a pending ACK cannot clean a re-enabled generation', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    await write(terminal, 'live');
    const ack = deferred<Awaited<ReturnType<TerminalHistoryBridge['checkpoint']>>>();
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(() => ack.promise);
    const first = kit.coordinator.request();
    await vi.waitFor(() => expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1));
    kit.state(false);
    expect(await first).toBe(true);
    kit.state(true);
    expect(await kit.coordinator.request()).toBe(true);
    ack.resolve({ ok: true, value: { revision: 1 } });
    await Promise.resolve();
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping periodic requests and a final flush drains later dirty output', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    await write(terminal, 'first');
    const ack = deferred<Awaited<ReturnType<TerminalHistoryBridge['checkpoint']>>>();
    const original = kit.bridge.checkpoint;
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(() => ack.promise);
    const periodic = kit.coordinator.request();
    await vi.waitFor(() => expect(original).toHaveBeenCalledTimes(1));
    const overlapping = kit.coordinator.request();
    await write(terminal, '\r\nlate');
    const final = kit.coordinator.request(Date.now() + 1000);
    ack.resolve({ ok: true, value: { revision: 1 } });
    expect(await periodic).toBe(true);
    expect(await overlapping).toBe(true);
    expect(await final).toBe(true);
    expect(original).toHaveBeenCalledTimes(2);
    expect(kit.records[0].record.normal.ansi).toContain('late');
  });

  it('destructive close cancels capture before unmount and an old fence cannot recapture a reopened ID', async () => {
    const kit = setup();
    const old = kit.add('a');
    await write(old.terminal, 'closed');
    const serialize = vi.spyOn(old.serializer, 'serialize');
    const queue = gate(old.terminal);
    const pending = kit.coordinator.request();
    await queue.arrived;
    kit.coordinator.close('a');
    expect(await pending).toBe(true);
    // The old instance is still mounted; even new mutations must remain excluded.
    old.terminal.write('after-close');
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.bridge.checkpoint).not.toHaveBeenCalled();
    const replacement = kit.add('a');
    await write(replacement.terminal, 'replacement');
    await queue.drain();
    expect(serialize).not.toHaveBeenCalled();
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.records.map((row) => row.record.normal.ansi)).toEqual(['replacement']);
  });

  it('does not strand future checkpoints when a candidate is disposed before its fence callback', async () => {
    const kit = setup();
    const old = kit.add('a');
    await write(old.terminal, 'discarded');
    const queue = gate(old.terminal);
    const first = kit.coordinator.request();
    await queue.arrived;
    const replacement = kit.add('a');
    old.unobserve();
    expect(await first).toBe(true);
    await write(replacement.terminal, 'new-instance');
    expect(await kit.coordinator.request()).toBe(true);
    await queue.drain();
    expect(kit.records).toHaveLength(1);
    expect(kit.records[0].record.normal.ansi).toBe('new-instance');
  });

  it('still waits for a submitted write ACK when its emulator is disposed during a final flush', async () => {
    const kit = setup();
    const old = kit.add('a');
    await write(old.terminal, 'submitted');
    const ack = deferred<Awaited<ReturnType<TerminalHistoryBridge['checkpoint']>>>();
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(() => ack.promise);
    let settled = false;
    const final = kit.coordinator.request(Date.now() + 1000).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1));
    old.unobserve();
    kit.terminals.delete('a');
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    ack.resolve({ ok: false, error: 'session' });
    expect(await final).toBe(false);
  });

  it('subscription teardown retains a submitted ACK obligation and cannot report final success', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    await write(terminal, 'submitted');
    const ack = deferred<Awaited<ReturnType<TerminalHistoryBridge['checkpoint']>>>();
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(() => ack.promise);
    const periodic = kit.coordinator.request();
    await vi.waitFor(() => expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    let settled = false;
    const final = kit.coordinator.request(Date.now() + 1000).then((result) => { settled = true; return result; });
    kit.stop();
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    ack.resolve({ ok: false, error: 'session' });
    await vi.runAllTimersAsync();
    expect(await final).toBe(false);
    expect(await periodic).toBe(false);
    expect(kit.listenerCount()).toBe(0);
  });

  it('subscription teardown still loses to the original final deadline if its submitted ACK stalls', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    await write(terminal, 'submitted');
    const ack = deferred<Awaited<ReturnType<TerminalHistoryBridge['checkpoint']>>>();
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(() => ack.promise);
    const periodic = kit.coordinator.request();
    await vi.waitFor(() => expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    let settled = false;
    const final = kit.coordinator.request(Date.now() + 1000).then((result) => { settled = true; return result; });
    kit.stop();
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await final).toBe(false);
    ack.resolve({ ok: false, error: 'session' });
    await vi.runAllTimersAsync();
    expect(await periodic).toBe(false);
  });

  it('confirmed disable can release a submitted obligation retained through subscription teardown', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    await write(terminal, 'submitted');
    const ack = deferred<Awaited<ReturnType<TerminalHistoryBridge['checkpoint']>>>();
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(() => ack.promise);
    const periodic = kit.coordinator.request();
    await vi.waitFor(() => expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1));
    kit.stop();
    const stop = kit.coordinator.start();
    cleanups.push(stop);
    kit.state(false);
    expect(await kit.coordinator.request(Date.now() + 1000)).toBe(true);
    expect(await periodic).toBe(true);
    ack.resolve({ ok: false, error: 'session' });
  });

  it('restarting the coordinator replaces its subscription and old ACKs cannot clean replacement instances', async () => {
    const kit = setup();
    const old = kit.add('a');
    await write(old.terminal, 'old');
    const ack = deferred<Awaited<ReturnType<TerminalHistoryBridge['checkpoint']>>>();
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(() => ack.promise);
    const first = kit.coordinator.request();
    await vi.waitFor(() => expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1));
    kit.stop();
    old.unobserve();
    const replacement = kit.add('a');
    await write(replacement.terminal, 'replacement');
    const previousStop = kit.coordinator.start();
    const currentStop = kit.coordinator.start();
    cleanups.push(currentStop);
    previousStop();
    kit.stop();
    expect(kit.listenerCount()).toBe(1);
    const final = kit.coordinator.request(Date.now() + 1000);
    ack.resolve({ ok: true, value: { revision: 1 } });
    await first;
    expect(await final).toBe(true);
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(2);
    expect(kit.records[0].record.normal.ansi).toBe('replacement');
    kit.state(false);
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(2);
  });

  it.each(['reject', 'failure-value'] as const)('a %s state seed fails requests safely and later saves share a retry', async (mode) => {
    const seed = deferred<HistoryResult<TerminalHistoryState>>();
    const initial = mode === 'reject' ? seed.promise.then(() => { throw new Error('fixture'); }) : seed.promise;
    const kit = setup(false, initial);
    const { terminal } = kit.add('a');
    await write(terminal, 'not-authorized-yet');
    const periodic = kit.coordinator.request();
    const final = kit.coordinator.request(Date.now() + 1000);
    seed.resolve({ ok: false, error: 'io' });
    expect(await periodic).toBe(false);
    expect(await final).toBe(false);
    expect(kit.report).toHaveBeenCalledWith('state');
    expect(kit.bridge.getBinding).not.toHaveBeenCalled();
    expect(kit.bridge.checkpoint).not.toHaveBeenCalled();
    const retry = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(kit.bridge.getState).mockImplementationOnce(() => retry.promise);
    const retryPeriodic = kit.coordinator.request();
    const retryFinal = kit.coordinator.request(Date.now() + 1000);
    await vi.waitFor(() => expect(kit.bridge.getState).toHaveBeenCalledTimes(2));
    retry.resolve({ ok: true, value: { enabled: true, generation: 1, error: null } });
    expect(await retryPeriodic).toBe(true);
    expect(await retryFinal).toBe(true);
    expect(kit.bridge.getState).toHaveBeenCalledTimes(2);
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1);
    expect(kit.records[0].record.normal.ansi).toBe('not-authorized-yet');
  });

  it('a consent event supersedes a retry seed without enabling output on a late response', async () => {
    const failed = deferred<HistoryResult<TerminalHistoryState>>();
    const kit = setup(false, failed.promise);
    kit.add('a');
    const first = kit.coordinator.request();
    failed.resolve({ ok: false, error: 'io' });
    expect(await first).toBe(false);
    const retry = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(kit.bridge.getState).mockImplementationOnce(() => retry.promise);
    const next = kit.coordinator.request();
    kit.state(false);
    expect(await next).toBe(true);
    retry.resolve({ ok: true, value: { enabled: true, generation: 1, error: null } });
    await Promise.resolve();
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.bridge.getState).toHaveBeenCalledTimes(2);
    expect(kit.bridge.getBinding).not.toHaveBeenCalled();
    expect(kit.bridge.checkpoint).not.toHaveBeenCalled();
  });

  it('yields between terminals rather than serializing every buffer in one task', async () => {
    const kit = setup();
    kit.add('first');
    const second = kit.add('second');
    let yielded = false;
    const checkpoint = vi.mocked(kit.bridge.checkpoint).getMockImplementation()!;
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(async (...args) => {
      setTimeout(() => { yielded = true; }, 0);
      return checkpoint(...args);
    });
    const serialize = second.serializer.serialize.bind(second.serializer);
    vi.spyOn(second.serializer, 'serialize').mockImplementation((options) => {
      expect(yielded).toBe(true);
      return serialize(options);
    });
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.records).toHaveLength(2);
  });

  it('a consent event seeds immediately and a late state response cannot override it', async () => {
    const seed = deferred<HistoryResult<TerminalHistoryState>>();
    const kit = setup(false, seed.promise);
    const { terminal } = kit.add('a');
    await write(terminal, 'live');
    kit.state(true);
    expect(await kit.coordinator.request()).toBe(true);
    seed.resolve({ ok: true, value: { enabled: false, generation: 0, error: null } });
    await Promise.resolve();
    await write(terminal, '\r\nmore');
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.records).toHaveLength(2);
  });

  it('a final arrival attempts output left dirty by failed periodic work but retains that failure', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    await write(terminal, 'before');
    const ack = deferred<Awaited<ReturnType<TerminalHistoryBridge['checkpoint']>>>();
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(() => ack.promise);
    const periodic = kit.coordinator.request();
    await vi.waitFor(() => expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1));
    await write(terminal, '\r\nlate');
    const final = kit.coordinator.request(Date.now() + 1000);
    ack.resolve({ ok: false, error: 'session' });
    expect(await periodic).toBe(false);
    expect(await final).toBe(false);
    expect(kit.records[0].record.normal.ansi).toContain('late');
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(2);
    expect(await kit.coordinator.request()).toBe(true);
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(2);
  });

  it('a final failure settles rather than repeatedly retrying the same unchanged buffer', async () => {
    const kit = setup();
    kit.add('a');
    vi.mocked(kit.bridge.checkpoint).mockResolvedValue({ ok: false, error: 'io' });
    expect(await kit.coordinator.request(Date.now() + 1000)).toBe(false);
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('uses one final deadline even while periodic IPC is stalled, without starting later terminals', async () => {
    const kit = setup();
    const { terminal } = kit.add('a');
    const second = kit.add('second');
    const serializeSecond = vi.spyOn(second.serializer, 'serialize');
    await write(terminal, 'first');
    const ack = deferred<Awaited<ReturnType<TerminalHistoryBridge['checkpoint']>>>();
    vi.mocked(kit.bridge.checkpoint).mockImplementationOnce(() => ack.promise);
    const periodic = kit.coordinator.request();
    await vi.waitFor(() => expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    const final = kit.coordinator.request(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await final).toBe(false);
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1);
    ack.resolve({ ok: true, value: { revision: 1 } });
    await vi.runAllTimersAsync();
    expect(await periodic).toBe(false);
    expect(serializeSecond).not.toHaveBeenCalled();
    expect(kit.bridge.checkpoint).toHaveBeenCalledTimes(1);
  });
});
