import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '../../src/main/session-persistence';
import type { TerminalHistoryIntegration } from '../../src/main/terminal-history-integration';
import type { TerminalHistoryRecord } from '../../src/shared/terminal-history';
import { IPC_CHANNELS } from '../../src/shared/types';

const location = vi.hoisted(() => ({ root: '' }));
vi.mock('../../src/shared/instance', () => ({ getAppDataDir: () => location.root }));
const output: TerminalHistoryRecord = { version: 1, capturedAt: 1, cols: 80, rows: 24,
  normal: { startLine: 0, lineCount: 24, ansi: 'fixture-output-not-in-layout' } };
const windowOf = (surface: string): SessionData['windows'][number] => ({
  bounds: { x: 1, y: 2, width: 800, height: 600 }, sidebarWidth: 240, activeWorkspaceId: 'ws-' + surface,
  workspaces: [{ id: 'ws-' + surface, title: surface, pinned: false, shell: 'pwsh', splitTree: {
    type: 'leaf', paneId: 'pane-' + surface, surfaces: [{ id: surface, type: 'terminal' }], activeSurfaceIndex: 0,
  } }],
});

let persistence: typeof import('../../src/main/session-persistence');
let Store: typeof import('../../src/main/terminal-history').TerminalHistoryStore;
let Integration: typeof import('../../src/main/terminal-history-integration').TerminalHistoryIntegration;
let Handoff: typeof import('../../src/main/terminal-history-handoff').TerminalHistoryHandoff;
let Registry: typeof import('../../src/main/session-windows').SessionWindowRegistry;
let consent: { enabled: boolean; generation: number };
let root: string;
const control = () => path.join(root, 'sessions', 'terminal-history-handoff.json');
const historyDir = () => path.join(root, 'terminal-history');
const recordPath = (id: string) => path.join(historyDir(), id + '.json');
const backupName = 'Auto-backup vold';

