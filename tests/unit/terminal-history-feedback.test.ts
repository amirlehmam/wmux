import { readFileSync } from 'node:fs';
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalHistoryBridge, TerminalHistoryState } from '../../src/shared/terminal-history';
import { TerminalHistoryCheckpoints } from '../../src/renderer/utils/terminal-history-checkpoints';
import { subscribeTerminalHistoryState } from '../../src/renderer/utils/terminal-history-state';
import { connectTerminalWithHistory } from '../../src/renderer/utils/terminal-history';
import { ReplayHold } from '../../src/renderer/utils/replay-hold';

let feedback: typeof import('../../src/renderer/utils/terminal-history-feedback');
const cleanups: (() => void)[] = [];
beforeEach(async () => {
  vi.resetModules();
  feedback = await import('../../src/renderer/utils/terminal-history-feedback');
});
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe('coalesced terminal history feedback', () => {
  it('buffers early restore failures, coalesces equivalent categories and unsubscribes', () => {
    feedback.reportTerminalHistoryFailure('unsafe-content');
    feedback.reportTerminalHistoryFailure('invalid-record');
    const notice = vi.fn();
    const off = feedback.onTerminalHistoryFailure(notice);
    expect(notice.mock.calls).toEqual([['record']]);
    feedback.reportTerminalHistoryFailure('unsupported-version');
    feedback.reportTerminalHistoryFailure('replay');
    feedback.reportTerminalHistoryFailure('read');
    expect(notice.mock.calls).toEqual([['record'], ['restore']]);
    off();
    feedback.reportTerminalHistoryFailure('cleanup');
    expect(notice).toHaveBeenCalledTimes(2);
    const next = vi.fn();
    feedback.onTerminalHistoryFailure(next)();
    expect(next.mock.calls).toEqual([['cleanup']]);
  });

  it('suppresses expected outcomes and never interpolates exceptions, paths or terminal content', () => {
    const notice = vi.fn();
    feedback.onTerminalHistoryFailure(notice);
    for (const value of ['missing', 'unauthorized', 'stale', 'disabled', 'cancelled', null,
      'password=secret', 'C:\\private\\terminal.json', new Error('sensitive output')]) {
      feedback.reportTerminalHistoryFailure(value);
    }
    expect(notice).not.toHaveBeenCalled();
    const t = (_key: string, fallback?: string) => fallback ?? _key;
    for (const error of ['io', 'session', 'invalid-target', 'checkpoint', 'revision', 'unsafe-content',
      'capture', 'replay', 'cleanup', 'settings', 'state']) {
      feedback.reportTerminalHistoryFailure(error);
      const category = feedback.terminalHistoryWarning(error)!;
      const text = feedback.terminalHistoryWarningText(category, t);
      expect(text.length).toBeGreaterThan(40);
      expect(text).not.toContain('sensitive output');
      expect(text).not.toContain('C:\\');
    }
    expect(notice.mock.calls).toEqual([['storage'], ['record'], ['capture'], ['restore'], ['cleanup'], ['settings'], ['state']]);
  });

  it('does not spam for repeated checkpoint ticks, multiple panes, or duplicate main/renderer failures', async () => {
    const notices = vi.fn();
    cleanups.push(feedback.onTerminalHistoryFailure(notices));
    const listeners = new Set<(state: TerminalHistoryState) => void>();
    const state = { enabled: true, generation: 1, error: null };
    const broadcast = (error: TerminalHistoryState['error']) => {
      for (const listener of listeners) listener({ ...state, error });
    };
    let fail = true;
    const bridge: TerminalHistoryBridge = {
      getState: vi.fn(async () => ({ ok: true, value: state })),
      onState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      setEnabled: vi.fn(), read: vi.fn(), forget: vi.fn(),
      getBinding: vi.fn(async (surface) => ({ ok: true, value: { incarnation: surface, revisionFloor: 0,
        binding: { recordId: surface, incarnation: surface, generation: 1 } } })),
      checkpoint: vi.fn(async (_surface, _binding, revision) => {
        broadcast(fail ? 'io' : null);
        return fail ? { ok: false, error: 'io' } : { ok: true, value: { revision } };
      }),
    };
    cleanups.push(subscribeTerminalHistoryState(bridge,
      (next) => feedback.reportTerminalHistoryFailure(next.error), () => feedback.reportTerminalHistoryFailure('state')));
    const terminals = new Map<string, Terminal>();
    const serializers = new Map<string, SerializeAddon>();
    const coordinator = new TerminalHistoryCheckpoints({ terminals: () => terminals,
      serializer: (surface) => serializers.get(surface), bridge: () => bridge, lines: () => 100,
      report: feedback.reportTerminalHistoryFailure });
    cleanups.push(coordinator.start());
    for (const surface of ['a', 'b', 'exited-but-open']) {
      const terminal = new Terminal({ cols: 30, rows: 4, allowProposedApi: true });
      const serializer = new SerializeAddon();
      terminal.loadAddon(serializer);
      terminals.set(surface, terminal);
      serializers.set(surface, serializer);
      cleanups.push(() => terminal.dispose());
      cleanups.push(coordinator.observe(terminal, () => true));
      await new Promise<void>((resolve) => terminal.write('fixture output', resolve));
    }
    expect(await coordinator.request()).toBe(false);
    expect(await coordinator.request()).toBe(false);
    expect(notices.mock.calls).toEqual([['storage']]);
    fail = false;
    expect(await coordinator.request()).toBe(true);
    fail = true;
    for (const terminal of terminals.values()) terminal.write('new fixture');
    expect(await coordinator.request()).toBe(false);
    expect(notices.mock.calls).toEqual([['storage']]);
    broadcast('cleanup');
    broadcast(null);
    broadcast('cleanup');
    expect(notices.mock.calls).toEqual([['storage'], ['cleanup']]);
  });

  it('notifies renderer-only validation and replay exceptions while still opening fresh shells', async () => {
    const notice = vi.fn();
    cleanups.push(feedback.onTerminalHistoryFailure(notice));
    const binding = { recordId: 'record', incarnation: 'live', generation: 1 };
    for (const failure of ['validation', 'replay', 'validation', 'replay']) {
      const terminal = new Terminal({ cols: 30, rows: 4, allowProposedApi: true });
      cleanups.push(() => terminal.dispose());
      const record = { version: failure === 'validation' ? 99 : 1, cols: 30, rows: 4, capturedAt: 1,
        normal: { startLine: 0, lineCount: 4, ansi: 'fixture output' } };
      const bridge: TerminalHistoryBridge = {
        getState: vi.fn(async () => ({ ok: true, value: { enabled: true, generation: 1, error: null } })),
        onState: () => () => {}, setEnabled: vi.fn(), checkpoint: vi.fn(), forget: vi.fn(),
        getBinding: vi.fn(async () => ({ ok: true, value: { binding, incarnation: 'live' } })),
        read: vi.fn(async () => ({ ok: true, value: record as any })),
      };
      if (failure === 'replay') {
        const write = vi.spyOn(terminal, 'write').mockImplementationOnce(() => { throw new Error('private exception'); });
        cleanups.push(() => write.mockRestore());
      }
      const create = vi.fn(async () => ({ id: 'fixture', reused: false }));
      const attach = vi.fn();
      await connectTerminalWithHistory({ terminal, surfaceId: 'fixture', bridge,
        signal: new AbortController().signal, isCurrent: () => true, hold: new ReplayHold(() => {}),
        fit: () => {}, has: async () => false, create, attach, abandoned: () => {}, restoreLive: () => {},
        report: feedback.reportTerminalHistoryFailure });
      expect(create).toHaveBeenCalledOnce();
      expect(attach).toHaveBeenCalledOnce();
    }
    expect(notice.mock.calls).toEqual([['record'], ['restore']]);
  });

  it('wires renderer-only restore/capture errors and main broadcasts into the same in-app bell', () => {
    const hook = readFileSync('src/renderer/hooks/useTerminal.ts', 'utf8');
    const app = readFileSync('src/renderer/App.tsx', 'utf8');
    expect(hook.match(/report: reportTerminalHistoryFailure/g)).toHaveLength(2);
    expect(hook).not.toContain("console.warn('[terminal-history]");
    expect(app).toContain('onTerminalHistoryFailure((category) =>');
    expect(app).toContain('(state) => reportTerminalHistoryFailure(state.error)');
    expect(app).toContain('text: terminalHistoryWarningText(category, t)');
    expect(app).toContain('return () => { offState(); offWarnings(); }');
  });
});
