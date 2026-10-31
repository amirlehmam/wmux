// @vitest-environment jsdom
/**
 * Remote Console (#254), review round 4: the phone-side halves of the fixes
 * whose server halves are pinned in the session, server and runtime suites.
 */
import fs from 'fs';
import path from 'path';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_KEY_ITEM, forgetDeviceKey, saveDeviceKey, type KeyStorage } from '../../src/renderer/remote/device-key';
import { createBrowserWsClient, createWsClient, type WsLike } from '../../src/renderer/remote/ws-client';
import { attachRetryable, errorKey } from '../../src/renderer/remote/components/TermView';
import { Toasts, visibleToasts, type Toast } from '../../src/renderer/remote/components/Toasts';
import { PrefsScreen, prefsHostLine, DEFAULT_PREFS } from '../../src/renderer/remote/screens/PrefsScreen';
import { sectionLabel } from '../../src/renderer/remote/screens/ConsoleScreen';
import { pairHintShown } from '../../src/renderer/components/Settings/RemoteConsoleSettings';
import { createT } from '../../src/renderer/remote/i18n';
import { de } from '../../src/renderer/remote/i18n/messages/de';
import { WS_KEY_PROTOCOL_PREFIX, WS_SUBPROTOCOL } from '../../src/shared/remote-console-protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = createT('en');
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let root: Root | null = null;
let host: HTMLElement | null = null;
function render(el: ReturnType<typeof createElement>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(el); });
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function memoryStorage(): KeyStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}

describe('re-pairing in another tab never wipes the new page key (#254)', () => {
  it('forgetDeviceKey removes only the key this page presented', () => {
    const storage = memoryStorage();
    const oldKey = 'o'.repeat(43);
    const newKey = 'n'.repeat(43);
    saveDeviceKey(newKey, storage);
    // The old tab learns its record is gone AFTER the pairing tab saved.
    forgetDeviceKey(oldKey, storage);
    expect(storage.map.get(DEVICE_KEY_ITEM)).toBe(newKey);
    forgetDeviceKey(newKey, storage);
    expect(storage.map.has(DEVICE_KEY_ITEM)).toBe(false);
    // A page that presented no key has none of its own to forget.
    saveDeviceKey(newKey, storage);
    forgetDeviceKey(null, storage);
    expect(storage.map.get(DEVICE_KEY_ITEM)).toBe(newKey);
  });

  it('a `revoked` frame marked `replaced` stops the client as replaced, not revoked', () => {
    const sockets: WsLike[] = [];
    const client = createWsClient({
      url: 'ws://x/ws',
      createSocket: () => {
        const s = { readyState: 1, send: () => undefined, close: () => undefined } as unknown as WsLike;
        sockets.push(s);
        return s;
      },
      setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined,
      isVisible: () => true,
    });
    client.start();
    sockets[0].onmessage?.({ data: JSON.stringify({ t: 'revoked', replaced: true }) });
    expect(client.state).toMatchObject({ status: 'stopped', stopReason: 'replaced' });
  });

  it('the page stops, without touching storage, on `replaced`', () => {
    const src = read('src/renderer/remote/RemoteApp.tsx');
    expect(src).toContain("st.stopReason === 'replaced'");
    expect(src).toContain('forgetDeviceKey(usedKey.current)');
    // `replaced` is neither an unpaired nor a keyless phase.
    expect(src).toMatch(/UNPAIRED_PHASES[^\n]*new Set\(\['unpaired', 'revoked', 'incompatible'\]\)/);
  });
});

describe('the socket reads the page key per connection (#254)', () => {
  it('a reconnect after a re-pair elsewhere presents the NEW key', async () => {
    vi.useFakeTimers();
    const made: { protocols: string[]; ws: { onclose: ((ev: { code: number }) => void) | null } }[] = [];
    class FakeWs {
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: ((ev: { code: number }) => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_url: string, protocols: string[]) { made.push({ protocols, ws: this }); }
      send() { /* nothing */ }
      close() { /* nothing */ }
    }
    vi.stubGlobal('WebSocket', FakeWs);
    let key = 'a'.repeat(43);
    const client = createBrowserWsClient(async () => true, () => key);
    client.start();
    expect(made[0].protocols).toEqual([WS_SUBPROTOCOL, WS_KEY_PROTOCOL_PREFIX + 'a'.repeat(43)]);
    // Another tab re-pairs: new cookie, new key in the shared storage. This
    // socket dies without a welcome (the browser reports the 401 as 1006), the
    // probe with the fresh key says "paired", and the retry must carry it too.
    key = 'b'.repeat(43);
    made[0].ws.onclose?.({ code: 1006 });
    await vi.runAllTimersAsync();
    expect(made.length).toBeGreaterThanOrEqual(2);
    expect(made[1].protocols).toEqual([WS_SUBPROTOCOL, WS_KEY_PROTOCOL_PREFIX + 'b'.repeat(43)]);
    client.stop();
  });
});

describe('a rate-limited attach can be retried (#254)', () => {
  it('names the refusal and offers Retry', () => {
    expect(errorKey('rate')).toBe('ack.rate');
    expect(attachRetryable('rate')).toBe(true);
    expect(attachRetryable('timeout')).toBe(true);
    expect(attachRetryable('gone')).toBe(false);
    expect(attachRetryable('no-terminal')).toBe(false);
    expect(attachRetryable(null)).toBe(false);
  });
});

