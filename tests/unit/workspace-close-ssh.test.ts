import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { notifyWorkspaceClosed } from '../../src/renderer/store/pty-teardown';
import type { WorkspaceId } from '../../src/shared/types';

/**
 * Closing a workspace tells main, so main can forget the workspace's ssh target. Only a workspace
 * that existed is announced, and a missing preload (unit tests, a plain browser) is not an error.
 */
const makeStore = () => create<WorkspaceSlice>()((set, get, api) => createWorkspaceSlice(set as never, get as never, api as never));

describe('closing a workspace announces it to main', () => {
  let workspaceClosed: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    workspaceClosed = vi.fn();
    (globalThis as any).window = { wmux: { ssh: { workspaceClosed }, pty: { kill: vi.fn() } } };
  });
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it('sends the id of the workspace that was closed, once', () => {
    const store = makeStore();
    const id = store.getState().createWorkspace({ title: 'A' });
    store.getState().closeWorkspace(id);
    expect(workspaceClosed).toHaveBeenCalledTimes(1);
    expect(workspaceClosed).toHaveBeenCalledWith(id);
  });

  it('sends nothing for an id that is not a workspace', () => {
    const store = makeStore();
    store.getState().closeWorkspace('ws-unknown' as WorkspaceId);
    expect(workspaceClosed).not.toHaveBeenCalled();
  });

  it('is a no-op without the preload, and survives a preload that throws', () => {
    delete (globalThis as any).window;
    expect(() => notifyWorkspaceClosed('ws-1')).not.toThrow();
    (globalThis as any).window = { wmux: { ssh: { workspaceClosed: () => { throw new Error('torn down'); } } } };
    expect(() => notifyWorkspaceClosed('ws-1')).not.toThrow();
  });
});
