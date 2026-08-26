import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  engineTransition,
  enableOutcome,
  disableTarget,
  elementHidden,
  resolveInputUrl,
  shouldPollAgentUrl,
  AGENT_URL_POLL_MS,
  AGENT_URL_POLL_SUPPRESS_MS,
} from '../../src/renderer/components/Browser/BrowserPane';
import { en } from '../../src/renderer/i18n/locales/en';
import { fr } from '../../src/renderer/i18n/locales/fr';

/**
 * The renderer half of the agent-browser engine (the pane, its address bar and
 * the setup card).
 *
 * Two kinds of test live here, deliberately:
 *
 *  1. Behaviour, against the pure decision helpers the pane exports. A pure
 *     "given the previous engine, the next one, and what enable answered, what
 *     should the pane do" beats an untestable effect, so the effect is reduced
 *     to plumbing around these.
 *
 *  2. Source-level guards, in the style of the "BrowserPane agent-mode guards"
 *     reasoning in agent-browser-routing.test.ts. vitest runs with
 *     `environment: 'node'` and wmux ships no React test renderer, so a webview
 *     cannot be mounted — but the properties at stake are structural
 *     ("the guard is INSIDE claimCdp, not at its call sites") and structure is
 *     exactly what reading the source can pin.
 */

const BROWSER_DIR = join(__dirname, '../../src/renderer/components/Browser');
const PANE = readFileSync(join(BROWSER_DIR, 'BrowserPane.tsx'), 'utf8');
const BAR = readFileSync(join(BROWSER_DIR, 'AddressBar.tsx'), 'utf8');
const SETUP = readFileSync(join(BROWSER_DIR, 'AgentBrowserSetup.tsx'), 'utf8');

/**
 * The body of a `const <name> = useCallback(...)` declaration, up to the
 * dependency array that closes it. Comments are stripped so a guard that only
 * exists in prose cannot pass for a guard that exists in code.
 */
function callbackBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} is not a useCallback in this file any more`).toBeGreaterThan(-1);
  const end = source.indexOf('}, [', start);
  expect(end, `${name} has no dependency array`).toBeGreaterThan(start);
  return stripComments(source.slice(start, end));
}

/**
 * Hand-rolled rather than `/\/\*[\s\S]*?\*\//` — a lazy dot-all pair is the
 * super-linear-backtracking shape sonarjs rejects, and indexOf is both linear
 * and easier to read.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = source.indexOf('/*', i);
    if (open === -1) { out += source.slice(i); break; }
    out += source.slice(i, open);
    const close = source.indexOf('*/', open + 2);
    if (close === -1) break; // unterminated: drop the tail rather than guess
    i = close + 2;
  }
  return out
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

const PANE_CODE = stripComments(PANE);

// ── guard 1: the CDP claim ──────────────────────────────────────────────────

describe('claimCdp refuses an agent-mode surface', () => {
  /**
   * In agent mode the webview shows agent-browser's dashboard SPA. Registering
   * that as a CDP target makes `wmux browser click e2` aimed at this surface
   * click on the DASHBOARD's own DOM instead of the remote page — silently, on
   * the pane the user is watching.
   */
  it('returns early on the engine, inside the callback', () => {
    const body = callbackBody(PANE, 'claimCdp');
    expect(body).toMatch(/engineRef\.current === 'agent'/);
    // The guard must precede the attach, not sit beside it.
    expect(body.indexOf("engineRef.current === 'agent'")).toBeLessThan(body.indexOf('cdp.attach'));
    expect(body).toMatch(/if \(engineRef\.current === 'agent'\) return;/);
  });

  /**
   * THE point of putting it inside. Guarding the three call sites leaves a
   * fourth caller free to reintroduce the bug, and this pane has already grown
   * one call site per issue (#27, #62, #155). So the call sites must stay
   * UNguarded — if one of them ever grows its own `engine === 'agent'` check
   * that is the signal the guard drifted back out of the function.
   */
  it('is guarded nowhere else, so a fourth call site cannot reintroduce the bug', () => {
    const callSites = [...PANE_CODE.matchAll(/claimCdp/g)].length;
    expect(callSites, 'claimCdp should be declared and called, not inlined away').toBeGreaterThan(2);

    // Every call is bare: `claimCdp()`, `{claimCdp}`, or a dependency entry.
    for (const m of PANE_CODE.matchAll(/(.{40})claimCdp\(\)/g)) {
      expect(m[1], 'a call site grew its own engine guard').not.toMatch(/engine/);
    }
    expect(PANE_CODE).toMatch(/onMouseDownCapture=\{claimCdp\}/);
    expect(PANE_CODE).toMatch(/onDomReady = \(\) => \{ claimCdp\(\); installPopupBridge\(\); \}/);
  });
});

