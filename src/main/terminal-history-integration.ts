import { IPC_CHANNELS } from '../shared/types';
import type { HistoryResult, TerminalHistoryBinding, TerminalHistoryState,
  TerminalHistoryStoreError } from '../shared/terminal-history';
import type { TerminalHistoryStore } from './terminal-history';
import { saveSession, type SessionData } from './session-persistence';
import { sessionWindows, terminalSurfaceIds, withoutTerminalHistory,
  type SessionWindowRegistry, type SessionWindowState } from './session-windows';

interface HistoryIntegrationOptions {
  ownerWindow(owner: number): string | null;
  broadcast(state: TerminalHistoryState): void;
  store: TerminalHistoryStore;
  windows?: SessionWindowRegistry;
  persist?: (data: SessionData) => boolean;
}

const unauthorized = { ok: false, error: 'unauthorized' } as const;
const sameBinding = (left: TerminalHistoryBinding | null, right: TerminalHistoryBinding | null): boolean =>
  !!left && !!right && left.incarnation === right.incarnation
  && left.recordId === right.recordId && left.generation === right.generation;

/**
 * Couples durable records to the existing automatic-window merge. A committed
 * record alone is not checkpoint success: its reference must also reach disk.
 * This coordinator has no process-exit path, timer, renderer registry or payload cache.
 */
export class TerminalHistoryIntegration {
  private readonly store: TerminalHistoryStore;
  private readonly windows: SessionWindowRegistry;
  private readonly persist: (data: SessionData) => boolean;
  private readonly pendingStartup = new Map<number, Set<string>>();
  private error: TerminalHistoryStoreError | null = null;

  constructor(private readonly options: HistoryIntegrationOptions) {
    this.store = options.store;
    this.windows = options.windows ?? sessionWindows;
    this.persist = options.persist ?? saveSession;
  }

  getState(): TerminalHistoryState {
    const state = this.store.getState();
    return { ...state, error: state.error ?? this.error };
  }

  private report(error: TerminalHistoryStoreError | null): void {
    this.error = error;
    this.options.broadcast(this.getState());
  }

  async setEnabled(enabled: boolean): Promise<HistoryResult<TerminalHistoryState>> {
    const operation = this.store.setEnabled(enabled);
    this.options.broadcast(this.getState());
    const result = await operation;
    if (!enabled) this.pendingStartup.clear();
    this.report(result.ok ? null : result.error);
    return result.ok ? { ok: true, value: this.getState() } : result;
  }

  /** Called only by main's accepted ordinary/agent PTY ownership paths. */
  associate(owner: number, surface: string): void {
    if (this.options.ownerWindow(owner)) this.store.associate(owner, surface);
  }

  /** Main primes the slot and issues grants before the renderer can mount a terminal. */
  seedWindow(owner: number): void {
    const windowId = this.options.ownerWindow(owner);
    if (!windowId || !this.windows.isStartup(windowId)) return;
    const state = this.windows.get(windowId);
    if (!state) return;
    const pending = new Set<string>();
    for (const surface of terminalSurfaceIds(state)) {
      const reference = state.terminalHistory?.[surface];
      if (reference && this.store.authorizeStartup(owner, surface, reference)) {
        this.store.associate(owner, surface);
        pending.add(surface);
      }
    }
    if (pending.size) this.pendingStartup.set(owner, pending);
  }

  discardStartup(owner: number): void {
    this.pendingStartup.delete(owner);
    this.store.discardStartup(owner);
  }

  revokeOwner(owner: number): void {
    this.pendingStartup.delete(owner);
    this.store.revokeOwner(owner);
  }

  getBinding(owner: number, surface: string) {
    const incarnation = this.store.incarnationFor(owner, surface);
    return this.options.ownerWindow(owner) && incarnation
      ? { ok: true as const, value: { binding: this.store.bindingFor(owner, surface), incarnation } }
      : unauthorized;
  }

  async read(owner: number, surface: string, binding: TerminalHistoryBinding) {
    if (!this.options.ownerWindow(owner)) return unauthorized;
    const result = await this.store.read(owner, surface, binding);
    if (!result.ok && ['io', 'invalid-record', 'invalid-target'].includes(result.error)) this.report(result.error);
    return result;
  }

  /** Renderer fields are discarded; even pending references come only from main. */
  private stamp(owner: number, state: SessionWindowState): SessionWindowState {
    const safe = withoutTerminalHistory(state);
    const refs = [...terminalSurfaceIds(safe)].flatMap((surface) => {
      const ref = this.store.referenceFor(owner, surface);
      return ref ? [[surface, ref] as const] : [];
    });
    if (refs.length) safe.terminalHistory = Object.fromEntries(refs);
    return safe;
  }

