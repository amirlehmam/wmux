import { useState, useRef, useCallback, useEffect } from 'react';
import AddressBar from './AddressBar';
import AgentBrowserSetup from './AgentBrowserSetup';
import { popupBridgeSource } from './popup-bridge';
import type { BrowserEngine } from '../../../shared/types';
import '../../styles/browser.css';

interface BrowserPaneProps {
  initialUrl?: string;
  surfaceId: string;
  workspaceId?: string;
  onUrlChange?: (url: string) => void;
  /**
   * Which backend drives this surface. `web` is the Electron <webview> this
   * pane has always been; `agent` points the SAME webview at agent-browser's
   * dashboard, deep-linked to this surface's session, while the actual pages
   * are driven in a real Chrome outside wmux.
   */
  engine?: BrowserEngine;
  onEngineChange?: (engine: BrowserEngine) => void;
}

/**
 * What the pane should do when the engine changes. Pure so the decision is
 * testable without a webview, a preload bridge or a React renderer — the effect
 * below is then only plumbing.
 *
 * `prev === next` is `none` on purpose: the effect runs on mount too, and a
 * mount must not tear down a session it never created. The one asymmetry is
 * that the pane seeds `prev` with `web`, so a surface RESTORED in agent mode
 * (browserEngine persisted) reads as a web→agent change and gets enabled.
 */
export type EngineAction =
  | { action: 'none' }
  | { action: 'enable'; url: string }
  | { action: 'disable' };

export function engineTransition(
  prev: BrowserEngine,
  next: BrowserEngine,
  currentUrl: string,
): EngineAction {
  if (prev === next) return { action: 'none' };
  return next === 'agent' ? { action: 'enable', url: currentUrl } : { action: 'disable' };
}

/**
 * What to show once `enable` (and the follow-up `status`) have answered.
 *
 * `dashboardAvailable: false` is NOT a failure of the feature: agent-browser
 * drives Chrome perfectly well without its viewer, and `enable` deliberately
 * swallows a dashboard that did not start. Loading the dashboard URL anyway
 * would paint Chromium's ERR_CONNECTION_REFUSED interstitial, which reads as
 * "my browser is broken" rather than "an optional viewer didn't start" — so it
 * gets its own outcome and its own honest card.
 */
export type EnableOutcome =
  | { show: 'setup' }
  | { show: 'dashboard'; url: string }
  | { show: 'no-dashboard' };

export function enableOutcome(
  result: { installed?: boolean; dashboardUrl?: string } | null | undefined,
  dashboardAvailable: boolean,
): EnableOutcome {
  if (!result?.installed) return { show: 'setup' };
  if (!result.dashboardUrl || !dashboardAvailable) return { show: 'no-dashboard' };
  return { show: 'dashboard', url: result.dashboardUrl };
}

/**
 * Where the webview should land when the pane goes back to `web`.
 *
 * The tab is one browser with two backends, not two unrelated tabs, so the
 * page the agent was last on wins; `fallback` (what the webview was showing
 * before the flip) is the answer when the session could not say. Returning
 * null means "already there, do not navigate" — a redundant loadURL is a
 * visible reload of a page the user never left.
 */
export function disableTarget(
  result: { url?: string } | null | undefined,
  fallback: string,
  showing: string,
): string | null {
  const target = result?.url || fallback;
  if (!target || target === showing) return null;
  return target;
}