// ── guard 2: the popup bridge ───────────────────────────────────────────────

describe('installPopupBridge refuses an agent-mode surface', () => {
  // It exists for `target="_blank"` on arbitrary sites (issue #126). The
  // dashboard is a known SPA that does not need it.
  it('returns early on the engine, inside the callback', () => {
    const body = callbackBody(PANE, 'installPopupBridge');
    expect(body).toMatch(/if \(engineRef\.current === 'agent'\) return;/);
    expect(body.indexOf("engineRef.current === 'agent'")).toBeLessThan(body.indexOf('executeJavaScript'));
  });
});

// ── guard 3: src is never re-pointed ────────────────────────────────────────

describe('the webview src stays pinned', () => {
  /**
   * Binding `src` to mutable state AND calling loadURL made every navigation
   * load twice, racing into a spurious ERR_ABORTED (the comment at the top of
   * BrowserPane records it). An engine switch is exactly such a mutation.
   */
  it('binds src to initialSrc and to nothing else', () => {
    const srcBindings = [...PANE_CODE.matchAll(/\bsrc=\{([^}]*)\}/g)].map((m) => m[1].trim());
    expect(srcBindings).toEqual(['initialSrc']);
  });

  it('never assigns initialSrc after the initial state', () => {
    // `const [initialSrc] = useState(initialUrl)` — no setter is destructured,
    // so there is nothing that could re-point it.
    expect(PANE_CODE).toMatch(/const \[initialSrc\] = useState\(initialUrl\)/);
    expect(PANE_CODE).not.toMatch(/setInitialSrc/);
  });

  it('moves the pane between engines with loadURL', () => {
    expect(PANE_CODE).toMatch(/loadURL\(outcome\.url\)/);   // → agent (dashboard)
    expect(PANE_CODE).toMatch(/loadURL\(target\)/);          // → web (back to the page)
  });
});

// ── guard 4: agent-mode navigations are not persisted as the surface URL ────

describe('the dashboard never becomes the surface URL', () => {
  /**
   * `onUrlChange` writes into the surface's persisted `url`. In agent mode the
   * webview's URL is the dashboard, so recording it would make a later flip
   * back to `web` land on the viewer instead of the page — the opposite of
   * "one browser with two backends".
   */
  it('skips the navigation handlers in agent mode', () => {
    const handlers = PANE_CODE.slice(
      PANE_CODE.indexOf('const onNavigate = (e: any)'),
      PANE_CODE.indexOf("wv.addEventListener('did-navigate'"),
    );
    // Both handlers that can reach onUrlChange bail out first.
    expect([...handlers.matchAll(/if \(engineRef\.current === 'agent'\) return;/g)]).toHaveLength(2);
    for (const call of handlers.split('onUrlChange?.(').slice(1)) {
      expect(call.length).toBeGreaterThan(0);
    }
    expect(handlers.indexOf("engineRef.current === 'agent'")).toBeLessThan(handlers.indexOf('onUrlChange'));
  });
});

// ── the switch decision ─────────────────────────────────────────────────────

