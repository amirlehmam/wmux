import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getAllWindows, getFocusedWindow } = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => [] as unknown[]),
  getFocusedWindow: vi.fn(() => null),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows, getFocusedWindow } }));

import { handleBridgeV2, validateLayoutAgentsParams } from '../../src/main/v2-bridge';
import { layoutAgentsParams } from '../../src/cli/wmux';

describe('validateLayoutAgentsParams (R1.5)', () => {
  it('accepts a count from 1 to 16 and leaves the ratio optional', () => {
    for (const count of [1, 2, 8, 16]) {
      expect(validateLayoutAgentsParams({ count })).toBeNull();
    }
  });

  it.each([
    ['missing', {}],
    ['zero', { count: 0 }],
    ['negative', { count: -1 }],
    ['above the cap', { count: 17 }],
    ['fractional', { count: 2.5 }],
    ['a string', { count: '3' }],
    ['null (NaN over JSON)', { count: null }],
  ])('rejects a count that is %s', (_label, params) => {
    expect(validateLayoutAgentsParams(params)).toMatch(/count/);
  });

  it.each([null, undefined, 'x', 3, ['count']])('rejects params that are not an object: %j', (params) => {
    expect(validateLayoutAgentsParams(params)).toMatch(/object/);
  });

  it.each([
    ['null (NaN over JSON)', null],
    ['a string', '0.4'],
    ['Infinity', Infinity],
  ])('rejects a coordinatorRatio that is %s', (_label, coordinatorRatio) => {
    expect(validateLayoutAgentsParams({ count: 2, coordinatorRatio })).toMatch(/coordinatorRatio/);
  });

  it('does not reject an out-of-range ratio: clamping is the layout function\'s job', () => {
    expect(validateLayoutAgentsParams({ count: 2, coordinatorRatio: 0.05 })).toBeNull();
    expect(validateLayoutAgentsParams({ count: 2, coordinatorRatio: 3 })).toBeNull();
  });

  it('rejects an id or type that is not a string', () => {
    expect(validateLayoutAgentsParams({ count: 2, anchorPaneId: 7 })).toMatch(/anchorPaneId/);
    expect(validateLayoutAgentsParams({ count: 2, anchorSurfaceId: {} })).toMatch(/anchorSurfaceId/);
    expect(validateLayoutAgentsParams({ count: 2, workspaceId: [] })).toMatch(/workspaceId/);
    expect(validateLayoutAgentsParams({ count: 2, type: 1 })).toMatch(/type/);
  });
});

describe('layout.agents over the bridge', () => {
  beforeEach(() => {
    getAllWindows.mockClear();
    getFocusedWindow.mockClear();
  });

  const call = (params: unknown) =>
    new Promise<{ ok?: unknown; error?: { code: number; message: string } }>((resolve) => {
      const handled = handleBridgeV2(
        'layout.agents',
        params,
        (ok) => resolve({ ok }),
        (code, message) => resolve({ error: { code, message } }),
      );
      expect(handled).toBe(true);
    });

  it.each([
    [{ count: 0 }],
    [{ count: 99 }],
    [{ count: 2, coordinatorRatio: null }],
    [undefined],
  ])('answers -32602 for %j without looking up a window', async (params) => {
    const reply = await call(params);
    expect(reply.error?.code).toBe(-32602);
    expect(getAllWindows).not.toHaveBeenCalled();
    expect(getFocusedWindow).not.toHaveBeenCalled();
  });

  it('lets valid params through to the window lookup (and fails there, not with -32602)', async () => {
    const reply = await call({ count: 2, caller: 'surf-1' });
    expect(getAllWindows).toHaveBeenCalled();
    expect(reply.error?.code).toBe(-32000);
  });
});

