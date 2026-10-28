import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types';
import type { TerminalHistoryBinding, TerminalHistoryBridge, TerminalHistoryRecord } from '../../src/shared/terminal-history';
import { TerminalHistoryStore, TERMINAL_HISTORY_SETTINGS_KEY } from '../../src/main/terminal-history';
import { TerminalHistoryIntegration } from '../../src/main/terminal-history-integration';
import { SessionWindowRegistry, type SessionWindowState } from '../../src/main/session-windows';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  contents: new Map<number, any>(),
  windows: [] as any[],
  expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, callback: (...args: any[]) => unknown) => electron.handlers.set(channel, callback),
    on: (channel: string, callback: (...args: any[]) => unknown) => electron.listeners.set(channel, callback),
  },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener, send: electron.send, sendSync: vi.fn() },
  contextBridge: { exposeInMainWorld: electron.expose }, webUtils: {},
  webContents: { fromId: (id: number) => electron.contents.get(id) },
  BrowserWindow: { getAllWindows: () => electron.windows, fromWebContents: (wc: any) => wc.window, getFocusedWindow: () => null },
  clipboard: {}, shell: {}, dialog: {}, nativeTheme: { on: vi.fn() },
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0' },
}));
vi.mock('../../src/shared/instance', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAppDataDir: () => path.join(os.tmpdir(), `wmux-history-integration-runtime-${process.pid}`),
}));

const record = (text = 'private-output'): TerminalHistoryRecord => ({
  version: 1, capturedAt: 1, cols: 80, rows: 24,
  normal: { startLine: 0, lineCount: 24, ansi: text },
});
const windowState = (surface: string): SessionWindowState => ({
  bounds: { x: 0, y: 0, width: 800, height: 600 }, sidebarWidth: 200, activeWorkspaceId: 'ws-a',
  workspaces: [{ id: 'ws-a', title: surface, pinned: false, shell: 'pwsh', splitTree: {
    type: 'leaf', paneId: 'pane-a', surfaces: [{ id: surface, type: 'terminal' }], activeSurfaceIndex: 0,
  } }],
});

function binding(integration: TerminalHistoryIntegration, owner = 1, surface = 'surf-a'): TerminalHistoryBinding {
  const result = integration.getBinding(owner, surface);
  if (!result.ok || !result.value.binding) throw new Error('Expected authorized binding');
  return result.value.binding;
}

