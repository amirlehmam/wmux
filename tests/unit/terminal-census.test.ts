import { describe, expect, it } from 'vitest';
import {
  terminalCensus, trackTerminal, markTerminalDisposed, trackWebglRenderer, markWebglRendererDisposed,
} from '../../src/renderer/utils/terminal-census';

describe('terminal census (#421)', () => {
  it('counts created, disposed and still-open terminals and renderers', () => {
    const before = terminalCensus();
    const a = {}; const b = {}; const r = {};
    trackTerminal(a); trackTerminal(b); trackWebglRenderer(r);
    markTerminalDisposed(a); markWebglRendererDisposed(r);

    const after = terminalCensus();
    expect(after.terminals.created - before.terminals.created).toBe(2);
    expect(after.terminals.disposed - before.terminals.disposed).toBe(1);
    expect(after.terminals.open - before.terminals.open).toBe(1);
    // `a` is still referenced here, so it is disposed but alive.
    expect(after.terminals.disposedButAlive).toBeGreaterThanOrEqual(1);
    expect(after.webglRenderers.open - before.webglRenderers.open).toBe(0);
  });

  it('tags tracked objects with markers named for a heap snapshot', () => {
    const term = {}; const renderer = {};
    trackTerminal(term); trackWebglRenderer(renderer);
    const marker = (o: object) => Object.getOwnPropertySymbols(o).map((s) => (o as Record<symbol, object>)[s])[0];
    expect(marker(term).constructor.name).toBe('WmuxLiveTerminal');
    expect(marker(renderer).constructor.name).toBe('WmuxLiveWebglRenderer');
    // The marker must not show up when a terminal is enumerated or serialised.
    expect(Object.keys(term)).toEqual([]);
  });
});