describe('layout.grid renderer errors over the bridge (AC18)', () => {
  const callGrid = (result: unknown) => {
    getAllWindows.mockReturnValue([{ webContents: { executeJavaScript: vi.fn(async () => result) }, isDestroyed: () => false }]);
    getFocusedWindow.mockReturnValue(null);
    return new Promise<{ ok?: unknown; error?: { code: number; message: string } }>((resolve) => {
      handleBridgeV2('layout.grid', { count: 4 }, (ok) => resolve({ ok }), (code, message) => resolve({ error: { code, message } }));
    });
  };

  afterEach(() => {
    getAllWindows.mockReset();
    getAllWindows.mockReturnValue([]);
    getFocusedWindow.mockReset();
    getFocusedWindow.mockReturnValue(null);
  });

  it('turns an { error } result into -32000 with that message', async () => {
    const reply = await callGrid({ error: 'Workspace has locked panes; unlock them or use layout agents' });
    expect(reply.error).toEqual({ code: -32000, message: 'Workspace has locked panes; unlock them or use layout agents' });
  });

  it('passes a normal result through', async () => {
    const result = { newPaneIds: ['pane-x'], newPanes: [] };
    expect((await callGrid(result)).ok).toEqual(result);
  });
});

describe('surface.create renderer errors over the bridge (AC25)', () => {
  const callCreate = (result: unknown) => {
    getAllWindows.mockReturnValue([{ webContents: { executeJavaScript: vi.fn(async () => result) }, isDestroyed: () => false }]);
    getFocusedWindow.mockReturnValue(null);
    return new Promise<{ ok?: unknown; error?: { code: number; message: string } }>((resolve) => {
      handleBridgeV2('surface.create', {}, (ok) => resolve({ ok }), (code, message) => resolve({ error: { code, message } }));
    });
  };

  afterEach(() => {
    getAllWindows.mockReset();
    getAllWindows.mockReturnValue([]);
    getFocusedWindow.mockReset();
    getFocusedWindow.mockReturnValue(null);
  });

  it('turns an { error } result into -32000 with that message', async () => {
    const reply = await callCreate({ error: 'No unlocked panes in workspace ws-1' });
    expect(reply.error).toEqual({ code: -32000, message: 'No unlocked panes in workspace ws-1' });
  });

  it('passes a created surface through', async () => {
    const result = { surfaceId: 'surf-x', paneId: 'pane-x' };
    expect((await callCreate(result)).ok).toEqual(result);
  });

  it('still reports a null result as the generic missing-workspace error', async () => {
    expect((await callCreate(null)).error).toEqual({ code: -32000, message: 'No active workspace or panes' });
  });
});

describe('layoutAgentsParams (wmux layout agents flags)', () => {
  const parse = (args: string[], caller?: string) => layoutAgentsParams(args, caller);

  it('maps every flag onto its pipe param', () => {
    expect(parse([
      '--count', '3', '--type', 'terminal', '--coordinator-ratio', '0.5',
      '--anchor-pane', 'pane-1', '--workspace', 'ws-1',
    ])).toEqual({
      params: { count: 3, type: 'terminal', coordinatorRatio: 0.5, anchorPaneId: 'pane-1', workspaceId: 'ws-1' },
    });
  });

  it('anchors on the caller\'s surface when no anchor was given', () => {
    expect(parse(['--count', '2'], 'surf-9')).toEqual({ params: { count: 2, anchorSurfaceId: 'surf-9' } });
  });

  it('does not add the caller\'s surface next to an explicit --anchor-pane', () => {
    const parsed = parse(['--count', '2', '--anchor-pane', 'pane-stale'], 'surf-9');
    expect(parsed).toEqual({ params: { count: 2, anchorPaneId: 'pane-stale' } });
  });

  it('keeps an explicit --anchor-surface over the caller\'s', () => {
    expect(parse(['--count', '2', '--anchor-surface', 'surf-1'], 'surf-9'))
      .toEqual({ params: { count: 2, anchorSurfaceId: 'surf-1' } });
  });

  it('sends no anchor at all when there is neither a flag nor a caller', () => {
    expect(parse(['--count', '2'])).toEqual({ params: { count: 2 } });
  });

  it.each([
    [[]],
    [['--count', '0']],
    [['--count', 'abc']],
    [['--count', '2.5']],
    [['--count', '-3']],
  ])('refuses %j for a missing or non-integer count', (args) => {
    expect(parse(args)).toHaveProperty('error');
  });

  it.each(['abc', '', 'NaN', 'Infinity'])('refuses --coordinator-ratio %j', (ratio) => {
    expect(parse(['--count', '2', '--coordinator-ratio', ratio])).toHaveProperty('error');
  });

  it('passes an out-of-range ratio through for main and the layout to clamp', () => {
    expect(parse(['--count', '2', '--coordinator-ratio', '0.95'])).toEqual({
      params: { count: 2, coordinatorRatio: 0.95 },
    });
  });
});
