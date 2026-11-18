import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A browser surface the user is not looking at is hidden with CSS, and Chromium
 * stops painting a webview it is told is not rendered: `wmux browser
 * screenshot` timed out as soon as the user switched workspace. A pane an agent
 * drives now keeps painting on a lease (src/main/browser-keep-rendering.ts has
 * the measurements). vitest runs in node with no React renderer, so the webview
 * itself cannot be mounted: the behaviour is pinned on the pure pieces, and the
 * wiring between processes on the source.
 */

const env = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => env.windows } }));

import {
  KeepRenderingLeases,
  keepRenderingLeases,
  KEEP_RENDERING_MS,
  KEEP_RENDERING_RENEW_MS,
  KEEP_RENDERING_GRANT_TIMEOUT_MS,
} from '../../src/main/browser-keep-rendering';
import {
  grantKeepRendering,
  keepRenderingLeft,
  KEEP_RENDERING_EVENT,
} from '../../src/renderer/utils/browser-keep-rendering';
import { webviewHiding, KEEP_RENDERING_STYLE } from '../../src/renderer/components/Browser/BrowserPane';

const SRC = join(__dirname, '../../src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('KeepRenderingLeases (main)', () => {
  function leases(answer: boolean | Error = true) {
    let now = 1_000_000;
    const grant = vi.fn(async (_surfaceId: string, _ms: number) => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const l = new KeepRenderingLeases(grant, () => now);
    return { l, grant, advance: (ms: number) => { now += ms; } };
  }

  it('grants a lease the first time an agent drives a pane', async () => {
    const { l, grant } = leases();
    await l.touch(7, 'surf-a');
    expect(grant).toHaveBeenCalledWith('surf-a', KEEP_RENDERING_MS);
  });

  it('renews at most once per interval, however many verbs arrive', async () => {
    const { l, grant, advance } = leases();
    await l.touch(7, 'surf-a');
    for (let i = 0; i < 20; i++) { advance(1000); await l.touch(7, 'surf-a'); }
    expect(grant).toHaveBeenCalledTimes(1);
    advance(KEEP_RENDERING_RENEW_MS);
    await l.touch(7, 'surf-a');
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it('renews well before the lease it granted runs out', () => {
    expect(KEEP_RENDERING_RENEW_MS).toBeLessThan(KEEP_RENDERING_MS / 2);
  });

  it('tells a remounted pane (a new webContents) at once, not after the interval', async () => {
    const { l, grant, advance } = leases();
    await l.touch(7, 'surf-a');
    advance(1000);
    await l.touch(8, 'surf-a');
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it('grants nothing for a webContents attached without a surface', async () => {
    const { l, grant } = leases();
    await l.touch(7, null);
    expect(grant).not.toHaveBeenCalled();
  });

  it('asks again on the next verb when no renderer took the lease', async () => {
    const { l, grant, advance } = leases(false);
    await l.touch(7, 'surf-a');
    advance(1000);
    await l.touch(7, 'surf-a');
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it('never throws: a lease is not a precondition for the verb', async () => {
    const { l, grant } = leases(new Error('renderer went away'));
    await expect(l.touch(7, 'surf-a')).resolves.toBeUndefined();
    await l.touch(7, 'surf-a');
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it('a hung renderer cannot hang the verb: the grant gives up after the timeout', async () => {
    vi.useFakeTimers();
    try {
      // executeJavaScript on a hung renderer never settles (#289).
      const grant = vi.fn(() => new Promise<boolean>(() => {}));
      const l = new KeepRenderingLeases(grant, () => 1_000_000);
      let settled = false;
      const touched = l.touch(7, 'surf-a').then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(KEEP_RENDERING_GRANT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await touched;
      expect(settled).toBe(true);
      // Not granted, so the next verb asks again rather than trusting a lease.
      const again = l.touch(7, 'surf-a');
      expect(grant).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(KEEP_RENDERING_GRANT_TIMEOUT_MS);
      await again;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('keepRenderingLeases → renderers', () => {
  beforeEach(() => { env.windows = []; });

  function fakeWindow(answer: unknown, opts: { destroyed?: boolean } = {}) {
    const scripts: string[] = [];
    return {
      scripts,
      isDestroyed: () => opts.destroyed ?? false,
      webContents: {
        executeJavaScript: async (js: string) => { scripts.push(js); return answer; },
      },
    };
  }

  it('calls the renderer global with the quoted surface id and the lease length', async () => {
    const win = fakeWindow(true);
    env.windows = [win];
    await keepRenderingLeases.touch(101, 'browser-ws"1');
    expect(win.scripts).toEqual([
      `window.__wmux_keepBrowserRendering?.(${JSON.stringify('browser-ws"1')}, ${KEEP_RENDERING_MS}) ?? false`,
    ]);
  });

  it('asks every live window, and counts the lease granted when one answers true', async () => {
    const old = fakeWindow(false);
    const host = fakeWindow(true);
    const gone = fakeWindow(true, { destroyed: true });
    env.windows = [old, host, gone];
    await keepRenderingLeases.touch(102, 'surf-b');
    expect(old.scripts).toHaveLength(1);
    expect(gone.scripts).toHaveLength(0);
    await keepRenderingLeases.touch(102, 'surf-b');
    expect(host.scripts).toHaveLength(1); // granted, so not asked again yet
  });

  it('the renderer defines the global main calls', () => {
    expect(read('renderer/pipe-bridge.ts')).toMatch(/w\.__wmux_keepBrowserRendering\s*=/);
    expect(read('main/browser-keep-rendering.ts')).toContain('window.__wmux_keepBrowserRendering?.(');
  });
});

describe('renderer leases', () => {
  const realWindow = (globalThis as any).window;
  let events: string[];
  beforeEach(() => {
    events = [];
    const target = new EventTarget();
    target.addEventListener(KEEP_RENDERING_EVENT, (e) => events.push((e as CustomEvent).detail.surfaceId));
    (globalThis as any).window = target;
  });
  afterEach(() => { (globalThis as any).window = realWindow; });

  it('runs for the granted time, then ends', () => {
    grantKeepRendering('r-1', 60_000, 1000);
    expect(keepRenderingLeft('r-1', 1000)).toBe(60_000);
    expect(keepRenderingLeft('r-1', 61_000)).toBe(0);
    expect(keepRenderingLeft('r-other', 1000)).toBe(0);
  });

  it('a shorter grant never cuts a longer one short', () => {
    grantKeepRendering('r-2', 60_000, 1000);
    grantKeepRendering('r-2', 1000, 2000);
    expect(keepRenderingLeft('r-2', 30_000)).toBe(31_000);
  });

  it('tells the pane, so it can restyle without polling', () => {
    grantKeepRendering('r-3', 60_000, 1000);
    expect(events).toEqual(['r-3']);
  });

  it('ignores a grant with no surface or no time', () => {
    grantKeepRendering('', 60_000, 1000);
    grantKeepRendering('r-4', 0, 1000);
    grantKeepRendering('r-4', Number.NaN, 1000);
    expect(keepRenderingLeft('r-4', 1000)).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('webviewHiding', () => {
  const base = { overlay: false, isBlank: false, isAgent: false, visible: true, keepRendering: false };

  it('leaves a pane on screen alone, lease or not', () => {
    expect(webviewHiding(base)).toEqual({});
    expect(webviewHiding({ ...base, keepRendering: true })).toEqual({});
  });

  it('lets a hidden pane nobody drives inherit the hiding, as before', () => {
    expect(webviewHiding({ ...base, visible: false })).toEqual({});
  });

  it('keeps a hidden pane an agent drives painting, transparent and out of reach', () => {
    const hiding = webviewHiding({ ...base, visible: false, keepRendering: true });
    expect(hiding.style).toBe(KEEP_RENDERING_STYLE);
    expect(hiding.tabIndex).toBe(-1);
    expect(KEEP_RENDERING_STYLE).toEqual({ visibility: 'visible', opacity: 0, pointerEvents: 'none' });
  });

  it('never applies to agent mode, whose webview only shows the dashboard', () => {
    expect(webviewHiding({ ...base, isAgent: true, visible: false, keepRendering: true })).toEqual({});
  });

  it('still hides the webview behind the setup card and on a blank page', () => {
    for (const extra of [{ overlay: true }, { isBlank: true }]) {
      for (const visible of [true, false]) {
        expect(webviewHiding({ ...base, ...extra, visible, keepRendering: true }))
          .toEqual({ style: { visibility: 'hidden' } });
      }
    }
  });
});

describe('every parent that hides a browser pane says so', () => {
  it('a split-tree pane gets the same visibility its layer uses', () => {
    const pane = read('renderer/components/SplitPane/PaneWrapper.tsx');
    expect(pane).toMatch(/visibility: isVisible \? 'visible' : 'hidden'/);
    expect(pane).toMatch(/<BrowserPane[\s\S]*?visible=\{isVisible\}/);
  });

  it('the browser panel hides inactive workspaces with visibility, never display:none', () => {
    const app = read('renderer/App.tsx');
    const panel = app.slice(app.indexOf('key={`browser-${ws.id}`}'), app.indexOf('surfaceId={`browser-${ws.id}`}') + 200);
    // `display: none` cannot be overridden by a descendant: the webview under
    // it can never be kept painting.
    expect(panel).not.toMatch(/display:/);
    expect(panel).toMatch(/visibility: ws\.id === activeWorkspaceId \? 'visible' : 'hidden'/);
    expect(panel).toMatch(/visible=\{ws\.id === activeWorkspaceId\}/);
    expect(app).toContain('openBrowserWorkspaces = workspaces.filter((ws) => ws.browserOpen && !ws.browserPanelDocked)');
    expect(app).toContain('openBrowserWorkspaces.map((ws)');
    expect(app).toContain("position: sideBrowserVisible ? 'relative' : 'absolute'");
  });

  it('the webview takes its hiding from webviewHiding, not a hand-written style', () => {
    const pane = read('renderer/components/Browser/BrowserPane.tsx');
    expect(pane).toMatch(/\{\.\.\.webviewHiding\(\{ overlay, isBlank, isAgent, visible, keepRendering \}\)\}/);
    expect(pane).toMatch(/const keepRendering = useKeepRendering\(surfaceId\)/);
  });
});
