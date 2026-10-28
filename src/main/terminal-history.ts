import { randomUUID } from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';
import { validateTerminalHistory, type TerminalHistoryRecord, type TerminalHistoryReference,
  type TerminalHistoryBinding, type TerminalHistoryStoreError, type HistoryResult,
  type TerminalHistoryState } from '../shared/terminal-history';
export type { TerminalHistoryReference, TerminalHistoryBinding, TerminalHistoryStoreError,
  HistoryResult, TerminalHistoryState } from '../shared/terminal-history';

/**
 * Main alone issues identities and startup grants. Surface names are not restore
 * authority, and a child process exiting does not end a terminal's association.
 * Nothing touches settings or disk until a store is constructed/used.
 */
export const TERMINAL_HISTORY_SETTINGS_KEY = 'wmux-terminal-history';

interface Consent {
  enabled: boolean;
  generation: number;
}

interface Association {
  owner: number;
  surface: string;
  incarnation: string;
  binding: TerminalHistoryBinding | null;
  startup: boolean;
  committedRevision: number;
  revision: number;
  retryRevision: boolean;
  tail: Promise<void>;
}

interface StoreOptions {
  /** Tests supply an isolated directory and settings boundary, not a second storage implementation. */
  directory?: string;
  settings?: {
    load(): Record<string, unknown>;
    save(key: string, value: unknown): boolean;
  };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ID = new RegExp(`^hist-${UUID}$`);
const RECORD_FILE = new RegExp(`^(hist-${UUID})\\.json$`);
const TEMP_FILE = new RegExp(`^\\.hist-${UUID}\\.${UUID}\\.tmp$`);
const validGeneration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const failure = (error: TerminalHistoryStoreError): HistoryResult<never> => ({ ok: false, error });
const success = <T>(value: T): HistoryResult<T> => ({ ok: true, value });
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function isTerminalHistoryReference(value: unknown): value is TerminalHistoryReference {
  if (!value || typeof value !== 'object') return false;
  const ref = value as TerminalHistoryReference;
  return typeof ref.recordId === 'string' && ID.test(ref.recordId) && validGeneration(ref.generation);
}

function settingsBoundary(): NonNullable<StoreOptions['settings']> {
  // Like AwakeManager, importing the module must not resolve settings paths.
  const { loadSettings, saveSetting } = require('./settings-store') as typeof import('./settings-store');
  return { load: loadSettings, save: saveSetting };
}

export class TerminalHistoryStore {
  private readonly directory: string;
  private readonly settings: NonNullable<StoreOptions['settings']>;
  private enabled = false;
  private generation = 0;
  private error: TerminalHistoryState['error'] = null;
  private settingsFailed = false;
  private consentPending = 0;
  private consentTail: Promise<unknown> = Promise.resolve();
  private readonly associations = new Map<number, Map<string, Association>>();
  private readonly startup = new Map<number, Map<string, TerminalHistoryReference>>();
  private readonly revoked = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly retryDeletes = new Set<string>();

  constructor(options: StoreOptions = {}) {
    this.directory = options.directory ?? path.join(getAppDataDir(), 'terminal-history');
    this.settings = options.settings ?? settingsBoundary();
    const raw = this.settings.load()[TERMINAL_HISTORY_SETTINGS_KEY] as Partial<Consent> | undefined;
    if (raw && typeof raw.enabled === 'boolean' && validGeneration(raw.generation)) {
      this.enabled = raw.enabled;
      this.generation = raw.generation;
    }
  }

  getState(): TerminalHistoryState {
    return { enabled: this.canUse(), generation: this.generation, error: this.error };
  }

