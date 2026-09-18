import { describe, it, expect, vi } from 'vitest';
import {
  resolveSpawnTarget,
  resolveSpawnWorkspace,
  resolveSpawnPaneLoads,
  SpawnTargetError,
  type SpawnTargetLookups,
} from '../../src/main/agent-spawn-target';

// Issue #242. The repro is two workspaces where the pane is in the NON-active
// one, which is exactly the situation an orchestrator creates and a single
// developer never does by hand — so it is modelled here rather than clicked.

const WS_ADMIN = 'ws-admin';
const WS_PERSONAL = 'ws-personal';
const PANE_ADMIN = 'pane-in-admin';
const PANE_PERSONAL = 'pane-in-personal';

// The split tree, as the renderer would answer for it: one pane per workspace.
const OWNER_OF: Record<string, string> = {
  [PANE_ADMIN]: WS_ADMIN,
  [PANE_PERSONAL]: WS_PERSONAL,
};
const PANES_OF: Record<string, { paneId: string; tabCount: number }[]> = {
  [WS_ADMIN]: [{ paneId: PANE_ADMIN, tabCount: 1 }],
  [WS_PERSONAL]: [{ paneId: PANE_PERSONAL, tabCount: 1 }],
};

function lookups(over: Partial<SpawnTargetLookups> = {}): SpawnTargetLookups {
  return {
    workspaceForPane: async (paneId) => OWNER_OF[paneId] ?? null,
    activeWorkspaceId: async () => WS_PERSONAL,
    paneLoads: async (workspaceId) => PANES_OF[workspaceId] ?? [],
    ...over,
  };
}

async function codeOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SpawnTargetError) return err.code;
    throw err;
  }
  throw new Error('expected a SpawnTargetError, got a resolution');
}

describe('resolveSpawnTarget', () => {
  describe('the #242 repro', () => {
    it('files an explicit pane under its OWNER, not the active workspace', async () => {
      const target = await resolveSpawnTarget({ paneId: PANE_ADMIN }, lookups());
      expect(target).toEqual({ paneId: PANE_ADMIN, workspaceId: WS_ADMIN });
    });

    it('never asks for the active workspace when a pane is named', async () => {
      const activeWorkspaceId = vi.fn(async () => WS_PERSONAL);
      await resolveSpawnTarget({ paneId: PANE_ADMIN }, lookups({ activeWorkspaceId }));
      expect(activeWorkspaceId).not.toHaveBeenCalled();
    });

    it('a fully specified spawn works with no active workspace at all', async () => {
      const target = await resolveSpawnTarget(
        { paneId: PANE_ADMIN },
        lookups({ activeWorkspaceId: async () => null }),
      );
      expect(target.workspaceId).toBe(WS_ADMIN);
    });
  });

  describe('an explicit workspace alongside an explicit pane', () => {
    it('agrees silently when they agree', async () => {
      const target = await resolveSpawnTarget(
        { paneId: PANE_ADMIN, workspaceId: WS_ADMIN },
        lookups(),
      );
      expect(target).toEqual({ paneId: PANE_ADMIN, workspaceId: WS_ADMIN });
    });

    it('rejects a contradiction rather than recording it', async () => {
      expect(
        await codeOf(() =>
          resolveSpawnTarget({ paneId: PANE_ADMIN, workspaceId: WS_PERSONAL }, lookups()),
        ),
      ).toBe(-32602);
    });

    it('names both sides of the contradiction in the message', async () => {
      await expect(
        resolveSpawnTarget({ paneId: PANE_ADMIN, workspaceId: WS_PERSONAL }, lookups()),
      ).rejects.toThrow(/pane-in-admin.*ws-admin.*ws-personal/);
    });
  });

  describe('an unknown pane', () => {
    it('is -32602 instead of an agent nobody can address', async () => {
      expect(
        await codeOf(() => resolveSpawnTarget({ paneId: 'pane-gone' }, lookups())),
      ).toBe(-32602);
    });

    it('does not silently fall back to the active workspace', async () => {
      await expect(
        resolveSpawnTarget({ paneId: 'pane-gone' }, lookups()),
      ).rejects.toThrow(/Unknown pane/);
    });
  });

  describe('no pane named', () => {
    it('distributes inside the active workspace, as before', async () => {
      const target = await resolveSpawnTarget({}, lookups());
      expect(target).toEqual({ paneId: PANE_PERSONAL, workspaceId: WS_PERSONAL });
    });

    it('distributes inside an EXPLICIT workspace, not the active one', async () => {
      const target = await resolveSpawnTarget({ workspaceId: WS_ADMIN }, lookups());
      // The other half of #242: the pane must come from the workspace the
      // record is filed under.
      expect(target).toEqual({ paneId: PANE_ADMIN, workspaceId: WS_ADMIN });
    });

    it('asks for the named workspace rather than the active one', async () => {
      const paneLoads = vi.fn(async () => [{ paneId: PANE_ADMIN, tabCount: 0 }]);
      await resolveSpawnTarget({ workspaceId: WS_ADMIN }, lookups({ paneLoads }));
      expect(paneLoads).toHaveBeenCalledWith(WS_ADMIN);
    });

    it('is -32000 with no active workspace', async () => {
      expect(
        await codeOf(() =>
          resolveSpawnTarget({}, lookups({ activeWorkspaceId: async () => null })),
        ),
      ).toBe(-32000);
    });

    it('is -32000 when the workspace has no panes', async () => {
      expect(
        await codeOf(() =>
          resolveSpawnTarget({}, lookups({ paneLoads: async () => [] })),
        ),
      ).toBe(-32000);
    });

    it('prefers the least loaded pane', async () => {
      const target = await resolveSpawnTarget(
        {},
        lookups({
          paneLoads: async () => [
            { paneId: 'pane-busy', tabCount: 4 },
            { paneId: 'pane-quiet', tabCount: 1 },
          ],
        }),
      );
      expect(target.paneId).toBe('pane-quiet');
    });
  });

  describe('an empty-string pane id is absent, not unknown', () => {
    it('falls through to distribution', async () => {
      const target = await resolveSpawnTarget({ paneId: '' }, lookups());
      expect(target.paneId).toBe(PANE_PERSONAL);
    });
  });
});

describe('the batch path shares the workspace decision', () => {
  it('honours an explicit workspace', async () => {
    expect(await resolveSpawnWorkspace(WS_ADMIN, lookups())).toBe(WS_ADMIN);
  });

  it('falls back to the active workspace', async () => {
    expect(await resolveSpawnWorkspace(undefined, lookups())).toBe(WS_PERSONAL);
  });

  it('is -32000 with neither', async () => {
    expect(
      await codeOf(() =>
        resolveSpawnWorkspace(undefined, lookups({ activeWorkspaceId: async () => null })),
      ),
    ).toBe(-32000);
  });

  it('reads the named workspace pane loads, so a batch lands where it is filed', async () => {
    const loads = await resolveSpawnPaneLoads(WS_ADMIN, lookups());
    expect(loads.map((l) => l.paneId)).toEqual([PANE_ADMIN]);
  });

  it('is -32000 when the named workspace has no panes', async () => {
    expect(
      await codeOf(() => resolveSpawnPaneLoads('ws-nowhere', lookups())),
    ).toBe(-32000);
  });
});
