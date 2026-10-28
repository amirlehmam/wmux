import type { KeepAwakeMode, KeepAwakeState } from '../shared/types';

/**
 * Keep Windows awake while coding agents work (issue #363), with one
 * `powerSaveBlocker` and three modes: `smart` (the default — held while any
 * pane's DECLARED state is `working`, so only agents that report through
 * hooks/`report-agent` count), `always` and `off`.
 *
 * MAIN owns the choice: the mode and the display flag are persisted in wmux's
 * own settings.json (`KEEP_AWAKE_SETTINGS_KEY`) and read when the manager is
 * built, so the mode picked in one window is the mode every window shows and
 * the one the next launch starts in. The titlebar menu and Settings read it
 * through `awake.getState`/`onStateChange` (useKeepAwake.ts), never a renderer
 * copy: that would be a second answer to "what mode are we in", and the first
 * one that disagreed would be the one the user had actually chosen.
 */

export type BlockerType = KeepAwakeState['blockerType'];

export interface PowerBlockerDriver {
  /** The blocker id, or null when no blocker could be taken. */
  start(type: BlockerType): number | null;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export interface KeepAwakePrefs {
  mode: KeepAwakeMode;
  preventDisplaySleep: boolean;
}

/** settings.json key main persists the choice under. */
export const KEEP_AWAKE_SETTINGS_KEY = 'wmux-keep-awake';

export const DEFAULT_KEEP_AWAKE_PREFS: KeepAwakePrefs = { mode: 'smart', preventDisplaySleep: false };

export function isKeepAwakeMode(value: unknown): value is KeepAwakeMode {
  return value === 'smart' || value === 'always' || value === 'off';
}

/** Reads the persisted prefs out of a settings map, field by field, defaulting what is missing or malformed. */
export function parseKeepAwakePrefs(raw: unknown): KeepAwakePrefs {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    mode: isKeepAwakeMode(obj.mode) ? obj.mode : DEFAULT_KEEP_AWAKE_PREFS.mode,
    preventDisplaySleep:
      typeof obj.preventDisplaySleep === 'boolean' ? obj.preventDisplaySleep : DEFAULT_KEEP_AWAKE_PREFS.preventDisplaySleep,
  };
}

function electronBlocker(): Electron.PowerSaveBlocker | null {
  try {
    const electron = require('electron') as typeof import('electron');
    return electron.powerSaveBlocker ?? null;
  } catch {
    return null;
  }
}

const defaultDriver: PowerBlockerDriver = {
  start: (type) => {
    try {
      const blocker = electronBlocker();
      return blocker ? blocker.start(type) : null;
    } catch {
      return null;
    }
  },
  stop: (id) => {
    try {
      electronBlocker()?.stop(id);
    } catch {
      /* already gone */
    }
  },
  isStarted: (id) => {
    try {
      return electronBlocker()?.isStarted(id) ?? false;
    } catch {
      return false;
    }
  },
};

function sameState(a: KeepAwakeState | null, b: KeepAwakeState): boolean {
  return (
    a !== null &&
    a.mode === b.mode &&
    a.isActive === b.isActive &&
    a.preventDisplaySleep === b.preventDisplaySleep &&
    a.blockerType === b.blockerType
  );
}

export class AwakeManager {
  private readonly driver: PowerBlockerDriver;
  private mode: KeepAwakeMode;
  private preventDisplaySleep: boolean;
  private activeBlockerId: number | null = null;
  private workingAgentsCount = 0;
  private disposed = false;
  private lastSent: KeepAwakeState | null = null;
  private readonly listeners = new Set<(state: KeepAwakeState) => void>();
  private readonly persist: ((prefs: KeepAwakePrefs) => void) | undefined;

  constructor(
    driver?: PowerBlockerDriver,
    initialMode: KeepAwakeMode = DEFAULT_KEEP_AWAKE_PREFS.mode,
    initialPreventDisplay = DEFAULT_KEEP_AWAKE_PREFS.preventDisplaySleep,
    persist?: (prefs: KeepAwakePrefs) => void,
  ) {
    this.driver = driver ?? defaultDriver;
    this.mode = initialMode;
    this.preventDisplaySleep = initialPreventDisplay;
    this.persist = persist;
    // 'always' must hold from the first moment, not from the first agent report.
    this.evaluate();
  }

  public getState(): KeepAwakeState {
    return {
      mode: this.mode,
      isActive: this.activeBlockerId !== null,
      preventDisplaySleep: this.preventDisplaySleep,
      blockerType: this.targetBlockerType(),
    };
  }

  public setMode(mode: KeepAwakeMode): void {
    if (this.disposed || this.mode === mode) return;
    this.mode = mode;
    this.savePrefs();
    this.evaluate();
  }