describe('automatic history publication and ownership', () => {
  let root: string;
  let store: TerminalHistoryStore;
  let windows: SessionWindowRegistry;
  let integration: TerminalHistoryIntegration;
  let persist: ReturnType<typeof vi.fn>;
  let broadcast: ReturnType<typeof vi.fn>;
  let owners: Map<number, string>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-history-integration-'));
    store = new TerminalHistoryStore({ directory: path.join(root, 'history'), settings: {
      load: () => ({ [TERMINAL_HISTORY_SETTINGS_KEY]: { enabled: true, generation: 0 } }), save: () => true,
    } });
    windows = new SessionWindowRegistry();
    owners = new Map([[1, 'win-a'], [2, 'win-b'], [3, 'win-new']]);
    persist = vi.fn(() => true);
    broadcast = vi.fn();
    integration = new TerminalHistoryIntegration({ store, windows, persist, broadcast,
      ownerWindow: (owner) => owners.get(owner) ?? null });
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('refuses non-desktop callers, wrong windows and stale lifetime tokens through registered IPC', async () => {
    integration.associate(1, 'surf-a');
    windows.prime('win-a', windowState('surf-a'));
    const token = binding(integration);
    integration.registerIpc({ handle: (channel: string, callback: any) => electron.handlers.set(channel, callback) } as any);
    const call = (channel: string, owner: number, ...args: any[]) => electron.handlers.get(channel)!({ sender: { id: owner } }, ...args);
    for (const channel of [IPC_CHANNELS.TERMINAL_HISTORY_GET_STATE, IPC_CHANNELS.TERMINAL_HISTORY_SET_ENABLED,
      IPC_CHANNELS.TERMINAL_HISTORY_BINDING, IPC_CHANNELS.TERMINAL_HISTORY_READ,
      IPC_CHANNELS.TERMINAL_HISTORY_CHECKPOINT]) {
      expect(await call(channel, 99, 'surf-a', token, 1, record())).toEqual({ ok: false, error: 'unauthorized' });
    }
    expect(await call(IPC_CHANNELS.TERMINAL_HISTORY_CHECKPOINT, 2, 'surf-a', token, 1, record())).toMatchObject({ ok: false });
    expect(await call(IPC_CHANNELS.TERMINAL_HISTORY_READ, 2, 'surf-a', token)).toMatchObject({ ok: false });
    expect(await integration.forget(1, 'surf-a', token.incarnation)).toMatchObject({ ok: true });
    integration.associate(1, 'surf-a');
    expect(binding(integration).recordId).not.toBe(token.recordId);
    expect(await integration.checkpoint(1, 'surf-a', token, 1, record())).toMatchObject({ ok: false });
    expect(await integration.read(1, 'surf-a', token)).toMatchObject({ ok: false });
  });

  it('seeds two automatic window slots before spawn, and never restores by surface ID alone', async () => {
    const first = new TerminalHistoryStore({ directory: path.join(root, 'history'), settings: {
      load: () => ({ [TERMINAL_HISTORY_SETTINGS_KEY]: { enabled: true, generation: 0 } }), save: () => true,
    } });
    for (const [owner, surface] of [[1, 'surf-a'], [2, 'surf-b']] as const) {
      const old = first.associate(owner, surface)!;
      await first.checkpoint(owner, surface, old, 1, record(surface));
      const state = windowState(surface);
      state.terminalHistory = { [surface]: first.referenceFor(owner, surface)! };
      const win = owners.get(owner)!;
      windows.prime(win, state);
      windows.markStartup(win);
      integration.seedWindow(owner);
    }
    expect(binding(integration, 1).recordId).not.toBe(binding(integration, 2, 'surf-b').recordId);
    expect(await integration.read(1, 'surf-a', binding(integration))).toMatchObject({ ok: true, value: record('surf-a') });
    expect(await integration.read(2, 'surf-b', binding(integration, 2, 'surf-b'))).toMatchObject({ ok: true, value: record('surf-b') });
    windows.update('win-new', windows.get('win-a')!);
    integration.seedWindow(3);
    expect(integration.getBinding(3, 'surf-a').ok).toBe(false);
    integration.associate(3, 'surf-a');
    expect(await integration.read(3, 'surf-a', binding(integration, 3))).toMatchObject({ ok: false, error: 'unauthorized' });
    const before = windows.get('win-a')!;
    expect(integration.saveWindow(1, { ...windowState('temporary'), workspaces: [] })).toBe(true);
    expect(windows.get('win-a')!.terminalHistory).toEqual(before.terminalHistory);
    expect(windows.get('win-a')!.workspaces).toEqual(before.workspaces);
    integration.discardStartup(1);
    expect(await integration.read(1, 'surf-a', binding(integration))).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('stamps references only after commit, refuses forgeries, and preserves every other window map', async () => {
    for (const [owner, surface] of [[1, 'surf-a'], [2, 'surf-b']] as const) {
      integration.associate(owner, surface);
      const state = windowState(surface);
      state.terminalHistory = { [surface]: { recordId: `hist-${randomUUID()}`, generation: 0 } };
      expect(integration.saveWindow(owner, state)).toBe(true);
      expect(windows.get(owners.get(owner)!)!.terminalHistory).toBeUndefined();
      expect(await integration.checkpoint(owner, surface, binding(integration, owner, surface), 1, record())).toMatchObject({ ok: true });
    }
    const refs = windows.toArray().map((state) => state.terminalHistory);
    expect(integration.saveWindow(1, windowState('surf-a'))).toBe(true);
    expect(integration.saveWindow(2, windowState('surf-b'))).toBe(true);
    const saved = persist.mock.lastCall![0];
    expect(saved.windows.map((state: SessionWindowState) => state.terminalHistory)).toEqual(refs);
    expect(JSON.stringify(saved)).not.toContain('private-output');
  });

  it('acknowledges only record AND link persistence, retaining the prior map and retrying the same revision', async () => {
    integration.associate(1, 'surf-a');
    windows.prime('win-a', windowState('surf-a'));
    const token = binding(integration);
    persist.mockReturnValueOnce(false);
    expect(await integration.checkpoint(1, 'surf-a', token, 1, record())).toEqual({ ok: false, error: 'session' });
    expect(integration.getState().error).toBe('session');
    expect(windows.get('win-a')!.terminalHistory).toBeUndefined();
    const write = vi.spyOn(store, 'checkpoint');
    expect(await integration.checkpoint(1, 'surf-a', token, 1, record())).toEqual({ ok: true, value: { revision: 1 } });
    expect(write).not.toHaveBeenCalled();
    expect(windows.get('win-a')!.terminalHistory?.['surf-a'].recordId).toBe(token.recordId);
    expect(integration.getState().error).toBeNull();
    expect(broadcast).toHaveBeenLastCalledWith(integration.getState());
  });

  it('keeps an already published reference when a later automatic replacement fails', async () => {
    integration.associate(1, 'surf-a');
    windows.prime('win-a', windowState('surf-a'));
    const token = binding(integration);
    await integration.checkpoint(1, 'surf-a', token, 1, record('first'));
    const previous = structuredClone(windows.get('win-a')!.terminalHistory);
    persist.mockReturnValueOnce(false);
    expect(await integration.checkpoint(1, 'surf-a', token, 2, record('second'))).toEqual({ ok: false, error: 'session' });
    expect(windows.get('win-a')!.terminalHistory).toEqual(previous);
    const write = vi.spyOn(store, 'checkpoint');
    expect(await integration.checkpoint(1, 'surf-a', token, 2, record('second'))).toMatchObject({ ok: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('issues the surviving association revision floor and resets it only for a new generation or lifetime', async () => {
    integration.associate(1, 'surf-a');
    windows.prime('win-a', windowState('surf-a'));
    const original = binding(integration);
    expect(await integration.checkpoint(1, 'surf-a', original, 9000, record('before-recovery'))).toMatchObject({ ok: true });
    // A full renderer reload can reset all of its counters, but not main's association.
    integration.associate(1, 'surf-a');
    expect(integration.getBinding(1, 'surf-a')).toMatchObject({ ok: true, value: { binding: original, revisionFloor: 9000 } });
    const recovered = integration.getBinding(1, 'surf-a');
    if (!recovered.ok) throw new Error('Missing association');
    expect(await integration.checkpoint(1, 'surf-a', original, recovered.value.revisionFloor + 1, record('after-recovery')))
      .toMatchObject({ ok: true });
    // Failed writes also reserve revisions, so a reload cannot reuse an older number.
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('fixture'));
    expect(await integration.checkpoint(1, 'surf-a', original, 9500, record())).toMatchObject({ ok: false });
    expect(integration.getBinding(1, 'surf-a')).toMatchObject({ value: { revisionFloor: 9500 } });
    await integration.setEnabled(false);
    await integration.setEnabled(true);
    const generation = binding(integration);
    expect(integration.getBinding(1, 'surf-a')).toMatchObject({ value: { revisionFloor: 0 } });
    expect(await integration.checkpoint(1, 'surf-a', generation, 1, record())).toMatchObject({ ok: true });
    await integration.forget(1, 'surf-a', generation.incarnation);
    integration.associate(1, 'surf-a');
    expect(binding(integration).incarnation).not.toBe(generation.incarnation);
    expect(integration.getBinding(1, 'surf-a')).toMatchObject({ value: { revisionFloor: 0 } });
    expect(await integration.checkpoint(1, 'surf-a', binding(integration), 1, record())).toMatchObject({ ok: true });
  });

  it('cannot acknowledge a record without terminal membership in the automatic slot', async () => {
    integration.associate(1, 'surf-a');
    windows.prime('win-a', windowState('different-terminal'));
    expect(await integration.checkpoint(1, 'surf-a', binding(integration), 1, record())).toEqual({ ok: false, error: 'session' });
  });

  it('revokes forgotten startup references even if deleting the record fails', async () => {
    const reference = { recordId: `hist-${randomUUID()}`, generation: 0 };
    const state = windowState('surf-a');
    state.terminalHistory = { 'surf-a': reference };
    windows.prime('win-a', state);
    windows.markStartup('win-a');
    integration.seedWindow(1);
    fs.mkdirSync(path.join(root, 'history'));
    fs.writeFileSync(path.join(root, 'history', `${reference.recordId}.json`), '{}');
    vi.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }));
    expect(await integration.forget(1, 'surf-a', binding(integration).incarnation)).toEqual({ ok: false, error: 'cleanup' });
    expect(integration.getBinding(1, 'surf-a').ok).toBe(false);
    expect(windows.get('win-a')!.terminalHistory).toBeUndefined();
    integration.saveWindow(1, { ...state, workspaces: [] });
    expect(windows.get('win-a')!.workspaces).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'cleanup' }));
  });

  it('a delayed close cannot erase a reopened same-ID terminal or publish an old write', async () => {
    integration.associate(1, 'surf-a');
    windows.prime('win-a', windowState('surf-a'));
    const old = binding(integration);
    const rename = fs.promises.rename.bind(fs.promises);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (...args) => {
      entered(); await gate; return rename(...args);
    });
    const pending = integration.checkpoint(1, 'surf-a', old, 1, record('closed-output'));
    await started;
    expect(integration.closeSurface(2, 'surf-a')).toBe(false);
    expect(integration.closeSurface(1, 'surf-a')).toBe(true);
    expect(integration.getBinding(1, 'surf-a').ok).toBe(false);
    expect(windows.get('win-a')!.terminalHistory).toBeUndefined();
    integration.associate(1, 'surf-a');
    const replacement = binding(integration);
    expect(replacement.incarnation).not.toBe(old.incarnation);
    expect(await integration.checkpoint(1, 'surf-a', replacement, 1, record('replacement'))).toMatchObject({ ok: true });
    release();
    expect(await pending).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'history', old.recordId + '.json'))).toBe(false));
    expect(binding(integration)).toEqual(replacement);
    expect(windows.get('win-a')!.terminalHistory?.['surf-a'].recordId).toBe(replacement.recordId);
  });

  it.each([[false, 1, false], [false, 0, true], [true, 1, true]] as const)(
    'window close quitting=%s remaining=%s retains=%s even after destroyed revoked authority', async (quitting, remaining, retained) => {
      integration.associate(1, 'surf-a');
      windows.prime('win-a', windowState('surf-a'));
      const token = binding(integration);
      await integration.checkpoint(1, 'surf-a', token, 1, record());
      integration.revokeOwner(1);
      owners.delete(1);
      expect(integration.getBinding(1, 'surf-a').ok).toBe(false);
      integration.closeWindow('win-a', 1, quitting, remaining);
      const file = path.join(root, 'history', token.recordId + '.json');
      if (!retained) await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false));
      expect(fs.existsSync(file)).toBe(retained);
      expect(windows.get('win-a') !== null).toBe(retained);
    });

  it('window discard also deletes an unpublished rename after destroyed has already revoked its owner', async () => {
    integration.associate(1, 'surf-a');
    windows.prime('win-a', windowState('surf-a'));
    const old = binding(integration);
    const rename = fs.promises.rename.bind(fs.promises);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (...args) => { entered(); await gate; return rename(...args); });
    const pending = integration.checkpoint(1, 'surf-a', old, 1, record());
    await started;
    expect(windows.get('win-a')!.terminalHistory).toBeUndefined();
    integration.revokeOwner(1);
    owners.delete(1);
    integration.closeWindow('win-a', 1, false, 1);
    release();
    expect(await pending).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(fs.readdirSync(path.join(root, 'history'))).toEqual([]));
    expect(windows.get('win-a')).toBeNull();
  });

  it('disable strips every window immediately while retaining lifetime metadata for open buffers', async () => {
    const tokens = [];
    for (const [owner, surface] of [[1, 'surf-a'], [2, 'surf-b']] as const) {
      integration.associate(owner, surface);
      windows.prime(owners.get(owner)!, windowState(surface));
      const issued = binding(integration, owner, surface);
      tokens.push(issued);
      expect(await integration.checkpoint(owner, surface, issued, 1, record())).toMatchObject({ ok: true });
    }
    const disabled = integration.setEnabled(false);
    expect(windows.toArray().map((state) => state.terminalHistory)).toEqual([undefined, undefined]);
    expect(persist.mock.lastCall![0].windows.map((state: SessionWindowState) => state.terminalHistory)).toEqual([undefined, undefined]);
    expect(await disabled).toMatchObject({ ok: true });
    expect(integration.getBinding(1, 'surf-a')).toMatchObject({ value: { binding: null, incarnation: tokens[0].incarnation } });
    expect(integration.getBinding(2, 'surf-b')).toMatchObject({ value: { binding: null, incarnation: tokens[1].incarnation } });
    await integration.setEnabled(true);
    expect(windows.toArray().map((state) => state.terminalHistory)).toEqual([undefined, undefined]);
  });

  it('manual selection preserves reused open buffers but drops other associations and saved-ID grants', async () => {
    integration.associate(1, 'surf-a');
    integration.associate(1, 'surf-dropped');
    const state = windowState('surf-a');
    state.workspaces[0].splitTree.surfaces.push({ id: 'surf-dropped', type: 'terminal' });
    windows.prime('win-a', state);
    const kept = binding(integration);
    const dropped = binding(integration, 1, 'surf-dropped');
    await integration.checkpoint(1, 'surf-a', kept, 1, record('visible-live-buffer'));
    await integration.checkpoint(1, 'surf-dropped', dropped, 1, record('dropped'));
    const incoming = { name: 'manual', savedAt: 1, workspaces: windowState('surf-a').workspaces };
    integration.selectNamed(1, incoming as any);
    expect(binding(integration)).toEqual(kept);
    expect(integration.getBinding(1, 'surf-dropped').ok).toBe(false);
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'history', dropped.recordId + '.json'))).toBe(false));
    integration.associate(1, 'surf-dropped');
    expect(binding(integration, 1, 'surf-dropped').recordId).not.toBe(dropped.recordId);
    expect(await integration.read(1, 'surf-dropped', binding(integration, 1, 'surf-dropped'))).toMatchObject({ ok: false });
  });

  it('reports actual store failures and broadcasts disabled generations, rejecting old writes', async () => {
    integration.associate(1, 'surf-a');
    windows.prime('win-a', windowState('surf-a'));
    const token = binding(integration);
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    expect(await integration.checkpoint(1, 'surf-a', token, 1, record())).toEqual({ ok: false, error: 'io' });
    expect(integration.getState().error).toBe('io');
    expect(await integration.setEnabled(false)).toMatchObject({ ok: true });
    expect(broadcast).toHaveBeenLastCalledWith({ enabled: false, generation: 1, error: null });
    await integration.setEnabled(true);
    expect(await integration.checkpoint(1, 'surf-a', token, 1, record())).toMatchObject({ ok: false });
    integration.saveWindow(1, windowState('surf-a'));
    expect(windows.get('win-a')!.terminalHistory).toBeUndefined();
  });
});

