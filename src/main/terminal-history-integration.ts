import { IPC_CHANNELS, type SavedSession } from '../shared/types';
import type { HistoryResult, TerminalHistoryBinding, TerminalHistoryState,
  TerminalHistoryStoreError } from '../shared/terminal-history';
import type { TerminalHistoryStore } from './terminal-history';
import { saveSession, loadNamedSession, sessionBackupFingerprint, type AutoSessionBackup, type SessionData } from './session-persistence';
import type { TerminalHistoryHandoff } from './terminal-history-handoff';
import { sessionWindows, terminalSurfaceIds, withoutTerminalHistory, toRestorePayload,
  type SessionWindowRegistry, type SessionWindowState } from './session-windows';

interface HistoryIntegrationOptions {
  ownerWindow(owner: number): string | null;
  broadcast(state: TerminalHistoryState): void;
  store: TerminalHistoryStore;
  windows?: SessionWindowRegistry;
  persist?: (data: SessionData) => boolean;
  handoff?: TerminalHistoryHandoff;
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
  private readonly runtimeSurfaces = new Map<number, Set<string>>();
  private readonly fallbackClaims = new Set<string>();
  private handoffOwner: number | undefined;

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
    // An unrelated successful checkpoint cannot disguise incomplete deletion.
    if (error !== null || this.error !== 'cleanup') this.error = error;
    this.options.broadcast(this.getState());
  }

  async setEnabled(enabled: boolean): Promise<HistoryResult<TerminalHistoryState>> {
    const operation = this.store.setEnabled(enabled);
    let cleared = true;
    if (!enabled) {
      this.pendingStartup.clear();
      this.handoffOwner = undefined;
      cleared = this.options.handoff?.invalidate() ?? true;
      for (const [id, state] of this.windows.entries()) this.windows.update(id, withoutTerminalHistory(state));
      if (!this.persist({ version: 1, windows: this.windows.toArray() })) cleared = false;
    }
    this.options.broadcast(this.getState());
    const result = await operation;
    if (result.ok && cleared) this.error = null;
    this.report(!result.ok ? result.error : cleared ? null : 'cleanup');
    return !result.ok ? result : cleared ? { ok: true, value: this.getState() } : { ok: false, error: 'cleanup' };
  }

  /** Called only by main's accepted ordinary/agent PTY ownership paths. */
  associate(owner: number, surface: string): void {
    if (this.options.ownerWindow(owner)) {
      this.store.associate(owner, surface);
      const surfaces = this.runtimeSurfaces.get(owner) ?? new Set<string>();
      surfaces.add(surface);
      this.runtimeSurfaces.set(owner, surfaces);
    }
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
    // A crash may have committed the replacement auto-session but not removed
    // its handoff. The next successful save can finish that same transaction.
    const handoff = this.options.handoff?.read(this.store.getState().generation);
    if (handoff && Object.entries(handoff.references).every(([surface, ref]) =>
      state.terminalHistory?.[surface]?.recordId === ref.recordId
      && state.terminalHistory[surface].generation === ref.generation)) this.handoffOwner = owner;
  }

  discardStartup(owner: number): void {
    this.pendingStartup.delete(owner);
    this.store.discardStartup(owner, this.runtimeSurfaces.get(owner));
  }

  /** A manual layout preserves real open buffers, never a saved-ID disk grant. */
  selectNamed(owner: number, session: SavedSession): void {
    const windowId = this.options.ownerWindow(owner);
    if (!windowId) return;
    const incoming = terminalSurfaceIds({ workspaces: session.workspaces } as SessionWindowState);
    const live = this.runtimeSurfaces.get(owner) ?? new Set<string>();
    for (const surface of this.store.surfacesFor(owner)) {
      if (incoming.has(surface) && live.has(surface)) continue;
      this.closeSurface(owner, surface);
    }
    this.discardStartup(owner);
    if (this.windows.isStartup(windowId)) {
      this.handoffOwner = undefined;
      if (this.options.handoff && !this.options.handoff.invalidate()) this.report('cleanup');
    }
  }

  /** Ordered accepted close: use main's current lifetime, never fetch it after closing. */
  closeSurface(owner: number, surface: string): boolean {
    if (!this.options.ownerWindow(owner)) return false;
    const incarnation = this.store.incarnationFor(owner, surface);
    if (!incarnation) return false;
    void this.forget(owner, surface, incarnation);
    this.runtimeSurfaces.get(owner)?.delete(surface);
    return true;
  }

  /** Final-window close and app quit preserve the last automatic session. */
  closeWindow(windowId: string, owner: number, quitting: boolean, remainingWindows: number): void {
    if (quitting || remainingWindows === 0) return;
    const refs = Object.values(this.windows.get(windowId)?.terminalHistory ?? {});
    this.pendingStartup.delete(owner);
    this.runtimeSurfaces.delete(owner);
    const deletion = this.store.discardOwner(owner, refs);
    if (this.options.handoff && !this.options.handoff.forget(new Set(refs.map((ref) => ref.recordId)), this.store.getState().generation)) this.report('cleanup');
    this.windows.forget(windowId);
    if (!this.persist({ version: 1, windows: this.windows.toArray() })) this.report('session');
    void deletion.then((result) => { if (!result.ok) this.report(result.error); });
  }

  prepareUpgrade(backup: AutoSessionBackup | null, session: SessionData): boolean {
    const state = this.store.getState();
    if (!state.enabled) return true;
    const refs = session.windows.flatMap((window) => Object.values(window.terminalHistory ?? {}))
      .filter((ref) => ref.generation === state.generation);
    if (!refs.length) return true;
    const prepared = !!backup && !!this.options.handoff?.prepare(backup, session, state.generation);
    if (!prepared) this.report('session');
    return prepared;
  }

  hasUpgrade(session: SessionData | null): boolean {
    const state = this.store.getState();
    const handoff = state.enabled ? this.options.handoff?.read(state.generation) : null;
    return !!handoff && (!session || handoff.sourceFingerprint === sessionBackupFingerprint(session));
  }

  /** Enumerate every startup slot before creating any renderer or granting replay. */
  async cleanupStartup(session: SessionData | null): Promise<void> {
    const state = this.store.getState();
    const handoff = state.enabled ? this.options.handoff?.read(state.generation) : null;
    const refs = (session?.windows ?? []).flatMap((window) => Object.values(window.terminalHistory ?? {}));
    const cleaned = this.options.handoff?.cleanup(state.enabled ? state.generation : -1) ?? true;
    const result = await this.store.cleanup([...refs, ...Object.values(handoff?.references ?? {})]);
    if (!cleaned || !result.ok) this.report(!result.ok ? result.error : 'cleanup');
    else if (this.error === 'cleanup') { this.error = null; this.report(null); }
  }

  /** Startup-only IPC, not a caller-supplied flag on generic named loads. */
  loadStartupFallback(owner: number, name: string): SavedSession | null {
    const id = this.options.ownerWindow(owner);
    const slot = id ? this.windows.get(id) : null;
    if (!id || !this.windows.isStartup(id) || toRestorePayload(slot) || this.fallbackClaims.has(id)) return null;
    const session = loadNamedSession(name);
    if (!session) return null;
    this.fallbackClaims.add(id);
    const state = this.store.getState();
    const handoff = state.enabled ? this.options.handoff?.read(state.generation) : null;
    if (slot || !handoff || name !== handoff.backup.name || sessionBackupFingerprint(session) !== handoff.backup.fingerprint) {
      this.selectNamed(owner, session);
      return session;
    }
    this.windows.prime(id, {
      bounds: { x: 0, y: 0, width: 0, height: 0 }, sidebarWidth: session.sidebarWidth ?? 260,
      activeWorkspaceId: null, workspaces: session.workspaces as SessionWindowState['workspaces'],
      terminalHistory: handoff.references,
    });
    this.handoffOwner = owner;
    this.seedWindow(owner);
    return session;
  }

  private retireHandoff(owner: number, state: SessionWindowState): void {
    if (this.handoffOwner !== owner) return;
    const handoff = this.options.handoff?.read(this.store.getState().generation);
    if (!handoff || !Object.entries(handoff.references).every(([surface, ref]) =>
      state.terminalHistory?.[surface]?.recordId === ref.recordId
      && state.terminalHistory[surface].generation === ref.generation)) return;
    if (this.options.handoff?.invalidate()) this.handoffOwner = undefined;
    else this.report('cleanup');
  }

  revokeOwner(owner: number): void {
    this.pendingStartup.delete(owner);
    this.runtimeSurfaces.delete(owner);
    this.store.revokeOwner(owner);
  }

  getBinding(owner: number, surface: string) {
    const incarnation = this.store.incarnationFor(owner, surface);
    return this.options.ownerWindow(owner) && incarnation
      ? { ok: true as const, value: { binding: this.store.bindingFor(owner, surface), incarnation,
        revisionFloor: this.store.revisionFloor(owner, surface) } }
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
    else {
      if (this.error === 'session') this.report(null);
      this.retireHandoff(owner, this.windows.get(windowId)!);
    }
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
    this.retireHandoff(owner, next);
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
    const id = issued.value.binding?.recordId;
    const handoffRemoved = !id || !this.options.handoff
      || this.options.handoff.forget(new Set([id]), this.store.getState().generation);
    this.pendingStartup.get(owner)?.delete(surface);
    // Publish removal before yielding: an old close must not remove or stamp a
    // later terminal's association when the same saved ID is reopened.
    const published = this.publish(owner);
    const result = await operation;
    if (!result.ok) { this.report(result.error); return result; }
    if (!handoffRemoved) { this.report('cleanup'); return { ok: false, error: 'cleanup' }; }
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
    handle(IPC_CHANNELS.SESSION_LOAD_STARTUP_FALLBACK, (owner, name) =>
      typeof name === 'string' ? this.loadStartupFallback(owner, name) : null);
    handle(IPC_CHANNELS.TERMINAL_HISTORY_GET_STATE, () => ({ ok: true, value: this.getState() }));
    handle(IPC_CHANNELS.TERMINAL_HISTORY_SET_ENABLED, (_owner, enabled) =>
      typeof enabled === 'boolean' ? this.setEnabled(enabled) : unauthorized);
    handle(IPC_CHANNELS.TERMINAL_HISTORY_BINDING, (owner, surface) => this.getBinding(owner, surface));
    handle(IPC_CHANNELS.TERMINAL_HISTORY_READ, (owner, surface, binding) => this.read(owner, surface, binding));
    handle(IPC_CHANNELS.TERMINAL_HISTORY_CHECKPOINT, (owner, surface, binding, revision, record) =>
      this.checkpoint(owner, surface, binding, revision, record));
  }
}
