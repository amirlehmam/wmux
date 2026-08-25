# agent-browser Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) as a second engine behind wmux's existing browser surface, so a user can flip any browser tab to "agent mode" and watch a real Chrome that their coding agent drives, live viewport and activity feed included.

**Architecture:** `browser` stays one `SurfaceType` and gains `browserEngine: 'web' | 'agent'` (default `'web'`). In agent mode the existing Electron `<webview>` loads agent-browser's own dashboard (`http://127.0.0.1:4848/?port=<streamPort>`), deep-linked to that pane's session — so wmux writes no new rendering code. All `browser.*` pipe verbs already funnel through `runBrowserCommand` in `v2-browser.ts`; that funnel starts resolving a *target* (`web` → wcId, `agent` → session) and switches once. Agents need no re-education: the global CLAUDE.md keeps saying `wmux browser open <url>`.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), React 19, Zustand, Vitest. External dependency: the `agent-browser` CLI (a native Rust binary, user-installed via npm — wmux bundles nothing).

**Spec:** `docs/superpowers/specs/2026-08-26-agent-browser-integration-design.md`

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/main/agent-browser-cli.ts` | Locate the `agent-browser` binary on this machine; run it and parse JSON. Nothing else. |
| `src/main/agent-browser-verbs.ts` | **Pure.** Translate a wmux browser verb + params into an `agent-browser` argv array. No I/O, no Electron. |
| `src/main/agent-browser-daemon.ts` | Own the `dashboard start`/`stop` process, refcounted; adopt a foreign dashboard rather than fight it. |
| `src/main/agent-browser-session.ts` | Map `surfaceId` → `{ sessionName, streamPort, dashboardUrl }`. Create lazily, close on surface close. |
| `src/renderer/components/Browser/AgentBrowserSetup.tsx` | The "not installed" card shown in place of the webview. |
| `tests/unit/agent-browser-verbs.test.ts` | Verb translation table. |
| `tests/unit/agent-browser-cli.test.ts` | Binary resolution (incl. Windows `.cmd` shim). |
| `tests/unit/agent-browser-session.test.ts` | Port allocation + session naming. |
| `tests/unit/agent-browser-routing.test.ts` | Engine → target resolution, and the "agent mode never attaches CDP" guard. |
| `tests/unit/browser-history-verbs.test.ts` | Regression pin for the back/forward/reload fix. |

**Modify:**

| File | Change |
|---|---|
| `src/shared/types.ts:14` | Add `browserEngine?: BrowserEngine` to `SurfaceRef`; export `BrowserEngine`. |
| `src/main/cdp-bridge.ts` | Add `goBack` / `goForward` / `reload`. |
| `src/main/v2-browser.ts` | `resolveBrowserWcId` → `resolveBrowserTarget`; `runBrowserCommand` switches on engine; add the three history cases. |
| `src/main/index.ts` | Register daemon teardown; add `browser.set_engine` / `browser.get_engine` V2 methods. |
| `src/renderer/components/Browser/BrowserPane.tsx` | Engine branch; suppress `claimCdp` + popup bridge in agent mode. |
| `src/renderer/components/Browser/AddressBar.tsx` | Engine toggle. |
| `src/renderer/components/SplitPane/PaneWrapper.tsx:274` | Pass `engine` + `onEngineChange` to `BrowserPane`. |
| `src/renderer/pipe-bridge.ts` | `window.__wmux_setBrowserEngine` / `__wmux_getBrowserEngine`. |
| `src/cli/wmux.ts` | `wmux browser engine [web\|agent] [--surface id]`. |

---

## Task 1: Add `browserEngine` to the surface model

**Files:**
- Modify: `src/shared/types.ts:12` (after `SurfaceType`) and `src/shared/types.ts:14` (`SurfaceRef`)
- Test: `tests/unit/agent-browser-routing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent-browser-routing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { engineOf } from '../../src/shared/types';
import type { SurfaceRef } from '../../src/shared/types';

