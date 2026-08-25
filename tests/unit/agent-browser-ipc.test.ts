/**
 * The renderer↔main plumbing that turns a browser surface's engine on and off.
 *
 * Two halves, both of which ship before the UI that drives them, so the tests
 * are the only thing holding them to their contract:
 *
 *  - `__wmux_getBrowserEngine` / `__wmux_setBrowserEngine` in the renderer.
 *    Main asks the first of these before routing EVERY `browser.*` verb
 *    (`engineForSurface` in v2-browser.ts), so its degradation rule — unknown
 *    surface, corrupt value, non-browser surface all answer `web` — is what
 *    keeps a bad id from taking the browser down rather than merely being
 *    wrong.
 *
 *  - `enableAgentBrowser` / `disableAgentBrowser` in main. Dependency-injected
 *    precisely so the sequencing can be pinned here with no Chrome, no
 *    dashboard and no ports: the argv must pin the tab, the stream must land on
 *    the port the registry allocated (the dashboard deep-link keys on it), and
 *    disabling a surface that never enabled must be a no-op rather than a
 *    phantom dashboard release.
 */
import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { create } from 'zustand';
import { createWorkspaceSlice, type WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createSurfaceSlice, type SurfaceSlice } from '../../src/renderer/store/surface-slice';
import { createLeaf } from '../../src/renderer/store/split-utils';
import type { PaneId, SurfaceId, WorkspaceId, SurfaceRef, SplitNode } from '../../src/shared/types';

// ─── module seams ──────────────────────────────────────────────────────────
//
// `initPipeBridge` reaches the real singleton store and (for read-screen) the
// xterm registry; ipc-handlers reaches Electron and the app data dir. None of
// that is what is under test, and the app data dir in particular must be
// redirected: `PtyLedger.takeOver()` runs at ipc-handlers import time and
// REWRITES the ledger, which for an unmocked path is the live wmux's own.

type TestStore = WorkspaceSlice & SurfaceSlice;
const makeStore = () =>
  create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createSurfaceSlice(...args),
  }));

let store = makeStore();

vi.mock('../../src/renderer/store', () => ({
  get useStore() {
    return store;
  },
}));
vi.mock('../../src/renderer/hooks/useTerminal', () => ({
  surfaceTerminalRegistry: new Map(),
}));

vi.mock('../../src/shared/instance', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppDataDir: () => path.join(os.tmpdir(), 'wmux-agent-browser-ipc-test'),
}));
vi.mock('electron', () => ({
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null, getFocusedWindow: () => null },
  clipboard: { readText: () => '', writeText: () => {} },
  shell: {},
  dialog: {},
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0' },
  nativeTheme: { on: () => {} },
}));

import { initPipeBridge } from '../../src/renderer/pipe-bridge';
import {
  agentBrowserOpenArgv,
  agentBrowserStreamArgv,
  disableAgentBrowser,
  enableAgentBrowser,
  readBackUrl,
  type AgentBrowserDeps,
} from '../../src/main/ipc-handlers';
import { SessionRegistry } from '../../src/main/agent-browser-session';

// ─── renderer: engine lookup ───────────────────────────────────────────────

const WS = 'ws-1' as WorkspaceId;
const PANE = 'pane-1' as PaneId;

/** A one-pane workspace holding exactly `surfaces`, installed into the store. */
function seed(surfaces: SurfaceRef[]): void {
  const leaf = createLeaf(PANE, 'browser');
  const splitTree: SplitNode = { ...leaf, surfaces };
  store = makeStore();
  store.setState({
    workspaces: [{ id: WS, title: 'w', pinned: false, shell: 'pwsh', splitTree, unreadCount: 0 } as any],
    activeWorkspaceId: WS,
  });
  (globalThis as Record<string, unknown>).window = {};
  initPipeBridge();
}

const bridge = () => globalThis.window as unknown as {
  __wmux_getBrowserEngine: (id: string) => string;
  __wmux_setBrowserEngine: (id: string, engine: string) => boolean;
};

const surface = (id: string, extra: Partial<SurfaceRef> = {}): SurfaceRef =>
  ({ id: id as SurfaceId, type: 'browser', ...extra }) as SurfaceRef;

