import type { Terminal } from '@xterm/xterm';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { TerminalHistoryBridge, TerminalHistoryState } from '../../shared/terminal-history';
import { captureTerminalHistory } from './terminal-history';

interface Candidate {
  revision: number;
  clean: number;
  cleanEpoch: number;
  attempted: number;
  attemptedEpoch: number;
  cancellation: AbortController;
  ready(): boolean;
}

interface CheckpointOptions {
  terminals(): ReadonlyMap<string, Terminal>;
  serializer(surface: string): SerializeAddon | undefined;
  bridge(): TerminalHistoryBridge | undefined;
  lines(): number;
  report(error: string): void;
}

/**
 * Mutation metadata is weak and instance-specific; enumeration and ownership stay
 * in the existing terminal/serializer registries. No output is retained here.
 */
export class TerminalHistoryCheckpoints {
  private readonly candidates = new WeakMap<Terminal, Candidate>();
  private state: TerminalHistoryState | undefined;
  private epoch = 0;
  private cancellation = new AbortController();
  private refreshState: (() => Promise<void>) | undefined;
  private stopSubscription: (() => void) | undefined;
  private completeDisabled: (() => void) | undefined;
  private active: Promise<boolean> | undefined;
  private activeDeadline: number | undefined;

  constructor(private readonly options: CheckpointOptions) {}