  /** A failed settings write locks this run off; a later toggle cannot disguise an undurable disable. */
  setEnabled(enabled: boolean): Promise<HistoryResult<TerminalHistoryState>> {
    this.consentPending++;
    if (!enabled) this.enabled = false;
    const operation = this.consentTail.then(async (): Promise<HistoryResult<TerminalHistoryState>> => {
      if (this.settingsFailed) return failure('settings');
      if (!enabled) {
        if (this.generation === Number.MAX_SAFE_INTEGER) return this.failSettings();
        this.generation++;
        this.startup.clear();
        for (const group of this.associations.values()) {
          for (const association of group.values()) {
            association.startup = false;
            association.committedRevision = 0;
          }
        }
      }
      let persisted = false;
      try {
        persisted = this.settings.save(TERMINAL_HISTORY_SETTINGS_KEY, { enabled, generation: this.generation });
      } catch { /* the persistence boundary may throw as well as return false */ }
      if (!persisted) return this.failSettings();
      this.enabled = enabled;
      // The preference is durable BEFORE waiting for started renames and purging.
      await this.drain();
      const cleaned = enabled ? await this.retryDeletion() : await this.cleanupFiles(new Set());
      this.error = cleaned ? null : 'cleanup';
      return cleaned ? success({ enabled: this.enabled, generation: this.generation, error: this.error }) : failure('cleanup');
    });
    const settled = operation.finally(() => { this.consentPending--; });
    this.consentTail = settled;
    return settled;
  }

  /** Only the automatic-session owner in main may call this, before creating the association. */
  authorizeStartup(owner: number, surface: string, reference: TerminalHistoryReference): boolean {
    if (!this.canUse() || !isTerminalHistoryReference(reference) || reference.generation !== this.generation
      || this.revoked.has(reference.recordId) || this.associations.get(owner)?.has(surface)) return false;
    for (const group of this.startup.values()) {
      if ([...group.values()].some((ref) => ref.recordId === reference.recordId)) return false;
    }
    for (const group of this.associations.values()) {
      if ([...group.values()].some((entry) => entry.binding?.recordId === reference.recordId)) return false;
    }
    const group = this.startup.get(owner) ?? new Map<string, TerminalHistoryReference>();
    group.set(surface, { recordId: reference.recordId, generation: reference.generation });
    this.startup.set(owner, group);
    return true;
  }

  /** Idempotent live remounts retain their incarnation, including after process exit. */
  associate(owner: number, surface: string): TerminalHistoryBinding | null {
    let group = this.associations.get(owner);
    if (!group) this.associations.set(owner, group = new Map());
    let association = group.get(surface);
    if (!association) {
      association = {
        owner, surface, incarnation: randomUUID(), binding: null,
        startup: false, committedRevision: 0, revision: 0, retryRevision: false, tail: Promise.resolve(),
      };
      group.set(surface, association);
    }
    return this.bindingFor(owner, surface);
  }

  bindingFor(owner: number, surface: string): TerminalHistoryBinding | null {
    const association = this.associations.get(owner)?.get(surface);
    if (!association || !this.canUse()) return null;
    if (!association.binding || association.binding.generation !== this.generation) {
      const reference = this.startup.get(owner)?.get(surface);
      this.startup.get(owner)?.delete(surface);
      association.binding = {
        recordId: reference?.recordId ?? `hist-${randomUUID()}`,
        generation: this.generation,
        incarnation: association.incarnation,
      };
      association.startup = reference !== undefined;
      association.revision = 0;
      association.retryRevision = false;
    }
    return { ...association.binding };
  }

  /** Disabled terminals still need lifetime-specific closure, without allocating an output identity. */
  incarnationFor(owner: number, surface: string): string | null {
    return this.associations.get(owner)?.get(surface)?.incarnation ?? null;
  }

  /** Store persistence is not session-link publication; the IPC caller must acknowledge both later. */
  referenceFor(owner: number, surface: string): TerminalHistoryReference | null {
    if (!this.canUse()) return null;
    const pending = this.startup.get(owner)?.get(surface);
    if (pending) return { ...pending };
    const association = this.associations.get(owner)?.get(surface);
    const binding = association?.binding;
    return binding && binding.generation === this.generation && (association.committedRevision > 0 || association.startup)
      ? { recordId: binding.recordId, generation: binding.generation } : null;
  }

  /** Link-publication retries need not rewrite a record that already committed. */
  hasCheckpoint(owner: number, surface: string, binding: TerminalHistoryBinding, revision: number): boolean {
    const association = this.authorized(owner, surface, binding);
    return !!association && association.committedRevision === revision && revision > 0;
  }