  public setPreventDisplaySleep(prevent: boolean): void {
    if (this.disposed || this.preventDisplaySleep === prevent) return;
    this.preventDisplaySleep = prevent;
    this.savePrefs();
    // A held blocker is of the old type: swap it, and say so once.
    if (this.activeBlockerId !== null) {
      this.release();
      this.acquire();
    }
    this.notify();
  }

  public onWorkingAgentsCountChanged(workingCount: number): void {
    this.workingAgentsCount = Math.max(0, workingCount);
    this.evaluate();
  }

  public onStateChange(listener: (state: KeepAwakeState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.listeners.clear();
  }

  private targetBlockerType(): BlockerType {
    return this.preventDisplaySleep ? 'prevent-display-sleep' : 'prevent-app-suspension';
  }

  private savePrefs(): void {
    try {
      this.persist?.({ mode: this.mode, preventDisplaySleep: this.preventDisplaySleep });
    } catch {
      /* a failed write must not cost the in-memory choice */
    }
  }

  private evaluate(): void {
    if (this.disposed) return;
    const shouldBeActive = this.mode === 'always' || (this.mode === 'smart' && this.workingAgentsCount > 0);
    if (shouldBeActive && this.activeBlockerId === null) {
      this.acquire();
    } else if (!shouldBeActive && this.activeBlockerId !== null) {
      this.release();
    }
    this.notify();
  }

  private acquire(): void {
    this.activeBlockerId = this.driver.start(this.targetBlockerType());
  }

  private release(): void {
    if (this.activeBlockerId === null) return;
    this.driver.stop(this.activeBlockerId);
    this.activeBlockerId = null;
  }

  /** Tells listeners only what changed: agent reports arrive on every tool call (#141). */
  private notify(): void {
    const state = this.getState();
    if (sameState(this.lastSent, state)) return;
    this.lastSent = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        /* listener error shouldn't crash caller */
      }
    }
  }
}

/** The fields of an agent snapshot the keep-awake count reads. */
export interface WorkingStateLike {
  state: string;
  updatedAt: number;
}

/** How many panes are working right now. Callers pass snapshots resolved at `now`. */
export function countWorkingAgents(states: readonly WorkingStateLike[]): number {
  let count = 0;
  for (const s of states) if (s.state === 'working') count++;
  return count;
}

/**
 * Delay until the first `working` claim outlives its trust window and turns
 * `unknown`, or null when nothing is working. That downgrade is LAZY in
 * agent-state.ts — computed on read, never broadcast — so without a re-check
 * here a crashed agent would hold the blocker until the next unrelated report.
 */
export function nextWorkingExpiryDelay(
  states: readonly WorkingStateLike[],
  now: number,
  trustMs: number,
  slackMs = 1000,
): number | null {
  let oldest: number | null = null;
  for (const s of states) {
    if (s.state === 'working' && (oldest === null || s.updatedAt < oldest)) oldest = s.updatedAt;
  }
  if (oldest === null) return null;
  return Math.max(slackMs, oldest + trustMs + slackMs - now);
}

export interface AgentStateSource {
  list(): readonly WorkingStateLike[];
  subscribe(listener: () => void): () => void;
  trustMs: number;
}

/**
 * Feeds the working count into the manager on every agent broadcast, and while
 * anything is working, re-counts once the oldest claim expires: at
 * `WORKING_TRUST_MS` (agent-state.ts; index.ts passes it as `trustMs`), because
 * that downgrade is never broadcast (see nextWorkingExpiryDelay).
 */
export function bindAwakeToAgentStates(
  manager: AwakeManager,
  source: AgentStateSource,
  now: () => number = Date.now,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const recount = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const states = source.list();
    manager.onWorkingAgentsCountChanged(countWorkingAgents(states));
    const delay = nextWorkingExpiryDelay(states, now(), source.trustMs);
    if (delay !== null) {
      timer = setTimeout(recount, delay);
      timer.unref?.();
    }
  };

  const unsubscribe = source.subscribe(recount);
  recount();
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

let instance: AwakeManager | null = null;

function settingsBackedManager(): AwakeManager {
  // Lazy: settings-store resolves %APPDATA% at import, which tests of the pure
  // parts above have no reason to pay for.
  const { loadSettings, saveSetting } = require('./settings-store') as typeof import('./settings-store');
  const prefs = parseKeepAwakePrefs(loadSettings()[KEEP_AWAKE_SETTINGS_KEY]);
  return new AwakeManager(undefined, prefs.mode, prefs.preventDisplaySleep, (next) =>
    saveSetting(KEEP_AWAKE_SETTINGS_KEY, next),
  );
}

export function getAwakeManager(): AwakeManager {
  instance ??= settingsBackedManager();
  return instance;
}