function run() {
  const store = new Store({ directory: historyDir(), settings: {
    load: () => ({ 'wmux-terminal-history': consent }),
    save: (_key, value) => { consent = value as typeof consent; return true; },
  } });
  const windows = new Registry();
  const owners = new Map([[1, 'win-start'], [2, 'win-second'], [3, 'win-new']]);
  const handoff = new Handoff(path.join(root, 'sessions'));
  const broadcast = vi.fn();
  const integration = new Integration({ store, windows, handoff, broadcast,
    ownerWindow: (owner) => owners.get(owner) ?? null });
  return { store, windows, owners, handoff, integration, broadcast };
}
function token(integration: TerminalHistoryIntegration, surface = 'surf-a', owner = 1) {
  const issued = integration.getBinding(owner, surface);
  if (!issued.ok || !issued.value.binding) throw new Error('No binding');
  return issued.value.binding;
}
async function original() {
  const current = run();
  for (const [owner, surface] of [[1, 'surf-a'], [2, 'surf-b']] as const) {
    current.integration.associate(owner, surface);
    expect(current.integration.saveWindow(owner, windowOf(surface))).toBe(true);
    expect(await current.integration.checkpoint(owner, surface, token(current.integration, surface, owner), 1, output)).toMatchObject({ ok: true });
  }
  return current;
}
function upgrade(current: ReturnType<typeof run>) {
  return persistence.handleVersionChange('new', {
    pending: () => current.integration.hasUpgrade(persistence.loadSession()),
    prepare: (backup, session) => current.integration.prepareUpgrade(backup, session),
  });
}
async function restart() {
  const next = run();
  await next.integration.cleanupStartup(persistence.loadSession());
  next.windows.markStartup('win-start');
  return next;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-history-handoff-'));
  location.root = root;
  consent = { enabled: true, generation: 0 };
  vi.resetModules();
  persistence = await import('../../src/main/session-persistence');
  ({ TerminalHistoryStore: Store } = await import('../../src/main/terminal-history'));
  ({ TerminalHistoryIntegration: Integration } = await import('../../src/main/terminal-history-integration'));
  ({ TerminalHistoryHandoff: Handoff } = await import('../../src/main/terminal-history-handoff'));
  ({ SessionWindowRegistry: Registry } = await import('../../src/main/session-windows'));
  persistence.handleVersionChange('old');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('durable automatic upgrade handoff', () => {
  it('links the exact flattened backup before auto removal, seeds before mount, retires only after real save', async () => {
    const old = await original();
    const refs = persistence.loadSession()!.windows.map((window) => window.terminalHistory!);
    expect(upgrade(old)).toBe(true);
    expect(persistence.loadSession()).toBeNull();
    expect(fs.existsSync(control())).toBe(true);
    const named = persistence.loadNamedSession(backupName)!;
    expect(named.workspaces.map((workspace) => workspace.title)).toEqual(['surf-a', 'surf-b']);
    expect(JSON.stringify(named)).not.toMatch(/terminalHistory|hist-|fixture-output/);
    const next = await restart();
    expect(next.integration.loadStartupFallback(1, backupName)).toEqual(named);
    expect(next.windows.get('win-start')!.terminalHistory).toEqual(Object.assign({}, ...refs));
    for (const surface of ['surf-a', 'surf-b']) {
      expect(await next.integration.read(1, surface, token(next.integration, surface))).toEqual({ ok: true, value: output });
    }
    expect(fs.existsSync(control())).toBe(true);
    // Even the early empty save must use the main-primed layout and references.
    expect(next.integration.saveWindow(1, { ...windowOf('empty'), workspaces: [] })).toBe(true);
    expect(persistence.loadSession()!.windows[0].terminalHistory).toEqual(Object.assign({}, ...refs));
    expect(persistence.loadSession()!.windows[0].workspaces).toHaveLength(2);
    expect(fs.existsSync(control())).toBe(false);
    expect(JSON.stringify(persistence.loadSession())).not.toContain('fixture-output');
  });

  it.each(['backup', 'handoff'] as const)('a failed %s write preserves the original auto-session and version', async (stage) => {
    const current = await original();
    const before = fs.readFileSync(persistence.getSessionPath(), 'utf8');
    const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args: any[]) => {
      if (String(file).endsWith(stage === 'handoff' ? 'terminal-history-handoff.json.tmp' : 'Auto-backup vold.json.tmp')) throw new Error('fixture');
      return (write as any)(file, ...args);
    });
    expect(upgrade(current)).toBe(false);
    expect(fs.readFileSync(persistence.getSessionPath(), 'utf8')).toBe(before);
    expect(persistence.savedVersion()).toBe('old');
    vi.restoreAllMocks();
    expect(upgrade(run())).toBe(true);
    expect((await restart()).integration.loadStartupFallback(1, backupName)).not.toBeNull();
  });

  it.each(['auto-removal', 'version-stamp'] as const)('recovers after a crash/failure at %s without replacing pending provenance', async (stage) => {
    const current = await original();
    if (stage === 'auto-removal') {
      const unlink = fs.unlinkSync.bind(fs);
      vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
        if (String(file) === persistence.getSessionPath()) throw new Error('fixture');
        return unlink(file);
      });
    } else {
      const write = fs.writeFileSync.bind(fs);
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args: any[]) => {
        if (String(file).endsWith('app-version.txt')) throw new Error('fixture');
        return (write as any)(file, ...args);
      });
    }
    expect(upgrade(current)).toBe(false);
    expect(persistence.savedVersion()).toBe('old');
    const pending = fs.readFileSync(control(), 'utf8');
    const backup = persistence.loadNamedSession(backupName);
    vi.restoreAllMocks();
    expect(upgrade(run())).toBe(true);
    expect(fs.readFileSync(control(), 'utf8')).toBe(pending);
    expect(persistence.loadNamedSession(backupName)).toEqual(backup);
    const next = await restart();
    expect(next.integration.loadStartupFallback(1, backupName)).not.toBeNull();
    expect(await next.integration.read(1, 'surf-a', token(next.integration))).toMatchObject({ ok: true });
  });

  it('survives same-version restart after claim and a failed replacement save', async () => {
    expect(upgrade(await original())).toBe(true);
    const first = await restart();
    first.integration.loadStartupFallback(1, backupName);
    const pending = fs.readFileSync(control(), 'utf8');
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === persistence.getSessionPath()) throw new Error('locked');
      rename(from, to);
    });
    expect(first.integration.saveWindow(1, first.windows.get('win-start')!)).toBe(false);
    expect(fs.readFileSync(control(), 'utf8')).toBe(pending);
    expect(persistence.loadSession()).toBeNull();
    vi.restoreAllMocks();
    const next = await restart();
    expect(upgrade(next)).toBe(false); // already stamped, still has durable handoff
    expect(next.integration.loadStartupFallback(1, backupName)).not.toBeNull();
    expect(await next.integration.read(1, 'surf-a', token(next.integration))).toMatchObject({ ok: true });
    expect(next.integration.saveWindow(1, next.windows.get('win-start')!)).toBe(true);
    expect(fs.existsSync(control())).toBe(false);
  });

  it('finishes retirement after a crash between the replacement save and control-file removal', async () => {
    expect(upgrade(await original())).toBe(true);
    const first = await restart();
    first.integration.loadStartupFallback(1, backupName);
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file) === control()) throw new Error('locked');
      return unlink(file);
    });
    expect(first.integration.saveWindow(1, first.windows.get('win-start')!)).toBe(true);
    expect(first.integration.getState().error).toBe('cleanup');
    expect(persistence.loadSession()!.windows[0].terminalHistory).toBeDefined();
    expect(fs.existsSync(control())).toBe(true);
    vi.restoreAllMocks();
    const next = await restart();
    next.windows.prime('win-start', persistence.loadSession()!.windows[0]);
    next.integration.seedWindow(1);
    expect(next.integration.loadStartupFallback(1, backupName)).toBeNull();
    expect(next.integration.saveWindow(1, next.windows.get('win-start')!)).toBe(true);
    expect(fs.existsSync(control())).toBe(false);
  });

  it('manual same-ID loads preserve genuinely reused buffers and lineage, but revoke disk reads', async () => {
    expect(upgrade(await original())).toBe(true);
    const next = await restart();
    const session = next.integration.loadStartupFallback(1, backupName)!;
    const before = token(next.integration);
    next.integration.associate(1, 'surf-a'); // accepted child attached to the real open emulator
    next.integration.selectNamed(1, session);
    expect(token(next.integration)).toEqual(before);
    expect(await next.integration.read(1, 'surf-a', before)).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(next.integration.getBinding(1, 'surf-b').ok).toBe(false); // same ID, but never a live buffer
    expect(next.integration.saveWindow(1, windowOf('surf-a'))).toBe(true);
    expect(persistence.loadSession()!.windows[0].terminalHistory?.['surf-a'].recordId).toBe(before.recordId);
  });

  it('destructive close removes its handoff reference even if replacement auto publication fails', async () => {
    expect(upgrade(await original())).toBe(true);
    const next = await restart();
    next.integration.loadStartupFallback(1, backupName);
    const closed = token(next.integration);
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === persistence.getSessionPath()) throw new Error('locked');
      rename(from, to);
    });
    expect(next.integration.closeSurface(1, 'surf-a')).toBe(true);
    expect(next.handoff.read(0)!.references['surf-a']).toBeUndefined();
    expect(next.handoff.read(0)!.references['surf-b']).toBeDefined();
    await vi.waitFor(() => expect(fs.existsSync(recordPath(closed.recordId))).toBe(false));
    vi.restoreAllMocks();
    const reopened = await restart();
    reopened.integration.loadStartupFallback(1, backupName);
    expect(reopened.integration.getBinding(1, 'surf-a').ok).toBe(false);
    expect(await reopened.integration.read(1, 'surf-b', token(reopened.integration, 'surf-b'))).toMatchObject({ ok: true });
  });

  it.each([false, true])('an empty startup auto slot restores an ordinary named layout without history (enabled=%s)', async (enabled) => {
    consent.enabled = enabled;
    const named = { name: 'layout-only', savedAt: 1, workspaces: windowOf('surf-saved').workspaces };
    persistence.saveNamedSession(named as any);
    const next = run();
    const { restoreAnswerFor } = await import('../../src/main/session-windows');
    const empty = { ...windowOf('unused'), workspaces: [] };
    next.windows.prime('win-start', empty);
    next.windows.markStartup('win-start');
    expect(restoreAnswerFor(empty, { startup: true })).toBeNull();
    expect(next.integration.loadStartupFallback(1, named.name)).toEqual(persistence.loadNamedSession(named.name));
    expect(next.integration.getBinding(1, 'surf-saved').ok).toBe(false);
    expect(next.windows.get('win-start')!.terminalHistory).toBeUndefined();
    expect(next.integration.loadStartupFallback(1, named.name)).toBeNull();
    expect(restoreAnswerFor(null, { startup: false })).toEqual({ fresh: true });
    expect(next.integration.loadStartupFallback(3, named.name)).toBeNull();
    next.windows.markStartup('win-second');
    const nonempty = windowOf('surf-existing');
    next.windows.prime('win-second', nonempty);
    expect(restoreAnswerFor(nonempty, { startup: true })).not.toBeNull();
    expect(next.integration.loadStartupFallback(2, named.name)).toBeNull();
  });

  it('an empty automatic slot cannot claim a valid handoff even for its exact backup and forged references', async () => {
    expect(upgrade(await original())).toBe(true);
    const next = await restart();
    const { restoreAnswerFor } = await import('../../src/main/session-windows');
    const empty = { ...windowOf('surf-a'), workspaces: [], terminalHistory: next.handoff.read(0)!.references };
    next.windows.prime('win-start', empty);
    next.integration.seedWindow(1);
    expect(restoreAnswerFor(empty, { startup: true })).toBeNull();
    expect(next.integration.loadStartupFallback(1, backupName)).toEqual(persistence.loadNamedSession(backupName));
    expect(next.integration.getBinding(1, 'surf-a').ok).toBe(false);
    expect(next.windows.get('win-start')!.workspaces).toEqual([]);
    expect(fs.existsSync(control())).toBe(false);
    next.integration.associate(1, 'surf-a');
    expect(await next.integration.read(1, 'surf-a', token(next.integration))).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('startup authorization comes from main window state, not a client flag or generic manual load', async () => {
    expect(upgrade(await original())).toBe(true);
    const next = await restart();
    const handlers = new Map<string, (...args: any[]) => any>();
    next.integration.registerIpc({ handle: (channel: string, callback: any) => handlers.set(channel, callback) } as any);
    const load = handlers.get(IPC_CHANNELS.SESSION_LOAD_STARTUP_FALLBACK)!;
    expect(await load({ sender: { id: 99 } }, backupName, { startup: true })).toEqual({ ok: false, error: 'unauthorized' });
    expect(await load({ sender: { id: 3 } }, backupName, { startup: true })).toBeNull();
    next.windows.markStartup('win-second');
    next.windows.prime('win-second', windowOf('existing-slot'));
    expect(await load({ sender: { id: 2 } }, backupName)).toBeNull();
    expect(persistence.loadNamedSession(backupName)).not.toBeNull();
    expect(next.integration.getBinding(1, 'surf-a').ok).toBe(false);
    expect(await load({ sender: { id: 1 } }, backupName)).not.toBeNull();
    expect(await load({ sender: { id: 1 } }, backupName)).toBeNull();
    const manual = persistence.loadNamedSession(backupName)!;
    next.integration.selectNamed(1, manual);
    expect(next.integration.getBinding(1, 'surf-a').ok).toBe(false);
    expect(fs.existsSync(control())).toBe(false);
    next.integration.associate(1, 'surf-a');
    expect(await next.integration.read(1, 'surf-a', token(next.integration))).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it.each(['changed', 'missing'] as const)('a %s backup cannot grant history even with the same name', async (mode) => {
    expect(upgrade(await original())).toBe(true);
    if (mode === 'missing') persistence.deleteNamedSession(backupName);
    else {
      const backup = persistence.loadNamedSession(backupName)!;
      backup.workspaces[0].title = 'manually replaced';
      persistence.saveNamedSession(backup);
    }
    const next = await restart();
    next.integration.loadStartupFallback(1, backupName);
    expect(next.integration.getBinding(1, 'surf-a').ok).toBe(false);
    expect(fs.existsSync(control())).toBe(false);
    expect(fs.readdirSync(historyDir())).toEqual([]);
  });

  it('a manual layout in an unrelated mid-run window cannot discard the startup window handoff', async () => {
    expect(upgrade(await original())).toBe(true);
    const next = await restart();
    next.integration.selectNamed(3, { name: 'other', savedAt: 1, workspaces: windowOf('new').workspaces } as any);
    expect(fs.existsSync(control())).toBe(true);
    expect(next.integration.loadStartupFallback(1, backupName)).not.toBeNull();
    expect(await next.integration.read(1, 'surf-a', token(next.integration))).toMatchObject({ ok: true });
  });

  it('an explicitly different startup layout invalidates the pending handoff', async () => {
    expect(upgrade(await original())).toBe(true);
    persistence.saveNamedSession({ name: 'different', savedAt: Date.now() + 1, workspaces: windowOf('new').workspaces } as any);
    const next = await restart();
    expect(next.integration.loadStartupFallback(1, 'different')).not.toBeNull();
    expect(fs.existsSync(control())).toBe(false);
    expect(next.integration.getBinding(1, 'surf-a').ok).toBe(false);
  });

  it('enumerates all automatic slots before orphan cleanup, keeping other windows and exact foreign filenames', async () => {
    await original();
    const refs = persistence.loadSession()!.windows.flatMap((window) => Object.values(window.terminalHistory!));
    const orphan = 'hist-' + randomUUID();
    const temp = '.' + orphan + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(recordPath(orphan), '{}');
    fs.writeFileSync(path.join(historyDir(), temp), 'abandoned');
    fs.writeFileSync(path.join(historyDir(), 'unrelated.json'), 'leave-alone');
    fs.writeFileSync(control() + '.tmp', 'abandoned');
    const next = await restart();
    expect(next.integration.getState().enabled).toBe(true);
    expect(fs.readdirSync(historyDir()).sort()).toEqual([...refs.map((ref) => ref.recordId + '.json'), 'unrelated.json'].sort());
    expect(fs.existsSync(control() + '.tmp')).toBe(false);
    next.windows.prime('win-start', persistence.loadSession()!.windows[0]);
    next.integration.seedWindow(1);
    expect(await next.integration.read(1, 'surf-a', token(next.integration))).toMatchObject({ ok: true });
  });

  it('disable clears every automatic reference and handoff, and late in-flight publication cannot revive either', async () => {
    const old = await original();
    expect(upgrade(old)).toBe(true);
    const next = await restart();
    next.integration.loadStartupFallback(1, backupName);
    const bound = token(next.integration);
    const rename = fs.promises.rename.bind(fs.promises);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (...args) => { entered(); await gate; return rename(...args); });
    const write = next.integration.checkpoint(1, 'surf-a', bound, 1, output);
    await started;
    const disabled = next.integration.setEnabled(false);
    expect(next.windows.toArray().every((window) => !window.terminalHistory)).toBe(true);
    expect(fs.existsSync(control())).toBe(false);
    expect(persistence.loadSession()!.windows.every((window) => !window.terminalHistory)).toBe(true);
    release();
    expect(await write).toMatchObject({ ok: false });
    expect(await disabled).toMatchObject({ ok: true });
    expect(fs.readdirSync(historyDir())).toEqual([]);
    expect(await next.integration.setEnabled(true)).toMatchObject({ ok: true });
    expect(await next.integration.read(1, 'surf-a', bound)).toMatchObject({ ok: false });
    expect(next.integration.getBinding(1, 'surf-a')).toMatchObject({ value: { binding: { generation: 1 } } });
  });

  it('locked old-generation control/records remain ineligible and exact cleanup retries next startup', async () => {
    const old = await original();
    expect(upgrade(old)).toBe(true);
    const next = await restart();
    const unlinkSync = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file) === control()) throw new Error('locked');
      return unlinkSync(file);
    });
    vi.spyOn(fs.promises, 'unlink').mockRejectedValue(new Error('locked'));
    expect(await next.integration.setEnabled(false)).toEqual({ ok: false, error: 'cleanup' });
    expect(consent).toEqual({ enabled: false, generation: 1 });
    expect(next.handoff.read(1)).toBeNull();
    expect(next.integration.getState().error).toBe('cleanup');
    vi.restoreAllMocks();
    await restart();
    expect(fs.existsSync(control())).toBe(false);
    expect(fs.readdirSync(historyDir())).toEqual([]);
  });
});