describe('__wmux_getBrowserEngine', () => {
  // The load-bearing one. Main runs `?? 'web'` on this answer for every browser
  // command, so an id it cannot place must not become an exception or an
  // engine that needs a binary nobody installed.
  it('answers web for a surface that does not exist', () => {
    seed([surface('surf-a')]);
    expect(bridge().__wmux_getBrowserEngine('surf-nope')).toBe('web');
  });

  it('answers agent for an agent-mode browser surface', () => {
    seed([surface('surf-a', { browserEngine: 'agent' })]);
    expect(bridge().__wmux_getBrowserEngine('surf-a')).toBe('agent');
  });

  it('answers web for a browser surface with no engine recorded', () => {
    seed([surface('surf-a')]);
    expect(bridge().__wmux_getBrowserEngine('surf-a')).toBe('web');
  });

  // The session file is user-editable, so this is a real input, not a
  // hypothetical one. Routed through engineOf so it degrades identically here
  // and in main rather than each side inventing its own rule.
  it('answers web for a corrupt persisted engine value', () => {
    seed([surface('surf-a', { browserEngine: 'evil' as never })]);
    expect(bridge().__wmux_getBrowserEngine('surf-a')).toBe('web');
  });

  it('answers web for a terminal surface even when it carries an engine', () => {
    seed([surface('surf-t', { type: 'terminal', browserEngine: 'agent' })]);
    expect(bridge().__wmux_getBrowserEngine('surf-t')).toBe('web');
  });
});

describe('__wmux_setBrowserEngine', () => {
  it('sets the engine on a browser surface', () => {
    seed([surface('surf-a')]);
    expect(bridge().__wmux_setBrowserEngine('surf-a', 'agent')).toBe(true);
    expect(bridge().__wmux_getBrowserEngine('surf-a')).toBe('agent');
  });

  // Writing the field anyway would persist a value engineOf ignores forever —
  // a mutation that reports success and changes nothing (#143).
  it('refuses a non-browser surface and leaves it alone', () => {
    seed([surface('surf-t', { type: 'terminal' })]);
    expect(bridge().__wmux_setBrowserEngine('surf-t', 'agent')).toBe(false);
    expect(bridge().__wmux_getBrowserEngine('surf-t')).toBe('web');
  });

  it('refuses a surface it cannot find', () => {
    seed([surface('surf-a')]);
    expect(bridge().__wmux_setBrowserEngine('surf-nope', 'agent')).toBe(false);
  });
});

// ─── main: enable / disable ────────────────────────────────────────────────

const SURF = 'surf-11111111-2222-3333-4444-555555555555' as SurfaceId;

const okRun = (data: unknown = null, stdout = ''): any =>
  ({ ok: true, spawnFailed: false, data, stdout, stderr: '' });

interface Harness {
  deps: AgentBrowserDeps;
  /** Every argv actually spawned, in order. */
  calls: string[][];
  acquired: string[];
  released: string[];
  registry: SessionRegistry;
}

function harness(overrides: Partial<AgentBrowserDeps> = {}, run?: AgentBrowserDeps['run']): Harness {
  const calls: string[][] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const registry = new SessionRegistry();
  const deps: AgentBrowserDeps = {
    binary: () => 'C:\\bin\\agent-browser.exe',
    run: async (binary, argv) => {
      calls.push(argv);
      return run ? run(binary, argv) : okRun();
    },
    acquireDashboard: async (id) => { acquired.push(id); },
    releaseDashboard: async (id) => { released.push(id); },
    ensureSession: (id) => registry.ensure(id),
    getSession: (id) => registry.get(id),
    releaseSession: (id) => registry.release(id),
    ...overrides,
  };
  return { deps, calls, acquired, released, registry };
}

describe('enable argv', () => {
  it('pins the tab to the session and opens the current url', () => {
    expect(agentBrowserOpenArgv('wmux-surf-a', 'https://example.com')).toEqual([
      '--session', 'wmux-surf-a', '--pin-tab', 'open', 'https://example.com',
    ]);
  });

  // about:blank is what a browser surface reports before it has ever
  // navigated; passing it through would spend a page load arriving at nothing.
  it('omits about:blank', () => {
    expect(agentBrowserOpenArgv('wmux-surf-a', 'about:blank')).toEqual([
      '--session', 'wmux-surf-a', '--pin-tab', 'open',
    ]);
  });

  it('omits an absent url', () => {
    expect(agentBrowserOpenArgv('wmux-surf-a')).toEqual([
      '--session', 'wmux-surf-a', '--pin-tab', 'open',
    ]);
  });

  it('binds the stream to a given port', () => {
    expect(agentBrowserStreamArgv('wmux-surf-a', 9301)).toEqual([
      '--session', 'wmux-surf-a', 'stream', 'enable', '--port', '9301',
    ]);
  });
});

