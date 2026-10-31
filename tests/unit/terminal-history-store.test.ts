import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TerminalHistoryStore, TERMINAL_HISTORY_SETTINGS_KEY,
  type TerminalHistoryBinding, type TerminalHistoryReference,
} from '../../src/main/terminal-history';
import type { TerminalHistoryRecord } from '../../src/shared/terminal-history';

function record(text = 'saved output'): TerminalHistoryRecord {
  return { version: 1, capturedAt: 100, cols: 80, rows: 24, normal: { startLine: 0, lineCount: 24, ansi: text } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const diskError = (code: string) => Object.assign(new Error(code), { code });

describe('main-owned terminal history', () => {
  let root: string;
  let directory: string;
  let persisted: Record<string, unknown>;
  let settings: { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  let store: TerminalHistoryStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-history-'));
    directory = path.join(root, 'terminal-history');
    persisted = {};
    settings = {
      load: vi.fn(() => persisted),
      save: vi.fn((key: string, value: unknown) => { persisted[key] = value; return true; }),
    };
    store = new TerminalHistoryStore({ directory, settings });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function enabledBinding(surface = 'surf-a', owner = 1): Promise<TerminalHistoryBinding> {
    expect((await store.setEnabled(true)).ok).toBe(true);
    return store.associate(owner, surface)!;
  }

  const target = (binding: TerminalHistoryReference) => path.join(directory, `${binding.recordId}.json`);
  const stored = async (binding: TerminalHistoryReference) => JSON.parse(await fs.readFile(target(binding), 'utf8'));

  it('has no filesystem or settings-write side effects while disabled, even with live ownership metadata', async () => {
    expect(store.getState()).toEqual({ enabled: false, generation: 0, error: null });
    expect(store.associate(1, 'surf-a')).toBeNull();
    expect(store.bindingFor(1, 'surf-a')).toBeNull();
    const forged = { recordId: `hist-${randomUUID()}`, generation: 0, incarnation: randomUUID() };
    expect(await store.checkpoint(1, 'surf-a', forged, 1, record())).toEqual({ ok: false, error: 'disabled' });
    expect(await store.read(1, 'surf-a', forged)).toEqual({ ok: false, error: 'disabled' });
    expect(settings.save).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('replaces atomically, retains ownership across live remount/process exit, and publishes only committed references', async () => {
    const binding = await enabledBinding();
    expect(store.referenceFor(1, 'surf-a')).toBeNull();
    expect(store.associate(1, 'surf-a')).toEqual(binding);
    expect(await store.checkpoint(1, 'surf-a', binding, 1, record('old'))).toEqual({
      ok: true, value: { reference: { recordId: binding.recordId, generation: 0 }, revision: 1 },
    });
    // No process-liveness dependency or exit operation exists in the store.
    expect(await store.checkpoint(1, 'surf-a', binding, 2, record('new'))).toMatchObject({ ok: true });
    expect((await stored(binding)).record.normal.ansi).toBe('new');
    expect(await fs.readdir(directory)).toEqual([`${binding.recordId}.json`]);
    expect(store.referenceFor(1, 'surf-a')).toEqual({ recordId: binding.recordId, generation: 0 });
    expect(await store.read(1, 'surf-a', binding)).toEqual({ ok: false, error: 'unauthorized' });
  });

  it.each(['writeFile', 'rename'] as const)('preserves the last good record after %s failure, then permits a newer retry', async (method) => {
    const binding = await enabledBinding();
    await store.checkpoint(1, 'surf-a', binding, 1, record('last good'));
    const original = await fs.readFile(target(binding), 'utf8');
    const spy = vi.spyOn(fs, method).mockRejectedValueOnce(diskError(method === 'writeFile' ? 'ENOSPC' : 'EPERM'));
    expect(await store.checkpoint(1, 'surf-a', binding, 2, record('lost'))).toEqual({ ok: false, error: 'io' });
    expect(await fs.readFile(target(binding), 'utf8')).toBe(original);
    expect(await fs.readdir(directory)).toEqual([`${binding.recordId}.json`]);
    spy.mockRestore();
    expect((await store.checkpoint(1, 'surf-a', binding, 2, record('retry'))).ok).toBe(true);
    expect((await stored(binding)).record.normal.ansi).toBe('retry');
  });

  it('supersedes queued work and rejects lower/duplicate revisions before they can overwrite newer output', async () => {
    const binding = await enabledBinding();
    const started = deferred();
    const release = deferred();
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      started.resolve();
      await release.promise;
      return write(...args);
    });
    const old = store.checkpoint(1, 'surf-a', binding, 1, record('old'));
    await started.promise;
    const latest = store.checkpoint(1, 'surf-a', binding, 3, record('new'));
    expect(await store.checkpoint(1, 'surf-a', binding, 2, record('late old'))).toEqual({ ok: false, error: 'stale' });
    release.resolve();
    expect(await old).toEqual({ ok: false, error: 'stale' });
    expect((await latest).ok).toBe(true);
    expect((await stored(binding)).record.normal.ansi).toBe('new');
    expect(await store.checkpoint(1, 'surf-a', binding, 3, record())).toEqual({ ok: false, error: 'stale' });
  });

  it('serializes behind an already-started older rename instead of letting its completion overwrite a newer record', async () => {
    const binding = await enabledBinding();
    const started = deferred();
    const release = deferred();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      started.resolve();
      await release.promise;
      return rename(...args);
    });
    const old = store.checkpoint(1, 'surf-a', binding, 1, record('old'));
    await started.promise;
    const latest = store.checkpoint(1, 'surf-a', binding, 2, record('new'));
    release.resolve();
    expect(await old).toEqual({ ok: false, error: 'stale' });
    expect((await latest).ok).toBe(true);
    expect((await stored(binding)).record.normal.ansi).toBe('new');
  });

  it('persists disable/generation before purging and waits for already-started renames and queued writes', async () => {
    const binding = await enabledBinding();
    const started = deferred();
    const release = deferred();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      started.resolve();
      await release.promise;
      return rename(...args);
    });
    const write = store.checkpoint(1, 'surf-a', binding, 1, record());
    await started.promise;
    const queued = store.checkpoint(1, 'surf-a', binding, 2, record('queued'));
    let finished = false;
    const disabled = store.setEnabled(false).then((result) => { finished = true; return result; });
    expect(store.getState().enabled).toBe(false);
    await Promise.resolve();
    expect(persisted[TERMINAL_HISTORY_SETTINGS_KEY]).toEqual({ enabled: false, generation: 1 });
    expect(finished).toBe(false);
    release.resolve();
    expect((await disabled).ok).toBe(true);
    expect(await write).toEqual({ ok: false, error: 'stale' });
    expect(await queued).toEqual({ ok: false, error: 'stale' });
    expect(await fs.readdir(directory)).toEqual([]);
    expect(store.getState()).toEqual({ enabled: false, generation: 1, error: null });
  });

  it('waits out a started rename on deliberate close; same-surface reopen gets unrelated authority', async () => {
    const binding = await enabledBinding();
    const started = deferred();
    const release = deferred();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      started.resolve();
      await release.promise;
      return rename(...args);
    });
    const write = store.checkpoint(1, 'surf-a', binding, 1, record('closed'));
    await started.promise;
    const closed = store.forget(1, 'surf-a', binding.incarnation);
    const fresh = store.associate(1, 'surf-a')!;
    expect(fresh.recordId).not.toBe(binding.recordId);
    expect(fresh.incarnation).not.toBe(binding.incarnation);
    expect(await store.checkpoint(1, 'surf-a', binding, 2, record())).toEqual({ ok: false, error: 'unauthorized' });
    expect((await store.checkpoint(1, 'surf-a', fresh, 1, record('fresh'))).ok).toBe(true);
    release.resolve();
    expect((await closed).ok).toBe(true);
    expect(await write).toEqual({ ok: false, error: 'stale' });
    expect(await fs.readdir(directory)).toEqual([`${fresh.recordId}.json`]);
    expect((await stored(fresh)).record.normal.ansi).toBe('fresh');
  });

  it('keeps failed deletion visible and retryable, while durable generation prevents revival after re-enable or restart', async () => {
    const binding = await enabledBinding();
    await store.checkpoint(1, 'surf-a', binding, 1, record('stale secret'));
    const unlink = fs.unlink.bind(fs);
    const fault = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (file === target(binding)) throw diskError('EACCES');
      return unlink(file);
    });
    expect(await store.setEnabled(false)).toEqual({ ok: false, error: 'cleanup' });
    expect(store.getState()).toEqual({ enabled: false, generation: 1, error: 'cleanup' });
    expect(await store.setEnabled(true)).toEqual({ ok: false, error: 'cleanup' });
    expect(store.getState().enabled).toBe(true);
    expect(store.authorizeStartup(2, 'surf-old', binding)).toBe(false);
    const restarted = new TerminalHistoryStore({ directory, settings });
    expect(restarted.authorizeStartup(2, 'surf-old', binding)).toBe(false);
    const fresh = store.bindingFor(1, 'surf-a')!;
    expect(fresh.generation).toBe(1);
    expect(fresh.recordId).not.toBe(binding.recordId);
    expect((await store.checkpoint(1, 'surf-a', fresh, 1, record('live buffer'))).ok).toBe(true);
    fault.mockRestore();
    expect((await store.cleanup([])).ok).toBe(true);
    expect(await fs.readdir(directory)).toEqual([`${fresh.recordId}.json`]);
  });

  it('never reuses deliberately forgotten authority when deletion fails', async () => {
    const binding = await enabledBinding();
    await store.checkpoint(1, 'surf-a', binding, 1, record());
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(diskError('EACCES'));
    expect(await store.forget(1, 'surf-a', binding.incarnation)).toEqual({ ok: false, error: 'cleanup' });
    expect(store.authorizeStartup(1, 'surf-a', binding)).toBe(false);
    const fresh = store.associate(1, 'surf-a')!;
    expect(fresh.recordId).not.toBe(binding.recordId);
    expect((await store.cleanup([])).ok).toBe(true);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each([false, true])('fails closed on settings failure (throw=%s) without claiming success or purging the previous file', async (throws) => {
    const binding = await enabledBinding();
    await store.checkpoint(1, 'surf-a', binding, 1, record());
    settings.save.mockImplementation(() => { if (throws) throw diskError('ENOSPC'); return false; });
    expect(await store.setEnabled(false)).toEqual({ ok: false, error: 'settings' });
    expect(store.getState()).toEqual({ enabled: false, generation: 1, error: 'settings' });
    expect(await fs.readFile(target(binding), 'utf8')).toContain('saved output');
    expect(await store.checkpoint(1, 'surf-a', binding, 2, record())).toEqual({ ok: false, error: 'disabled' });
    expect(await store.read(1, 'surf-a', binding)).toEqual({ ok: false, error: 'disabled' });
    expect(await store.setEnabled(true)).toEqual({ ok: false, error: 'settings' });
    expect(await store.cleanup([])).toEqual({ ok: false, error: 'settings' });
  });

  it('does not enable on a failed first consent write', async () => {
    settings.save.mockReturnValue(false);
    expect(await store.setEnabled(true)).toEqual({ ok: false, error: 'settings' });
    expect(store.associate(1, 'surf-a')).toBeNull();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('requires a main startup grant, correct owner, incarnation, generation and strict generated ID', async () => {
    const binding = await enabledBinding();
    await store.checkpoint(1, 'surf-a', binding, 1, record('restore me'));
    const restarted = new TerminalHistoryStore({ directory, settings });
    expect(restarted.authorizeStartup(2, 'surf-a', { ...binding, recordId: '../settings' })).toBe(false);
    expect(restarted.authorizeStartup(2, 'surf-a', { ...binding, generation: 99 })).toBe(false);
    expect(restarted.authorizeStartup(2, 'surf-a', binding)).toBe(true);
    expect(restarted.referenceFor(2, 'surf-a')).toEqual({ recordId: binding.recordId, generation: 0 });
    expect(restarted.authorizeStartup(3, 'surf-a', binding)).toBe(false);
    const restored = restarted.associate(2, 'surf-a')!;
    expect(restored.recordId).toBe(binding.recordId);
    expect(restored.incarnation).not.toBe(binding.incarnation);
    expect(await restarted.read(3, 'surf-a', restored)).toEqual({ ok: false, error: 'unauthorized' });
    expect(await restarted.read(2, 'surf-a', binding)).toEqual({ ok: false, error: 'unauthorized' });
    expect(await restarted.read(2, 'surf-a', restored)).toEqual({ ok: true, value: record('restore me') });
    expect(await restarted.checkpoint(3, 'surf-a', restored, 1, record())).toEqual({ ok: false, error: 'unauthorized' });
    expect(await restarted.checkpoint(2, 'surf-a', { ...restored, recordId: '../../settings' }, 1, record())).toEqual({ ok: false, error: 'unauthorized' });
    restarted.revokeOwner(2);
    expect(await restarted.read(2, 'surf-a', restored)).toEqual({ ok: false, error: 'unauthorized' });
    expect((await stored(binding)).record.normal.ansi).toBe('restore me');
  });

  it('returns restored output to the caller without retaining it in the association sequencer after disable', async () => {
    const binding = await enabledBinding();
    const snapshot = record('x'.repeat(100_000));
    expect((await store.checkpoint(1, 'surf-a', binding, 1, snapshot)).ok).toBe(true);
    const reader = new TerminalHistoryStore({ directory, settings });
    expect(reader.authorizeStartup(2, 'surf-a', binding)).toBe(true);
    const restored = reader.associate(2, 'surf-a')!;
    expect(await reader.read(2, 'surf-a', restored)).toEqual({ ok: true, value: snapshot });
    const association = (reader as unknown as {
      associations: Map<number, Map<string, { tail: Promise<unknown> }>>;
    }).associations.get(2)!.get('surf-a')!;
    expect(await association.tail).toBeUndefined();
    expect((await reader.setEnabled(false)).ok).toBe(true);
    expect(await association.tail).toBeUndefined();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('revalidates read records and generations rather than trusting saved JSON', async () => {
    const binding = await enabledBinding();
    const reader = new TerminalHistoryStore({ directory, settings });
    expect(reader.authorizeStartup(2, 'surf-a', binding)).toBe(true);
    const restored = reader.associate(2, 'surf-a')!;
    expect(await reader.read(2, 'surf-a', restored)).toEqual({ ok: false, error: 'missing' });
    expect(await store.checkpoint(1, 'surf-a', binding, 1, record('\x1b]52;c;bad\x07'))).toEqual({ ok: false, error: 'invalid-record' });
    expect(await fs.readdir(root)).toEqual([]);
    await fs.mkdir(directory);
    await fs.writeFile(target(binding), '{');
    expect(await reader.read(2, 'surf-a', restored)).toEqual({ ok: false, error: 'invalid-record' });
    await fs.writeFile(target(binding), JSON.stringify({ generation: 99, record: record() }));
    expect(await reader.read(2, 'surf-a', restored)).toEqual({ ok: false, error: 'stale' });
    await fs.writeFile(target(binding), JSON.stringify({ generation: 0, record: record('\x1b[?1049h') }));
    expect(await reader.read(2, 'surf-a', restored)).toEqual({ ok: false, error: 'invalid-record' });
  });

  it('rejects directory targets on read, write and deletion, leaving their contents untouched', async () => {
    const binding = await enabledBinding();
    await fs.mkdir(target(binding), { recursive: true });
    await fs.writeFile(path.join(target(binding), 'unrelated'), 'keep');
    expect(await store.checkpoint(1, 'surf-a', binding, 1, record())).toEqual({ ok: false, error: 'invalid-target' });
    const reader = new TerminalHistoryStore({ directory, settings });
    reader.authorizeStartup(2, 'surf-a', binding);
    expect(await reader.read(2, 'surf-a', reader.associate(2, 'surf-a')!)).toEqual({ ok: false, error: 'invalid-target' });
    expect(await store.forget(1, 'surf-a', binding.incarnation)).toEqual({ ok: false, error: 'cleanup' });
    expect(await fs.readFile(path.join(target(binding), 'unrelated'), 'utf8')).toBe('keep');
  });

  it('rejects a symlink/junction history directory instead of reading, writing or deleting through it', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, directory, 'junction');
    const binding = await enabledBinding();
    expect(await store.checkpoint(1, 'surf-a', binding, 1, record())).toEqual({ ok: false, error: 'invalid-target' });
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await store.cleanup([])).toEqual({ ok: false, error: 'cleanup' });
  });

  it('cleans only exact owned orphan/temp filenames, preserving all retained windows and active bindings', async () => {
    const binding = await enabledBinding();
    await store.checkpoint(1, 'surf-a', binding, 1, record());
    const second = { recordId: `hist-${randomUUID()}`, generation: 0 };
    const orphan = { recordId: `hist-${randomUUID()}`, generation: 0 };
    await fs.writeFile(target(second), JSON.stringify({ generation: 0, record: record('window two') }));
    await fs.writeFile(target(orphan), 'orphan');
    const temp = `.hist-${randomUUID()}.${randomUUID()}.tmp`;
    await fs.writeFile(path.join(directory, temp), 'interrupted');
    await fs.writeFile(path.join(directory, 'notes.json'), 'unrelated');
    await fs.writeFile(path.join(directory, 'hist-not-an-id.json'), 'unrelated');
    expect((await store.cleanup([second])).ok).toBe(true);
    expect((await fs.readdir(directory)).sort()).toEqual([
      `${binding.recordId}.json`, `${second.recordId}.json`, 'hist-not-an-id.json', 'notes.json',
    ].sort());
    expect((await stored(second)).record.normal.ansi).toBe('window two');
  });

  it('permits forgetting disabled metadata before same-surface reopen', async () => {
    const binding = await enabledBinding();
    await store.checkpoint(1, 'surf-a', binding, 1, record());
    expect((await store.setEnabled(false)).ok).toBe(true);
    expect((await store.forget(1, 'surf-a', binding.incarnation)).ok).toBe(true);
    expect(store.associate(1, 'surf-a')).toBeNull();
    expect((await store.setEnabled(true)).ok).toBe(true);
    expect(store.bindingFor(1, 'surf-a')!.incarnation).not.toBe(binding.incarnation);
  });

  it('revokes a read already waiting on file I/O before disable completes', async () => {
    const binding = await enabledBinding();
    await store.checkpoint(1, 'surf-a', binding, 1, record());
    const reader = new TerminalHistoryStore({ directory, settings });
    reader.authorizeStartup(2, 'surf-a', binding);
    const restored = reader.associate(2, 'surf-a')!;
    const started = deferred();
    const release = deferred();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      started.resolve();
      await release.promise;
      return handle;
    });
    const reading = reader.read(2, 'surf-a', restored);
    await started.promise;
    const disabled = reader.setEnabled(false);
    expect(reader.getState().enabled).toBe(false);
    release.resolve();
    expect(await reading).toEqual({ ok: false, error: 'stale' });
    expect((await disabled).ok).toBe(true);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('removes never-enabled association metadata using its lifetime token without creating output', async () => {
    store.associate(1, 'surf-a');
    const incarnation = store.incarnationFor(1, 'surf-a')!;
    expect(await store.forget(2, 'surf-a', incarnation)).toEqual({ ok: false, error: 'unauthorized' });
    expect(await store.forget(1, 'surf-a', 'stale-token')).toEqual({ ok: false, error: 'unauthorized' });
    expect((await store.forget(1, 'surf-a', incarnation)).ok).toBe(true);
    store.associate(1, 'surf-a');
    expect(store.incarnationFor(1, 'surf-a')).not.toBe(incarnation);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('freezes validated input before yielding and applies no additional line/byte/age retention policy', async () => {
    const binding = await enabledBinding();
    const snapshot = record('x'.repeat(100_000));
    snapshot.normal.lineCount = 1_000_000;
    snapshot.capturedAt = 0;
    const writing = store.checkpoint(1, 'surf-a', binding, 1, snapshot);
    snapshot.normal.ansi = '\x1b]52;c;mutated\x07';
    expect((await writing).ok).toBe(true);
    const saved = (await stored(binding)).record;
    expect(saved.normal.ansi).toBe('x'.repeat(100_000));
    expect(saved.normal.lineCount).toBe(1_000_000);
    expect(saved.capturedAt).toBe(0);
  });

  it('serializes rapid toggles so an enable cannot bypass pending disable cleanup', async () => {
    const binding = await enabledBinding();
    await store.checkpoint(1, 'surf-a', binding, 1, record());
    const off = store.setEnabled(false);
    const on = store.setEnabled(true);
    expect(store.bindingFor(1, 'surf-a')).toBeNull();
    expect((await off).ok).toBe(true);
    expect((await on).ok).toBe(true);
    expect(persisted[TERMINAL_HISTORY_SETTINGS_KEY]).toEqual({ enabled: true, generation: 1 });
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