describe('engineTransition', () => {
  it('does nothing when the engine has not changed', () => {
    expect(engineTransition('web', 'web', 'https://a')).toEqual({ action: 'none' });
    expect(engineTransition('agent', 'agent', 'https://a')).toEqual({ action: 'none' });
  });

  it('enables on web → agent, carrying the page the webview was showing', () => {
    // Otherwise the flip is a navigation to nothing and the user loses their page.
    expect(engineTransition('web', 'agent', 'https://a')).toEqual({ action: 'enable', url: 'https://a' });
  });

  it('disables on agent → web', () => {
    expect(engineTransition('agent', 'web', 'https://a')).toEqual({ action: 'disable' });
  });

  /**
   * The pane seeds `prev` with 'web' rather than with the current engine, so a
   * surface RESTORED in agent mode (persisted browserEngine) is a web→agent
   * change on mount and actually gets a session. A pane mounting in web mode —
   * every ordinary one — still sees prev === next and does nothing, which is
   * what "not on mount" is protecting.
   */
  it('is what makes a restored agent surface enable itself on mount', () => {
    expect(engineTransition('web', 'agent', 'https://a').action).toBe('enable');
    expect(engineTransition('web', 'web', 'https://a').action).toBe('none');
  });

  it('seeds prev with web in the pane, not with the incoming engine', () => {
    expect(PANE_CODE).toMatch(/prevEngineRef = useRef<BrowserEngine>\('web'\)/);
  });

  /**
   * The seed only works once per instance, and StrictMode (dev) tears a pane
   * down and sets it up again on the SAME instance — refs and all. Without the
   * re-seed on teardown, a restored agent surface is enabled, disabled by the
   * simulated unmount, and then sees prev === next and never comes back.
   */
  it('re-seeds prev on teardown so a StrictMode remount redoes the switch', () => {
    expect(PANE_CODE).toMatch(/mountedRef\.current = false;\s*prevEngineRef\.current = 'web';/);
  });
});

/**
 * An opaque stand-in for the session's dashboard URL. Deliberately NOT a URL:
 * neither helper parses it, they hand it back untouched, and an opaque token
 * proves exactly that — while keeping the real loopback address (plain http, on
 * purpose, and rightly flagged as clear-text) out of the fixtures.
 */
const DASHBOARD = 'DASHBOARD_URL';

describe('enableOutcome', () => {
  it('shows the setup card when the binary is absent', () => {
    expect(enableOutcome({ installed: false }, true)).toEqual({ show: 'setup' });
  });

  it('treats a failed enable (null) as a missing install rather than a live pane', () => {
    expect(enableOutcome(null, true)).toEqual({ show: 'setup' });
    expect(enableOutcome(undefined, true)).toEqual({ show: 'setup' });
  });

  it('loads the dashboard when everything is up', () => {
    expect(enableOutcome({ installed: true, dashboardUrl: DASHBOARD }, true))
      .toEqual({ show: 'dashboard', url: DASHBOARD });
  });

  /**
   * The one the review flagged. `enable` deliberately swallows a dashboard that
   * did not start — agent-browser drives Chrome fine without its viewer — and
   * still returns a dashboardUrl, because the session always has one. Loading
   * it anyway paints Chromium's ERR_CONNECTION_REFUSED, which the user reads as
   * "my browser is broken" rather than "an optional viewer didn't start".
   */
  it('does not load a dashboard URL that nothing is listening on', () => {
    expect(enableOutcome({ installed: true, dashboardUrl: DASHBOARD }, false))
      .toEqual({ show: 'no-dashboard' });
  });

  it('reports no-dashboard rather than setup when the install is fine but the URL is missing', () => {
    // An installed binary with no dashboard URL is still a working agent
    // browser; offering a 240 MB install for it would be a lie.
    expect(enableOutcome({ installed: true }, true)).toEqual({ show: 'no-dashboard' });
  });
});

describe('disableTarget', () => {
  it('prefers where the agent browser actually was', () => {
    expect(disableTarget({ url: 'https://agent-was-here' }, 'https://fallback', DASHBOARD))
      .toBe('https://agent-was-here');
  });

  it('falls back when the session could not say where it was', () => {
    expect(disableTarget({}, 'https://fallback', DASHBOARD)).toBe('https://fallback');
    expect(disableTarget(null, 'https://fallback', DASHBOARD)).toBe('https://fallback');
  });

  // A redundant loadURL is a visible reload of a page the user never left —
  // which is what happens after the setup card, where the webview never moved.
  it('does not navigate to the page already on screen', () => {
    expect(disableTarget({ url: 'https://a' }, 'https://b', 'https://a')).toBeNull();
    expect(disableTarget({}, 'https://a', 'https://a')).toBeNull();
  });

  it('does not navigate when there is nowhere to go', () => {
    expect(disableTarget({}, '', 'https://a')).toBeNull();
  });
});