  /** Subscribe before the seed so a late invoke cannot undo a consent event. */
  start(): () => void {
    this.stopSubscription?.();
    const bridge = this.options.bridge();
    if (!bridge) return () => {};
    let events = 0;
    let stopped = false;
    let pending: Promise<void> | undefined;
    let finishSeed: (() => void) | undefined;
    const seed = (): Promise<void> => {
      if (stopped || this.state !== undefined) return Promise.resolve();
      if (pending) return pending;
      const version = events;
      let seeded!: () => void;
      const request = new Promise<void>((resolve) => { seeded = resolve; });
      const finish = () => {
        if (pending === request) pending = undefined;
        if (finishSeed === finish) finishSeed = undefined;
        seeded();
      };
      pending = request;
      finishSeed = finish;
      void (async () => {
        try {
          const result = await bridge.getState();
          if (!stopped && events === version) {
            if (result.ok) this.update(result.value);
            else this.options.report('state');
          }
        } catch {
          if (!stopped && events === version) this.options.report('state');
        } finally { finish(); }
      })();
      return request;
    };
    const off = bridge.onState((state) => {
      if (stopped) return;
      events++;
      this.update(state);
      finishSeed?.();
    });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      off();
      finishSeed?.();
      if (this.stopSubscription === stop) {
        this.stopSubscription = undefined;
        this.refreshState = undefined;
        this.update(undefined);
      }
    };
    this.stopSubscription = stop;
    this.refreshState = seed;
    void seed();
    return stop;
  }

  private update(state: TerminalHistoryState | undefined): void {
    const changed = this.state?.enabled !== state?.enabled || this.state?.generation !== state?.generation;
    this.state = state;
    if (changed) {
      this.epoch++;
      this.cancellation.abort();
      this.cancellation = new AbortController();
    }
    // Subscription teardown revokes capture authority, not a submitted write's
    // ACK obligation. Only confirmed disabled consent can waive that obligation.
    if (state?.enabled === false) this.completeDisabled?.();
  }

  /**
   * Observe the public mutation boundary, not onWriteParsed: empty write fences
   * fire that event too. Writeln has its own public implementation in xterm.
   * Keeping queued-write revisions lets a later write remain dirty even when
   * the checkpoint's callback runs in the same parser batch.
   */
  observe(terminal: Terminal, ready: () => boolean): () => void {
    const candidate: Candidate = { revision: 1, clean: 0, cleanEpoch: -1, attempted: 0,
      attemptedEpoch: -1, cancellation: new AbortController(), ready };
    this.candidates.set(terminal, candidate);
    const write = terminal.write;
    const writeln = terminal.writeln;
    const reset = terminal.reset;
    const clear = terminal.clear;
    const dirty = () => { candidate.revision++; };
    terminal.write = function (data, callback) {
      if (data.length) dirty();
      write.call(this, data, callback);
    };
    terminal.writeln = function (data, callback) {
      dirty();
      writeln.call(this, data, callback);
    };
    terminal.reset = function () { dirty(); reset.call(this); };
    terminal.clear = function () { dirty(); clear.call(this); };
    const resize = terminal.onResize(dirty);
    return () => {
      resize.dispose();
      candidate.cancellation.abort();
      // A stale cleanup cannot remove metadata belonging to another observer.
      if (this.candidates.get(terminal) !== candidate) return;
      this.candidates.delete(terminal);
      terminal.write = write;
      terminal.writeln = writeln;
      terminal.reset = reset;
      terminal.clear = clear;
    };
  }

  /** Destructive close precedes React cleanup and must cancel even a pending write fence. */
  close(surface: string): void {
    const terminal = this.options.terminals().get(surface);
    const candidate = terminal && this.candidates.get(terminal);
    if (!candidate) return;
    candidate.ready = () => false;
    candidate.cancellation.abort();
  }

  lineLimitChanged(terminal: Terminal): void {
    const candidate = this.candidates.get(terminal);
    if (candidate) candidate.revision++;
  }

  private dirty(candidate: Candidate): boolean {
    return candidate.cleanEpoch !== this.epoch || candidate.revision !== candidate.clean;
  }

  private hasDirty(unattemptedOnly = false): boolean {
    if (!this.state?.enabled) return false;
    for (const [, terminal] of this.options.terminals()) {
      const candidate = this.candidates.get(terminal);
      if (candidate?.ready() && this.dirty(candidate) && (!unattemptedOnly
        || candidate.attemptedEpoch !== this.epoch || candidate.attempted !== candidate.revision)) return true;
    }
    return false;
  }

  /** Periodic requests share one pass. A final request also drains later revisions. */
  request(deadline?: number): Promise<boolean> {
    if (this.active && deadline !== undefined) {
      this.activeDeadline = Math.min(this.activeDeadline ?? deadline, deadline);
    }
    const run = async () => {
      await this.refreshState?.();
      let success = true;
      // A final arrival joins periodic work, then makes one attempt at anything
      // it left dirty. Further passes require NEW mutations, not a failing disk
      // being retried in a tight loop until shutdown's deadline.
      if (deadline !== undefined && this.active) {
        this.activeDeadline = Math.min(this.activeDeadline ?? deadline, deadline);
        success = await this.active;
      }
      let first = true;
      do {
        if (this.state?.enabled === false) return true;
        if (!this.state) return false;
        if (deadline !== undefined && Date.now() >= deadline) return false;
        if (deadline !== undefined && !this.hasDirty(!first)) break;
        if (!this.active) {
          this.activeDeadline = deadline;
          const pass = this.capturePass();
          this.active = pass;
          void pass.finally(() => {
            if (this.active === pass) { this.active = undefined; this.activeDeadline = undefined; }
          });
        }
        success = await this.active && success;
        first = false;
      } while (deadline !== undefined && this.hasDirty(true));
      return this.state !== undefined && (!this.state.enabled || success);
    };
    if (deadline === undefined) return run();
    // One overall budget, including an already-running periodic pass or IPC.
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
      void run().then((result) => { clearTimeout(timer); resolve(result); }, () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private capturePass(): Promise<boolean> {
    const signal = this.cancellation.signal;
    return new Promise((resolve) => {
      const disabled = () => resolve(true);
      this.completeDisabled = disabled;
      void this.captureTerminals(signal).then(resolve, () => resolve(false)).finally(() => {
        if (this.completeDisabled === disabled) this.completeDisabled = undefined;
      });
    });
  }

  private async captureTerminals(signal: AbortSignal): Promise<boolean> {
    const bridge = this.options.bridge();
    if (this.state?.enabled === false) return true;
    if (!bridge || !this.state) return false;
    const epoch = this.epoch;
    const expired = () => this.activeDeadline !== undefined && Date.now() >= this.activeDeadline;
    let success = true;
    for (const [surface, terminal] of this.options.terminals()) {
      if (signal.aborted) return false;
      if (expired()) return false;
      const candidate = this.candidates.get(terminal);
      const serializer = this.options.serializer(surface);
      if (!candidate?.ready() || !serializer || !this.dirty(candidate)) continue;
      const current = () => !signal.aborted && epoch === this.epoch
        && this.candidates.get(terminal) === candidate && candidate.ready()
        && this.options.terminals().get(surface) === terminal;
      const lifetime = candidate.cancellation.signal;
      let submitted = false;
      const attempt = async (): Promise<boolean> => {
        candidate.attempted = candidate.revision;
        candidate.attemptedEpoch = epoch;
        const issued = await bridge.getBinding(surface);
        if (!current() || expired()) return false;
        if (!issued.ok || !issued.value.binding) return false;
        const binding = issued.value.binding;
        // Main's floor survives full renderer recovery and includes failed writes.
        // Local mutation counters are deliberately NOT persistent revisions.
        const floor = issued.value.revisionFloor;
        if (floor === undefined || !Number.isSafeInteger(floor) || floor < 0) return false;
        const revision = floor + 1;
        if (!Number.isSafeInteger(revision)) return false;
        const mutation = candidate.revision;
        candidate.attempted = mutation;
        const captured = await new Promise<ReturnType<typeof captureTerminalHistory> | null>((resolve) => {
          const finish = (value: ReturnType<typeof captureTerminalHistory> | null) => {
            signal.removeEventListener('abort', cancel);
            lifetime.removeEventListener('abort', cancel);
            resolve(value);
          };
          const cancel = () => finish(null);
          signal.addEventListener('abort', cancel, { once: true });
          lifetime.addEventListener('abort', cancel, { once: true });
          try {
            terminal.write('', () => {
              // Never let a serializer exception escape into xterm's write loop.
              try { finish(current() && !expired() ? captureTerminalHistory(terminal, serializer, this.options.lines()) : null); }
              catch { finish(null); }
            });
          } catch { finish(null); }
        });
        if (!current()) return false;
        if (!captured?.ok) { this.options.report('capture'); return false; }
        if (expired()) return false;
        submitted = true;
        const result = await bridge.checkpoint(surface, binding, revision, captured.record);
        if (!current()) return result.ok && result.value.revision === revision;
        if (result.ok && result.value.revision === revision) {
          candidate.clean = mutation;
          candidate.cleanEpoch = epoch;
          return true;
        }
        this.options.report(result.ok ? 'revision' : result.error);
        return false;
      };
      // Disposal need not deliver queued xterm callbacks. Only cancel preparation:
      // a submitted write still owes an ACK even if its emulator was replaced.
      let cancel!: () => void;
      const aborted = new Promise<boolean>((resolve) => { cancel = () => { if (!submitted) resolve(true); }; });
      lifetime.addEventListener('abort', cancel, { once: true });
      try {
        success = await Promise.race([attempt(), aborted]) && success;
      } catch { success = false; this.options.report('checkpoint'); }
      finally { lifetime.removeEventListener('abort', cancel); }
      // Let input/paint and other terminal callbacks run between large snapshots.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return success;
  }
}