/** Address-bar input → a URL, matching the web engine's own resolution. */
export function resolveInputUrl(input: string): string {
  if (/^https?:\/\//.test(input)) return input;
  if (input.includes('.') && !input.includes(' ')) return 'https://' + input;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/** Agent-mode lifecycle, as far as this pane is concerned. */
type AgentStatus = 'idle' | 'starting' | 'live' | 'setup' | 'no-dashboard';

export default function BrowserPane({
  initialUrl = 'https://github.com/amirlehmam/wmux',
  surfaceId,
  workspaceId,
  onUrlChange,
  engine = 'web',
  onEngineChange,
}: BrowserPaneProps) {
  // src is fixed to the initial page; all later navigation goes through loadURL
  // (below). Binding src to a mutable url state AND calling loadURL made every
  // navigation trigger two loads of the same URL, which raced and produced a
  // spurious ERR_ABORTED (logged by the main process' guest-view handler).
  // The engine switch is exactly such a mutation, so it goes through loadURL
  // too and src stays pinned to initialSrc forever.
  const [initialSrc] = useState(initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const webviewRef = useRef<any>(null);

  // Agent mode. `agentUrl` is the page the REMOTE Chrome was last asked to
  // open; it is what the address bar shows in agent mode, because the webview's
  // own URL is the dashboard and showing that would be a lie about where the
  // agent is.
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [agentUrl, setAgentUrl] = useState(initialUrl);
  const dashboardUrlRef = useRef<string | null>(null);

  // Mirrors read from webview event listeners and from callbacks that are
  // deliberately dependency-free (they are handed to a memoised child and to
  // long-lived listeners). Assigned during render so a listener that fires
  // between two commits can never act on a stale engine.
  const engineRef = useRef<BrowserEngine>(engine);
  engineRef.current = engine;
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  const agentUrlRef = useRef(agentUrl);
  agentUrlRef.current = agentUrl;

  // Seeded with `web` rather than with `engine`, so a surface restored in agent
  // mode (persisted browserEngine) reads as a web→agent change on mount and
  // actually gets a session. A pane that mounts in web mode — every ordinary
  // one — sees prev === next and does nothing at all.
  const prevEngineRef = useRef<BrowserEngine>('web');
  // Bumped on every switch. An in-flight enable/disable that finishes after the
  // user has flipped again (or after the pane went away) must not touch state
  // or the webview: its answer is about a world that no longer exists.
  const switchSeqRef = useRef(0);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // StrictMode double-invokes effects in dev: the pane is torn down and set
      // up again on the SAME instance, so the refs survive. Putting the
      // previous engine back to its seed is what makes the second setup redo
      // the switch — otherwise a pane restored in agent mode would be enabled,
      // disabled by the simulated unmount, and never enabled again.
      prevEngineRef.current = 'web';
    };
  }, []);

  /**
   * Ask the agent-browser session to open a URL. `enable` is the sanctioned
   * renderer-side way to do this — it runs `open <url>` against the session and
   * is idempotent per surface — so the pane needs no second IPC surface for it.
   */
  const openInAgent = useCallback((url: string) => {
    setAgentUrl(url);
    window.wmux?.agentBrowser?.enable(surfaceId, url)?.catch?.(() => {});
  }, [surfaceId]);

  const navigate = useCallback((newUrl: string) => {
    const resolved = resolveInputUrl(newUrl);
    // In agent mode the address bar addresses the REMOTE browser. The webview
    // stays on the dashboard; navigating it would throw away the viewer the
    // user just asked to watch.
    if (engineRef.current === 'agent') {
      openInAgent(resolved);
      return;
    }
    // Single navigation. loadURL can still reject with ERR_ABORTED for genuine
    // cases (a client-side redirect, an unreachable host, navigating again
    // mid-load); those are reflected by the did-*-load handlers below, so
    // swallow the promise rejection rather than leaving it unhandled.
    webviewRef.current?.loadURL(resolved).catch(() => {});
  }, [openInAgent]);

  // Back/forward/reload in agent mode.
  //
  // The webview is showing agent-browser's dashboard SPA, and the remote page's
  // history belongs to a Chrome this pane cannot reach (there is no renderer
  // IPC for arbitrary agent-browser verbs — those go through the CLI/pipe).
  // So:
  //   • back/forward are DISABLED — canGoBack/canGoForward are forced false in
  //     agent mode, and the handlers refuse as well so a stale enabled button
  //     can't walk the user off the viewer. Silently walking the dashboard's
  //     own SPA history is the one behaviour that is definitely wrong.
  //   • reload reloads the VIEWER. That is the honest reading of the button in
  //     agent mode ("the feed looks stuck") and it is the only recovery gesture
  //     available from here; the address bar covers "go somewhere else".
  const goBack = useCallback(() => {
    if (engineRef.current === 'agent') return;
    webviewRef.current?.goBack();
  }, []);
  const goForward = useCallback(() => {
    if (engineRef.current === 'agent') return;
    webviewRef.current?.goForward();
  }, []);
  const reload = useCallback(() => webviewRef.current?.reload(), []);
  const stop = useCallback(() => webviewRef.current?.stop(), []);
  const openDevTools = useCallback(() => webviewRef.current?.openDevTools(), []);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onNavigate = (e: any) => {
      // In agent mode every navigation here is the dashboard SPA moving around
      // inside itself. Recording it would overwrite the surface's persisted
      // `url` with the dashboard, so flipping back to web would land on the
      // viewer instead of the page.
      if (engineRef.current === 'agent') return;
      setCurrentUrl(e.url);
      onUrlChange?.(e.url);
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    };
    const onStartLoad = () => setIsLoading(true);
    const onStopLoad = () => {
      setIsLoading(false);
      if (engineRef.current === 'agent') return;
      const finalUrl = wv.getURL();
      setCurrentUrl(finalUrl);
      onUrlChange?.(finalUrl);
    };
    // The dashboard is optional observability. When it is not listening, the
    // webview paints ERR_CONNECTION_REFUSED, which the user reads as a broken
    // browser. Catch it and say what actually happened instead.
    const onFailLoad = (e: any) => {
      if (engineRef.current !== 'agent') return;
      if (e?.isMainFrame === false) return;
      const dash = dashboardUrlRef.current;
      if (!dash) return; // nothing of ours is loading; not our failure to explain
      const failed = String(e?.validatedURL ?? '');
      if (!failed || failed.startsWith(dash.split('?')[0])) setAgentStatus('no-dashboard');
    };

    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    wv.addEventListener('did-start-loading', onStartLoad);
    wv.addEventListener('did-stop-loading', onStopLoad);
    wv.addEventListener('did-fail-load', onFailLoad);

    return () => {
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
      wv.removeEventListener('did-start-loading', onStartLoad);
      wv.removeEventListener('did-stop-loading', onStopLoad);
      wv.removeEventListener('did-fail-load', onFailLoad);
    };
  }, []);

  const wcIdRef = useRef<number | null>(null);
  // Register this pane's webview as a CDP target, tagged with its surface and
  // workspace so main can route per-caller browser commands here (issues #27, #62).
  //
  // In agent mode the webview shows agent-browser's dashboard SPA, so claiming
  // it would make `wmux browser click e2` aimed at this surface click on the
  // DASHBOARD's DOM rather than the remote page. The guard lives here rather
  // than at the call sites so a fourth caller cannot reintroduce it.
  const claimCdp = useCallback(() => {
    if (engineRef.current === 'agent') return;
    const wcId = webviewRef.current?.getWebContentsId?.();
    if (wcId && window.wmux?.cdp?.attach) {
      wcIdRef.current = wcId;
      window.wmux.cdp.attach(wcId, surfaceId, workspaceId ?? null);
    }
  }, [surfaceId, workspaceId]);
  // `target="_blank"` links and `window.open()` are silently dropped by a
  // webview with no `allowpopups`, so they read as dead buttons (issue #126).
  // Re-installed on every dom-ready because each document starts clean; the
  // bridge itself is idempotent for SPA re-entry.
  //
  // It exists for arbitrary sites. The dashboard is a known SPA that does not
  // need it, so agent mode returns early — same guard placement, same reason.
  const installPopupBridge = useCallback(() => {
    if (engineRef.current === 'agent') return;
    webviewRef.current?.executeJavaScript?.(popupBridgeSource()).catch(() => {});
  }, []);

  // Last automatic recovery, so a page that crashes on load can't be reloaded in
  // a tight loop. One retry per RECOVERY_COOLDOWN_MS; after that the pane stays
  // on the crash screen and the user reloads it themselves.
  const lastRecoveryRef = useRef(0);
  const RECOVERY_COOLDOWN_MS = 10000;

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onDomReady = () => { claimCdp(); installPopupBridge(); };
    // A dead guest renderer used to leave a permanently stale CDP target: detach
    // was reachable only from this effect's cleanup — i.e. only from a React
    // unmount — so a webview that died while the component stayed mounted kept
    // its entry in the bridge, kept matching by surface id, and answered every
    // browser command with `browser_not_open` with no way back short of closing
    // the pane (issue #155). Attach only re-runs on dom-ready, and a dead
    // renderer does not reload itself, so nothing re-attached either.
    const onGone = () => {
      if (wcIdRef.current !== null) window.wmux?.cdp?.detach?.(wcIdRef.current);
      wcIdRef.current = null;
      const now = Date.now();
      if (now - lastRecoveryRef.current < RECOVERY_COOLDOWN_MS) return;
      lastRecoveryRef.current = now;
      // Reload so the SAME pane comes back and re-attaches on its next
      // dom-ready. Without this the bridge heals by adopting or creating a
      // different browser, leaving this surface a dead rectangle that
      // list-surfaces still advertises as a browser.
      try { wv.reload(); } catch { /* already torn down */ }
    };
    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('render-process-gone', onGone);
    wv.addEventListener('crashed', onGone);
    wv.addEventListener('destroyed', onGone);
    return () => {
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('render-process-gone', onGone);
      wv.removeEventListener('crashed', onGone);
      wv.removeEventListener('destroyed', onGone);
      // Only detach if this pane still owns the connection — closing a split-tree
      // browser pane must not kill another open pane's CDP (issue #27).
      if (wcIdRef.current !== null) window.wmux?.cdp?.detach?.(wcIdRef.current);
    };
  }, [claimCdp, installPopupBridge]);

  // ── engine switching ──────────────────────────────────────────────────────

  const enterAgentMode = useCallback(async (url: string) => {
    const seq = ++switchSeqRef.current;
    const stale = () => !mountedRef.current || switchSeqRef.current !== seq;
    const api = window.wmux?.agentBrowser;
    setAgentStatus('starting');
    setAgentUrl(url);
    if (!api) { setAgentStatus('setup'); return; }

    let result: { installed?: boolean; dashboardUrl?: string } | null;
    try {
      result = await api.enable(surfaceId, url);
    } catch {
      result = null;
    }
    if (stale()) return;

    let dashboardAvailable = true;
    if (result?.installed) {
      try {
        dashboardAvailable = (await api.status()).dashboardAvailable !== false;
      } catch {
        dashboardAvailable = false;
      }
      if (stale()) return;
    }

    const outcome = enableOutcome(result, dashboardAvailable);
    if (outcome.show === 'setup') { setAgentStatus('setup'); return; }
    if (outcome.show === 'no-dashboard') {
      dashboardUrlRef.current = result?.dashboardUrl ?? null;
      setAgentStatus('no-dashboard');
      return;
    }
    dashboardUrlRef.current = outcome.url;
    setAgentStatus('live');
    webviewRef.current?.loadURL(outcome.url).catch(() => {});
  }, [surfaceId]);

  const leaveAgentMode = useCallback(async () => {
    const seq = ++switchSeqRef.current;
    const stale = () => !mountedRef.current || switchSeqRef.current !== seq;
    setAgentStatus('idle');
    dashboardUrlRef.current = null;

    let result: { url?: string } | null;
    try {
      result = (await window.wmux?.agentBrowser?.disable(surfaceId)) ?? null;
    } catch {
      result = null;
    }
    if (stale()) return;

    const showing = webviewRef.current?.getURL?.() ?? '';
    const target = disableTarget(result, agentUrlRef.current || currentUrlRef.current, showing);
    if (target) {
      setCurrentUrl(target);
      webviewRef.current?.loadURL(target).catch(() => {});
    }
  }, [surfaceId]);

  useEffect(() => {
    const prev = prevEngineRef.current;
    prevEngineRef.current = engine;
    const decision = engineTransition(prev, engine, currentUrlRef.current);
    if (decision.action === 'enable') void enterAgentMode(decision.url);
    else if (decision.action === 'disable') void leaveAgentMode();
  }, [engine, enterAgentMode, leaveAgentMode]);

  // A pane that goes away in agent mode still owns a Chrome and a dashboard
  // refcount. `disable` is idempotent, so calling it for a pane that was never
  // enabled is a no-op rather than something to guard against.
  useEffect(() => () => {
    if (engineRef.current === 'agent') {
      window.wmux?.agentBrowser?.disable(surfaceId)?.catch?.(() => {});
    }
  }, [surfaceId]);

  // Listen for programmatic navigation (e.g. auto-navigate on dev server detection)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const targetId = detail?.surfaceId;
      if (detail?.url && (!targetId || targetId === surfaceId)) navigate(detail.url);
    };
    window.addEventListener('wmux:browser-navigate', handler);
    return () => window.removeEventListener('wmux:browser-navigate', handler);
  }, [navigate, surfaceId]);

  const isAgent = engine === 'agent';
  const overlay = isAgent && (agentStatus === 'setup' || agentStatus === 'no-dashboard');

  return (
    <div className="browser-pane" onMouseDownCapture={claimCdp}>
      <AddressBar
        url={isAgent ? agentUrl : currentUrl}
        isLoading={isLoading}
        canGoBack={!isAgent && canGoBack}
        canGoForward={!isAgent && canGoForward}
        engine={engine}
        onEngineChange={onEngineChange}
        onNavigate={navigate}
        onBack={goBack}
        onForward={goForward}
        onReload={reload}
        onStop={stop}
        onDevTools={openDevTools}
      />
      <div className="browser-pane__body">
        {/* @ts-ignore — webview is an Electron-specific HTML element */}
        <webview
          ref={webviewRef}
          src={initialSrc}
          className="browser-pane__webview"
          // Hidden rather than unmounted: unmounting destroys the guest page and
          // its CDP registration, so the setup card would cost the user the tab
          // they were on. Same reason keep-alive tabs use visibility.
          style={overlay ? { visibility: 'hidden' } : undefined}
        />
        {overlay && (
          <AgentBrowserSetup
            reason={agentStatus === 'setup' ? 'not-installed' : 'no-dashboard'}
            onInstalled={() => void enterAgentMode(agentUrlRef.current)}
            onRetry={() => void enterAgentMode(agentUrlRef.current)}
            onCancel={() => onEngineChange?.('web')}
          />
        )}
      </div>
    </div>
  );
}