describe('enableAgentBrowser', () => {
  it('reports not installed without spawning anything', async () => {
    const h = harness({ binary: () => null });
    expect(await enableAgentBrowser(SURF, undefined, h.deps)).toEqual({ installed: false });
    expect(h.calls).toEqual([]);
    expect(h.acquired).toEqual([]);
  });

  it('opens a pinned session and returns its dashboard deep link', async () => {
    const h = harness();
    const res = await enableAgentBrowser(SURF, 'https://example.com', h.deps);
    const session = h.registry.get(SURF)!;

    expect(res).toEqual({
      installed: true,
      dashboardUrl: session.dashboardUrl,
      sessionName: session.sessionName,
    });
    expect(h.calls[0]).toContain('--pin-tab');
    expect(h.calls[0]).toEqual([
      '--session', session.sessionName, '--pin-tab', 'open', 'https://example.com',
    ]);
  });

  // The dashboard renders `?port=<streamPort>`, so a stream bound anywhere else
  // is a blank pane. The port must come from the registry, never a constant.
  it('binds the stream to the port the registry allocated', async () => {
    const h = harness();
    await enableAgentBrowser(SURF, undefined, h.deps);
    const session = h.registry.get(SURF)!;

    expect(h.calls[1]).toEqual([
      '--session', session.sessionName, 'stream', 'enable', '--port', String(session.streamPort),
    ]);
    expect(session.dashboardUrl).toContain(`?port=${session.streamPort}`);
  });

  // The dashboard is observability; Chrome is the feature. Failing the whole
  // flip because the viewer did not start would trade a degraded feature for a
  // broken one.
  it('still enables when the dashboard refuses to start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({ acquireDashboard: async () => { throw new Error('port in use'); } });
    const res = await enableAgentBrowser(SURF, undefined, h.deps);
    expect(res.installed).toBe(true);
    expect(h.calls).toHaveLength(2);
    warn.mockRestore();
  });
});

describe('disableAgentBrowser', () => {
  // The renderer calls this on unmount, which fires for panes that never
  // entered agent mode. A phantom release would decrement a refcount this
  // surface never incremented.
  it('is a no-op for a surface with no session', async () => {
    const h = harness();
    expect(await disableAgentBrowser(SURF, h.deps)).toEqual({});
    expect(h.calls).toEqual([]);
    expect(h.released).toEqual([]);
  });

  it('reads the url back before closing, then releases both', async () => {
    const h = harness({}, async (_b, argv) =>
      argv.includes('url') ? okRun({ url: 'https://example.com/deep' }) : okRun());
    await enableAgentBrowser(SURF, undefined, h.deps);
    const session = h.registry.get(SURF)!;
    h.calls.length = 0;

    const res = await disableAgentBrowser(SURF, h.deps);

    expect(res).toEqual({ url: 'https://example.com/deep' });
    expect(h.calls).toEqual([
      ['--session', session.sessionName, 'get', 'url'],
      ['--session', session.sessionName, 'close'],
    ]);
    expect(h.registry.get(SURF)).toBeUndefined();
    expect(h.released).toEqual([SURF]);
  });

  it('still closes when the read-back fails', async () => {
    const h = harness({}, async (_b, argv) => {
      if (argv.includes('url')) throw new Error('session gone');
      return okRun();
    });
    await enableAgentBrowser(SURF, undefined, h.deps);
    h.calls.length = 0;

    expect(await disableAgentBrowser(SURF, h.deps)).toEqual({});
    expect(h.calls.at(-1)).toContain('close');
    expect(h.released).toEqual([SURF]);
  });

  it('tears the session down even with no binary left to close it with', async () => {
    const h = harness();
    await enableAgentBrowser(SURF, undefined, h.deps);
    // A binary that vanished mid-session (uninstalled, moved) must not strand
    // the registry entry and the dashboard reference forever.
    (h.deps as { binary: () => string | null }).binary = () => null;

    expect(await disableAgentBrowser(SURF, h.deps)).toEqual({});
    expect(h.registry.get(SURF)).toBeUndefined();
    expect(h.released).toEqual([SURF]);
  });
});

describe('readBackUrl', () => {
  it('prefers parsed JSON', () => {
    expect(readBackUrl(okRun({ url: 'https://a.test/' }, 'noise'))).toBe('https://a.test/');
  });

  it('falls back to stdout for a verb that does not emit JSON', () => {
    expect(readBackUrl(okRun(null, ' https://b.test/ \n'))).toBe('https://b.test/');
  });

  // Its only consumer sets this as a <webview> src. A javascript: url read off
  // a page the agent visited would be script execution inside the pane chrome.
  it('drops a scheme that is not safe to hand back to a webview', () => {
    expect(readBackUrl(okRun(null, 'javascript:alert(1)'))).toBeUndefined();
    expect(readBackUrl(okRun({ url: 'data:text/html,<script>x</script>' }))).toBeUndefined();
  });

  it('has no answer when the invocation failed', () => {
    expect(readBackUrl({ ok: false, spawnFailed: false, data: null, stdout: 'https://a.test/', stderr: '' }))
      .toBeUndefined();
  });
});