  /** An early empty layout must not erase a startup slot still awaiting replay/capture. */
  saveWindow(owner: number, state: SessionWindowState): boolean {
    const windowId = this.options.ownerWindow(owner);
    if (!windowId) return false;
    const previous = this.windows.get(windowId);
    const members = terminalSurfaceIds(state);
    const pending = this.pendingStartup.get(owner);
    const source = previous && pending && [...pending].some((surface) => !members.has(surface)) ? previous : state;
    this.windows.update(windowId, this.stamp(owner, source));
    const saved = this.persist({ version: 1, windows: this.windows.toArray() });
    if (!saved) this.report('session');
    else if (this.error === 'session') this.report(null);
    return saved;
  }

  private publish(owner: number, requiredSurface?: string): boolean {
    const windowId = this.options.ownerWindow(owner);
    const previous = windowId ? this.windows.get(windowId) : null;
    if (!windowId) return false;
    if (!previous) return !requiredSurface;
    const next = this.stamp(owner, previous);
    if (requiredSurface && !next.terminalHistory?.[requiredSurface]) return false;
    const merged = this.windows.toArray().map((state) => state === previous ? next : state);
    if (!this.persist({ version: 1, windows: merged })) return false;
    this.windows.update(windowId, next);
    return true;
  }

  async checkpoint(owner: number, surface: string, binding: TerminalHistoryBinding, revision: number,
    record: unknown): Promise<HistoryResult<{ revision: number }>> {
    const issued = this.getBinding(owner, surface);
    if (!issued.ok || !sameBinding(issued.value.binding, binding)) return unauthorized;
    // A failed session rename is retriable without rewriting an already committed
    // record or requiring fresh terminal output to get a new buffer revision.
    if (!this.store.hasCheckpoint(owner, surface, binding, revision)) {
      const result = await this.store.checkpoint(owner, surface, binding, revision, record);
      if (!result.ok) {
        if (!['disabled', 'unauthorized', 'stale'].includes(result.error)) this.report(result.error);
        return result;
      }
    }
    const current = this.getBinding(owner, surface);
    if (!current.ok || !sameBinding(current.value.binding, binding)) return unauthorized;
    if (!this.publish(owner, surface)) {
      this.report('session');
      return { ok: false, error: 'session' };
    }
    this.pendingStartup.get(owner)?.delete(surface);
    this.report(null);
    return { ok: true, value: { revision } };
  }

  async forget(owner: number, surface: string, incarnation: string): Promise<HistoryResult> {
    const issued = this.getBinding(owner, surface);
    if (!issued.ok || issued.value.incarnation !== incarnation) return unauthorized;
    const operation = this.store.forget(owner, surface, incarnation);
    this.pendingStartup.get(owner)?.delete(surface);
    const result = await operation;
    // Revocation is already effective even when deleting the record fails.
    const published = this.publish(owner);
    if (!result.ok) { this.report(result.error); return result; }
    if (!published) { this.report('session'); return { ok: false, error: 'session' }; }
    this.report(null);
    return result;
  }

  /** Every entry point, including state/consent, is restricted to a desktop renderer. */
  registerIpc(ipc: Pick<Electron.IpcMain, 'handle'>): void {
    const handle = (channel: string, callback: (owner: number, ...args: any[]) => unknown): void => {
      ipc.handle(channel, (event, ...args: any[]) => this.options.ownerWindow(event.sender.id)
        ? callback(event.sender.id, ...args) : unauthorized);
    };
    handle(IPC_CHANNELS.TERMINAL_HISTORY_GET_STATE, () => ({ ok: true, value: this.getState() }));
    handle(IPC_CHANNELS.TERMINAL_HISTORY_SET_ENABLED, (_owner, enabled) =>
      typeof enabled === 'boolean' ? this.setEnabled(enabled) : unauthorized);
    handle(IPC_CHANNELS.TERMINAL_HISTORY_BINDING, (owner, surface) => this.getBinding(owner, surface));
    handle(IPC_CHANNELS.TERMINAL_HISTORY_READ, (owner, surface, binding) => this.read(owner, surface, binding));
    handle(IPC_CHANNELS.TERMINAL_HISTORY_CHECKPOINT, (owner, surface, binding, revision, record) =>
      this.checkpoint(owner, surface, binding, revision, record));
    handle(IPC_CHANNELS.TERMINAL_HISTORY_FORGET, (owner, surface, incarnation) => this.forget(owner, surface, incarnation));
  }
}