  checkpoint(owner: number, surface: string, binding: TerminalHistoryBinding, revision: number,
    record: unknown): Promise<HistoryResult<{ reference: TerminalHistoryReference; revision: number }>> {
    const association = this.authorized(owner, surface, binding);
    if (!association) return Promise.resolve(failure(this.canUse() ? 'unauthorized' : 'disabled'));
    if (!Number.isSafeInteger(revision) || revision < 1 || revision < association.revision
      || (revision === association.revision && !association.retryRevision)) return Promise.resolve(failure('stale'));
    const validated = validateTerminalHistory(record);
    if (!validated.ok) return Promise.resolve(failure('invalid-record'));
    // Freeze the validated payload before yielding; subsequent caller mutation cannot bypass validation.
    const payload = JSON.stringify({ generation: binding.generation, record: validated.record });
    association.revision = revision;
    association.retryRevision = false;
    return this.enqueue(association, async () => {
      if (!this.current(association, binding, revision)) return failure('stale');
      const target = this.recordPath(binding.recordId);
      const temp = path.join(this.directory, `.${binding.recordId}.${randomUUID()}.tmp`);
      try {
        await this.ensureDirectory(true);
        await this.regularTarget(target);
        await fs.writeFile(temp, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        if (!this.current(association, binding, revision)) return failure('stale');
        await this.regularTarget(target);
        if (!this.current(association, binding, revision)) return failure('stale');
        await fs.rename(temp, target);
        if (!this.current(association, binding, revision)) return failure('stale');
        association.committedRevision = revision;
        association.startup = false;
        return success({ reference: { recordId: binding.recordId, generation: binding.generation }, revision });
      } catch (error) {
        return failure(this.ioError(error));
      } finally {
        await this.removeFile(temp);
      }
    }).then((result) => {
      // Retrying unchanged dirty output after an I/O failure must not require new terminal output.
      if (association.revision === revision) association.retryRevision = !result.ok;
      return result;
    });
  }

  /** Fresh associations cannot read a coincidentally matching surface or record identity. */
  read(owner: number, surface: string, binding: TerminalHistoryBinding): Promise<HistoryResult<TerminalHistoryRecord>> {
    const association = this.authorized(owner, surface, binding);
    if (!association || !association.startup) return Promise.resolve(failure(this.canUse() ? 'unauthorized' : 'disabled'));
    return this.enqueue(association, async () => {
      if (!this.current(association, binding) || !association.startup) return failure('stale');
      try {
        await this.ensureDirectory(false);
        const target = this.recordPath(binding.recordId);
        const before = await this.regularTarget(target);
        if (!before) return failure('missing');
        const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let raw: string;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) return failure('invalid-target');
          raw = await handle.readFile('utf8');
        } finally { await handle.close(); }
        if (!this.current(association, binding)) return failure('stale');
        const envelope = JSON.parse(raw) as { generation?: unknown; record?: unknown } | null;
        if (!envelope || envelope.generation !== this.generation) return failure('stale');
        const validated = validateTerminalHistory(envelope.record);
        return validated.ok ? success(validated.record) : failure('invalid-record');
      } catch (error) {
        return failure(error instanceof SyntaxError ? 'invalid-record' : this.ioError(error));
      }
    });
  }

  /** Deliberate closure invalidates synchronously, then waits out even an already-started rename. */
  forget(owner: number, surface: string, incarnation: string): Promise<HistoryResult> {
    const association = this.associations.get(owner)?.get(surface);
    if (!association || association.incarnation !== incarnation) return Promise.resolve(failure('unauthorized'));
    const id = association.binding?.recordId ?? this.startup.get(owner)?.get(surface)?.recordId;
    this.associations.get(owner)!.delete(surface);
    this.startup.get(owner)?.delete(surface);
    if (id) this.revoked.add(id);
    return this.track(association.tail.then(async () => {
      const removed = !id || await this.removeFile(this.recordPath(id));
      if (!removed) this.error = 'cleanup';
      return removed ? success(undefined) : failure('cleanup');
    }));
  }

  /** An explicit named-layout load cannot consume automatic startup read grants. */
  discardStartup(owner: number): void {
    this.startup.delete(owner);
    for (const association of this.associations.get(owner)?.values() ?? []) {
      if (!association.startup) continue;
      association.startup = false;
      association.binding = null;
    }
  }

  /** Revoking a destroyed renderer is not a decision to erase its automatic-session history. */
  revokeOwner(owner: number): void {
    this.associations.delete(owner);
    this.startup.delete(owner);
  }

