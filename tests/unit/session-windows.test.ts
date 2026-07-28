import { describe, it, expect } from 'vitest';
import {
  SessionWindowRegistry,
  toRestorePayload,
  type SessionWindowState,
} from '../../src/main/session-windows';

function win(id: string, workspaceTitles: string[]): SessionWindowState {
  return {
    bounds: { x: 0, y: 0, width: 1400, height: 900 },
    sidebarWidth: 200,
    activeWorkspaceId: `ws-${id}-0`,
    workspaces: workspaceTitles.map((title, i) => ({
      id: `ws-${id}-${i}`,
      title,
      pinned: false,
      shell: 'pwsh',
      splitTree: { type: 'leaf', paneId: `pane-${id}-${i}`, surfaces: [], activeSurfaceIndex: 0 },
    })),
  } as SessionWindowState;
}

describe('session window registry (issue #118)', () => {
  // The bug: every window answers the same `session:request` broadcast with a
  // one-entry `windows` array, and the payload was written straight over the
  // file — so with two windows open, whoever replied last erased the other's
  // workspaces every 30 seconds and again on quit.
  it('keeps every window when they all report, instead of last-writer-wins', () => {
    const reg = new SessionWindowRegistry();
    reg.update('win-a', win('a', ['A1', 'A2']));
    reg.update('win-b', win('b', ['B1']));

    const saved = reg.toArray();
    expect(saved).toHaveLength(2);
    expect(saved[0].workspaces.map((w) => w.title)).toEqual(['A1', 'A2']);
    expect(saved[1].workspaces.map((w) => w.title)).toEqual(['B1']);
  });

  it('replaces a window\'s own slot on its next report', () => {
    const reg = new SessionWindowRegistry();
    reg.update('win-a', win('a', ['old']));
    reg.update('win-a', win('a', ['new']));
    expect(reg.toArray()).toHaveLength(1);
    expect(reg.toArray()[0].workspaces[0].title).toBe('new');
  });

  it('serializes in creation order regardless of who answers first', () => {
    const reg = new SessionWindowRegistry();
    reg.prime('win-a', win('a', ['A']));
    reg.prime('win-b', win('b', ['B']));
    // Window B happens to answer the broadcast first.
    reg.update('win-b', win('b', ['B*']));
    reg.update('win-a', win('a', ['A*']));
    expect(reg.toArray().map((w) => w.workspaces[0].title)).toEqual(['A*', 'B*']);
  });

  it('primes restored windows so one that never reports still persists', () => {
    const reg = new SessionWindowRegistry();
    reg.prime('win-a', win('a', ['A']));
    reg.prime('win-b', win('b', ['B']));
    // Only A reports before the save.
    reg.update('win-a', win('a', ['A edited']));
    expect(reg.toArray().map((w) => w.workspaces[0].title)).toEqual(['A edited', 'B']);
  });

  it('forgets a window the user closed', () => {
    const reg = new SessionWindowRegistry();
    reg.update('win-a', win('a', ['A']));
    reg.update('win-b', win('b', ['B']));
    reg.forget('win-b');
    expect(reg.toArray().map((w) => w.workspaces[0].title)).toEqual(['A']);
  });

  it('prunes windows that are gone when asked to retain the live set', () => {
    const reg = new SessionWindowRegistry();
    reg.update('win-a', win('a', ['A']));
    reg.update('win-b', win('b', ['B']));
    reg.retainOnly(['win-a']);
    expect(reg.size).toBe(1);
    expect(reg.get('win-b')).toBeNull();
  });
});

describe('toRestorePayload', () => {
  it('hands a window back its own workspaces with the active one selected', () => {
    const state = win('a', ['first', 'second']);
    state.activeWorkspaceId = 'ws-a-1';
    expect(toRestorePayload(state)).toEqual({
      workspaces: state.workspaces,
      sidebarWidth: 200,
      activeIndex: 1,
    });
  });

  it('falls back to the first workspace when the active id is stale', () => {
    const state = win('a', ['only']);
    state.activeWorkspaceId = 'ws-does-not-exist';
    expect(toRestorePayload(state)?.activeIndex).toBe(0);
  });

  // A window opened during this run has no slot. Returning null makes the
  // renderer create a fresh workspace; returning windows[0] (the old behaviour)
  // made every new window a clone of the first window's tabs.
  it('returns null for a window with no saved state', () => {
    expect(toRestorePayload(null)).toBeNull();
    expect(toRestorePayload(win('a', []))).toBeNull();
  });
});