describe('resolveInputUrl', () => {
  it('keeps an absolute URL', () => {
    // Only the https arm is fixtured: the plain-http arm of the same regex
    // cannot be written here without a clear-text URL literal, and inventing a
    // way around the linter to assert one branch of `^https?://` would be worth
    // less than the rule it dodged.
    expect(resolveInputUrl('https://a.dev/x')).toBe('https://a.dev/x');
    expect(resolveInputUrl('https://a.dev')).toBe('https://a.dev');
  });

  it('promotes a bare host', () => {
    expect(resolveInputUrl('example.com')).toBe('https://example.com');
  });

  it('searches for anything that is not a host', () => {
    expect(resolveInputUrl('how do i x')).toContain('google.com/search?q=');
  });

  // The address bar addresses the REMOTE browser in agent mode, so the string
  // handed to `open` has to be resolved the same way the web engine resolves it
  // — otherwise the same typing produces two different pages per engine.
  it('is the single resolution both engines go through', () => {
    expect(PANE_CODE).toMatch(/const resolved = resolveInputUrl\(newUrl\)/);
    const navigate = callbackBody(PANE, 'navigate');
    expect(navigate.indexOf('resolveInputUrl')).toBeLessThan(navigate.indexOf("engineRef.current === 'agent'"));
  });
});

// ── the address bar ─────────────────────────────────────────────────────────