describe('toasts on the attach screen (#254)', () => {
  const toasts: Toast[] = [
    { id: 1, kind: 'blocked', s: 'surf-a', label: 'claude: a' },
    { id: 2, kind: 'done', s: 'surf-b', label: 'claude: b' },
    { id: 3, kind: 'error', text: 'Too fast' },
  ];

  it('leave out the pane already on screen, which shows its own answers', () => {
    expect(visibleToasts(toasts, 'surf-a').map((x) => x.id)).toEqual([2, 3]);
    expect(visibleToasts(toasts, null).map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it('follow the visual viewport when iOS pans the layout viewport', () => {
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { height: 400, offsetTop: 180 }));
    const el = render(createElement(Toasts, {
      toasts, attached: 'surf-a', roster: [], operator: true, t, onOpen: vi.fn(), onAnswer: vi.fn(), onDismiss: vi.fn(),
    }));
    const stack = el.querySelector<HTMLElement>('.rc-toasts');
    expect(stack?.style.transform).toBe('translateY(180px)');
    expect(el.querySelectorAll('.rc-toast')).toHaveLength(2);
  });
});

describe('Prefs does not claim a connection it does not have (#254)', () => {
  it('says "Connected to" only while ready, and shows the connection chip', () => {
    expect(prefsHostLine(t, 'pc:9790', 'ready')).toBe('Connected to pc:9790');
    expect(prefsHostLine(t, 'pc:9790', 'waiting')).toBe('pc:9790');
    expect(prefsHostLine(t, 'pc:9790', 'stopped')).toBe('pc:9790');
    const el = render(createElement(PrefsScreen, {
      t, prefs: DEFAULT_PREFS, host: 'pc:9790', status: 'stopped', device: null, effectiveScope: 'viewer',
      onChange: vi.fn(), onBack: vi.fn(), onForget: vi.fn(),
    }));
    expect(el.textContent).not.toContain('Connected to');
    expect(el.querySelector('.rc-chip--stopped')?.textContent).toBe(t.t('conn.offline'));
  });
});

describe('the "N agents need you" plural is displayed (#254)', () => {
  it('names the Needs-you section for a screen reader', () => {
    expect(sectionLabel(t, 'needsYou', 1)).toBe('1 agent needs you');
    expect(sectionLabel(t, 'needsYou', 3)).toBe('3 agents need you');
    expect(sectionLabel(createT('ru'), 'needsYou', 5)).toBe('5 агентов ждут вас');
    expect(sectionLabel(t, 'done', 2)).toBeUndefined();
  });
});

describe('Settings (#254)', () => {
  it('asks to turn the console on only when it is off', () => {
    const cfg = (enabled: boolean) => ({ enabled }) as never;
    expect(pairHintShown({ running: false, config: cfg(false) })).toBe(true);
    // Enabled but failed to start (port busy, bind failed): the status line names it.
    expect(pairHintShown({ running: false, config: cfg(true) })).toBe(false);
    expect(pairHintShown({ running: true, config: cfg(true) })).toBe(false);
  });

  it('every device-name field takes the length the server keeps', () => {
    for (const f of ['src/renderer/components/Settings/RemoteConsoleSettings.tsx', 'src/renderer/components/Settings/PairDeviceDialog.tsx']) {
      const src = read(f);
      expect(src).not.toContain('maxLength={40}');
      expect(src).toContain('maxLength={DEVICE_NAME_MAX}');
    }
  });

  it('the preload exposes the dismiss-rejected-origin bridge', () => {
    // AGENTS.md no longer copies the bridge or channel lists; the preload and
    // IPC_CHANNELS are their one homes.
    expect(read('src/preload/index.ts')).toContain('dismissRejectedOrigin: () =>');
    expect(read('src/shared/types.ts')).toContain("'remote-console:dismiss-rejected-origin'");
  });
});

describe('attach header (#254)', () => {
  it('puts the state chip under the title so the label keeps the width', () => {
    const src = read('src/renderer/remote/screens/AttachScreen.tsx');
    expect(src).toMatch(/<div className="rc-attach__heading">\s*<h1[^>]*rc-attach__title[^]*?chips\.includes\('state'\)[^]*?<\/div>/);
    const css = read('src/renderer/remote/remote.css');
    expect(css).toMatch(/\.rc-attach__heading \{[^}]*min-width: 0;[^}]*flex-direction: column;/);
  });
});

describe('German phone strings match the desktop (#254)', () => {
  it('formal Sie, "Remote-Konsole", and one name for the Enter key', () => {
    const all = Object.values(de).join('\n');
    expect(all).not.toMatch(/\b(du|dich|dir|dein|deine|deinem|deinen|deiner)\b/i);
    expect(all).not.toContain('Fernkonsole');
    expect(de['unreachable.body']).toContain('Remote-Konsole');
    expect(de['keys.enter']).toBe('Eingabetaste');
    expect(all).not.toMatch(/\bEingabe\b(?!taste)/);
    expect(de['composer.submitSkipped']).not.toMatch(/\bEnter\b/);
  });
});
