import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A browser surface whose guest webContents died without its React component
 * unmounting left a PERMANENTLY stale CDP target (issue #155).
 *
 * detach() had exactly one production trigger — BrowserPane's effect cleanup —
 * so a renderer that crashed while the pane stayed mounted was never pruned.
 * The dead entry still matched by surface id, so `wcIdForSurface` returned a
 * non-null id and v2-browser's self-healing branch (guarded on `wcId === null`)
 * never ran: the caller stayed bound to a corpse. Meanwhile the one place that
 * DID notice the death — getDebugger — threw `browser_not_open` without
 * dropping anything, so every later command repeated the same detection and the
 * same throw, forever, while surface.list kept advertising a live browser.
 *
 * These tests pin the durable half of the fix: a dead target is dropped the
 * moment it is found dead, which turns a permanent wedge into one failed
 * command — including for deaths that arrive by routes nobody listens for.
 */

const fakeContents = new Map<number, any>();

function makeWc(id: number) {
  let destroyed = false;
  let attached = false;
  const wc = {
    isDestroyed: () => destroyed,
    once: () => {},
    removeListener: () => {},
    /** Kill the guest renderer the way a crash does: no unmount, no detach. */
    kill: () => { destroyed = true; },
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      sendCommand: async () => ({ nodes: [] }),
    },
  };
  fakeContents.set(id, wc);
  return wc;
}

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => fakeContents.get(id) },
}));

import { CDPBridge } from '../../src/main/cdp-bridge';

describe('a browser whose renderer dies (issue #155)', () => {
  beforeEach(() => fakeContents.clear());

  it('stops matching by surface id, so the caller binding can heal', async () => {
    const bridge = new CDPBridge();
    const wc = makeWc(1);
    bridge.attach(1, 'surf-browser', 'ws-1');
    expect(bridge.wcIdForSurface('surf-browser')).toBe(1);

    wc.kill();

    // The whole point: NON-null here is what kept resolveBrowserWcId from
    // clearing the binding and adopting a working browser.
    expect(bridge.wcIdForSurface('surf-browser')).toBeNull();
    expect(bridge.wcIdForWorkspace('ws-1')).toBeNull();
    expect(bridge.isAttached).toBe(false);
  });

  it('drops the target on the first failed command, not on every one forever', async () => {
    const bridge = new CDPBridge();
    const wc = makeWc(1);
    bridge.attach(1, 'surf-browser', 'ws-1');
    wc.kill();

    await expect(bridge.snapshot(1)).rejects.toThrow('browser_not_open');

    expect(bridge.hasTarget(1)).toBe(false);
    expect(bridge.attachedWebContentsId).toBeNull();
  });

  it('leaves a second, live browser untouched when one dies', async () => {
    // The reason detach is per-wcId in the first place (issues #27, #62): a
    // sweep that took out healthy panes would be a worse bug than the one fixed.
    const bridge = new CDPBridge();
    const dying = makeWc(1);
    makeWc(2);
    bridge.attach(1, 'surf-a', 'ws-1');
    bridge.attach(2, 'surf-b', 'ws-2');

    dying.kill();
    expect(bridge.wcIdForSurface('surf-a')).toBeNull();

    expect(bridge.wcIdForSurface('surf-b')).toBe(2);
    expect(bridge.hasTarget(2)).toBe(true);
    await expect(bridge.snapshot(2)).resolves.toBeDefined();
  });

  it('falls back to a live browser once the dead default is gone', async () => {
    const bridge = new CDPBridge();
    makeWc(1);
    const dying = makeWc(2);
    bridge.attach(1, 'surf-a', 'ws-1');
    bridge.attach(2, 'surf-b', 'ws-2');  // most recent → the default target

    dying.kill();

    // No explicit wcId: the default must not be a corpse.
    await expect(bridge.snapshot()).resolves.toBeDefined();
    expect(bridge.attachedWebContentsId).toBe(1);
  });

  it('re-attaches a live guest whose debugger came loose instead of pruning it', async () => {
    // DevTools taking the session and giving it back is recoverable. Pruning
    // here would replace a working pane with a new one.
    const bridge = new CDPBridge();
    const wc = makeWc(1);
    bridge.attach(1, 'surf-browser', 'ws-1');
    wc.debugger.detach();

    await expect(bridge.snapshot(1)).resolves.toBeDefined();

    expect(wc.debugger.isAttached()).toBe(true);
    expect(bridge.hasTarget(1)).toBe(true);
  });
});