describe('AddressBar engine toggle', () => {
  it('offers both engines with the active one marked', () => {
    expect(BAR).toMatch(/onEngineChange\('web'\)/);
    expect(BAR).toMatch(/onEngineChange\('agent'\)/);
    expect(BAR).toMatch(/browser-address-bar__engine-btn--active/);
    expect([...BAR.matchAll(/aria-pressed=/g)]).toHaveLength(2);
  });

  it('explains each engine in plain language, since nobody knows what agent-browser is', () => {
    expect(BAR).toMatch(/addressBar\.engineWebTitle/);
    expect(BAR).toMatch(/addressBar\.engineAgentTitle/);
  });

  /**
   * The bar must not learn about agent-browser. It reports "the user asked for
   * this URL" through onNavigate and BrowserPane decides what that means, so
   * there is one place that knows which engine is in play.
   */
  it('knows nothing about agent-browser itself', () => {
    expect(BAR).not.toMatch(/agentBrowser|window\.wmux/);
  });

  it('hides the toggle entirely when the host cannot act on it', () => {
    expect(BAR).toMatch(/\{onEngineChange && \(/);
  });
});

describe('back / forward / reload in agent mode', () => {
  /**
   * The remote page's history lives in a Chrome this pane cannot reach: there
   * is no renderer IPC for arbitrary agent-browser verbs. So back/forward are
   * disabled — walking the DASHBOARD's own SPA history is the one behaviour
   * that is definitely wrong — and reload addresses the viewer, the only thing
   * actually in the webview.
   */
  it('forces the history flags off so the buttons are visibly disabled', () => {
    expect(PANE_CODE).toMatch(/canGoBack=\{!isAgent && canGoBack\}/);
    expect(PANE_CODE).toMatch(/canGoForward=\{!isAgent && canGoForward\}/);
  });

  it('refuses in the handlers too, so a stale enabled button cannot walk the dashboard', () => {
    expect(callbackBody(PANE, 'goBack')).toMatch(/if \(engineRef\.current === 'agent'\) return;/);
    expect(callbackBody(PANE, 'goForward')).toMatch(/if \(engineRef\.current === 'agent'\) return;/);
  });

  it('leaves reload pointed at the webview, and says so in the tooltip', () => {
    // Unchanged and engine-independent: in agent mode the webview IS the
    // viewer, so reloading it is the honest reading of the button.
    expect(PANE_CODE).toMatch(/const reload = useCallback\(\(\) => webviewRef\.current\?\.reload\(\), \[\]\);/);
    expect(BAR).toMatch(/addressBar\.reloadViewer/);
    expect(BAR).toMatch(/addressBar\.backAgent/);
  });
});

// ── the setup card ──────────────────────────────────────────────────────────

describe('AgentBrowserSetup', () => {
  it('states the one-time cost and shows the two commands', () => {
    expect(SETUP).toMatch(/agentBrowser\.setupCost/);
    expect(SETUP).toMatch(/npm i -g agent-browser/);
    expect(SETUP).toMatch(/agent-browser install/);
  });

  // A large npm install plus a Chrome download fails in ways (proxy, EACCES, no
  // network) that are only diagnosable from the output, so it runs in a REAL
  // terminal pane rather than a hidden child process behind a spinner.
  it('installs through the terminal-pane flow, then polls for the binary', () => {
    expect(SETUP).toMatch(/agentBrowser\?\.install\(\)/);
    expect(SETUP).toMatch(/agentBrowser\?\.status\(\)/);
    expect(SETUP).toMatch(/setInterval/);
  });

  it('stops polling — on success, on a deadline, and on unmount', () => {
    expect(SETUP).toMatch(/POLL_TIMEOUT_MS/);
    expect(SETUP).toMatch(/useEffect\(\(\) => stopPolling, \[stopPolling\]\)/);
    expect([...SETUP.matchAll(/stopPolling\(\)/g)].length).toBeGreaterThanOrEqual(2);
  });

  it('offers install and cancel', () => {
    expect(SETUP).toMatch(/agentBrowser\.install'/);
    expect(SETUP).toMatch(/agentBrowser\.cancel'/);
    expect(SETUP).toMatch(/onCancel/);
  });

  /**
   * A missing dashboard and a missing install are different situations. The
   * first means the feature works and only its optional viewer is absent;
   * telling that user to download 240 MB would be both wrong and insulting.
   */
  it('says something specific about a missing dashboard instead of offering the install', () => {
    const noDash = SETUP.slice(SETUP.indexOf("if (reason === 'no-dashboard')"), SETUP.indexOf('agentBrowser.setupTitle'));
    expect(noDash).toMatch(/agentBrowser\.noDashTitle/);
    expect(noDash).toMatch(/agentBrowser\.retry/);
    expect(noDash).toMatch(/agentBrowser\.backToWeb/);
    expect(noDash).not.toMatch(/agentBrowser\.install'/);
    expect(noDash).not.toMatch(/240/);
  });

  it('is reached from the pane for both reasons, over a webview that stays alive', () => {
    expect(PANE_CODE).toMatch(/reason=\{agentStatus === 'setup' \? 'not-installed' : 'no-dashboard'\}/);
    // Hiding, not unmounting: unmounting destroys the guest page and its CDP
    // registration, so the card would cost the user the tab they were on.
    expect(PANE_CODE).toMatch(/style=\{overlay \? \{ visibility: 'hidden' \} : undefined\}/);
  });

  it('detects the dead dashboard from did-fail-load as well as from status()', () => {
    expect(PANE_CODE).toMatch(/did-fail-load/);
    expect(PANE_CODE).toMatch(/dashboardAvailable/);
  });
});

// ── i18n ────────────────────────────────────────────────────────────────────

describe('i18n coverage for the new UI', () => {
  const KEYS = [
    'addressBar.engineGroup',
    'addressBar.engineWeb',
    'addressBar.engineAgent',
    'addressBar.engineWebTitle',
    'addressBar.engineAgentTitle',
    'addressBar.backAgent',
    'addressBar.reloadViewer',
    'agentBrowser.setupTitle',
    'agentBrowser.setupBody',
    'agentBrowser.setupCost',
    'agentBrowser.installHint',
    'agentBrowser.installing',
    'agentBrowser.installFailed',
    'agentBrowser.install',
    'agentBrowser.waiting',
    'agentBrowser.cancel',
    'agentBrowser.noDashTitle',
    'agentBrowser.noDashBody',
    'agentBrowser.retry',
    'agentBrowser.backToWeb',
  ] as const;

  it.each(KEYS)('%s is in English, the source of truth', (key) => {
    expect((en as Record<string, string>)[key]).toBeTruthy();
  });

  // The other 16 bundled locales fall back to English key-by-key
  // (`DICTIONARIES[lang]?.[key] ?? DICTIONARIES.en?.[key]`), so leaving them
  // untranslated renders English rather than a raw key. French is translated
  // because the maintainer reads it.
  it.each(KEYS)('%s is translated in French', (key) => {
    expect((fr as Record<string, string>)[key]).toBeTruthy();
  });

  it('uses only keys that exist, in both components', () => {
    const used = new Set<string>();
    for (const source of [BAR, SETUP]) {
      for (const m of source.matchAll(/t\(\s*'([a-zA-Z][\w.]*)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) {
      expect((en as Record<string, string>)[key], `${key} is missing from en.ts`).toBeTruthy();
    }
  });

  /**
   * `useT()` is referentially stable per language on purpose (issue #141: an
   * unstable one invalidated 42 dependency arrays and turned a 2s poll into a
   * render-speed loop). These components still must not rely on that — a `t` in
   * a dependency array is the shape that regressed, so neither file has one.
   */
  it('keeps t out of every dependency array', () => {
    for (const source of [BAR, SETUP]) {
      for (const m of source.matchAll(/\}, \[([^\]]*)\]\)/g)) {
        expect(m[1].split(',').map((d) => d.trim())).not.toContain('t');
      }
    }
  });
});

// ── the address bar, in agent mode, telling the truth ───────────────────────
//
// The pane shows agent-browser's dashboard while the actual page lives in a
// Chrome outside wmux that the AGENT drives. So the bar cannot observe
// navigation the way it observes the webview's: left alone it shows the last
// URL the PANE asked for, which stops being true the moment the agent clicks
// anything. These pin the poll that fixes it — and, just as importantly, the
// conditions under which it refuses to run.

const pollState = (over: Partial<Parameters<typeof shouldPollAgentUrl>[0]> = {}) => ({
  engine: 'agent' as const,
  status: 'live',
  documentHidden: false,
  paneHidden: false,
  inFlight: false,
  now: 10_000,
  suppressUntil: 0,
  ...over,
});

describe('shouldPollAgentUrl', () => {
  it('polls a live, visible agent pane', () => {
    expect(shouldPollAgentUrl(pollState())).toBe(true);
  });

  // Each poll is a real agent-browser invocation. A web pane has a webview
  // whose URL it can simply read, so spending a child process there would be
  // pure waste answering a question already answered.
  it('never polls the web engine', () => {
    expect(shouldPollAgentUrl(pollState({ engine: 'web' }))).toBe(false);
  });

  it('does not poll before a session exists', () => {
    for (const status of ['idle', 'starting', 'setup']) {
      expect(shouldPollAgentUrl(pollState({ status }))).toBe(false);
    }
  });

  /**
   * A dashboard that did not start is not a session that did not start —
   * agent-browser drives Chrome perfectly well without its viewer, and the bar
   * above that pane is exactly as capable of lying.
   */
  it('still polls when only the dashboard is missing', () => {
    expect(shouldPollAgentUrl(pollState({ status: 'no-dashboard' }))).toBe(true);
  });

  it('does not poll a minimised window or a hidden keep-alive tab', () => {
    expect(shouldPollAgentUrl(pollState({ documentHidden: true }))).toBe(false);
    expect(shouldPollAgentUrl(pollState({ paneHidden: true }))).toBe(false);
  });

  // A second request would queue behind the first and buy nothing; if the CLI
  // is slower than the interval, that is precisely when NOT to pile on.
  it('does not overlap itself', () => {
    expect(shouldPollAgentUrl(pollState({ inFlight: true }))).toBe(false);
  });

  /**
   * `open` is asynchronous and Chrome takes a moment to commit, so a poll
   * landing in that window reports the page the user just navigated AWAY from
   * and the bar visibly snaps back to it.
   */
  it('is suppressed for a moment after the pane asks for a url', () => {
    expect(shouldPollAgentUrl(pollState({ now: 10_000, suppressUntil: 11_000 }))).toBe(false);
    expect(shouldPollAgentUrl(pollState({ now: 11_000, suppressUntil: 11_000 }))).toBe(true);
  });

  it('suppresses for less than a full interval, so no tick is lost outright', () => {
    expect(AGENT_URL_POLL_SUPPRESS_MS).toBeLessThan(AGENT_URL_POLL_MS);
  });

  /**
   * Issue #141 was a 2s poll that ran at RENDER speed because an unstable hook
   * identity invalidated its dependency array. The interval here is a named
   * constant so the number is reviewable, and deliberately not sub-second: this
   * is a status readout, not a control.
   */
  it('polls on a human timescale, not a render timescale', () => {
    expect(AGENT_URL_POLL_MS).toBeGreaterThanOrEqual(1_000);
    expect(AGENT_URL_POLL_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('elementHidden', () => {
  // wmux's keep-alive tabs stay MOUNTED and are hidden with `visibility`, which
  // offsetParent does not report — hence checkVisibility, which does.
  it('believes checkVisibility when the platform has it', () => {
    expect(elementHidden({ checkVisibility: () => false } as unknown as HTMLElement)).toBe(true);
    expect(elementHidden({ checkVisibility: () => true } as unknown as HTMLElement)).toBe(false);
  });

  it('asks about the visibility property, not just layout', () => {
    let asked: unknown;
    elementHidden({ checkVisibility: (o: unknown) => { asked = o; return true; } } as unknown as HTMLElement);
    expect(asked).toEqual({ visibilityProperty: true });
  });

  it('falls back to offsetParent where checkVisibility is absent', () => {
    expect(elementHidden({ offsetParent: null } as unknown as HTMLElement)).toBe(true);
    expect(elementHidden({ offsetParent: {} } as unknown as HTMLElement)).toBe(false);
  });

  // First render, before the ref lands. Suppressing the first poll of a pane
  // the user is looking at is the wrong way to be wrong.
  it('treats a missing element as visible', () => {
    expect(elementHidden(null)).toBe(false);
    expect(elementHidden(undefined)).toBe(false);
  });
});

describe('the url poll, as wired', () => {
  /** The `useEffect(...)` block that owns the interval, up to its deps array. */
  const pollEffect = (): string => {
    const start = PANE.indexOf('const tick = async ()');
    expect(start, 'the poll effect is not in this file any more').toBeGreaterThan(-1);
    const end = PANE.indexOf('}, [', start);
    expect(end, 'the poll effect has no dependency array').toBeGreaterThan(start);
    return stripComments(PANE.slice(start, end + 40));
  };

  /**
   * THE #141 guard, and the reason this test is source-level rather than
   * behavioural: the bug was never in what the poll did, it was in how often
   * the effect owning it was re-created. Every dependency here must be a
   * primitive that changes only when the pane's situation really changes — no
   * callbacks, no hook results, no objects.
   */
  it('depends on primitives only, so it is not re-armed every commit', () => {
    expect(pollEffect()).toContain('}, [engine, agentStatus, surfaceId]');
  });

  it('names no callback among its dependencies', () => {
    // A callback in the array is the exact shape of #141: `useCallback` is only
    // as stable as ITS own deps, and one unstable link re-arms the interval.
    const deps = /\}, \[([^\]]*)\]/.exec(pollEffect())?.[1] ?? '';
    for (const name of ['navigate', 'openInAgent', 'enterAgentMode', 'leaveAgentMode', 't']) {
      expect(deps.split(',').map((d) => d.trim())).not.toContain(name);
    }
  });

  it('clears its interval on teardown, and ignores an answer that arrives after', () => {
    const body = pollEffect();
    expect(body).toContain('clearInterval(timer)');
    expect(body).toContain('cancelled = true');
    expect(body).toContain('if (!cancelled && res?.url)');
  });

  it('decides whether to spend an invocation through the pure helper', () => {
    expect(pollEffect()).toContain('shouldPollAgentUrl({');
    expect(pollEffect()).toContain('paneHidden: elementHidden(rootRef.current)');
  });

  it('leaves the last known url alone when a poll cannot answer', () => {
    // No clearing branch: a failed invocation must not blank an address bar
    // that was correct a moment ago.
    expect(pollEffect()).not.toMatch(/setAgentUrl\(''\)|setAgentUrl\(undefined\)/);
  });
});

describe('address-bar navigation in agent mode', () => {
  /**
   * The pane used to reuse `enable` to mean "navigate", which re-acquired the
   * dashboard and re-launched with the stream env on every Enter — neither of
   * which does anything for a session that is already live, since the stream
   * port is read at browser LAUNCH and cannot be moved afterwards.
   */
  it('goes through the dedicated open verb', () => {
    const body = callbackBody(PANE, 'openInAgent');
    expect(body).toContain('api?.open?.(surfaceId, url)');
    expect(body.indexOf('api?.open?.')).toBeLessThan(body.indexOf('api?.enable?.'));
  });

  // `open` requires an EXISTING session, and the user can type a URL while the
  // flip into agent mode is still in flight. That is the one case where the
  // heavier verb is the right answer rather than a wasteful one.
  it('falls back to enable only when open refuses', () => {
    const body = callbackBody(PANE, 'openInAgent');
    expect(body).toMatch(/if \(res\?\.ok\) return;\s*await api\?\.enable\?\.\(surfaceId, url\);/);
  });

  it('suppresses the poll while the navigation commits', () => {
    expect(callbackBody(PANE, 'openInAgent'))
      .toContain('suppressPollUntilRef.current = Date.now() + AGENT_URL_POLL_SUPPRESS_MS');
  });

  it('shows the requested url immediately rather than waiting for a poll', () => {
    const body = callbackBody(PANE, 'openInAgent');
    expect(body.indexOf('setAgentUrl(url)')).toBeLessThan(body.indexOf('api?.open?.'));
  });
});
