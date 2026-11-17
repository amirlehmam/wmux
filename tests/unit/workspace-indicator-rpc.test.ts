import { describe, expect, it, vi } from 'vitest';
import {
  handleSetIndicator,
  setIndicatorJs,
  validateIndicatorParams,
} from '../../src/main/workspace-indicator-rpc';

/** A window whose renderer answers `answer` (or throws it, when it is an Error). */
function fakeWindow(answer: unknown, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      executeJavaScript: vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    },
  };
}

async function call(params: unknown, windows: ReturnType<typeof fakeWindow>[]) {
  const respond = vi.fn();
  const respondError = vi.fn();
  await handleSetIndicator(params, windows, respond, respondError);
  return { respond, respondError };
}

describe('validateIndicatorParams', () => {
  it('accepts text with a workspace or a caller', () => {
    expect(validateIndicatorParams({ text: 'SSH', workspaceId: 'ws-1' })).toBeNull();
    expect(validateIndicatorParams({ text: '', caller: 'surf-1', color: '#fff' })).toBeNull();
  });

  it.each([
    [null],
    ['nope'],
    [{ workspaceId: 'ws-1' }],
    [{ text: 5, workspaceId: 'ws-1' }],
    [{ text: 'SSH', workspaceId: 7 }],
    [{ text: 'SSH', workspaceId: 'ws-1', color: 1 }],
  ])('refuses %j', (params) => {
    expect(validateIndicatorParams(params)).toEqual(expect.any(String));
  });

  it('refuses a call that names no workspace and comes from no pane', () => {
    expect(validateIndicatorParams({ text: 'SSH' })).toMatch(/--workspace/);
  });
});

describe('setIndicatorJs', () => {
  it('encodes every value, so a quote cannot end the expression', () => {
    const js = setIndicatorJs({ workspaceId: 'ws-1', text: `a'"); alert(1); //`, color: '#fff' });
    expect(js).toContain(JSON.stringify(`a'"); alert(1); //`));
    expect(js.startsWith('window.__wmux_setWorkspaceIndicator?.(')).toBe(true);
  });
});

describe('handleSetIndicator', () => {
  it('answers -32602 before asking any window', async () => {
    const win = fakeWindow({ workspaceId: 'ws-1' });
    const { respond, respondError } = await call({ text: 'SSH' }, [win]);
    expect(respondError).toHaveBeenCalledWith(-32602, expect.any(String));
    expect(respond).not.toHaveBeenCalled();
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('answers with the first window that holds the workspace, skipping dead and failing ones', async () => {
    const dead = fakeWindow({ workspaceId: 'ws-x' }, true);
    const reloading = fakeWindow(new Error('reloading'));
    const other = fakeWindow(null);
    const owner = fakeWindow({ workspaceId: 'ws-2', indicator: { text: 'SSH' } });
    const { respond, respondError } = await call({ text: 'SSH', workspaceId: 'ws-2' }, [dead, reloading, other, owner]);
    expect(respond).toHaveBeenCalledWith({ workspaceId: 'ws-2', indicator: { text: 'SSH' } });
    expect(respondError).not.toHaveBeenCalled();
    expect(dead.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('reports an unknown workspace instead of a silent success', async () => {
    const { respond, respondError } = await call({ text: 'SSH', workspaceId: 'ws-gone' }, [fakeWindow(null)]);
    expect(respond).not.toHaveBeenCalled();
    expect(respondError).toHaveBeenCalledWith(-32000, 'Workspace not found: ws-gone');
  });

  it('reports a caller surface that no window holds', async () => {
    const { respondError } = await call({ text: '', caller: 'surf-stale' }, [fakeWindow(null)]);
    expect(respondError).toHaveBeenCalledWith(-32000, expect.stringMatching(/not in any workspace/));
  });
});
