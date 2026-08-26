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
  agentBrowserCurrentUrl,
  agentBrowserOpen,
  agentBrowserOpenArgv,
  agentBrowserStreamEnv,
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
  /** The env override each spawn carried, positionally matching `calls`. */
  envs: Array<NodeJS.ProcessEnv | undefined>;
  acquired: string[];
  released: string[];
  registry: SessionRegistry;
}

function harness(overrides: Partial<AgentBrowserDeps> = {}, run?: AgentBrowserDeps['run']): Harness {
  const calls: string[][] = [];
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const registry = new SessionRegistry();
  const deps: AgentBrowserDeps = {
    binary: () => 'C:\\bin\\agent-browser.exe',
    run: async (binary, argv, env) => {
      calls.push(argv);
      envs.push(env);
      return run ? run(binary, argv, env) : okRun();
    },
    acquireDashboard: async (id) => { acquired.push(id); },
    releaseDashboard: async (id) => { released.push(id); },
    ensureSession: (id) => registry.ensure(id),
    getSession: (id) => registry.get(id),
    releaseSession: (id) => registry.release(id),
    ...overrides,
  };
  return { deps, calls, envs, acquired, released, registry };
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

  /**
   * Measured against agent-browser 0.35.0: streaming is ALREADY enabled by the
   * time a session opens, on an OS-assigned port, so `stream enable --port`
   * exits 1 with "✗ Streaming is already enabled for this session" and the
   * stream stays where it was (`ws://127.0.0.1:61379`). Launching with the
   * documented env var instead puts it on the requested port
   * (`ws://127.0.0.1:9300`, Connected: true), which is what the dashboard's
   * `?port=` deep link needs.
   */
  it('pins the stream port through the environment, not a subcommand', () => {
    expect(agentBrowserStreamEnv(9301)).toEqual({ AGENT_BROWSER_STREAM_PORT: '9301' });
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

    expect(h.envs[0]).toEqual({ AGENT_BROWSER_STREAM_PORT: String(session.streamPort) });
    expect(session.dashboardUrl).toContain(`?port=${session.streamPort}`);
  });

  /**
   * The env var is read when the session's browser LAUNCHES, so it has to ride
   * on the `open` — the one invocation that does the launching. A later call
   * carrying it would be too late, and `stream enable --port` (which this
   * replaced) is rejected outright because streaming is already on by then.
   */
  it('enables with exactly one invocation, and it is the open', async () => {
    const h = harness();
    await enableAgentBrowser(SURF, 'https://example.com', h.deps);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toContain('open');
    expect(h.calls.some((argv) => argv.includes('stream'))).toBe(false);
  });

  // The dashboard is observability; Chrome is the feature. Failing the whole
  // flip because the viewer did not start would trade a degraded feature for a
  // broken one.
  it('still enables when the dashboard refuses to start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({ acquireDashboard: async () => { throw new Error('port in use'); } });
    const res = await enableAgentBrowser(SURF, undefined, h.deps);
    expect(res.installed).toBe(true);
    expect(h.calls).toHaveLength(1);
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

// ─── main: the two verbs that keep the address bar honest ──────────────────
//
// In agent mode the pane's bar could only ever show the last URL the PANE
// asked for, while the agent navigates the real Chrome independently — so the
// two drift and the bar reports a page nobody is on. `currentUrl` reads where
// the session actually is; `open` is its counterpart, replacing the pane's old
// habit of reusing `enable` to mean "navigate" (which re-acquired the dashboard
// and re-bound the stream on every address-bar Enter).

describe('agentBrowserCurrentUrl', () => {
  it('asks the session where it is, by name', async () => {
    const h = harness({}, async () => okRun(null, 'https://example.com/\n'));
    const session = h.registry.ensure(SURF);

    expect(await agentBrowserCurrentUrl(SURF, h.deps)).toEqual({ url: 'https://example.com/' });
    expect(h.calls).toEqual([['--session', session.sessionName, 'get', 'url']]);
  });

  /**
   * The argv carries no `--json` today, so the bare line IS the answer — but
   * with `--json` the url sits at `data.url` inside a `{success, data, error}`
   * envelope (verified against 0.35.0). Both forms are unwrapped in one place
   * so adding the flag later cannot silently blank the address bar.
   */
  it('reads the --json envelope as readily as the bare line', async () => {
    const h = harness({}, async () =>
      okRun({ success: true, data: { url: 'https://a.test/' }, error: null }, 'noise'));
    h.registry.ensure(SURF);
    expect(await agentBrowserCurrentUrl(SURF, h.deps)).toEqual({ url: 'https://a.test/' });
  });

  // A read must never create. `ensureSession` here would start a Chrome for a
  // pane that is not in agent mode at all.
  it('answers nothing, and spawns nothing, for a surface with no session', async () => {
    const h = harness();
    expect(await agentBrowserCurrentUrl(SURF, h.deps)).toEqual({});
    expect(h.calls).toEqual([]);
    expect(h.registry.get(SURF)).toBeUndefined();
  });

  it('answers nothing when agent-browser is not installed', async () => {
    const h = harness({ binary: () => null });
    h.registry.ensure(SURF);
    expect(await agentBrowserCurrentUrl(SURF, h.deps)).toEqual({});
    expect(h.calls).toEqual([]);
  });

  /**
   * This is POLLED. A transient CLI failure has to degrade to "the bar keeps
   * its last value", not to a rejected IPC call every few seconds.
   */
  it('degrades to no answer rather than throwing', async () => {
    const h = harness({}, async () => { throw new Error('spawn exploded'); });
    h.registry.ensure(SURF);
    await expect(agentBrowserCurrentUrl(SURF, h.deps)).resolves.toEqual({});
  });

  it('drops a scheme it would not hand back to a webview', async () => {
    const h = harness({}, async () => okRun(null, 'javascript:alert(1)'));
    h.registry.ensure(SURF);
    expect(await agentBrowserCurrentUrl(SURF, h.deps)).toEqual({});
  });
});

describe('agentBrowserOpen', () => {
  it('opens the url against the existing session, pinned to its tab', async () => {
    const h = harness();
    const session = h.registry.ensure(SURF);

    expect(await agentBrowserOpen(SURF, 'https://example.com', h.deps)).toEqual({ ok: true });
    expect(h.calls).toEqual([
      ['--session', session.sessionName, '--pin-tab', 'open', 'https://example.com'],
    ]);
  });

  /**
   * The whole reason this verb exists: `enable` also acquires a dashboard
   * reference and relaunches with the stream env, and neither does anything for
   * a session that is already live — the stream port is read at browser LAUNCH
   * and cannot be moved afterwards. Both were pure cost on every Enter.
   */
  it('takes no dashboard reference and re-binds no stream', async () => {
    const h = harness();
    h.registry.ensure(SURF);
    await agentBrowserOpen(SURF, 'https://example.com', h.deps);
    expect(h.acquired).toEqual([]);
    expect(h.envs).toEqual([undefined]);
  });

  // "Navigate" is meaningless for a surface that is not in agent mode, and
  // creating a session here would let a stray renderer call start a Chrome for
  // a pane the user never flipped.
  it('refuses a surface with no session, and creates none', async () => {
    const h = harness();
    expect(await agentBrowserOpen(SURF, 'https://example.com', h.deps)).toEqual({ ok: false });
    expect(h.calls).toEqual([]);
    expect(h.registry.get(SURF)).toBeUndefined();
  });

  /**
   * This value arrives from the renderer and becomes a POSITIONAL argument to
   * agent-browser, so anything not anchored to a known scheme would be parsed
   * as part of the command rather than as a target.
   */
  it('refuses anything that is not an anchored, known scheme', async () => {
    const h = harness();
    h.registry.ensure(SURF);
    for (const url of ['--all', '-x', '', 'javascript:alert(1)', 'data:text/html,x', 'example.com']) {
      expect(await agentBrowserOpen(SURF, url, h.deps)).toEqual({ ok: false });
    }
    expect(h.calls).toEqual([]);
  });

  it('accepts exactly the schemes a read-back url can carry', async () => {
    const h = harness();
    h.registry.ensure(SURF);
    for (const url of ['https://a.test/', 'file:///c:/x.html', 'about:blank']) {
      expect(await agentBrowserOpen(SURF, url, h.deps)).toEqual({ ok: true });
    }
  });

  it('reports a refusal from the CLI as a refusal', async () => {
    const h = harness({}, async () => ({ ok: false, spawnFailed: false, data: null, stdout: '', stderr: 'no' }));
    h.registry.ensure(SURF);
    expect(await agentBrowserOpen(SURF, 'https://a.test/', h.deps)).toEqual({ ok: false });
  });

  it('does not throw when the spawn itself explodes', async () => {
    const h = harness({}, async () => { throw new Error('spawn exploded'); });
    h.registry.ensure(SURF);
    await expect(agentBrowserOpen(SURF, 'https://a.test/', h.deps)).resolves.toEqual({ ok: false });
  });

  it('answers false when agent-browser is not installed', async () => {
    const h = harness({ binary: () => null });
    h.registry.ensure(SURF);
    expect(await agentBrowserOpen(SURF, 'https://a.test/', h.deps)).toEqual({ ok: false });
  });
});

// ─── main: enable awaits a bindable session ────────────────────────────────

describe('enableAgentBrowser session allocation', () => {
  /**
   * The production `ensureSession` probes the stream port before committing to
   * it (`SessionRegistry.ensureBindable`), which makes it async. A synchronous
   * stub stays valid — that is what keeps every other test here port-free — but
   * the async shape has to actually be awaited, or the open would be spawned
   * against a Promise instead of a session.
   */
  it('awaits an async ensureSession', async () => {
    const h = harness();
    const registry = h.registry;
    const deps: AgentBrowserDeps = {
      ...h.deps,
      ensureSession: async (id) => {
        await Promise.resolve();
        return registry.ensure(id);
      },
    };
    const res = await enableAgentBrowser(SURF, undefined, deps);
    const session = registry.get(SURF)!;
    expect(res.sessionName).toBe(session.sessionName);
    expect(h.calls[0]).toEqual(['--session', session.sessionName, '--pin-tab', 'open']);
  });
});
