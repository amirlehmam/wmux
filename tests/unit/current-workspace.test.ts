/**
 * `workspace.current` — the caller-scoped "which workspace am I in?" method
 * behind `wmux current-workspace`.
 *
 * The two behaviours worth pinning are the ones that make the answer
 * trustworthy: a caller in a NON-focused workspace must get its own workspace
 * rather than the active one `list-workspaces` reports, and an unresolvable
 * surface must be an explicit miss rather than the focused workspace — an agent
 * has to be able to tell "I don't know" from "it's this one".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const windows: FakeWindow[] = [];
let focused: FakeWindow | null = null;

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => windows,
    getFocusedWindow: () => focused,
  },
}));

import { handleBridgeV2 } from '../../src/main/v2-bridge';

interface Workspace { id: string; title: string; cwd: string; shell: string }

class FakeWindow {
  isDestroyed = () => false;
  /** The JS expressions main asked this window to evaluate, in order. */
  evaluated: string[] = [];
  webContents = {
    executeJavaScript: async (js: string) => {
      this.evaluated.push(js);
      const locate = /__wmux_locateSurface\?\.\((.*)\)$/.exec(js);
      if (locate) {
        const surfaceId = JSON.parse(locate[1]);
        const workspaceId = this.surfaces[surfaceId];
        return workspaceId ? { workspaceId, paneId: 'pane-x' } : null;
      }
      const current = /__wmux_currentWorkspace\?\.\((.*), (.*)\)$/.exec(js);
      if (current) {
        // Mirrors pipe-bridge's implementation: no workspace id (or an unknown
        // one) means null — deliberately no fall back to the active workspace.
        const workspaceId = current[1] === 'undefined' ? undefined : JSON.parse(current[1]);
        const surfaceId = current[2] === 'undefined' ? null : JSON.parse(current[2]);
        const ws = workspaceId && this.workspaces[workspaceId];
        return ws ? { ...ws, surfaceId } : null;
      }
      throw new Error(`unexpected js: ${js}`);
    },
  };
  constructor(
    public id: number,
    /** surfaceId → the workspace holding it. */
    public surfaces: Record<string, string>,
    public workspaces: Record<string, Workspace>,
  ) {}
}

const WS_BG: Workspace = { id: 'ws-bg', title: 'accel-144', cwd: 'C:\\Work\\project', shell: 'pwsh' };
const WS_FOCUSED: Workspace = { id: 'ws-focused', title: 'other', cwd: 'C:\\Work\\project', shell: 'pwsh' };
const CALLER = 'surf-caller';

function call(params: any): Promise<{ result?: any; error?: string }> {
  return new Promise((resolve) => {
    const handled = handleBridgeV2(
      'workspace.current',
      params,
      (result) => resolve({ result }),
      (_code, message) => resolve({ error: message }),
    );
    expect(handled).toBe(true);
  });
}

beforeEach(() => {
  windows.length = 0;
  focused = null;
});

describe('workspace.current', () => {
  it('answers about the caller\'s own workspace, not the focused one', async () => {
    const win = new FakeWindow(
      1,
      { [CALLER]: WS_BG.id },
      { [WS_BG.id]: WS_BG, [WS_FOCUSED.id]: WS_FOCUSED },
    );
    windows.push(win);
    focused = win;

    const { result, error } = await call({ caller: CALLER });

    expect(error).toBeUndefined();
    expect(result).toEqual({ ...WS_BG, surfaceId: CALLER });
  });

  it('echoes the caller surface back, so the reply is self-identifying', async () => {
    const win = new FakeWindow(1, { [CALLER]: WS_BG.id }, { [WS_BG.id]: WS_BG });
    windows.push(win);

    const { result } = await call({ caller: CALLER });

    expect(result.surfaceId).toBe(CALLER);
  });

  it('is an explicit miss for a stale surface — never the focused workspace', async () => {
    const win = new FakeWindow(1, {}, { [WS_FOCUSED.id]: WS_FOCUSED });
    windows.push(win);
    focused = win;

    const { result, error } = await call({ caller: 'surf-closed-pane' });

    expect(result).toBeUndefined();
    expect(error).toBe('surface not found');
  });

  it('is an explicit miss outside wmux, where there is no caller at all', async () => {
    const win = new FakeWindow(1, { [CALLER]: WS_BG.id }, { [WS_BG.id]: WS_BG });
    windows.push(win);
    focused = win;

    const { error } = await call({});

    expect(error).toBe('surface not found');
  });

  it('honours an explicit workspaceId (the --surface / --workspace override path)', async () => {
    const win = new FakeWindow(
      1,
      { [CALLER]: WS_BG.id },
      { [WS_BG.id]: WS_BG, [WS_FOCUSED.id]: WS_FOCUSED },
    );
    windows.push(win);

    const { result } = await call({ caller: CALLER, workspaceId: WS_FOCUSED.id });

    expect(result.id).toBe(WS_FOCUSED.id);
  });

  it('errors rather than guessing when no window is open', async () => {
    const { result, error } = await call({ caller: CALLER });

    expect(result).toBeUndefined();
    expect(error).toBe('No window');
  });
});
