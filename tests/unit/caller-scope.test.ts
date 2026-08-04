import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

// v2-bridge pulls in electron at module load; the resolution rules under test
// are dependency-injected and never touch it.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));

import { resolveCallerTarget } from '../../src/main/v2-bridge';

interface FakeWindow {
  id: number;
  /** surfaceId → the workspace that holds it, in THIS window. */
  surfaces: Record<string, string>;
  throws?: boolean;
}

const win = (id: number, surfaces: Record<string, string>, throws = false): FakeWindow =>
  ({ id, surfaces, throws });

function harness(live: FakeWindow[], focused: FakeWindow | null, cache = new Map<string, number>()) {
  const probed: number[] = [];
  return {
    probed,
    cache,
    deps: {
      live,
      focused: () => focused,
      keyOf: (w: FakeWindow) => w.id,
      locate: async (w: FakeWindow, surfaceId: string) => {
        probed.push(w.id);
        if (w.throws) throw new Error('window went away');
        const workspaceId = w.surfaces[surfaceId];
        return workspaceId ? { workspaceId } : null;
      },
      cache,
    },
  };
}

const CALLER = 'surf-caller';

describe('caller resolution (issue #143)', () => {
  // The reported symptom: `wmux tree` from a pane reported a workspace the
  // caller was not in. Knowing the WINDOW was never enough — a window holds
  // many workspaces and every unscoped method fell back to the active one.
  it('answers about the workspace holding the caller, not the window\'s active one', async () => {
    const only = win(1, { [CALLER]: 'ws-background' });
    const h = harness([only], only);

    const target = await resolveCallerTarget(CALLER, h.deps);

    expect(target?.win).toBe(only);
    expect(target?.workspaceId).toBe('ws-background');
  });

  it('picks the window that holds the caller even when another one is focused', async () => {
    const other = win(1, {});
    const home = win(2, { [CALLER]: 'ws-home' });
    const h = harness([other, home], other);

    const target = await resolveCallerTarget(CALLER, h.deps);

    expect(target?.win).toBe(home);
    expect(target?.workspaceId).toBe('ws-home');
  });

  // "Fall back to the focused window only when the id is unknown" — a stale
  // WMUX_SURFACE_ID (closed pane, exported env) must not strand the caller.
  it('falls back to the focused window, with no workspace opinion, for an unknown surface', async () => {
    const a = win(1, {});
    const b = win(2, {});
    const h = harness([a, b], b);

    const target = await resolveCallerTarget('surf-gone', h.deps);

    expect(target?.win).toBe(b);
    expect(target?.workspaceId).toBeUndefined();
  });

  it('leaves resolution to the focused window when no caller id is supplied', async () => {
    const a = win(1, { [CALLER]: 'ws-a' });
    const b = win(2, {});
    const h = harness([a, b], b);

    const target = await resolveCallerTarget(undefined, h.deps);

    expect(target?.win).toBe(b);
    expect(target?.workspaceId).toBeUndefined();
    expect(h.probed).toEqual([]); // no id to probe with
  });

  it('probes the cached window first', async () => {
    const a = win(1, {});
    const home = win(2, { [CALLER]: 'ws-home' });
    const h = harness([a, home], a, new Map([[CALLER, 2]]));

    await resolveCallerTarget(CALLER, h.deps);

    expect(h.probed).toEqual([2]);
  });

  // The cache used to be authoritative, so one outdated hit pinned a caller to
  // the wrong window for the rest of the session — the "byte-stable across
  // focus changes" wrong answer in the report. It is now only a probe order.
  it('heals a stale cache entry instead of pinning the caller to the wrong window', async () => {
    const home = win(1, { [CALLER]: 'ws-home' });
    const stale = win(2, {});
    const h = harness([home, stale], stale, new Map([[CALLER, 2]]));

    const target = await resolveCallerTarget(CALLER, h.deps);

    expect(h.probed).toEqual([2, 1]); // cached first, then the rest
    expect(target?.win).toBe(home);
    expect(h.cache.get(CALLER)).toBe(1);
  });

  it('forgets the cache when the surface has disappeared everywhere', async () => {
    const a = win(1, {});
    const h = harness([a], a, new Map([[CALLER, 1]]));

    await resolveCallerTarget(CALLER, h.deps);

    expect(h.cache.has(CALLER)).toBe(false);
  });

  it('skips a window that dies mid-probe and keeps looking', async () => {
    const dying = win(1, {}, true);
    const home = win(2, { [CALLER]: 'ws-home' });
    const h = harness([dying, home], dying);

    const target = await resolveCallerTarget(CALLER, h.deps);

    expect(target?.win).toBe(home);
  });

  it('returns null when there is no window at all', async () => {
    const h = harness([], null);
    expect(await resolveCallerTarget(CALLER, h.deps)).toBeNull();
  });
});
