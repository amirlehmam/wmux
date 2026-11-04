/**
 * Count live xterm terminals and WebGL renderers in a shipped build (#421).
 *
 * The memory reports on #421 come from heap snapshots of the installed app. Its
 * bundle is minified, so `Terminal`, `CoreTerminal` and `WebglRenderer` do not
 * appear in a snapshot under any name a reporter can search for, and the
 * question that settles a leak ("how many terminals are alive against how many
 * are open?") had to be answered through proxies like glyph atlases.
 *
 * Two answers, both cheap enough to stay on in release builds:
 *
 * - Every tracked object carries a marker whose class name survives
 *   minification: the classes are created as object-literal properties, and V8
 *   names a class after the property key, which the minifier never renames. In
 *   a heap snapshot, the "WmuxLiveTerminal" and "WmuxLiveWebglRenderer"
 *   constructor rows count exactly the objects still reachable.
 * - `window.__wmux_terminalCensus()` reports the same without a snapshot:
 *   how many were created, disposed and collected, and how many disposed ones
 *   are still reachable. After a forced GC (DevTools' bin icon), a non-zero
 *   `disposedButAlive` is a leak.
 */
const Markers = {
  WmuxLiveTerminal: class {},
  WmuxLiveWebglRenderer: class {},
};

type Kind = 'terminal' | 'webgl';

interface Counter {
  created: number;
  disposed: number;
  collected: number;
  /** Disposed objects, held weakly: whatever deref()s is still reachable. */
  disposedRefs: Set<WeakRef<object>>;
}

const counters: Record<Kind, Counter> = {
  terminal: { created: 0, disposed: 0, collected: 0, disposedRefs: new Set() },
  webgl: { created: 0, disposed: 0, collected: 0, disposedRefs: new Set() },
};

const registry = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry<Kind>((kind) => { counters[kind].collected++; })
  : undefined;

const MARKER = Symbol('wmux.census');

function track(kind: Kind, target: object): void {
  try {
    const Marker = kind === 'terminal' ? Markers.WmuxLiveTerminal : Markers.WmuxLiveWebglRenderer;
    Object.defineProperty(target, MARKER, { value: new Marker() });
  } catch { /* frozen or exotic object: count it anyway */ }
  counters[kind].created++;
  registry?.register(target, kind);
}

function markDisposed(kind: Kind, target: object): void {
  const c = counters[kind];
  c.disposed++;
  if (typeof WeakRef === 'function') c.disposedRefs.add(new WeakRef(target));
}

export const trackTerminal = (terminal: object): void => track('terminal', terminal);
export const markTerminalDisposed = (terminal: object): void => markDisposed('terminal', terminal);
export const trackWebglRenderer = (addon: object): void => track('webgl', addon);
export const markWebglRendererDisposed = (addon: object): void => markDisposed('webgl', addon);

export interface CensusEntry {
  created: number;
  disposed: number;
  collected: number;
  /** created − disposed: what wmux itself still uses. */
  open: number;
  /** Disposed but not yet collected. Only a leak if it survives a forced GC. */
  disposedButAlive: number;
}

function snapshot(c: Counter): CensusEntry {
  for (const ref of c.disposedRefs) {
    if (ref.deref() === undefined) c.disposedRefs.delete(ref);
  }
  return {
    created: c.created,
    disposed: c.disposed,
    collected: c.collected,
    open: c.created - c.disposed,
    disposedButAlive: c.disposedRefs.size,
  };
}

export function terminalCensus(): { terminals: CensusEntry; webglRenderers: CensusEntry } {
  return { terminals: snapshot(counters.terminal), webglRenderers: snapshot(counters.webgl) };
}

if (typeof window !== 'undefined') {
  (window as unknown as { __wmux_terminalCensus?: typeof terminalCensus }).__wmux_terminalCensus = terminalCensus;
}