describe('production IPC ownership hooks and preload capture', () => {
  let ipc: typeof import('../../src/main/ipc-handlers');
  let bridge: TerminalHistoryBridge;
  const desktop = (id: number) => {
    const wc = { id, isDestroyed: () => false, send: vi.fn(), once: vi.fn(), executeJavaScript: vi.fn(), window: null as any };
    const win = { webContents: wc, isDestroyed: () => false };
    wc.window = win;
    electron.contents.set(id, wc);
    return win;
  };
  let first: ReturnType<typeof desktop>;
  let second: ReturnType<typeof desktop>;

  beforeAll(async () => {
    ipc = await import('../../src/main/ipc-handlers');
    first = desktop(11); second = desktop(22);
    electron.windows = [first, second];
    ipc.registerIpcHandlers({
      idForWebContents: (wc: any) => electron.contents.has(wc.id) ? `win-${wc.id}` : undefined,
      getWindow: (id: string) => id === 'win-11' ? first : id === 'win-22' ? second : null,
      getAllWindows: () => [{ id: 'win-11' }, { id: 'win-22' }],
    } as any);
    await ipc.terminalHistory.setEnabled(true);
    await import('../../src/preload/index');
    bridge = electron.expose.mock.calls.find(([name]) => name === 'wmux')![1].terminalHistory;
  });
  afterAll(async () => {
    await ipc.terminalHistory.setEnabled(false);
    fs.rmSync(path.join(os.tmpdir(), `wmux-history-integration-runtime-${process.pid}`), { recursive: true, force: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('binds accepted normal and agent PTYs, retains exited-open ownership and idempotent creates', async () => {
    const exits = new Map<string, (code: number) => void>();
    vi.spyOn(ipc.ptyManager, 'onData').mockReturnValue(() => {});
    vi.spyOn(ipc.ptyManager, 'onExit').mockImplementation((surface, callback) => { exits.set(surface, callback); return () => {}; });
    const create = vi.spyOn(ipc.ptyManager, 'create').mockReturnValue({ id: 'surf-normal', shell: 'pwsh', reused: false } as any);
    const handler = electron.handlers.get(IPC_CHANNELS.PTY_CREATE)!;
    await handler({ sender: first.webContents }, { shell: 'pwsh', cwd: 'C:\\' });
    const token = binding(ipc.terminalHistory, 11, 'surf-normal');
    create.mockReturnValue({ id: 'surf-normal', shell: 'pwsh', reused: true } as any);
    await handler({ sender: first.webContents }, { shell: 'pwsh' });
    await handler({ sender: second.webContents }, { shell: 'pwsh' });
    expect(binding(ipc.terminalHistory, 11, 'surf-normal')).toEqual(token);
    expect(ipc.terminalHistory.getBinding(22, 'surf-normal').ok).toBe(false);
    ipc.setupAgentPtyForwarding('surf-agent', first as any);
    exits.get('surf-normal')!(0);
    exits.get('surf-agent')!(0);
    for (const surface of ['surf-normal', 'surf-agent']) {
      ipc.terminalHistory.saveWindow(11, windowState(surface));
      expect(await ipc.terminalHistory.checkpoint(11, surface, binding(ipc.terminalHistory, 11, surface), 1, record())).toMatchObject({ ok: true });
    }
    expect(first.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_HISTORY_STATE, ipc.terminalHistory.getState());
    expect(second.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_HISTORY_STATE, ipc.terminalHistory.getState());
  });

  it('destructive PTY_KILL is owner-bound even after EXIT and while history is disabled', async () => {
    const exits = new Map<string, (code: number) => void>();
    vi.spyOn(ipc.ptyManager, 'onData').mockReturnValue(() => {});
    vi.spyOn(ipc.ptyManager, 'onExit').mockImplementation((surface, callback) => { exits.set(surface, callback); return () => {}; });
    vi.spyOn(ipc.ptyManager, 'create').mockReturnValue({ id: 'surf-close-after-exit', shell: 'pwsh', reused: false } as any);
    await electron.handlers.get(IPC_CHANNELS.PTY_CREATE)!({ sender: first.webContents }, {});
    const before = ipc.terminalHistory.getBinding(11, 'surf-close-after-exit');
    exits.get('surf-close-after-exit')!(0);
    expect(ipc.terminalHistory.getBinding(11, 'surf-close-after-exit')).toEqual(before);
    const kill = vi.spyOn(ipc.ptyManager, 'kill').mockImplementation(() => {});
    const close = electron.listeners.get(IPC_CHANNELS.PTY_KILL)!;
    close({ sender: second.webContents }, 'surf-close-after-exit');
    expect(kill).not.toHaveBeenCalled();
    await ipc.terminalHistory.setEnabled(false);
    expect(ipc.terminalHistory.getBinding(11, 'surf-close-after-exit')).toMatchObject({ ok: true, value: { binding: null } });
    close({ sender: first.webContents }, 'surf-close-after-exit');
    expect(kill).toHaveBeenCalledExactlyOnceWith('surf-close-after-exit');
    expect(ipc.terminalHistory.getBinding(11, 'surf-close-after-exit').ok).toBe(false);
    await ipc.terminalHistory.setEnabled(true);
  });

  it.each([true, false])('closing exited A cannot kill B after B creates the same saved ID (history enabled=%s)', async (enabled) => {
    await ipc.terminalHistory.setEnabled(enabled);
    const id = `surf-cross-owner-${enabled}`;
    let live = false;
    let exit!: (code: number) => void;
    vi.spyOn(ipc.ptyManager, 'has').mockImplementation((surface) => surface === id && live);
    vi.spyOn(ipc.ptyManager, 'onData').mockReturnValue(() => {});
    vi.spyOn(ipc.ptyManager, 'onExit').mockImplementation((_surface, callback) => { exit = callback; return () => {}; });
    const create = vi.spyOn(ipc.ptyManager, 'create').mockImplementation(() => {
      live = true;
      return { id, shell: 'pwsh', reused: false } as any;
    });
    const handler = electron.handlers.get(IPC_CHANNELS.PTY_CREATE)!;
    const close = electron.listeners.get(IPC_CHANNELS.PTY_KILL)!;
    await handler({ sender: first.webContents }, { shell: 'pwsh' });
    const old = ipc.terminalHistory.getBinding(11, id);
    if (!old.ok) throw new Error('Missing original lifetime');
    if (enabled) {
      ipc.terminalHistory.saveWindow(11, windowState(id));
      expect(await ipc.terminalHistory.checkpoint(11, id, old.value.binding!, 1, record('A-output'))).toMatchObject({ ok: true });
    }
    const beforeExit = ipc.terminalHistory.getBinding(11, id);
    live = false;
    exit(0);
    expect(ipc.terminalHistory.getBinding(11, id)).toEqual(beforeExit);
    await handler({ sender: second.webContents }, { shell: 'claude' });
    if (enabled) {
      ipc.terminalHistory.saveWindow(22, windowState(id));
      expect(await ipc.terminalHistory.checkpoint(22, id, binding(ipc.terminalHistory, 22, id), 1, record('B-output'))).toMatchObject({ ok: true });
    }
    const replacement = ipc.terminalHistory.getBinding(22, id);
    const metadata = ipc.agentIdentity.identify(id);
    expect(metadata).not.toBeNull();
    const kill = vi.spyOn(ipc.ptyManager, 'kill').mockImplementation(() => { live = false; });
    close({ sender: first.webContents }, id);
    expect(kill).not.toHaveBeenCalled();
    expect(ipc.ptyManager.has(id as any)).toBe(true);
    expect(ipc.agentIdentity.identify(id)).toEqual(metadata);
    expect(ipc.terminalHistory.getBinding(11, id).ok).toBe(false);
    expect(ipc.terminalHistory.getBinding(22, id)).toEqual(replacement);
    if (enabled) {
      const directory = path.join(os.tmpdir(), `wmux-history-integration-runtime-${process.pid}`, 'terminal-history');
      await vi.waitFor(() => expect(fs.existsSync(path.join(directory, old.value.binding!.recordId + '.json'))).toBe(false));
      const current = binding(ipc.terminalHistory, 22, id);
      expect(fs.existsSync(path.join(directory, current.recordId + '.json'))).toBe(true);
      expect(await ipc.terminalHistory.checkpoint(22, id, current, 2, record('B-still-owned'))).toMatchObject({ ok: true });
    }
    // Idempotent create must still see B as the owner, not reclaim an owner erased by A's close.
    create.mockReturnValue({ id, shell: 'pwsh', reused: true } as any);
    await handler({ sender: first.webContents }, { shell: 'pwsh' });
    expect(ipc.terminalHistory.getBinding(11, id).ok).toBe(false);
    expect(ipc.agentIdentity.identify(id)).toEqual(metadata);
    close({ sender: second.webContents }, id);
    expect(kill).toHaveBeenCalledExactlyOnceWith(id);
    expect(ipc.agentIdentity.identify(id)).toBeNull();
    await ipc.terminalHistory.setEnabled(true);
  });

  it.each([
    ['single', ['pane-second']],
    ['batch', ['pane-second', 'pane-second-other']],
  ] as const)('routes %s spawns through the owning second window for history and output', async (_route, panes) => {
    const { prepareAgentSpawn } = await import('../../src/main/agent-spawn-window');
    first.webContents.executeJavaScript.mockResolvedValue([{ paneId: 'pane-first', tabCount: 0 }]);
    second.webContents.executeJavaScript.mockResolvedValue(panes.map((paneId) => ({ paneId, tabCount: 0 })));
    first.webContents.send.mockClear();
    second.webContents.send.mockClear();
    const data = new Map<string, (chunk: string) => void>();
    const exits = new Map<string, (code: number) => void>();
    vi.spyOn(ipc.ptyManager, 'onData').mockImplementation((surface, callback) => { data.set(surface, callback); return () => {}; });
    vi.spyOn(ipc.ptyManager, 'onExit').mockImplementation((surface, callback) => { exits.set(surface, callback); return () => {}; });
    const spawn = vi.spyOn(ipc.agentManager, 'spawn').mockImplementation(() => ({
      agentId: `agent-${randomUUID()}`, surfaceId: `surf-${randomUUID()}`,
    }));
    const spawnAgent = await prepareAgentSpawn('ws-second', panes);
    expect(spawn).not.toHaveBeenCalled();
    expect(first.webContents.executeJavaScript).toHaveBeenCalledWith('window.__wmux_getPaneLoads?.("ws-second") ?? []');
    expect(second.webContents.executeJavaScript).toHaveBeenCalledWith('window.__wmux_getPaneLoads?.("ws-second") ?? []');
    for (const paneId of panes) {
      const result = spawnAgent({ cmd: 'fixture-agent', paneId, workspaceId: 'ws-second' } as any);
      expect(ipc.terminalHistory.getBinding(11, result.surfaceId).ok).toBe(false);
      expect(binding(ipc.terminalHistory, 22, result.surfaceId)).toBeDefined();
      data.get(result.surfaceId)!('agent-output');
      expect(second.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.PTY_DATA, result.surfaceId, 'agent-output');
      expect(first.webContents.send).not.toHaveBeenCalledWith(IPC_CHANNELS.PTY_DATA, result.surfaceId, 'agent-output');
      exits.get(result.surfaceId)!(0);
    }
    expect(spawn).toHaveBeenCalledTimes(panes.length);
  });

  it('does not spawn into an unowned or disappearing target window', async () => {
    const { prepareAgentSpawn } = await import('../../src/main/agent-spawn-window');
    const spawn = vi.spyOn(ipc.agentManager, 'spawn');
    first.webContents.executeJavaScript.mockResolvedValue([]);
    second.webContents.executeJavaScript.mockResolvedValue([]);
    await expect(prepareAgentSpawn('ws-second', ['pane-second'])).rejects.toMatchObject({ code: -32000 });
    const destroyed = vi.spyOn(second, 'isDestroyed').mockReturnValue(false);
    second.webContents.executeJavaScript.mockImplementationOnce(async () => {
      destroyed.mockReturnValue(true);
      return [{ paneId: 'pane-second', tabCount: 0 }];
    });
    await expect(prepareAgentSpawn('ws-second', ['pane-second'])).rejects.toMatchObject({ code: -32000 });
    destroyed.mockReturnValue(false);
    second.webContents.executeJavaScript.mockResolvedValue([{ paneId: 'pane-second', tabCount: 0 }]);
    const spawnAgent = await prepareAgentSpawn('ws-second', ['pane-second']);
    destroyed.mockReturnValue(true);
    expect(() => spawnAgent({ cmd: 'fixture-agent', paneId: 'pane-second', workspaceId: 'ws-second' } as any))
      .toThrow('Target window is no longer available');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('ignores generic settings writes to dedicated consent', async () => {
    const { loadSettings } = await import('../../src/main/settings-store');
    const before = loadSettings()[TERMINAL_HISTORY_SETTINGS_KEY];
    electron.listeners.get(IPC_CHANNELS.SETTINGS_SET)!({ sender: first.webContents }, TERMINAL_HISTORY_SETTINGS_KEY, { enabled: false, generation: 999 });
    expect(loadSettings()[TERMINAL_HISTORY_SETTINGS_KEY]).toEqual(before);
    expect(ipc.terminalHistory.getState().enabled).toBe(true);
  });

  it('forwards optional final request metadata without exposing the Electron event', () => {
    const session = electron.expose.mock.calls.find(([name]) => name === 'wmux')![1].session;
    const callback = vi.fn();
    const unsubscribe = session.onAutoSaveRequest(callback);
    const [channel, listener] = electron.on.mock.lastCall!;
    const request = { token: 'final-request', deadline: 1234 };
    listener({ sender: 'not-metadata' }, request);
    listener({ sender: 'periodic' });
    expect(callback.mock.calls).toEqual([[request], [undefined]]);
    const data = { version: 1, windows: [] };
    session.pushAutoSave(data, request.token);
    session.historyDone(request.token, false);
    expect(electron.send.mock.calls.slice(-2)).toEqual([
      [IPC_CHANNELS.SESSION_SAVE, data, request.token], [IPC_CHANNELS.SESSION_HISTORY_DONE, request.token, false],
    ]);
    expect(channel).toBe(IPC_CHANNELS.SESSION_REQUEST);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(channel, listener);
  });

  it('uses a distinct startup-only preload channel rather than a generic load flag', async () => {
    const session = electron.expose.mock.calls.find(([name]) => name === 'wmux')![1].session;
    await session.load('backup');
    await session.loadStartupFallback('backup');
    expect(electron.invoke.mock.calls.slice(-2)).toEqual([
      [IPC_CHANNELS.SESSION_LOAD_NAMED, 'backup'], [IPC_CHANNELS.SESSION_LOAD_STARTUP_FALLBACK, 'backup'],
    ]);
  });

  it('preserves failed consent results and authoritative paused/final broadcasts through preload', async () => {
    const callback = vi.fn();
    const off = bridge.onState(callback);
    const [, listener] = electron.on.mock.lastCall!;
    const paused = { enabled: false, generation: 5, error: null };
    const final = { enabled: true, generation: 5, error: 'cleanup' };
    listener({ privateEvent: true }, paused);
    electron.invoke.mockResolvedValueOnce({ ok: false, error: 'cleanup' });
    expect(await bridge.setEnabled(true)).toEqual({ ok: false, error: 'cleanup' });
    listener({ privateEvent: true }, final);
    electron.invoke.mockResolvedValueOnce({ ok: true, value: final });
    expect(await bridge.getState()).toEqual({ ok: true, value: final });
    expect(callback.mock.calls).toEqual([[paused], [final]]);
    off();
    expect(electron.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_HISTORY_STATE, listener);
  });

  it('forwards only typed history operations and unsubscribes the exact listener', async () => {
    const token = { recordId: `hist-${randomUUID()}`, generation: 0, incarnation: randomUUID() };
    await bridge.getState(); await bridge.setEnabled(true); await bridge.getBinding('surf-a');
    await bridge.read('surf-a', token); await bridge.checkpoint('surf-a', token, 2, record());
    expect(electron.invoke.mock.calls.slice(-5)).toEqual([
      [IPC_CHANNELS.TERMINAL_HISTORY_GET_STATE], [IPC_CHANNELS.TERMINAL_HISTORY_SET_ENABLED, true],
      [IPC_CHANNELS.TERMINAL_HISTORY_BINDING, 'surf-a'], [IPC_CHANNELS.TERMINAL_HISTORY_READ, 'surf-a', token],
      [IPC_CHANNELS.TERMINAL_HISTORY_CHECKPOINT, 'surf-a', token, 2, record()],
    ]);
    const callback = vi.fn();
    const unsubscribe = bridge.onState(callback);
    const [channel, listener] = electron.on.mock.lastCall!;
    const state = { enabled: true, generation: 1, error: null };
    listener({}, state);
    expect(callback).toHaveBeenCalledExactlyOnceWith(state);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(channel, listener);
  });
});