describe('engineOf', () => {
  it('defaults an undefined engine to web', () => {
    const s = { id: 'surf-1', type: 'browser' } as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });

  it('returns an explicit engine', () => {
    const s = { id: 'surf-1', type: 'browser', browserEngine: 'agent' } as SurfaceRef;
    expect(engineOf(s)).toBe('agent');
  });

  it('treats a non-browser surface as web', () => {
    const s = { id: 'surf-1', type: 'terminal', browserEngine: 'agent' } as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });

  it('rejects an unknown engine string from a hand-edited session file', () => {
    const s = { id: 'surf-1', type: 'browser', browserEngine: 'evil' } as unknown as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent-browser-routing.test.ts`
Expected: FAIL — `engineOf` is not exported from `src/shared/types`.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/types.ts`, immediately after the `SurfaceType` declaration on line 12:

```ts
/**
 * Which engine backs a `browser` surface.
 *
 * `web`   — the Electron <webview>. The default, always, and what every
 *           browser surface was before agent-browser existed.
 * `agent` — vercel-labs/agent-browser: a real Chrome driven by the CLI, shown
 *           through its own dashboard.
 *
 * Absent means `web`, so an older saved session restores correctly with no
 * migration (session-persistence.ts superset rule, #145).
 */
export type BrowserEngine = 'web' | 'agent';
```

Add to `SurfaceRef` (after the `url?: string` field around line 49):

```ts
  /**
   * Which engine backs this browser surface. Absent ⇒ 'web'. Read through
   * `engineOf()` rather than directly, so an absent or corrupt value can only
   * ever degrade to the safe engine.
   */
  browserEngine?: BrowserEngine;
```

Then at the end of the file:

```ts
/**
 * The engine a surface actually runs on. Never trust the raw field: it is
 * persisted to a user-editable session file, and every unknown value must
 * degrade to `web` — the engine that needs no external binary and so can
 * always be rendered.
 */
export function engineOf(surface: { type: SurfaceType; browserEngine?: BrowserEngine }): BrowserEngine {
  if (surface.type !== 'browser') return 'web';
  return surface.browserEngine === 'agent' ? 'agent' : 'web';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent-browser-routing.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify persistence accepts the new field**

Run: `npx vitest run tests/unit/session-persistence.test.ts`
Expected: PASS. `browserEngine` lives on `SurfaceRef`, which the persisted split tree already serialises wholesale — no persistence change is needed. If this fails, the persisted tree is being field-picked somewhere and that call site must be found before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts tests/unit/agent-browser-routing.test.ts
git commit -m "feat(types): add browserEngine to SurfaceRef"
```

---

## Task 2: Fix `browser.back` / `forward` / `reload` (pre-existing bug)

These three verbs are documented in the global CLAUDE.md wmux writes to every machine, and the CLI sends them, but `runBrowserCommand` has no case for them so they hit `default:` and throw `Unknown: browser.back`. Fix before adding a second engine, so both engines gain them together.

**Files:**
- Modify: `src/main/cdp-bridge.ts` (add three methods after `navigate`, which ends around line 281)
- Modify: `src/main/v2-browser.ts:107-133` (`runBrowserCommand` switch)
- Test: `tests/unit/browser-history-verbs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/browser-history-verbs.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/browser-history-verbs.test.ts`
Expected: FAIL — `bridge.goBack is not a function`.

- [ ] **Step 3: Implement the three bridge methods**

In `src/main/cdp-bridge.ts`, after `navigate()` (which ends around line 281):

```ts
  /**
   * Step through session history by a signed offset.
   *
   * Deliberately a no-op at either end rather than a throw: `wmux browser back`
   * on the first page of a pane is a user pressing a button that is simply not
   * available, not an error worth failing an agent's turn over.
   */
  private async goHistory(delta: number, wcId?: number): Promise<void> {
    const target = this.resolveTarget(wcId);
    const { currentIndex, entries } = await this.sendCommand(target, 'Page.getNavigationHistory');
    const next = currentIndex + delta;
    if (next < 0 || next >= entries.length) return;
    await this.sendCommand(target, 'Page.navigateToHistoryEntry', { entryId: entries[next].id });
  }

  async goBack(wcId?: number): Promise<void> {
    await this.goHistory(-1, wcId);
  }

  async goForward(wcId?: number): Promise<void> {
    await this.goHistory(1, wcId);
  }

  async reload(wcId?: number): Promise<void> {
    const target = this.resolveTarget(wcId);
    await this.sendCommand(target, 'Page.reload', {});
  }
```

- [ ] **Step 4: Add the three cases to the funnel**

In `src/main/v2-browser.ts`, inside `runBrowserCommand`'s switch, after the `browser.wait` case (line 128-130):

```ts
    case 'browser.back':
      await cdpBridge.goBack(wcId);
      return { ok: true };
    case 'browser.forward':
      await cdpBridge.goForward(wcId);
      return { ok: true };
    case 'browser.reload':
      await cdpBridge.reload(wcId);
      return { ok: true };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/browser-history-verbs.test.ts tests/unit/cdp-bridge.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/cdp-bridge.ts src/main/v2-browser.ts tests/unit/browser-history-verbs.test.ts
git commit -m "fix(browser): back/forward/reload threw Unknown instead of navigating

The CLI has always sent browser.back/forward/reload and the global
CLAUDE.md has always documented them, but runBrowserCommand had no case
for any of the three, so every call hit default: and threw
'Unknown: browser.back'."
```

---

## Task 3: Locate the `agent-browser` binary

**Files:**
- Create: `src/main/agent-browser-cli.ts`
- Test: `tests/unit/agent-browser-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent-browser-cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveAgentBrowserBinary, AGENT_BROWSER_NAMES } from '../../src/main/agent-browser-cli';

/** A fake filesystem probe: only the listed absolute paths "exist". */
function existsIn(paths: string[]) {
  return (p: string) => paths.includes(p.replace(/\\/g, '/'));
}

describe('resolveAgentBrowserBinary', () => {
  it('prefers an explicit configured path over everything else', () => {
    const found = resolveAgentBrowserBinary({
      configured: 'C:/tools/agent-browser.cmd',
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      exists: existsIn(['C:/tools/agent-browser.cmd', 'C:/Users/x/AppData/Roaming/npm/agent-browser.cmd']),
    });
    expect(found).toBe('C:/tools/agent-browser.cmd');
  });

  it('finds the npm global .cmd shim on Windows', () => {
    const found = resolveAgentBrowserBinary({
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      exists: existsIn(['C:/Users/x/AppData/Roaming/npm/agent-browser.cmd']),
    });
    expect(found).toBe('C:/Users/x/AppData/Roaming/npm/agent-browser.cmd');
  });

  it('finds the extensionless binary on posix', () => {
    const found = resolveAgentBrowserBinary({
      env: { HOME: '/home/x' },
      platform: 'linux',
      exists: existsIn(['/usr/local/bin/agent-browser']),
    });
    expect(found).toBe('/usr/local/bin/agent-browser');
  });

  it('returns null when nothing is installed', () => {
    const found = resolveAgentBrowserBinary({
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      platform: 'win32',
      exists: () => false,
    });
    expect(found).toBeNull();
  });

  it('ignores a configured path that does not exist', () => {
    const found = resolveAgentBrowserBinary({
      configured: 'C:/gone/agent-browser.cmd',
      env: {},
      platform: 'win32',
      exists: () => false,
    });
    expect(found).toBeNull();
  });

  it('prefers .cmd over .exe over bare on win32', () => {
    expect(AGENT_BROWSER_NAMES('win32')).toEqual(['agent-browser.cmd', 'agent-browser.exe', 'agent-browser']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent-browser-cli.test.ts`
Expected: FAIL — cannot find module `src/main/agent-browser-cli`.

- [ ] **Step 3: Write the implementation**

Create `src/main/agent-browser-cli.ts`:

```ts
/**
 * Where is `agent-browser` on this machine, and how do we run it?
 *
 * The same lesson as `node-runtime.ts` (#187): do NOT assume the binary is on
 * PATH. wmux hands its panes a curated environment, and npm's global bin
 * directory is frequently absent from the PATH the Electron process inherited.
 * On Windows the npm global install is a `.cmd` shim, which is also the trap
 * `powershell-shim.ts` documents — so the name we look for is extension-first,
 * and we always spawn by ABSOLUTE path.
 *
 * Resolution is pure (`resolveAgentBrowserBinary`) so it is testable with no
 * filesystem, and memoised at the module boundary because it is read on the
 * pane-render path (#176: `where` cost 2x pty.spawn).
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Candidate basenames, most preferred first. */
export function AGENT_BROWSER_NAMES(platform: string): string[] {
  return platform === 'win32'
    ? ['agent-browser.cmd', 'agent-browser.exe', 'agent-browser']
    : ['agent-browser'];
}

/** Directories to search, most preferred first. */
function searchDirs(env: NodeJS.ProcessEnv, platform: string): string[] {
  const dirs: (string | undefined)[] = platform === 'win32'
    ? [
        env.APPDATA && path.join(env.APPDATA, 'npm'),
        env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'),
        env.USERPROFILE && path.join(env.USERPROFILE, '.cargo', 'bin'),
        env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'shims'),
      ]
    : [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        env.HOME && path.join(env.HOME, '.cargo', 'bin'),
        env.HOME && path.join(env.HOME, '.local', 'bin'),
      ];
  const fromPath = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  return [...dirs, ...fromPath].filter((d): d is string => typeof d === 'string' && d.length > 0);
}

export interface ResolveOptions {
  /** An explicit path from wmux settings. Wins outright — but only if it exists. */
  configured?: string;
  env: NodeJS.ProcessEnv;
  platform: string;
  exists: (p: string) => boolean;
}

/**
 * Absolute path to the binary, or null when it is not installed.
 *
 * A configured path that does not exist returns null rather than falling back:
 * the user asked for a specific binary, and silently running a different one is
 * the wrong kind of helpful.
 */
export function resolveAgentBrowserBinary(opts: ResolveOptions): string | null {
  const { configured, env, platform, exists } = opts;
  if (configured) return exists(configured) ? configured : null;
  for (const dir of searchDirs(env, platform)) {
    for (const name of AGENT_BROWSER_NAMES(platform)) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

let cached: string | null | undefined;

/** Memoised resolution against the real machine. Pass `force` after an install. */
export function agentBrowserPath(configured?: string, force = false): string | null {
  if (!force && cached !== undefined) return cached;
  cached = resolveAgentBrowserBinary({
    configured,
    env: process.env,
    platform: process.platform,
    exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  });
  return cached;
}

export interface RunResult {
  ok: boolean;
  /** Parsed JSON when the CLI emitted it, else null. */
  data: any;
  /** Raw stdout, kept for verbs whose payload is not JSON. */
  stdout: string;
  stderr: string;
}

/**
 * Run one agent-browser invocation.
 *
 * Spawned via execFile with an argv ARRAY — never a shell string — so a URL or
 * a snippet of JS passed to `eval` cannot break out into the shell. This is a
 * security boundary: the argv comes from a pipe command an agent controls.
 */
export function runAgentBrowser(binary: string, argv: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(binary, argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let data: any = null;
      try { data = JSON.parse(stdout); } catch { /* not every verb emits JSON */ }
      resolve({ ok: !err, data, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}
```

> **RESOLVED during implementation — the `.cmd` shim must never be used.**
>
> Verified empirically on this machine (Node v24.13.0): `execFile` on a `.cmd`
> throws a **synchronous `EINVAL`**, not a callback error. This is Node's
> CVE-2024-27980 mitigation — `.bat`/`.cmd` cannot be spawned without
> `shell: true`, and `shell: true` would put agent-controlled URLs and `eval`
> snippets through cmd.exe's parser, which is exactly the trap
> `powershell-shim.ts` documents.
>
> The way out needs no shell and no new dependency. `npm pack agent-browser`
> (v0.35.0) shows the package ships the native Rust binaries itself:
>
> ```
> package/bin/agent-browser-win32-x64.exe
> package/bin/agent-browser-darwin-arm64
> package/bin/agent-browser-linux-x64          (+ arm64, musl variants)
> package/bin/agent-browser.js                 <- npx wrapper only
> ```
>
> and `bin/agent-browser.js` states in its own header: *"For global installs,
> postinstall.js patches the shims to invoke the native binary directly."*
>
> So resolution targets the real binary at
> `<npm global root>/node_modules/agent-browser/bin/agent-browser-<platform>-<arch>[.exe]`,
> probed **before** anything on PATH. `AGENT_BROWSER_NAMES('win32')` is
> `['agent-browser.exe']` — no `.cmd`, no extensionless name — and a test pins
> that a lone `.cmd` resolves to `null`, as a regression guard.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent-browser-cli.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-browser-cli.ts tests/unit/agent-browser-cli.test.ts
git commit -m "feat(agent-browser): resolve the CLI binary without trusting PATH"
```

---

## Task 4: The verb translation table

**Files:**
- Create: `src/main/agent-browser-verbs.ts`
- Test: `tests/unit/agent-browser-verbs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent-browser-verbs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toAgentBrowserArgv, normaliseRef } from '../../src/main/agent-browser-verbs';

const S = 'surf-abc';
/** Strip the leading session flags so each case asserts only its own verb. */
const verb = (method: string, params?: any) => toAgentBrowserArgv(method, params, S).slice(2);

describe('normaliseRef', () => {
  it('adds the @ agent-browser expects', () => expect(normaliseRef('e12')).toBe('@e12'));
  it('leaves an already-prefixed ref alone', () => expect(normaliseRef('@e12')).toBe('@e12'));
  it('passes a CSS selector through untouched', () => expect(normaliseRef('#submit')).toBe('#submit'));
  it('passes a text selector through untouched', () => expect(normaliseRef('.item a')).toBe('.item a'));
});

describe('toAgentBrowserArgv', () => {
  it('always pins the session first', () => {
    expect(toAgentBrowserArgv('browser.snapshot', {}, S).slice(0, 2)).toEqual(['--session', S]);
  });

  it('maps navigate to open', () => {
    expect(verb('browser.navigate', { url: 'https://example.com' })).toEqual(['open', 'https://example.com']);
  });

  it('maps snapshot', () => expect(verb('browser.snapshot')).toEqual(['snapshot']));

  it('maps click with a ref', () => {
    expect(verb('browser.click', { ref: 'e2' })).toEqual(['click', '@e2']);
  });

  it('maps type', () => {
    expect(verb('browser.type', { ref: 'e3', text: 'hello' })).toEqual(['type', '@e3', 'hello']);
  });

  it('maps fill', () => {
    expect(verb('browser.fill', { ref: 'e3', value: 'a@b.com' })).toEqual(['fill', '@e3', 'a@b.com']);
  });

  it('maps get_text with a ref to `get text`', () => {
    expect(verb('browser.get_text', { ref: 'e1' })).toEqual(['get', 'text', '@e1']);
  });

  it('maps get_text with NO ref to `read` (whole page)', () => {
    expect(verb('browser.get_text', {})).toEqual(['read']);
  });

  it('maps screenshot, and --full only when asked', () => {
    expect(verb('browser.screenshot', {})).toEqual(['screenshot', '--json']);
    expect(verb('browser.screenshot', { fullPage: true })).toEqual(['screenshot', '--full', '--json']);
  });

  it('maps eval', () => {
    expect(verb('browser.eval', { js: '1+1' })).toEqual(['eval', '1+1']);
  });

  it('maps wait with a ref, and with a bare timeout', () => {
    expect(verb('browser.wait', { ref: 'e5' })).toEqual(['wait', '@e5']);
    expect(verb('browser.wait', { timeout: 500 })).toEqual(['wait', '500']);
  });

  it('maps the history verbs', () => {
    expect(verb('browser.back')).toEqual(['back']);
    expect(verb('browser.forward')).toEqual(['forward']);
    expect(verb('browser.reload')).toEqual(['reload']);
  });

  it('throws a -32601 for an unknown method, matching the web engine', () => {
    expect(() => toAgentBrowserArgv('browser.nope', {}, S)).toThrow(/Unknown/);
  });

  it('never returns a single shell string — argv stays an array', () => {
    const argv = toAgentBrowserArgv('browser.eval', { js: 'a && b; rm -rf /' }, S);
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toContain('a && b; rm -rf /');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent-browser-verbs.test.ts`
Expected: FAIL — cannot find module `src/main/agent-browser-verbs`.

- [ ] **Step 3: Write the implementation**

Create `src/main/agent-browser-verbs.ts`:

```ts
/**
 * wmux browser verb → agent-browser argv.
 *
 * Deliberately PURE and I/O-free: this is the piece most likely to drift as
 * agent-browser's CLI evolves, so it must be exhaustively testable without a
 * daemon, a Chrome, or an Electron.
 *
 * Returns an argv ARRAY, never a shell string. Callers pass it straight to
 * execFile. `params` originates from a pipe command an agent controls, so a
 * joined string here would be a command-injection hole.
 */

/**
 * wmux refs are `e12`; agent-browser wants `@e12`. Anything that is not a bare
 * wmux ref is passed through untouched, because agent-browser accepts CSS and
 * text selectors in the same position.
 */
export function normaliseRef(ref: string): string {
  return /^e\d+$/.test(ref) ? `@${ref}` : ref;
}

export function toAgentBrowserArgv(method: string, params: any, session: string): string[] {
  const p = params ?? {};
  const head = ['--session', session];
  const ref = typeof p.ref === 'string' ? normaliseRef(p.ref) : undefined;

  switch (method) {
    case 'browser.navigate':  return [...head, 'open', String(p.url ?? '')];
    case 'browser.snapshot':  return [...head, 'snapshot'];
    case 'browser.click':     return [...head, 'click', ref!];
    case 'browser.type':      return [...head, 'type', ref!, String(p.text ?? '')];
    case 'browser.fill':      return [...head, 'fill', ref!, String(p.value ?? '')];
    // No ref means "the whole page" in wmux. agent-browser spells that `read`,
    // which returns agent-readable text rather than a raw innerText dump.
    case 'browser.get_text':  return ref ? [...head, 'get', 'text', ref] : [...head, 'read'];
    case 'browser.screenshot':
      return [...head, 'screenshot', ...(p.fullPage ? ['--full'] : []), '--json'];
    case 'browser.eval':      return [...head, 'eval', String(p.js ?? '')];
    case 'browser.wait':
      return ref ? [...head, 'wait', ref] : [...head, 'wait', String(p.timeout ?? 1000)];
    case 'browser.back':      return [...head, 'back'];
    case 'browser.forward':   return [...head, 'forward'];
    case 'browser.reload':    return [...head, 'reload'];
    default:
      // Same code the web engine uses, so a caller cannot tell the engines
      // apart by their error for an unsupported verb.
      throw Object.assign(new Error(`Unknown: ${method}`), { rpcCode: -32601 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent-browser-verbs.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-browser-verbs.ts tests/unit/agent-browser-verbs.test.ts
git commit -m "feat(agent-browser): pure verb → argv translation table"
```

- [ ] **Step 6: Live-verify the resolved binary actually runs**

Task 3's `.cmd` question is settled (see the RESOLVED note in Task 3): resolution
targets the package's real `.exe`, never the shim. What still needs a live check
is that the resolved path runs and that resolution finds it on a real install:

```bash
npm install -g agent-browser
node -e "
  const { execFile } = require('child_process');
  const path = require('path');
  const p = path.join(process.env.APPDATA, 'npm', 'node_modules', 'agent-browser',
                      'bin', 'agent-browser-win32-x64.exe');
  execFile(p, ['--version'], (e, out) => console.log(e ? 'FAILED: ' + e.message : 'OK: ' + out.trim()));
"
```

Expected: `OK: <version>` — a real `.exe` spawns fine with an argv array and no
shell. Then confirm wmux's own resolver agrees:

```bash
npx tsx -e "import('./src/main/agent-browser-cli.ts').then(m => console.log(m.agentBrowserPath()))"
```

Expected: the same `.exe` path. If it returns a `.cmd`, the search order
regressed — fix the order, do not reach for `shell: true`.

---

## Task 5: Session registry and stream ports

**Files:**
- Create: `src/main/agent-browser-session.ts`
- Test: `tests/unit/agent-browser-session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent-browser-session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SessionRegistry, sessionNameFor, DASHBOARD_PORT } from '../../src/main/agent-browser-session';

describe('sessionNameFor', () => {
  it('derives a stable name from the surface id', () => {
    expect(sessionNameFor('surf-abc123' as any)).toBe('wmux-surf-abc123');
    expect(sessionNameFor('surf-abc123' as any)).toBe('wmux-surf-abc123');
  });

  it('namespaces wmux sessions so the reaper can recognise its own', () => {
    expect(sessionNameFor('surf-x' as any).startsWith('wmux-')).toBe(true);
  });
});

describe('SessionRegistry', () => {
  it('assigns a distinct stream port per surface', () => {
    const r = new SessionRegistry(9300);
    const a = r.ensure('surf-a' as any);
    const b = r.ensure('surf-b' as any);
    expect(a.streamPort).toBe(9300);
    expect(b.streamPort).toBe(9301);
    expect(a.sessionName).not.toBe(b.sessionName);
  });

  it('is idempotent for the same surface', () => {
    const r = new SessionRegistry(9300);
    expect(r.ensure('surf-a' as any)).toEqual(r.ensure('surf-a' as any));
  });

  it('deep-links the dashboard to the session stream port', () => {
    const r = new SessionRegistry(9300);
    expect(r.ensure('surf-a' as any).dashboardUrl)
      .toBe(`http://127.0.0.1:${DASHBOARD_PORT}/?port=9300`);
  });

  it('releases a port so a later surface can reuse it', () => {
    const r = new SessionRegistry(9300);
    r.ensure('surf-a' as any);
    r.ensure('surf-b' as any);
    r.release('surf-a' as any);
    expect(r.ensure('surf-c' as any).streamPort).toBe(9300);
  });

  it('reports nothing for a surface it has never seen', () => {
    expect(new SessionRegistry(9300).get('surf-nope' as any)).toBeUndefined();
  });

  it('lists live sessions so teardown can close them all', () => {
    const r = new SessionRegistry(9300);
    r.ensure('surf-a' as any);
    r.ensure('surf-b' as any);
    expect(r.all().map((s) => s.sessionName).sort()).toEqual(['wmux-surf-a', 'wmux-surf-b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent-browser-session.test.ts`
Expected: FAIL — cannot find module `src/main/agent-browser-session`.

- [ ] **Step 3: Write the implementation**

Create `src/main/agent-browser-session.ts`:

```ts
/**
 * surfaceId → agent-browser session.
 *
 * Sessions are EPHEMERAL: a session's process lifetime equals its surface's
 * lifetime. Nothing is persisted — no --profile dir, no --restore. That makes
 * orphan handling correct by construction rather than by heuristic: there is no
 * such thing as a legitimately-surviving wmux-owned session, so any `wmux-`
 * prefixed session with no live surface is garbage. This is the property the
 * #139 post-mortem wanted and did not have.
 *
 * wmux allocates the stream port ITSELF rather than letting agent-browser pick
 * one, because the dashboard deep-link keys on port
 * (packages/dashboard/src/store/sessions.ts reads `?port=` into activePortAtom).
 * Discovering an OS-assigned port after the fact is a race against the webview
 * load.
 */
import type { SurfaceId } from '../shared/types';

/** agent-browser's dashboard default. */
export const DASHBOARD_PORT = 4848;

/** First stream port wmux hands out. Above the CDP proxy's 9222-9230 range. */
export const STREAM_PORT_BASE = 9300;

/**
 * Session names are prefixed so the reaper and `agent-browser session list` can
 * tell a wmux-owned session from one the user made by hand. Never close a
 * session without this prefix.
 */
export const WMUX_SESSION_PREFIX = 'wmux-';

export function sessionNameFor(surfaceId: SurfaceId): string {
  return `${WMUX_SESSION_PREFIX}${surfaceId}`;
}

export interface AgentSession {
  surfaceId: SurfaceId;
  sessionName: string;
  streamPort: number;
  dashboardUrl: string;
}

export class SessionRegistry {
  private readonly sessions = new Map<SurfaceId, AgentSession>();
  private readonly usedPorts = new Set<number>();

  constructor(private readonly basePort: number = STREAM_PORT_BASE) {}

  private nextPort(): number {
    let p = this.basePort;
    while (this.usedPorts.has(p)) p++;
    this.usedPorts.add(p);
    return p;
  }

  ensure(surfaceId: SurfaceId): AgentSession {
    const existing = this.sessions.get(surfaceId);
    if (existing) return existing;
    const streamPort = this.nextPort();
    const session: AgentSession = {
      surfaceId,
      sessionName: sessionNameFor(surfaceId),
      streamPort,
      dashboardUrl: `http://127.0.0.1:${DASHBOARD_PORT}/?port=${streamPort}`,
    };
    this.sessions.set(surfaceId, session);
    return session;
  }

  get(surfaceId: SurfaceId): AgentSession | undefined {
    return this.sessions.get(surfaceId);
  }

  all(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /** Forget a surface's session and free its port. Caller closes the browser. */
  release(surfaceId: SurfaceId): AgentSession | undefined {
    const s = this.sessions.get(surfaceId);
    if (!s) return undefined;
    this.usedPorts.delete(s.streamPort);
    this.sessions.delete(surfaceId);
    return s;
  }

  get size(): number {
    return this.sessions.size;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent-browser-session.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-browser-session.ts tests/unit/agent-browser-session.test.ts
git commit -m "feat(agent-browser): ephemeral session registry with wmux-allocated stream ports"
```

---

## Task 6: The dashboard daemon

**Files:**
- Create: `src/main/agent-browser-daemon.ts`
- Test: append to `tests/unit/agent-browser-session.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agent-browser-session.test.ts`:

```ts
import { DashboardDaemon } from '../../src/main/agent-browser-daemon';

/** A daemon whose process control and port probe are both stubbed. */
function daemonWith(portAlreadyOpen: boolean) {
  const calls: string[] = [];
  const d = new DashboardDaemon({
    probe: async () => portAlreadyOpen,
    start: async () => { calls.push('start'); return true; },
    stop: async () => { calls.push('stop'); },
  });
  return { d, calls };
}

describe('DashboardDaemon', () => {
  it('starts on the first acquire and stops when the last is released', async () => {
    const { d, calls } = daemonWith(false);
    await d.acquire();
    await d.acquire();
    expect(calls).toEqual(['start']);
    await d.release();
    expect(calls).toEqual(['start']);
    await d.release();
    expect(calls).toEqual(['start', 'stop']);
  });

  it('adopts a dashboard someone else started, and never stops it', async () => {
    const { d, calls } = daemonWith(true);
    await d.acquire();
    expect(calls).toEqual([]);
    expect(d.adopted).toBe(true);
    await d.release();
    expect(calls).toEqual([]);
  });

  it('never lets the refcount go negative', async () => {
    const { d, calls } = daemonWith(false);
    await d.release();
    await d.release();
    expect(calls).toEqual([]);
    await d.acquire();
    expect(calls).toEqual(['start']);
  });

  it('shutdown stops an owned dashboard regardless of refcount', async () => {
    const { d, calls } = daemonWith(false);
    await d.acquire();
    await d.acquire();
    await d.shutdown();
    expect(calls).toEqual(['start', 'stop']);
  });

  it('shutdown leaves an adopted dashboard running', async () => {
    const { d, calls } = daemonWith(true);
    await d.acquire();
    await d.shutdown();
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent-browser-session.test.ts`
Expected: FAIL — cannot find module `src/main/agent-browser-daemon`.

- [ ] **Step 3: Write the implementation**

Create `src/main/agent-browser-daemon.ts`:

```ts
/**
 * The agent-browser observability dashboard process.
 *
 * Refcounted by the number of live agent-mode surfaces: first acquire starts
 * it, last release stops it.
 *
 * ── Adopt, never fight ────────────────────────────────────────────────────
 * If :4848 already answers when we go to start, a human (or another wmux)
 * started it. We use it and record `adopted`. An adopted dashboard is NEVER
 * stopped — not on the last release, not on shutdown. wmux did not start it, so
 * stopping it is not wmux's to do, and killing a dashboard the user is watching
 * in their own Chrome would be a genuinely baffling bug to report.
 *
 * Process control is injected so this is testable with no child processes.
 */
export interface DaemonHooks {
  /** True when something is already listening on the dashboard port. */
  probe: () => Promise<boolean>;
  /** Start the dashboard. Returns false if it could not be started. */
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
}

export class DashboardDaemon {
  private refs = 0;
  private running = false;
  /** True when the dashboard was already up and we merely attached to it. */
  adopted = false;

  constructor(private readonly hooks: DaemonHooks) {}

  async acquire(): Promise<void> {
    this.refs++;
    if (this.running || this.adopted) return;
    if (await this.hooks.probe()) {
      this.adopted = true;
      return;
    }
    this.running = await this.hooks.start();
  }

  async release(): Promise<void> {
    // Clamp at zero. A double-release from an unmount racing a surface close
    // must not drive the count negative and strand a running dashboard.
    if (this.refs > 0) this.refs--;
    if (this.refs > 0) return;
    if (this.running && !this.adopted) {
      await this.hooks.stop();
      this.running = false;
    }
  }

  /** Teardown on app quit. Ignores the refcount; still respects adoption. */
  async shutdown(): Promise<void> {
    this.refs = 0;
    if (this.running && !this.adopted) {
      await this.hooks.stop();
      this.running = false;
    }
  }

  get isAvailable(): boolean {
    return this.running || this.adopted;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent-browser-session.test.ts`
Expected: PASS, 12 tests total (7 registry + 5 daemon).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-browser-daemon.ts tests/unit/agent-browser-session.test.ts
git commit -m "feat(agent-browser): refcounted dashboard daemon that adopts rather than fights"
```

---

## Task 7: Route `browser.*` by engine

**Files:**
- Modify: `src/main/v2-browser.ts` (whole-file change: `resolveBrowserWcId` → `resolveBrowserTarget`)
- Test: extend `tests/unit/agent-browser-routing.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agent-browser-routing.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runBrowserCommandForTarget } from '../../src/main/v2-browser';

const bridge = {
  navigate: vi.fn(async () => {}),
  snapshot: vi.fn(async () => ({ tree: 'x', refCount: 1 })),
  goBack: vi.fn(async () => {}),
};

describe('runBrowserCommandForTarget', () => {
  it('web targets reach the CDP bridge', async () => {
    const runner = vi.fn();
    await runBrowserCommandForTarget(
      'browser.navigate', { url: 'https://a' },
      { kind: 'web', wcId: 7 },
      { bridge: bridge as any, runAgent: runner },
    );
    expect(bridge.navigate).toHaveBeenCalledWith('https://a', undefined, 7);
    expect(runner).not.toHaveBeenCalled();
  });

  it('agent targets shell out with the session pinned, and never touch the bridge', async () => {
    const runner = vi.fn(async () => ({ ok: true, data: { url: 'https://a' }, stdout: '', stderr: '' }));
    bridge.navigate.mockClear();
    await runBrowserCommandForTarget(
      'browser.navigate', { url: 'https://a' },
      { kind: 'agent', session: { surfaceId: 'surf-a', sessionName: 'wmux-surf-a', streamPort: 9300, dashboardUrl: 'x' } as any },
      { bridge: bridge as any, runAgent: runner },
    );
    expect(runner).toHaveBeenCalledWith(['--session', 'wmux-surf-a', 'open', 'https://a']);
    expect(bridge.navigate).not.toHaveBeenCalled();
  });

  it('surfaces an agent-browser failure as an error, not a silent ok', async () => {
    const runner = vi.fn(async () => ({ ok: false, data: null, stdout: '', stderr: 'chrome not installed' }));
    await expect(runBrowserCommandForTarget(
      'browser.snapshot', {},
      { kind: 'agent', session: { sessionName: 'wmux-surf-a' } as any },
      { bridge: bridge as any, runAgent: runner },
    )).rejects.toThrow(/chrome not installed/);
  });

  it('rejects an unknown verb identically on both engines', async () => {
    const opts = { bridge: bridge as any, runAgent: vi.fn() };
    await expect(runBrowserCommandForTarget('browser.nope', {}, { kind: 'web', wcId: 1 }, opts)).rejects.toThrow(/Unknown/);
    await expect(runBrowserCommandForTarget('browser.nope', {}, { kind: 'agent', session: { sessionName: 'w' } as any }, opts)).rejects.toThrow(/Unknown/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent-browser-routing.test.ts`
Expected: FAIL — `runBrowserCommandForTarget` is not exported from `v2-browser`.

- [ ] **Step 3: Refactor `runBrowserCommand` into an injectable, target-aware function**

In `src/main/v2-browser.ts`, add near the top:

```ts
import { toAgentBrowserArgv } from './agent-browser-verbs';
import type { AgentSession } from './agent-browser-session';

export type BrowserTarget =
  | { kind: 'web'; wcId: number }
  | { kind: 'agent'; session: AgentSession };

/** Injected so routing is testable with no Electron and no daemon. */
export interface BrowserDeps {
  bridge: typeof cdpBridge;
  runAgent: (argv: string[]) => Promise<{ ok: boolean; data: any; stdout: string; stderr: string }>;
}
```

Replace the body of `runBrowserCommand` with a target-aware version. Keep the existing web branch verbatim — it is the behaviour every current user depends on:

```ts
/**
 * Run one browser verb against a resolved target.
 *
 * The two engines must be indistinguishable to a caller apart from what they
 * can see: same verb names, same result shapes, and the SAME error for an
 * unknown verb (hence toAgentBrowserArgv throwing the identical -32601).
 */
export async function runBrowserCommandForTarget(
  method: string,
  params: any,
  target: BrowserTarget,
  deps: BrowserDeps,
): Promise<any> {
  if (target.kind === 'agent') {
    // Throws -32601 for an unknown verb before any process is spawned.
    const argv = toAgentBrowserArgv(method, params, target.session.sessionName);
    const res = await deps.runAgent(argv);
    if (!res.ok) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || `agent-browser ${method} failed`);
    }
    return agentResultShape(method, res);
  }

  const { wcId } = target;
  const b = deps.bridge;
  switch (method) {
    case 'browser.navigate':   await b.navigate(params?.url, params?.timeout, wcId); return { ok: true };
    case 'browser.snapshot':   return b.snapshot(wcId);
    case 'browser.click':      await b.click(params?.ref, wcId); return { ok: true };
    case 'browser.type':       await b.type(params?.ref, params?.text, wcId); return { ok: true };
    case 'browser.fill':       await b.fill(params?.ref, params?.value, wcId); return { ok: true };
    case 'browser.screenshot': return { data: await b.screenshot(params?.fullPage, wcId) };
    case 'browser.get_text':   return { text: await b.getText(params?.ref, wcId) };
    case 'browser.eval':       return { result: await b.evaluate(params?.js, wcId) };
    case 'browser.wait':       await b.wait(params?.ref, params?.timeout, wcId); return { ok: true };
    case 'browser.back':       await b.goBack(wcId); return { ok: true };
    case 'browser.forward':    await b.goForward(wcId); return { ok: true };
    case 'browser.reload':     await b.reload(wcId); return { ok: true };
    default:
      throw Object.assign(new Error(`Unknown: ${method}`), { rpcCode: -32601 });
  }
}

/**
 * Coerce an agent-browser result into the shape the web engine returns, so a
 * caller written against one engine keeps working on the other.
 */
function agentResultShape(method: string, res: { data: any; stdout: string }): any {
  switch (method) {
    case 'browser.snapshot':   return res.data ?? { tree: res.stdout, refCount: 0 };
    case 'browser.get_text':   return { text: res.data?.text ?? res.stdout };
    case 'browser.screenshot': return { data: res.data?.data ?? res.data?.base64 ?? res.stdout.trim() };
    case 'browser.eval':       return { result: res.data?.result ?? res.data };
    default:                   return { ok: true };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent-browser-routing.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire target resolution into the existing entry points**

Still in `v2-browser.ts`, add alongside `resolveBrowserWcId`. Keep all of its existing per-caller binding logic (#62) — only the return type changes:

```ts
/**
 * Which engine backs the browser surface this caller is bound to?
 *
 * Asks the renderer, because the split tree is the store's. A surface that has
 * gone away answers 'web', which is correct: the web path re-creates a pane,
 * while the agent path would spin up a Chrome for a surface nobody can see.
 */
async function engineForSurface(surfaceId: string): Promise<'web' | 'agent'> {
  const win = firstWindow();
  if (!win) return 'web';
  const engine = await win.webContents.executeJavaScript(
    `window.__wmux_getBrowserEngine?.(${JSON.stringify(surfaceId)}) ?? 'web'`,
  );
  return engine === 'agent' ? 'agent' : 'web';
}

export async function resolveBrowserTarget(caller?: string): Promise<BrowserTarget | null> {
  const surfaceId = caller ? callerBrowserSurface.get(caller) : undefined;
  if (surfaceId && (await engineForSurface(surfaceId)) === 'agent') {
    return { kind: 'agent', session: sessionRegistry.ensure(surfaceId as any) };
  }
  const wcId = await resolveBrowserWcId(caller);
  if (wcId === null) {
    // The caller may have JUST been bound to an agent-mode surface by
    // resolveBrowserWcId's own creation path, so re-check before giving up.
    const bound = caller ? callerBrowserSurface.get(caller) : undefined;
    if (bound && (await engineForSurface(bound)) === 'agent') {
      return { kind: 'agent', session: sessionRegistry.ensure(bound as any) };
    }
    return null;
  }
  return { kind: 'web', wcId };
}
```

Update `handleBrowserV2` and `handleBrowserBatch` to use it:

```ts
const target = await resolveBrowserTarget(params?.caller);
if (target === null) { respondError(-32000, 'Could not open browser panel'); return; }
respond(await runBrowserCommandForTarget(method, params, target, defaultDeps));
```

where `defaultDeps` is defined once in the module:

```ts
const defaultDeps: BrowserDeps = {
  bridge: cdpBridge,
  runAgent: async (argv) => {
    const bin = agentBrowserPath();
    if (!bin) throw new Error('agent-browser is not installed — open a browser tab in agent mode to install it');
    await dashboardDaemon.acquire();
    return runAgentBrowser(bin, argv);
  },
};
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Pay particular attention to `caller-scope.test.ts` and `browser-timeout.test.ts` — both exercise the routing this task rewrote.

- [ ] **Step 7: Commit**

```bash
git add src/main/v2-browser.ts tests/unit/agent-browser-routing.test.ts
git commit -m "feat(browser): route browser.* verbs by surface engine"
```

---

## Task 8: Renderer — engine branch in `BrowserPane`

**Files:**
- Modify: `src/renderer/components/Browser/BrowserPane.tsx`
- Modify: `src/renderer/components/SplitPane/PaneWrapper.tsx:273-286`
- Test: extend `tests/unit/agent-browser-routing.test.ts`

- [ ] **Step 1: Write the failing guard test**

This is a source-level pin, the same shape as the `opencode-plugin` export-count test. Append to `tests/unit/agent-browser-routing.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

describe('BrowserPane agent-mode guards', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/components/Browser/BrowserPane.tsx'),
    'utf8',
  );

  it('guards claimCdp on the engine, inside the function itself', () => {
    // Inside claimCdp, not merely at its call sites: registering the dashboard
    // page as a CDP target would make `wmux browser` commands aimed at this
    // surface drive the dashboard's own DOM. A future call site must not be
    // able to reintroduce that.
    const body = src.slice(src.indexOf('const claimCdp'), src.indexOf('const installPopupBridge'));
    expect(body).toMatch(/engine\s*===\s*'agent'/);
  });

  it('guards the popup bridge on the engine', () => {
    const body = src.slice(src.indexOf('const installPopupBridge'), src.indexOf('const lastRecoveryRef'));
    expect(body).toMatch(/engine\s*===\s*'agent'/);
  });

  it('never re-points the webview via src — the double-load trap at line 14', () => {
    // src is bound to initialSrc exactly once. An engine switch must go through
    // loadURL, or it reintroduces the spurious ERR_ABORTED that comment records.
    expect(src).toMatch(/src=\{initialSrc\}/);
    expect(src).not.toMatch(/src=\{(currentUrl|url|dashboardUrl)\}/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent-browser-routing.test.ts`
Expected: FAIL on the first two — `BrowserPane.tsx` has no `engine` yet.

- [ ] **Step 3: Add the engine prop and its guards**

In `src/renderer/components/Browser/BrowserPane.tsx`, extend the props:

```ts
import type { BrowserEngine } from '../../../shared/types';

interface BrowserPaneProps {
  initialUrl?: string;
  surfaceId: string;
  workspaceId?: string;
  engine?: BrowserEngine;
  onUrlChange?: (url: string) => void;
  onEngineChange?: (engine: BrowserEngine) => void;
}
```

and the signature:

```ts
export default function BrowserPane({
  initialUrl = 'https://github.com/amirlehmam/wmux',
  surfaceId,
  workspaceId,
  engine = 'web',
  onUrlChange,
  onEngineChange,
}: BrowserPaneProps) {
```

Guard `claimCdp` (currently line 81-87) from the inside:

```ts
  const claimCdp = useCallback(() => {
    // Agent mode renders agent-browser's dashboard, not a page the user asked
    // for. Registering it as a CDP target would point `wmux browser` commands
    // for this surface at the dashboard's own DOM. The check lives HERE rather
    // than at the call sites so a new call site cannot reintroduce it.
    if (engine === 'agent') return;
    const wcId = webviewRef.current?.getWebContentsId?.();
    if (wcId && window.wmux?.cdp?.attach) {
      wcIdRef.current = wcId;
      window.wmux.cdp.attach(wcId, surfaceId, workspaceId ?? null);
    }
  }, [surfaceId, workspaceId, engine]);
```

Guard the popup bridge (currently line 92-94):

```ts
  const installPopupBridge = useCallback(() => {
    // The bridge exists for target="_blank" on arbitrary sites (#126). The
    // dashboard is a known SPA that does not need it.
    if (engine === 'agent') return;
    webviewRef.current?.executeJavaScript?.(popupBridgeSource()).catch(() => {});
  }, [engine]);
```

- [ ] **Step 4: Switch the loaded page when the engine changes**

Add after the existing navigation effect (around line 149). This uses `loadURL`, never `src`:

```ts
  // Engine switch. Goes through loadURL for the reason recorded at the top of
  // this file: binding `src` to mutable state double-loads and produces a
  // spurious ERR_ABORTED.
  const prevEngineRef = useRef(engine);
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  useEffect(() => {
    if (prevEngineRef.current === engine) return;
    prevEngineRef.current = engine;
    let cancelled = false;
    (async () => {
      if (engine === 'agent') {
        const res = await window.wmux?.agentBrowser?.enable(surfaceId, currentUrl);
        if (cancelled) return;
        if (res?.dashboardUrl) {
          setAgentUrl(res.dashboardUrl);
          webviewRef.current?.loadURL(res.dashboardUrl).catch(() => {});
        }
      } else {
        // Carry the page the agent browser was on back to the webview, so the
        // tab feels like one browser with two backends.
        const last = await window.wmux?.agentBrowser?.disable(surfaceId);
        if (cancelled) return;
        setAgentUrl(null);
        navigate(last?.url || currentUrl);
      }
    })();
    return () => { cancelled = true; };
  }, [engine, surfaceId, currentUrl, navigate]);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent-browser-routing.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Pass the engine down from `PaneWrapper`**

In `src/renderer/components/SplitPane/PaneWrapper.tsx`, extend the `BrowserPane` element at line 273:

```tsx
            <BrowserPane
              surfaceId={surface.id}
              workspaceId={workspaceId}
              engine={surface.browserEngine ?? 'web'}
              onEngineChange={(e) => updateSurface(workspaceId, paneId, surface.id, { browserEngine: e })}
              {...(surface.url ? { initialUrl: surface.url } : {})}
              onUrlChange={(u) => {
                if (u && u !== 'about:blank') {
                  updateSurface(workspaceId, paneId, surface.id, { url: u });
                }
              }}
            />
```

- [ ] **Step 7: Typecheck and commit**

Run: `npm run build:main && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add src/renderer/components/Browser/BrowserPane.tsx src/renderer/components/SplitPane/PaneWrapper.tsx tests/unit/agent-browser-routing.test.ts
git commit -m "feat(browser): engine-aware BrowserPane with CDP and popup-bridge guards"
```

---

## Task 9: IPC, preload and the pipe bridge

**Files:**
- Modify: `src/shared/types.ts` (`IPC_CHANNELS`)
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/pipe-bridge.ts`

- [ ] **Step 1: Add the channels**

In `src/shared/types.ts`, inside `IPC_CHANNELS`:

```ts
  AGENT_BROWSER_ENABLE: 'agent-browser:enable',
  AGENT_BROWSER_DISABLE: 'agent-browser:disable',
  AGENT_BROWSER_STATUS: 'agent-browser:status',
  AGENT_BROWSER_INSTALL: 'agent-browser:install',
```

- [ ] **Step 2: Handle them in main**

In `src/main/ipc-handlers.ts`:

```ts
import { agentBrowserPath, runAgentBrowser } from './agent-browser-cli';
import { SessionRegistry } from './agent-browser-session';
import { dashboardDaemon } from './agent-browser-daemon-instance';

export const sessionRegistry = new SessionRegistry();

ipcMain.handle(IPC_CHANNELS.AGENT_BROWSER_STATUS, async () => ({
  installed: agentBrowserPath() !== null,
  dashboardAvailable: dashboardDaemon.isAvailable,
}));

ipcMain.handle(IPC_CHANNELS.AGENT_BROWSER_ENABLE, async (_e, surfaceId: string, currentUrl?: string) => {
  const bin = agentBrowserPath();
  if (!bin) return { installed: false };
  await dashboardDaemon.acquire();
  const session = sessionRegistry.ensure(surfaceId as any);
  // Launch the session on its OWN stream port so the dashboard deep-link
  // resolves, and --pin-tab so a second pane's session cannot steal this
  // session's tab.
  await runAgentBrowser(bin, [
    '--session', session.sessionName,
    '--pin-tab',
    'open',
    ...(currentUrl && currentUrl !== 'about:blank' ? [currentUrl] : []),
  ]);
  await runAgentBrowser(bin, ['--session', session.sessionName, 'stream', 'enable', '--port', String(session.streamPort)]);
  return { installed: true, dashboardUrl: session.dashboardUrl, sessionName: session.sessionName };
});

ipcMain.handle(IPC_CHANNELS.AGENT_BROWSER_DISABLE, async (_e, surfaceId: string) => {
  const bin = agentBrowserPath();
  const session = sessionRegistry.get(surfaceId as any);
  let url: string | undefined;
  if (bin && session) {
    // Read the page back BEFORE closing, so flipping to web mode lands on
    // whatever the agent browser was showing.
    const got = await runAgentBrowser(bin, ['--session', session.sessionName, 'get', 'url']);
    url = (got.data?.url ?? got.stdout.trim()) || undefined;
    await runAgentBrowser(bin, ['--session', session.sessionName, 'close']);
  }
  sessionRegistry.release(surfaceId as any);
  await dashboardDaemon.release();
  return { url };
});
```

- [ ] **Step 3: Expose them on `window.wmux`**

In `src/preload/index.ts`, alongside the existing `browser` group:

```ts
  agentBrowser: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_BROWSER_STATUS),
    enable: (surfaceId: string, currentUrl?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_BROWSER_ENABLE, surfaceId, currentUrl),
    disable: (surfaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_BROWSER_DISABLE, surfaceId),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_BROWSER_INSTALL),
  },
```

- [ ] **Step 4: Add the pipe-bridge globals main reads**

In `src/renderer/pipe-bridge.ts`, next to the other `window.__wmux_*` exports:

```ts
/**
 * The engine backing a browser surface. Read by v2-browser.ts to decide which
 * engine a `browser.*` verb should run on. Returns 'web' for an unknown
 * surface, which is the safe answer: it needs no external binary.
 */
window.__wmux_getBrowserEngine = (surfaceId: string): 'web' | 'agent' => {
  const { workspaces } = useStore.getState();
  for (const ws of workspaces) {
    for (const paneId of getAllPaneIds(ws.splitTree)) {
      const leaf = findLeaf(ws.splitTree, paneId);
      const surface = leaf?.surfaces.find((s) => s.id === surfaceId);
      if (surface) return surface.browserEngine === 'agent' ? 'agent' : 'web';
    }
  }
  return 'web';
};

window.__wmux_setBrowserEngine = (surfaceId: string, engine: 'web' | 'agent'): boolean => {
  const { workspaces, updateSurface } = useStore.getState();
  for (const ws of workspaces) {
    for (const paneId of getAllPaneIds(ws.splitTree)) {
      const leaf = findLeaf(ws.splitTree, paneId);
      const surface = leaf?.surfaces.find((s) => s.id === surfaceId);
      if (surface && surface.type === 'browser') {
        updateSurface(ws.id, paneId, surfaceId as any, { browserEngine: engine });
        return true;
      }
    }
  }
  return false;
};
```

- [ ] **Step 5: Typecheck, test, commit**

Run: `npm run build:main && npm test`
Expected: PASS.

```bash
git add src/shared/types.ts src/main/ipc-handlers.ts src/preload/index.ts src/renderer/pipe-bridge.ts
git commit -m "feat(agent-browser): IPC + pipe-bridge for engine control"
```

---

## Task 10: The AddressBar toggle and the setup card

**Files:**
- Create: `src/renderer/components/Browser/AgentBrowserSetup.tsx`
- Modify: `src/renderer/components/Browser/AddressBar.tsx`
- Modify: `src/renderer/styles/browser.css`

- [ ] **Step 1: Add the toggle to the AddressBar**

In `src/renderer/components/Browser/AddressBar.tsx`, extend props with `engine: BrowserEngine` and `onEngineChange: (e: BrowserEngine) => void`, and render before the URL field:

```tsx
      <div className="address-bar__engine" role="group" aria-label="Browser engine">
        <button
          className={`address-bar__engine-btn${engine === 'web' ? ' address-bar__engine-btn--active' : ''}`}
          onClick={() => onEngineChange('web')}
          title="wmux browser — the built-in web view"
        >web</button>
        <button
          className={`address-bar__engine-btn${engine === 'agent' ? ' address-bar__engine-btn--active' : ''}`}
          onClick={() => onEngineChange('agent')}
          title="agent-browser — a real Chrome your agent drives, with a live activity feed"
        >✦ agent</button>
      </div>
```

- [ ] **Step 2: Create the setup card**

Create `src/renderer/components/Browser/AgentBrowserSetup.tsx`:

```tsx
import { useState } from 'react';

interface Props {
  /** Run the install in a visible terminal surface and resolve when it exits. */
  onInstall: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Shown in place of the webview when agent mode is selected but the
 * `agent-browser` binary is not installed.
 *
 * The install deliberately runs in a REAL terminal surface rather than behind a
 * spinner: it is ~240 MB of npm plus a Chrome-for-Testing download, and when it
 * fails the user needs to read why.
 */
export default function AgentBrowserSetup({ onInstall, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="agent-browser-setup">
      <h2 className="agent-browser-setup__title">✦ agent-browser</h2>
      <p className="agent-browser-setup__body">
        Vercel's agent-browser gives this tab a real Chrome that your agent drives,
        with a live viewport and an activity feed of every command it runs.
      </p>
      <p className="agent-browser-setup__meta">Not installed yet — about 240 MB, once.</p>
      <pre className="agent-browser-setup__cmd">npm i -g agent-browser{'\n'}agent-browser install</pre>
      <div className="agent-browser-setup__actions">
        <button
          className="agent-browser-setup__btn agent-browser-setup__btn--primary"
          disabled={busy}
          onClick={async () => { setBusy(true); try { await onInstall(); } finally { setBusy(false); } }}
        >{busy ? 'Installing…' : 'Install'}</button>
        <button className="agent-browser-setup__btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render it from `BrowserPane`**

In `BrowserPane.tsx`, track install state and branch the body:

```tsx
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    if (engine !== 'agent') return;
    window.wmux?.agentBrowser?.status().then((s: any) => setInstalled(!!s?.installed));
  }, [engine]);

  const showSetup = engine === 'agent' && installed === false;
```

and in the returned JSX, replace the bare `<webview>` with:

```tsx
      {showSetup ? (
        <AgentBrowserSetup
          onInstall={async () => {
            await window.wmux?.agentBrowser?.install();
            const s = await window.wmux?.agentBrowser?.status();
            setInstalled(!!s?.installed);
          }}
          onCancel={() => onEngineChange?.('web')}
        />
      ) : (
        /* @ts-ignore — webview is an Electron-specific HTML element */
        <webview ref={webviewRef} src={initialSrc} className="browser-pane__webview" />
      )}
```

- [ ] **Step 4: Style it**

Append to `src/renderer/styles/browser.css`:

```css
.address-bar__engine { display: flex; gap: 2px; margin-right: 8px; }
.address-bar__engine-btn {
  padding: 2px 8px; font-size: 11px; border: none; border-radius: 4px;
  background: transparent; color: var(--wmux-fg-dim); cursor: pointer;
}
.address-bar__engine-btn--active { background: var(--wmux-accent); color: var(--wmux-bg); }

.agent-browser-setup {
  display: flex; flex-direction: column; align-items: flex-start; justify-content: center;
  gap: 10px; height: 100%; padding: 32px; background: var(--wmux-bg); color: var(--wmux-fg);
}
.agent-browser-setup__title { margin: 0; font-size: 16px; }
.agent-browser-setup__body { margin: 0; max-width: 46ch; line-height: 1.5; color: var(--wmux-fg-dim); }
.agent-browser-setup__meta { margin: 0; font-size: 12px; color: var(--wmux-fg-dim); }
.agent-browser-setup__cmd {
  margin: 0; padding: 10px 12px; border-radius: 6px; font-size: 12px;
  background: var(--wmux-bg-alt); color: var(--wmux-fg);
}
.agent-browser-setup__actions { display: flex; gap: 8px; margin-top: 6px; }
.agent-browser-setup__btn {
  padding: 6px 14px; border: 1px solid var(--wmux-border); border-radius: 6px;
  background: transparent; color: var(--wmux-fg); cursor: pointer;
}
.agent-browser-setup__btn--primary { background: var(--wmux-accent); color: var(--wmux-bg); border-color: transparent; }
.agent-browser-setup__btn:disabled { opacity: 0.6; cursor: default; }
```

- [ ] **Step 5: Build and commit**

Run: `npx vite build`
Expected: succeeds.

```bash
git add src/renderer/components/Browser/ src/renderer/styles/browser.css
git commit -m "feat(browser): engine toggle and agent-browser setup card"
```

---

## Task 11: Install flow + teardown + orphan registration

> **Carried forward from Tasks 5 and 6 review — three constraints this task must honour.**
>
> 1. **`SessionRegistry` is NOT ground truth for what is running.** Its maps are
>    in-memory and start empty after a restart or crash, so a `wmux-` prefixed
>    session that survived a crash is real on the OS and invisible to a fresh
>    registry. Startup reconciliation must consult `agent-browser session list`,
>    never the registry. The "ephemeral ⇒ orphans are unambiguous" property holds
>    for the *naming convention*, not for the in-memory bookkeeping.
>
> 2. **A handed-out stream port may not be bindable.** `nextPort()` tracks only
>    what this process allocated; it never asks the OS. An orphan from a previous
>    wmux — or any unrelated program — can already hold it. Treat an
>    `EADDRINUSE`-style launch failure as "ask the registry for the next port and
>    retry", not as a hard failure.
>
> 3. **`DashboardDaemon.acquire()` throws when `start()` fails.** It rolls the
>    refcount back and rethrows so the caller sees it, rather than reporting a ref
>    it cannot serve. Every call site needs a `try`/`catch` — a surface flipping
>    into agent mode must fall back to the setup card or to `web`, not hang.

**Files:**
- Create: `src/main/agent-browser-daemon-instance.ts`
- Modify: `src/main/ipc-handlers.ts` (the `AGENT_BROWSER_INSTALL` handler)
- Modify: `src/main/index.ts` (quit teardown)

- [ ] **Step 1: Create the singleton daemon wired to real processes**

Create `src/main/agent-browser-daemon-instance.ts`:

```ts
/**
 * The single DashboardDaemon for this wmux process, wired to real child
 * processes and a real port probe. Split from `agent-browser-daemon.ts` so the
 * refcount logic stays unit-testable with no I/O.
 */
import net from 'net';
import { DashboardDaemon } from './agent-browser-daemon';
import { DASHBOARD_PORT } from './agent-browser-session';
import { agentBrowserPath, runAgentBrowser } from './agent-browser-cli';

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (open: boolean) => { sock.destroy(); resolve(open); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

export const dashboardDaemon = new DashboardDaemon({
  probe: () => probePort(DASHBOARD_PORT),
  start: async () => {
    const bin = agentBrowserPath();
    if (!bin) return false;
    const res = await runAgentBrowser(bin, ['dashboard', 'start'], 30_000);
    return res.ok;
  },
  stop: async () => {
    const bin = agentBrowserPath();
    if (!bin) return;
    await runAgentBrowser(bin, ['dashboard', 'stop'], 10_000);
  },
});
```

- [ ] **Step 2: Implement the install handler**

In `src/main/ipc-handlers.ts`:

```ts
ipcMain.handle(IPC_CHANNELS.AGENT_BROWSER_INSTALL, async () => {
  // A REAL terminal surface, not a hidden child process: this is ~240 MB of
  // npm plus a Chrome download, and its failures (proxy, EACCES on the global
  // prefix, no network) are only diagnosable if the user can read them.
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return { started: false };
  await win.webContents.executeJavaScript(`
    window.__wmux_splitPane?.({
      direction: 'vertical',
      type: 'terminal',
      startupCommands: ['npm i -g agent-browser', 'agent-browser install'],
    })
  `);
  return { started: true };
});
```

- [ ] **Step 3: Tear everything down on quit**

In `src/main/index.ts`, in the existing `will-quit` handler:

```ts
  // Sessions are ephemeral (see agent-browser-session.ts), so quitting closes
  // every one of them. Anything wmux-prefixed that outlives this is garbage by
  // definition — which is exactly what makes the reaper's job unambiguous.
  const bin = agentBrowserPath();
  if (bin) {
    for (const s of sessionRegistry.all()) {
      try { await runAgentBrowser(bin, ['--session', s.sessionName, 'close'], 5_000); } catch { /* quitting */ }
    }
  }
  await dashboardDaemon.shutdown();
```

- [ ] **Step 4: Close a session when its surface closes**

In `src/main/ipc-handlers.ts`, in the existing surface-close path (wherever `pty:kill` for a surface is handled), add:

```ts
  // A closed agent-mode surface must not leave a Chrome behind.
  if (sessionRegistry.get(surfaceId as any)) {
    const bin = agentBrowserPath();
    const s = sessionRegistry.release(surfaceId as any);
    if (bin && s) { runAgentBrowser(bin, ['--session', s.sessionName, 'close'], 5_000).catch(() => {}); }
    dashboardDaemon.release().catch(() => {});
  }
```

- [ ] **Step 5: Build, test, commit**

Run: `npm run build:main && npm test`
Expected: PASS.

```bash
git add src/main/agent-browser-daemon-instance.ts src/main/ipc-handlers.ts src/main/index.ts
git commit -m "feat(agent-browser): install flow, session teardown, quit-time cleanup"
```

---

## Task 12: `wmux browser engine` CLI

**Files:**
- Modify: `src/cli/wmux.ts`
- Modify: `src/main/index.ts` (V2 method dispatch)
- Test: extend `tests/unit/cli-subcommands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/cli-subcommands.test.ts`:

```ts
describe('wmux browser engine', () => {
  it('parses a bare read', () => {
    expect(parseArgs(['browser', 'engine'])).toMatchObject({ method: 'browser.get_engine' });
  });

  it('parses a switch to agent', () => {
    expect(parseArgs(['browser', 'engine', 'agent']))
      .toMatchObject({ method: 'browser.set_engine', params: { engine: 'agent' } });
  });

  it('parses an explicit surface', () => {
    expect(parseArgs(['browser', 'engine', 'web', '--surface', 'surf-1']))
      .toMatchObject({ method: 'browser.set_engine', params: { engine: 'web', surface: 'surf-1' } });
  });

  it('rejects an engine that is neither web nor agent', () => {
    expect(() => parseArgs(['browser', 'engine', 'nope'])).toThrow(/web|agent/);
  });
});
```

Adapt the import/helper name to whatever `cli-subcommands.test.ts` already uses to exercise argument parsing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli-subcommands.test.ts`
Expected: FAIL — the `engine` subcommand is unrecognised.

- [ ] **Step 3: Add the subcommand**

In `src/cli/wmux.ts`, in the `browser` verb dispatch, before the CDP verbs:

```ts
    if (sub === 'engine') {
      const value = rest[0];
      const surface = flagValue(rest, '--surface') ?? process.env.WMUX_SURFACE_ID;
      if (!value || value.startsWith('--')) {
        return { method: 'browser.get_engine', params: { surface } };
      }
      if (value !== 'web' && value !== 'agent') {
        throw new Error(`browser engine must be 'web' or 'agent', got '${value}'`);
      }
      return { method: 'browser.set_engine', params: { engine: value, surface } };
    }
```

- [ ] **Step 4: Handle the two methods in main**

In `src/main/index.ts`, in the V2 method switch, before the `browser.*` delegation to `handleBrowserV2`:

```ts
    case 'browser.get_engine': {
      const surface = request.params?.surface;
      if (!surface) { respondError(-32602, 'browser engine needs a surface'); return; }
      const engine = await win.webContents.executeJavaScript(
        `window.__wmux_getBrowserEngine?.(${JSON.stringify(surface)}) ?? 'web'`,
      );
      respond({ engine });
      return;
    }
    case 'browser.set_engine': {
      const surface = request.params?.surface;
      if (!surface) { respondError(-32602, 'browser engine needs a surface'); return; }
      const ok = await win.webContents.executeJavaScript(
        `window.__wmux_setBrowserEngine?.(${JSON.stringify(surface)}, ${JSON.stringify(request.params.engine)}) ?? false`,
      );
      if (!ok) { respondError(-32000, `no browser surface ${surface}`); return; }
      respond({ engine: request.params.engine });
      return;
    }
```

- [ ] **Step 5: Run tests and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/cli/wmux.ts src/main/index.ts tests/unit/cli-subcommands.test.ts
git commit -m "feat(cli): wmux browser engine [web|agent]"
```

---

## Task 13: Documentation

**Files:**
- Modify: `CLAUDE.md` (Architecture table, CLI Reference, V2 methods)

- [ ] **Step 1: Add the four new main-process files to the Architecture table**

In `CLAUDE.md`, in the `### Main Process (src/main/)` table:

```markdown
| `agent-browser-cli.ts` | Locate the `agent-browser` binary and run it (#agent-browser). Same lesson as `node-runtime.ts`: never assume PATH — npm's global bin is routinely absent from the env Electron inherited, and on Windows the install is a `.cmd` shim. Resolution is pure and memoised; every spawn passes an argv ARRAY, never a shell string, because the params come from a pipe command an agent controls |
| `agent-browser-verbs.ts` | Pure `wmux verb + params → agent-browser argv`. Pure so the table most likely to drift as the upstream CLI evolves is testable with no daemon, no Chrome and no Electron. Throws the SAME -32601 as the web engine for an unknown verb, so a caller cannot tell the engines apart by their errors |
| `agent-browser-daemon.ts` | Refcounted `dashboard start`/`stop`. **Adopt, never fight**: a dashboard already on :4848 was started by someone else, so wmux uses it and never stops it — killing a dashboard the user is watching in their own Chrome is a baffling bug to receive |
| `agent-browser-session.ts` | `surfaceId` → session. Sessions are EPHEMERAL — process lifetime equals surface lifetime, nothing persisted. That is what makes orphan handling correct by construction: no wmux-owned session legitimately survives, so any `wmux-` session with no live surface is garbage. wmux allocates the stream port itself because the dashboard deep-link keys on `?port=` |
```

- [ ] **Step 1b: Document the one known engine divergence**

Verified against agent-browser's real CLI docs during Task 4: `wait` accepts
`wait <selector>` or `wait <ms>`, but has **no per-call timeout flag**. Its only
timeout control is the global `AGENT_BROWSER_DEFAULT_TIMEOUT` env var (25s
default). wmux's own `wmux browser wait <ref> [ms]` sends both a ref and a
timeout, so in `agent` mode the caller's `ms` is unrepresentable and is dropped —
while in `web` mode `cdpBridge.wait(ref, timeout)` honours it.

This is the only place the two engines behave differently for the same command,
so it has to be written down rather than discovered. Add to the CLI Reference:

```bash
wmux browser wait <ref> [ms]           # NOTE: in agent mode the [ms] bound is
                                       # ignored — agent-browser has no per-call
                                       # wait timeout, only the global
                                       # AGENT_BROWSER_DEFAULT_TIMEOUT (25s).
                                       # The web engine honours [ms] normally.
```

- [ ] **Step 2: Document the CLI verb**

In the `## CLI Reference` block, under Browser:

```bash
wmux browser engine [web|agent] [--surface <id>]   # which engine backs this browser
                                       # surface. 'web' (default) is the built-in
                                       # webview; 'agent' is vercel-labs/agent-browser
                                       # — a real Chrome shown through its own
                                       # dashboard, live viewport + activity feed.
                                       # Every other `wmux browser` verb routes to
                                       # whichever engine the surface is on, so
                                       # agents need no new vocabulary.
```

- [ ] **Step 3: Document the V2 methods**

Under **Fully implemented V2 methods**, extend the `browser.*` line:

```markdown
- `browser.*` (via CDP bridge, or agent-browser when the surface's engine is `agent`)
- `browser.get_engine`, `browser.set_engine`
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: agent-browser engine, CLI verb and V2 methods"
```

---

## Task 14: Full verification

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: all PASS, including the new `agent-browser-*` files.

- [ ] **Step 2: Lint and typecheck**

Run: `npm run lint && npm run build:main && npx vite build`
Expected: clean.

- [ ] **Step 3: Live verification (requires a running wmux)**

Not automatable — this is the part unit tests cannot cover. Work through each:

1. `wmux browser back` and `wmux browser reload` succeed instead of `Unknown:` (Task 2 fix).
2. Open a browser tab. It is in `web` mode and behaves exactly as before.
3. Flip it to `agent` with the toggle. With `agent-browser` absent, the setup card appears; Install opens a terminal pane and the real npm output is visible.
4. After install, flipping to `agent` loads the dashboard, deep-linked so **this pane's** session is selected rather than a global list.
5. From a terminal pane in the same workspace: `wmux browser open example.com` — the page appears in the dashboard viewport and the command appears in the activity feed.
6. `wmux browser snapshot` returns refs; `wmux browser click e2` acts on the agent browser.
7. Two panes both in agent mode: distinct sessions, neither steals the other's tab.
8. Flip back to `web`: the webview returns, showing the page the agent browser was on.
9. Close the agent tab, then run `agent-browser session list` — the `wmux-` session is gone.
10. Quit wmux, then check Task Manager: no orphaned `chrome.exe` or `agent-browser` daemon.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(browser): agent-browser as a second browser engine

Closes the agent-browser integration. A browser surface now carries an
engine: 'web' (the Electron webview, unchanged and still the default) or
'agent' (vercel-labs/agent-browser, shown through its own dashboard,
deep-linked to that pane's session).

All browser.* verbs route by engine, so the global CLAUDE.md is unchanged
and every agent — Claude Code, OpenCode, Kiro — drives the agent browser
with the vocabulary it already knows."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 what agent-browser is (context) | — |
| §2 surface model | 1 |
| §3 `agent-browser-cli.ts` | 3 |
| §3 `agent-browser-daemon.ts` | 6, 11 |
| §3 `agent-browser-session.ts` | 5 |
| §3a session lifetime (ephemeral, headless) | 5, 11 |
| §3 `agent-browser-verbs.ts` | 4 |
| §4 command routing + verb mapping | 7 |
| §5 back/forward/reload bug | 2 |
| §6 renderer engine branch + guards | 8 |
| §7 install flow | 10, 11 |
| §8 CLI & settings | 12 |
| §9 failure modes | 6 (adopt), 11 (teardown), 10 (missing binary), 14 (live) |
| §10 testing | 1, 2, 3, 4, 5, 6, 7, 8, 12, 14 |

**Gap found and closed:** §8 also specifies a *Settings → Browser default engine* preference. It is not worth its own task and is deliberately deferred — the per-surface toggle (Task 10) and the CLI (Task 12) both ship, and a default-engine preference with no rev-and-promote need can be added later as a one-line settings read in `PaneWrapper`. Recorded here rather than silently dropped.

**Type consistency:** `BrowserEngine`, `engineOf`, `BrowserTarget`, `AgentSession`, `SessionRegistry.ensure/get/all/release`, `DashboardDaemon.acquire/release/shutdown/isAvailable/adopted`, `toAgentBrowserArgv`, `normaliseRef`, `agentBrowserPath`, `runAgentBrowser`, `runBrowserCommandForTarget` are each defined in exactly one task and used with the same signature everywhere after.

**Known unverified assumption:** whether Node's `execFile` can spawn the Windows `.cmd` shim directly. Task 4 Step 6 is a live check with a stated fallback, rather than an assumption buried in the code.
