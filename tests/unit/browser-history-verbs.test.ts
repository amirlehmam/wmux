import { describe, it, expect, vi } from 'vitest';
import { CDPBridge } from '../../src/main/cdp-bridge';

/**
 * Drive the bridge through a stubbed sendCommand so the history verbs can be
 * asserted with no Electron, no webContents and no real page.
 */
function bridgeWithStub(history: any) {
  const bridge = new CDPBridge();
  const sent: Array<{ method: string; params: any }> = [];
  (bridge as any).resolveTarget = () => ({ wcId: 1, refMap: new Map() });
  (bridge as any).sendCommand = vi.fn(async (_t: any, method: string, params: any) => {
    sent.push({ method, params });
    if (method === 'Page.getNavigationHistory') return history;
    return {};
  });
  return { bridge, sent };
}

const HISTORY = {
  currentIndex: 1,
  entries: [{ id: 10, url: 'https://a' }, { id: 11, url: 'https://b' }, { id: 12, url: 'https://c' }],
};

describe('browser history verbs', () => {
  it('goBack navigates to the previous history entry', async () => {
    const { bridge, sent } = bridgeWithStub(HISTORY);
    await bridge.goBack(1);
    expect(sent.at(-1)).toEqual({ method: 'Page.navigateToHistoryEntry', params: { entryId: 10 } });
  });

  it('goForward navigates to the next history entry', async () => {
    const { bridge, sent } = bridgeWithStub(HISTORY);
    await bridge.goForward(1);
    expect(sent.at(-1)).toEqual({ method: 'Page.navigateToHistoryEntry', params: { entryId: 12 } });
  });

  it('goBack at the start of history is a no-op, not a throw', async () => {
    const { bridge, sent } = bridgeWithStub({ currentIndex: 0, entries: [{ id: 10, url: 'https://a' }] });
    await expect(bridge.goBack(1)).resolves.toBeUndefined();
    expect(sent.some((s) => s.method === 'Page.navigateToHistoryEntry')).toBe(false);
  });

  it('goForward at the end of history is a no-op, not a throw', async () => {
    const { bridge, sent } = bridgeWithStub({ currentIndex: 0, entries: [{ id: 10, url: 'https://a' }] });
    await expect(bridge.goForward(1)).resolves.toBeUndefined();
    expect(sent.some((s) => s.method === 'Page.navigateToHistoryEntry')).toBe(false);
  });

  it('reload issues Page.reload', async () => {
    const { bridge, sent } = bridgeWithStub(HISTORY);
    await bridge.reload(1);
    expect(sent.at(-1)).toEqual({ method: 'Page.reload', params: {} });
  });
});