  /** Call only after main has enumerated ALL automatic window/handoff references. No age eviction. */
  cleanup(retained: readonly TerminalHistoryReference[]): Promise<HistoryResult> {
    this.consentPending++;
    const operation = this.consentTail.then(async (): Promise<HistoryResult> => {
      if (this.settingsFailed) return failure('settings');
      await this.drain();
      const keep = new Set(retained.filter((ref) => isTerminalHistoryReference(ref)
        && ref.generation === this.generation && !this.revoked.has(ref.recordId)).map((ref) => ref.recordId));
      for (const group of this.associations.values()) {
        for (const association of group.values()) {
          if (association.binding?.generation === this.generation) keep.add(association.binding.recordId);
        }
      }
      for (const group of this.startup.values()) for (const ref of group.values()) keep.add(ref.recordId);
      const cleaned = await this.cleanupFiles(this.enabled ? keep : new Set());
      this.error = cleaned ? this.error === 'cleanup' ? null : this.error : 'cleanup';
      return cleaned ? success(undefined) : failure('cleanup');
    });
    const settled = operation.finally(() => { this.consentPending--; });
    this.consentTail = settled;
    return settled;
  }

  private canUse(): boolean {
    return this.enabled && !this.settingsFailed && this.consentPending === 0;
  }

  private failSettings(): HistoryResult<never> {
    this.enabled = false;
    this.settingsFailed = true;
    this.error = 'settings';
    return failure('settings');
  }

  private authorized(owner: number, surface: string, binding: TerminalHistoryBinding): Association | null {
    if (!this.canUse() || !isTerminalHistoryReference(binding)) return null;
    const association = this.associations.get(owner)?.get(surface);
    const issued = association?.binding;
    return association && issued && issued.recordId === binding.recordId && issued.generation === binding.generation
      && issued.incarnation === binding.incarnation ? association : null;
  }

  private current(association: Association, binding: TerminalHistoryBinding, revision?: number): boolean {
    return this.authorized(association.owner, association.surface, binding) === association
      && binding.generation === this.generation && (revision === undefined || revision === association.revision);
  }

  private enqueue<T>(association: Association, operation: () => Promise<HistoryResult<T>>): Promise<HistoryResult<T>> {
    const result = this.track(association.tail.then(operation));
    // Retain completion only: a settled read result contains the terminal's full output.
    association.tail = result.then(() => undefined);
    return result;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.finally(() => { this.pending.delete(operation); });
    return operation;
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private recordPath(id: string): string {
    if (!ID.test(id)) throw new Error('invalid-target');
    return path.join(this.directory, `${id}.json`);
  }

  private async ensureDirectory(create: boolean): Promise<void> {
    if (create) await fs.mkdir(this.directory, { recursive: true });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid-target');
  }

  private async regularTarget(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid-target');
      return stat;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  private ioError(error: unknown): TerminalHistoryStoreError {
    return missing(error) ? 'missing' : error instanceof Error && error.message === 'invalid-target' ? 'invalid-target' : 'io';
  }

  private async removeFile(file: string): Promise<boolean> {
    try {
      await this.ensureDirectory(false);
      if (await this.regularTarget(file)) await fs.unlink(file);
      this.retryDeletes.delete(file);
      return true;
    } catch (error) {
      if (missing(error)) { this.retryDeletes.delete(file); return true; }
      this.retryDeletes.add(file);
      return false;
    }
  }

  private async retryDeletion(): Promise<boolean> {
    const results = await Promise.all([...this.retryDeletes].map((file) => this.removeFile(file)));
    return results.every(Boolean);
  }

  private async cleanupFiles(keep: Set<string>): Promise<boolean> {
    try {
      await this.ensureDirectory(false);
      const entries = await fs.readdir(this.directory);
      let cleaned = true;
      for (const entry of entries) {
        const record = RECORD_FILE.exec(entry);
        if (record ? keep.has(record[1]) : !TEMP_FILE.test(entry)) continue;
        const file = path.join(this.directory, entry);
        if (!await this.removeFile(file)) cleaned = false;
      }
      return cleaned;
    } catch (error) { return missing(error); }
  }
}
