// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentBrowserViewer, { viewerCoordinates } from '../../src/renderer/components/Browser/AgentBrowserViewer';
import type { AgentViewerBridge, AgentViewerEvent } from '../../src/shared/types';
import { useStore } from '../../src/renderer/store';
import * as i18n from '../../src/renderer/i18n';

let container: HTMLDivElement, root: Root;
let api: AgentViewerBridge;
let onEvent: (event: AgentViewerEvent) => void;
let measure: () => void;
let decode: HTMLImageElement[];
const draw = vi.fn();
let width = 900, height = 640;
const event = async (message: AgentViewerEvent['message'], revision = 1) => {
  const token = vi.mocked(api.reconnect).mock.calls.at(-1)?.[2] ?? vi.mocked(api.attach).mock.calls.at(-1)![1];
  await act(async () => onEvent({ surfaceId: 'surf-renderer', token, revision, message }));
};
const present = async (revision = 1) => {
  await event({ type: 'frame', id: decode.length + 1, data: 'AAAA', width: 900, height: 640 }, revision);
  await act(async () => decode.at(-1)!.onload?.(new Event('load')));
};
const render = async (visible = true) => {
  await act(async () => root.render(createElement(AgentBrowserViewer, { surfaceId: 'surf-renderer', visible, onPageState: vi.fn() })));
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  decode = [];
  width = 900; height = 640;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { measure = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('Image', class {
    naturalWidth = 900; naturalHeight = 640; onload?: () => void; onerror?: () => void;
    constructor() { decode.push(this as unknown as HTMLImageElement); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as any);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 10, top: 20, width, height } as DOMRect));
  api = { attach: vi.fn(async () => {}), reconnect: vi.fn(async () => {}), reportFailure: vi.fn(), detach: vi.fn(), ack: vi.fn(), input: vi.fn(), action: vi.fn(async () => {}),
    onEvent: vi.fn((callback) => { onEvent = callback; return vi.fn(); }) };
  window.wmux = { agentViewer: api };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  draw.mockClear();
});
const textarea = () => container.querySelector('textarea')!;
const dispatchText = async (value: string, inputType = 'insertText', isComposing = false) => {
  await act(async () => {
    textarea().value = value;
    textarea().dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType, isComposing }));
  });
};
const dispatchKey = async (type: string, key: string, code: string, keyCode: number, ctrlKey = false) => {
  await act(async () => textarea().dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code, keyCode, ctrlKey })));
};

describe('renderer stream/input bridge', () => {
  it('acknowledges draw/drop and ignores decodes completing after hiding or detach', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await event({ type: 'frame', id: 1, data: 'AAAA', width: 900, height: 640 });
    expect(api.ack).not.toHaveBeenCalled();
    await act(async () => decode[0].onload?.(new Event('load')));
    expect(draw).toHaveBeenCalledOnce();
    expect(api.ack).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 1, true);
    await event({ type: 'frame', id: 2, data: 'BBBB', width: 900, height: 640 });
    await render(false);
    await act(async () => decode[1].onload?.(new Event('load')));
    expect(draw).toHaveBeenCalledOnce();
    expect(api.ack).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 2, false);
    expect(api.detach).not.toHaveBeenCalled();
    expect(api.action).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 1, { type: 'visibility', visible: false });
    expect(api.attach).toHaveBeenCalledOnce();
    await render(true);
    await event({ type: 'frame', id: 3, data: 'AAAA', width: 900, height: 640 });
    await act(async () => root.render(null));
    await act(async () => decode[2].onload?.(new Event('load')));
    expect(draw).toHaveBeenCalledOnce();
    expect(api.detach).toHaveBeenCalledOnce();
    expect(api.ack).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 3, false);
  });

  it('keeps single-codepoint Unicode on the stream and inserts long composition exactly once', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await present();
    await dispatchKey('keydown', 'a', 'KeyA', 65);
    await dispatchText('a');
    await dispatchKey('keyup', 'a', 'KeyA', 65);
    await dispatchText('✓');
    await dispatchText('🙂');
    const composition = '日本語入力テスト café 漢字 🙂 "quoted"\nnext line';
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await dispatchText('日本語', 'insertCompositionText', true);
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: composition })));
    await dispatchText(composition, 'insertFromComposition');
    const inputs = vi.mocked(api.input).mock.calls.map((call) => call[3]);
    expect(inputs).toEqual([
      expect.objectContaining({ eventType: 'rawKeyDown', key: 'a' }),
      expect.objectContaining({ eventType: 'char', text: 'a' }),
      expect.objectContaining({ eventType: 'keyUp', key: 'a' }),
      expect.objectContaining({ eventType: 'char', text: '✓' }),
      expect.objectContaining({ eventType: 'char', text: '🙂' }),
    ]);
    expect(vi.mocked(api.action).mock.calls.map((call) => call[3])).toEqual([{ type: 'insert-text', text: composition }]);
    expect(textarea().value).toBe('');
    await dispatchText('textarea bulk text');
    expect(api.action).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 1, { type: 'insert-text', text: 'textarea bulk text' });
    expect(api.input).toHaveBeenCalledTimes(5);
  });

  it.each(['tab', 'token', 'visibility', 'undrawn'])('drops pending composition after %s invalidation and permits fresh composition', async (change) => {
    vi.useFakeTimers();
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    if (change !== 'undrawn') await present();
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await dispatchText('日本語', 'insertCompositionText', true);
    let revision = 1;
    if (change === 'tab') {
      revision = 2;
      await event({ type: 'tabs', tabs: [{ tabId: 't2', title: 'Other', url: 'https://other.test/', active: true }] }, revision);
    } else if (change === 'token') {
      await event({ type: 'error', message: 'Disconnected' });
      const reconnect = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reconnect / Continue')!;
      await act(async () => reconnect.click());
      revision = 0;
      await event({ type: 'status', connected: true, width: 900, height: 640 }, revision);
    } else if (change === 'visibility') {
      await render(false);
      await render(true);
    }
    await present(revision);
    const oldText = '日本語入力テスト 🙂 "old composition"';
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: oldText })));
    await dispatchText(oldText, 'insertFromComposition');
    expect(api.input).not.toHaveBeenCalled();
    expect(vi.mocked(api.action).mock.calls.filter((call) => call[3].type === 'insert-text')).toEqual([]);
    expect(textarea().value).toBe('');
    const freshText = '新しい入力テスト 🙂';
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await dispatchText('新しい', 'insertCompositionText', true);
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: freshText })));
    await dispatchText(freshText, 'insertFromComposition');
    expect(api.input).not.toHaveBeenCalled();
    const token = vi.mocked(api.reconnect).mock.calls.at(-1)?.[2] ?? vi.mocked(api.attach).mock.calls[0][1];
    expect(vi.mocked(api.action).mock.calls.filter((call) => call[3].type === 'insert-text')).toEqual([
      ['surf-renderer', token, revision, { type: 'insert-text', text: freshText }],
    ]);
  });

  it.each(['url', 'tabs'])('drops pending composition on observed same-tab navigation through %s, even after returning to the original URL', async (source) => {
    vi.useFakeTimers();
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    const metadata = async (url: string) => event(source === 'url' ? { type: 'url', url }
      : { type: 'tabs', tabs: [{ tabId: 't1', title: 'Page', url, active: true }] });
    await metadata('https://a.test/');
    await present();
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await dispatchText('日本語', 'insertCompositionText', true);
    await metadata('https://b.test/');
    await present();
    await metadata('https://a.test/');
    await present();
    const oldText = '日本語入力テスト from page A';
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: oldText })));
    await dispatchText(oldText, 'insertFromComposition');
    expect(api.input).not.toHaveBeenCalled();
    expect(vi.mocked(api.action).mock.calls.filter((call) => call[3].type === 'insert-text')).toEqual([]);
    expect(textarea().value).toBe('');
    const freshText = '新しい入力テスト';
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await metadata('https://a.test/');
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: freshText })));
    await dispatchText(freshText, 'insertFromComposition');
    expect(api.input).not.toHaveBeenCalled();
    expect(vi.mocked(api.action).mock.calls.filter((call) => call[3].type === 'insert-text').map((call) => call[3])).toEqual([
      { type: 'insert-text', text: freshText },
    ]);
  });

  it('preserves healthy composition through initial URL acquisition, identical URLs and title-only metadata', async () => {
    vi.useFakeTimers();
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await present();
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await event({ type: 'url', url: 'https://a.test/' });
    await event({ type: 'tabs', tabs: [{ tabId: 't1', title: 'A', url: 'https://a.test/', active: true }] });
    await event({ type: 'url', url: 'https://a.test/' });
    await event({ type: 'tabs', tabs: [{ tabId: 't1', title: 'New title', url: 'https://a.test/', active: true }] });
    const text = '日本語入力テスト';
    await act(async () => textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text })));
    await dispatchText(text, 'insertFromComposition');
    expect(api.input).not.toHaveBeenCalled();
    expect(api.action).toHaveBeenCalledExactlyOnceWith('surf-renderer', expect.any(String), 1, { type: 'insert-text', text });
  });

  it('keeps copy/paste finite and lets outer-tab shortcuts bubble without forwarding to Chrome', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await present();
    await dispatchKey('keydown', 'c', 'KeyC', 67, true);
    await dispatchKey('keydown', 'v', 'KeyV', 86, true);
    expect(vi.mocked(api.action).mock.calls.map((call) => call[3])).toEqual([{ type: 'copy' }, { type: 'paste' }]);
    const binding = useStore.getState().shortcuts.nextSurface;
    const bubbled = vi.fn();
    document.addEventListener('keydown', bubbled);
    try {
      await act(async () => textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true,
        key: binding.key, ctrlKey: !!binding.ctrl, shiftKey: !!binding.shift, altKey: !!binding.alt })));
      expect(bubbled).toHaveBeenCalledOnce();
      expect(api.input).not.toHaveBeenCalled();
    } finally { document.removeEventListener('keydown', bubbled); }
  });

  it('blocks key/text/pointer/clipboard until the current revision is actually drawn, including return from hiding', async () => {
    vi.useFakeTimers();
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    const tryInput = async () => {
      await dispatchKey('keydown', 'ArrowDown', 'ArrowDown', 40);
      await dispatchText('not yet');
      await dispatchKey('keydown', 'v', 'KeyV', 86, true);
      await act(async () => container.querySelector('canvas')!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 50 })));
    };
    await tryInput();
    expect(api.input).not.toHaveBeenCalled();
    expect(api.action).not.toHaveBeenCalled();
    await present();
    await dispatchText('tab A');
    expect(api.action).toHaveBeenCalledExactlyOnceWith('surf-renderer', expect.any(String), 1, { type: 'insert-text', text: 'tab A' });
    vi.mocked(api.action).mockClear();
    await event({ type: 'tabs', tabs: [{ tabId: 't2', title: 'B', url: 'https://b.test/', active: true }] }, 2);
    await tryInput();
    expect(api.input).not.toHaveBeenCalled();
    expect(api.action).not.toHaveBeenCalled();
    await present(2);
    await dispatchText('tab B');
    expect(api.action).toHaveBeenCalledExactlyOnceWith('surf-renderer', expect.any(String), 2, { type: 'insert-text', text: 'tab B' });
    vi.mocked(api.action).mockClear();
    await render(false);
    await render(true);
    await event({ type: 'status', connected: true, width: 900, height: 640 }, 2);
    vi.mocked(api.action).mockClear();
    await tryInput();
    expect(api.input).not.toHaveBeenCalled();
    expect(api.action).not.toHaveBeenCalled();
    await present(2);
    await dispatchText('reattached');
    expect(api.action).toHaveBeenCalledExactlyOnceWith('surf-renderer', expect.any(String), 2, { type: 'insert-text', text: 'reattached' });
  });

  it('drains newest-tab sizing after obsolete in-flight resize rejection without a permanent error', async () => {
    vi.useFakeTimers();
    await render();
    let rejectOld!: (error: Error) => void;
    vi.mocked(api.action).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).toHaveBeenCalledOnce();
    width = 800; height = 600;
    await event({ type: 'tabs', tabs: [{ tabId: 't2', title: 'B', url: 'https://b.test/', active: true }] }, 2);
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).toHaveBeenCalledOnce();
    await act(async () => rejectOld(new Error('Stale page action')));
    expect(api.action).toHaveBeenCalledTimes(2);
    expect(api.action).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 2, { type: 'viewport', width: 800, height: 600 });
    expect(container.textContent).not.toContain('Stale');
  });

  it('coalesces real viewport writes, ignores zero/hidden panes, and reapplies on tab changes', async () => {
    vi.useFakeTimers();
    await render();
    await event({ type: 'status', connected: true, width: 1280, height: 720 });
    width = 800; height = 600; measure();
    width = 750; measure();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).toHaveBeenCalledWith('surf-renderer', expect.any(String), 1, { type: 'viewport', width: 750, height: 600 });
    expect(api.action).toHaveBeenCalledOnce();
    await event({ type: 'tabs', tabs: [{ tabId: 't1', title: '', url: 'about:blank', active: true }] });
    await act(async () => vi.advanceTimersByTimeAsync(150));
    vi.mocked(api.action).mockClear();
    await event({ type: 'tabs', tabs: [{ tabId: 't1', title: 'new title', url: 'https://fixture.test/', active: true }] });
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).not.toHaveBeenCalled();
    await event({ type: 'tabs', tabs: [{ tabId: 't2', title: '', url: 'about:blank', active: true }] }, 2);
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).toHaveBeenCalledOnce();
    vi.mocked(api.action).mockClear();
    width = 0; height = 0; measure();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    await render(false);
    width = 600; height = 400; measure();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(vi.mocked(api.action).mock.calls.map((call) => call[3])).toEqual([{ type: 'visibility', visible: false }]);
    await render(true);
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(api.action).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 2, { type: 'viewport', width: 600, height: 400 });
    expect(api.attach).toHaveBeenCalledOnce();
    expect(api.detach).not.toHaveBeenCalled();
  });

  it('keeps tab/URL/connection updates while hidden and drops frames without decoding', async () => {
    const onPageState = vi.fn(), onTabs = vi.fn(), onConnection = vi.fn();
    await act(async () => root.render(createElement(AgentBrowserViewer, { surfaceId: 'surf-renderer', visible: false, onPageState, onTabs, onConnection })));
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    const tabs = [{ tabId: 't9', title: 'Blank', url: 'about:blank', active: true }];
    await event({ type: 'tabs', tabs }, 2);
    await event({ type: 'frame', id: 4, data: 'AAAA', width: 900, height: 640 }, 2);
    expect(decode).toHaveLength(0);
    expect(api.ack).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 4, false);
    expect(onPageState).toHaveBeenCalledWith('about:blank', 'Blank');
    expect(onTabs).toHaveBeenCalledWith(tabs);
    expect(onConnection).toHaveBeenLastCalledWith(true);
    expect(api.attach).toHaveBeenCalledOnce();
  });

  it('draws the bridge cache and restores paste on repeated static-page returns without viewport repaint', async () => {
    vi.useFakeTimers();
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await present();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    let id = 1;
    vi.mocked(api.action).mockImplementation(async (surfaceId, token, revision, action) => {
      if (action.type === 'visibility' && action.visible) {
        onEvent({ surfaceId, token, revision, message: { type: 'frame', id: ++id, data: 'AAAA', width: 900, height: 640 } });
      }
    });
    for (let count = 0; count < 3; count++) {
      await render(false);
      await render(true);
      await dispatchKey('keydown', 'v', 'KeyV', 86, true);
      expect(vi.mocked(api.action).mock.calls.filter((call) => call[3].type === 'paste')).toHaveLength(count);
      await act(async () => decode.at(-1)!.onload?.(new Event('load')));
      await act(async () => vi.advanceTimersByTimeAsync(150));
      expect(container.textContent).not.toContain('Waiting for page frame');
      expect(api.ack).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), id, true);
      await dispatchKey('keydown', 'v', 'KeyV', 86, true);
      expect(api.action).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 1, { type: 'paste' });
    }
    expect(api.attach).toHaveBeenCalledOnce();
    expect(draw).toHaveBeenCalledTimes(4);
  });

  it('does not draw an old decode after a hide/return round trip', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await event({ type: 'frame', id: 1, data: 'AAAA', width: 900, height: 640 });
    await render(false);
    await render(true);
    await act(async () => decode[0].onload?.(new Event('load')));
    expect(draw).not.toHaveBeenCalled();
    expect(api.ack).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 1, false);
  });

  it('forwards pointer drag/release and cancels host wheel scrolling', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await event({ type: 'frame', id: 1, data: 'AAAA', width: 1800, height: 1280 });
    await act(async () => decode[0].onload?.(new Event('load')));
    const canvas = container.querySelector('canvas')!;
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    const pointer = async (type: string, button: number, buttons: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 460, clientY: 340, button, buttons });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      await act(async () => canvas.dispatchEvent(event));
    };
    await pointer('pointerdown', 0, 1);
    await pointer('pointermove', -1, 1);
    await pointer('pointerup', 0, 0);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 460, clientY: 340, deltaY: 700 });
    await act(async () => canvas.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(vi.mocked(api.input).mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ eventType: 'mousePressed', x: 900, y: 640, button: 'left' }),
      expect.objectContaining({ eventType: 'mouseMoved', button: 'left' }),
      expect.objectContaining({ eventType: 'mouseReleased', button: 'left' }),
      expect.objectContaining({ eventType: 'mouseWheel', deltaY: 700, button: 'none' }),
    ]);
  });

  it('counts consecutive presses without PointerEvent.detail and preserves each count on release', async () => {
    vi.useFakeTimers();
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await present();
    const canvas = container.querySelector('canvas')!;
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    for (let count = 0; count < 2; count++) {
      for (const type of ['pointerdown', 'pointerup']) {
        await act(async () => canvas.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, clientX: 460 + count, clientY: 340, button: 0,
        })));
      }
      await act(async () => vi.advanceTimersByTimeAsync(100));
    }
    expect(vi.mocked(api.input).mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ eventType: 'mousePressed', clickCount: 1 }),
      expect.objectContaining({ eventType: 'mouseReleased', clickCount: 1 }),
      expect.objectContaining({ eventType: 'mousePressed', clickCount: 2 }),
      expect.objectContaining({ eventType: 'mouseReleased', clickCount: 2 }),
    ]);
  });

  it('activates the pane when keyboard traversal focuses the page input', async () => {
    const onActivate = vi.fn();
    await act(async () => root.render(createElement(AgentBrowserViewer, {
      surfaceId: 'surf-renderer', visible: true, onPageState: vi.fn(), onActivate,
    })));
    await act(async () => textarea().focus());
    expect(document.activeElement).toBe(textarea());
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it('translates the page input label and decode failure through the viewer translator', async () => {
    vi.spyOn(i18n, 'useT').mockReturnValue((key) => `translated:${key}`);
    await render();
    expect(textarea().getAttribute('aria-label')).toBe('translated:browser.agent.pageInput');
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await event({ type: 'frame', id: 1, data: 'AAAA', width: 900, height: 640 });
    await act(async () => decode[0].onerror?.(new Event('error')));
    expect(container.textContent).toContain('translated:browser.agent.decodeError');
  });

  it('reports decode failure to main, ignores later frames/status and offers explicit recovery with a new token', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await event({ type: 'frame', id: 1, data: 'AAAA', width: 900, height: 640 });
    await act(async () => decode[0].onerror?.(new Event('error')));
    const oldToken = vi.mocked(api.attach).mock.calls[0][1];
    expect(api.reportFailure).toHaveBeenCalledExactlyOnceWith('surf-renderer', oldToken, 1, 'decode');
    expect(container.textContent).toContain('Could not decode');
    await render(false);
    await render(true);
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await dispatchText('paused');
    expect(api.input).not.toHaveBeenCalled();
    expect(vi.mocked(api.action).mock.calls.filter((call) => call[3].type === 'insert-text')).toEqual([]);
    const reconnect = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reconnect / Continue')!;
    await act(async () => reconnect.click());
    expect(api.reconnect).toHaveBeenCalledExactlyOnceWith('surf-renderer', oldToken, expect.not.stringMatching(oldToken));
    expect(api.attach).toHaveBeenCalledOnce();
    await event({ type: 'status', connected: true, width: 900, height: 640 }, 0);
    await present(0);
    await dispatchText('continued');
    expect(api.action).toHaveBeenLastCalledWith('surf-renderer', expect.any(String), 0, { type: 'insert-text', text: 'continued' });
    await act(async () => decode[0].onload?.(new Event('load')));
    expect(draw).toHaveBeenCalledOnce();
    expect(api.ack).toHaveBeenLastCalledWith('surf-renderer', oldToken, 1, false);
  });

  it('keeps ordinary command errors dismissible without reconnect or restarting', async () => {
    await render();
    await event({ type: 'status', connected: true, width: 900, height: 640 });
    await present();
    vi.mocked(api.action).mockRejectedValueOnce(new Error('Selection failed'));
    await dispatchKey('keydown', 'c', 'KeyC', 67, true);
    expect(container.textContent).toContain('Selection failed');
    const dismiss = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Dismiss')!;
    await act(async () => dismiss.click());
    expect(container.textContent).not.toContain('Selection failed');
    expect(api.reportFailure).not.toHaveBeenCalled();
    expect(api.reconnect).not.toHaveBeenCalled();
  });

  it('keeps failed recovery retryable and fences a pending recovery on unmount', async () => {
    await render();
    await event({ type: 'error', message: 'Disconnected' });
    vi.mocked(api.reconnect).mockRejectedValueOnce(new Error('Unauthorized'));
    const clickReconnect = async () => {
      const button = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Reconnect / Continue')!;
      await act(async () => button.click());
    };
    await clickReconnect();
    expect(container.textContent).toContain('Unauthorized');
    vi.mocked(api.reconnect).mockImplementationOnce(() => new Promise(() => {}));
    await clickReconnect();
    const calls = vi.mocked(api.reconnect).mock.calls;
    expect(calls[1][1]).toBe(calls[0][1]);
    await act(async () => root.render(null));
    expect(api.detach).toHaveBeenCalledWith('surf-renderer', calls[1][2]);
    expect(api.detach).toHaveBeenCalledWith('surf-renderer', calls[1][1]);
  });

  it('maps coordinates using viewport dimensions, not image pixels or scroll metadata', () => {
    expect(viewerCoordinates(460, 340, { left: 10, top: 20, width: 900, height: 640 }, 1800, 1280)).toEqual({ x: 900, y: 640 });
    expect(viewerCoordinates(10, 20, { left: 10, top: 20, width: 0, height: 0 }, 900, 640)).toBeNull();
  });
});
