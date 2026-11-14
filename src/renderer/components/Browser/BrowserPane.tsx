import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import AddressBar from './AddressBar';
import { useT } from '../../i18n';
import AgentBrowserSetup from './AgentBrowserSetup';
import AgentBrowserViewer, { type AgentViewerHandle } from './AgentBrowserViewer';
import { popupBridgeSource } from './popup-bridge';
import type { AgentBrowserTab, AgentViewerAction, BrowserEngine } from '../../../shared/types';
import { BROWSER_BLANK_PAGE } from '../../utils/browser-start-page';
import { canApplyAgentBrowserReadback, getAgentBrowserHandoff, hasPendingAgentBrowserHandoff, invalidateAgentBrowserReadback } from '../../store/agent-browser-handoff';
import { useKeepRendering } from '../../utils/browser-keep-rendering';
import { openInNewBrowserTab } from '../../utils/open-in-browser';
import { buildBrowserContextMenu, isTabOpenableUrl, linkStatusText } from '../../../shared/browser-context-menu';
import { labelBrowserMenu, runBrowserMenuAction } from './browser-menu-actions';
import {
  activeHistoryUrl,
  encodeHistoryRestoreSrc,
  sameBrowserHistory,
  sanitizeBrowserHistory,
  type BrowserHistory,
} from '../../../shared/browser-history';
import '../../styles/browser.css';

interface BrowserPaneProps {
  onMoveToWorkspace?: () => void;
  initialUrl?: string;
  surfaceId: string;
  workspaceId?: string;
  onUrlChange?: (url: string) => void;
  /**
   * What the tab should read from the page; '' when the page has no title.
   * Only a tab passes this: the side panel has no tab to label.
   */
  onTitleChange?: (title: string) => void;
  /**
   * Which backend drives this surface. `web` is the Electron <webview> this
   * pane has always been; `agent` streams the real Chrome page, with the
   * hardened webview retained for the optional session dashboard.
   */
  engine?: BrowserEngine;
  onEngineChange?: (engine: BrowserEngine) => void;
  /**
   * The back/forward stack this pane had (#315), restored on mount. Used only
   * when its active entry IS `initialUrl`: the caller's URL rules (#232) stay
   * the authority on which page opens, and the history only adds Back/Forward.
   */
  initialHistory?: BrowserHistory;
  /** The stack changed — persist it beside the URL. Web mode only. */
  onHistoryChange?: (history: BrowserHistory) => void;
  /**
   * Is the pane on screen? False for a background tab and for every pane of an
   * inactive workspace, which an ancestor hides with `visibility: hidden`. The
   * pane cannot tell on its own in time to style the webview, so the parent
   * that does the hiding says so.
   */
  visible?: boolean;
  /**
   * Focus this pane (#388). A click inside the page is handled by the guest
   * process and never reaches the host DOM, so the split-tree leaf's onClick
   * never sees it. The <webview> ELEMENT does receive DOM focus when the guest
   * takes it, and that is the signal used here.
   */
  onActivate?: () => void;
  /**
   * Is this the focused pane? When another pane takes focus the webview is
   * blurred, or it would stay `document.activeElement` and the next click
   * into it would fire no `focus` event at all.
   */
  focused?: boolean;
  /**
   * "Open link in new tab" from the right-click menu (#439), or a Ctrl+click
   * or middle-click on a link: a new browser tab beside this one. The clicks
   * open it in the `background`, as a browser does. Without it (the side
   * panel, which has no tabs) the tab goes into the active workspace's panes
   * instead.
   */
  onOpenInNewTab?: (url: string, opts?: { background?: boolean }) => void;
}

/**
 * The src a pane mounts on: the restore sentinel when there is a stack worth
 * restoring, or null for a plain `initialUrl` load. A one-entry stack restores
 * nothing a plain load would not, and agent mode never shows the page itself.
 * Re-sanitized because session.json is a file the user can edit.
 */
export function historyRestoreSrc(
  engine: BrowserEngine,
  initialUrl: string,
  history: BrowserHistory | undefined,
): string | null {
  if (engine !== 'web') return null;
  const clean = sanitizeBrowserHistory(history);
  if (!clean || clean.entries.length < 2 || activeHistoryUrl(clean) !== initialUrl) return null;
  return encodeHistoryRestoreSrc(clean);
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

/**
 * A webview's `getTitle()` without the title Chromium makes up for an untitled
 * page, which is its URL without the scheme. The tab has its own, shorter answer
 * for that page. Only `getTitle()` needs this: an untitled page fires no
 * page-title-updated.
 */
export function explicitPageTitle(title: string, url: string): string {
  const bare = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return bare(title) === bare(url) ? '' : title;
}

/** Address-bar input → a URL, matching the web engine's own resolution. */
export function resolveInputUrl(input: string): string {
  if (/^https?:\/\//.test(input)) return input;
  if (input.includes('.') && !input.includes(' ')) return 'https://' + input;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/** Agent-mode lifecycle, as far as this pane is concerned. */
type AgentStatus = 'idle' | 'starting' | 'live' | 'setup' | 'error';

/**
 * A hidden webview an agent is driving: painted, transparent, out of the way.
 *
 * `visibility: visible` overrides the hidden ancestor, so Chromium keeps the
 * guest rendering (frames, requestAnimationFrame, unthrottled timers) and
 * `capturePage` / `Page.captureScreenshot` get the frame they wait for.
 * `opacity: 0` keeps it from showing over the pane the user is looking at,
 * `pointer-events: none` lets the mouse through to that pane, and
 * `tabIndex = -1` keeps Tab from walking into it: a visible webview is
 * focusable again, and without it Tab from an input of the workspace on
 * screen moved focus into the hidden page.
 *
 * Measured in a bare Electron 43 harness: the window still showed the active
 * workspace, its hit test landed on the visible pane, Tab skipped the hidden
 * webview, and CDP clicks, the accessibility snapshot and both captures still
 * worked on the hidden page.
 */
export const KEEP_RENDERING_STYLE: CSSProperties = {
  visibility: 'visible',
  opacity: 0,
  pointerEvents: 'none',
};

/**
 * The webview's own style and tab index. Pure so every case is testable
 * without a webview.
 *
 * Nothing to show (agent setup card, blank page) wins: hidden is exactly what
 * those want, on screen or off. A hidden pane goes on painting only while an
 * agent holds a lease on it (utils/browser-keep-rendering.ts); every other
 * hidden pane inherits `visibility: hidden` and stays throttled like a
 * background tab, as it always has. Agent mode is excluded: its webview shows
 * agent-browser's dashboard, and its pages are painted by a real Chrome.
 */
export function webviewHiding(s: {
  overlay: boolean;
  isBlank: boolean;
  isAgent: boolean;
  visible: boolean;
  keepRendering: boolean;
}): { style?: CSSProperties; tabIndex?: number } {
  if (s.overlay || s.isBlank) return { style: { visibility: 'hidden' } };
  if (!s.visible && s.keepRendering && !s.isAgent) return { style: KEEP_RENDERING_STYLE, tabIndex: -1 };
  return {};
}

export default function BrowserPane({
  onMoveToWorkspace,
  // Blank, not the project's own GitHub repo (#232). A browser surface nobody
  // has given a URL has nowhere to be, and shipping the vendor's page as that
  // answer meant wmux opened its own repo on every launch — then persisted it
  // as if the user had chosen it. See utils/browser-start-page.ts.
  initialUrl = BROWSER_BLANK_PAGE,
  surfaceId,
  workspaceId,
  onUrlChange,
  onTitleChange,
  engine = 'web',
  onEngineChange,
  initialHistory,
  onHistoryChange,
  visible = true,
  onActivate,
  focused,
  onOpenInNewTab,
}: BrowserPaneProps) {
  const keepRendering = useKeepRendering(surfaceId);
  // src is fixed to the initial page; all later navigation goes through loadURL
  // (below). Binding src to a mutable url state AND calling loadURL made every
  // navigation trigger two loads of the same URL, which raced and produced a
  // spurious ERR_ABORTED (logged by the main process' guest-view handler).
  // The engine switch is exactly such a mutation, so it goes through loadURL
  // too and src stays pinned to initialSrc forever.
  const t = useT();
  // A pane with a saved back/forward stack mounts on the restore sentinel and
  // main rebuilds the stack before the guest loads anything (#315); the active
  // entry is `initialUrl` either way, so the address bar starts on it.
  const [initialSrc] = useState(() => historyRestoreSrc(engine, initialUrl, initialHistory) ?? initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const webviewRef = useRef<any>(null);
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;
  const onHistoryChangeRef = useRef(onHistoryChange);
  onHistoryChangeRef.current = onHistoryChange;
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const lastHistoryRef = useRef<BrowserHistory | null>(null);
  // Read by the context-menu listener, which is registered once: `useT()` and
  // the callback prop are new on every render (#141).
  const tRef = useRef(t);
  tRef.current = t;
  const onOpenInNewTabRef = useRef(onOpenInNewTab);
  onOpenInNewTabRef.current = onOpenInNewTab;
  // The URL of the link under the pointer, for the status bar (#439).
  const [hoverUrl, setHoverUrl] = useState('');

  // Agent mode. `agentUrl` is the page the REMOTE Chrome was last asked to
  // open; it is what the address bar shows in agent mode, because the webview's
  // own URL is the dashboard and showing that would be a lie about where the
  // agent is.
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [agentError, setAgentError] = useState('');
  const [agentUrl, setAgentUrl] = useState(initialUrl);
  const [presentation, setPresentation] = useState<'page' | 'dashboard'>('page');
  const [dashboardAvailable, setDashboardAvailable] = useState(false);
  const dashboardUrlRef = useRef<string | null>(null);
  const viewerRef = useRef<AgentViewerHandle>(null);
  const [agentTabs, setAgentTabs] = useState<AgentBrowserTab[]>([]);
  const [agentConnected, setAgentConnected] = useState(false);
  const agentConnectedRef = useRef(false);
  const pendingNavigationRef = useRef<string | null>(null);
  const [focusAddress, setFocusAddress] = useState(0);
  const freshStartRef = useRef(false);

  // Mirrors read from webview event listeners and from callbacks that are
  // deliberately dependency-free (they are handed to a memoised child and to
  // long-lived listeners). Assigned during render so a listener that fires
  // between two commits can never act on a stale engine.
  const engineRef = useRef<BrowserEngine>(engine);
  engineRef.current = engine;
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  const initialUrlRef = useRef(initialUrl);
  initialUrlRef.current = initialUrl;
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
      pendingNavigationRef.current = null;
      agentConnectedRef.current = false;
      // Invalidate answers from the detached view, including StrictMode's
      // simulated unmount. The next setup joins the same main-process startup.
      switchSeqRef.current++;
      prevEngineRef.current = 'web';
    };
  }, []);

  /** Toolbar commands never address the dashboard guest or start a session. */
  const agentAction = useCallback((action: AgentViewerAction) => {
    return viewerRef.current?.action(action) ?? Promise.reject(new Error('Page is not connected'));
  }, []);

  const onAgentConnection = useCallback((connected: boolean) => {
    agentConnectedRef.current = connected;
    setAgentConnected(connected);
    if (!connected || engineRef.current !== 'agent' || !pendingNavigationRef.current) return;
    const url = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    void agentAction({ type: 'navigate', url }).catch(() => {});
  }, [agentAction]);

  // Engine state changes before the outgoing dashboard finishes loading. Keep
  // its identity until a Web commit (or an explicit toolbar command) owns it.
  const isOutgoingDashboardUrl = useCallback((url: string) => {
    const dashboard = dashboardUrlRef.current;
    return !!dashboard && url.startsWith(dashboard.split('?')[0]);
  }, []);

  const navigate = useCallback((newUrl: string) => {
    const resolved = resolveInputUrl(newUrl);
    // In agent mode the address bar addresses the REMOTE browser. The webview
    // stays on the dashboard; navigating it would throw away the viewer the
    // user just asked to watch.
    if (engineRef.current === 'agent') {
      if (!agentConnectedRef.current || !viewerRef.current) {
        pendingNavigationRef.current = resolved;
        return;
      }
      void agentAction({ type: 'navigate', url: resolved }).catch(() => {});
      return;
    }
    // Single navigation. loadURL can still reject with ERR_ABORTED for genuine
    // cases (a client-side redirect, an unreachable host, navigating again
    // mid-load); those are reflected by the did-*-load handlers below, so
    // swallow the promise rejection rather than leaving it unhandled.
    invalidateAgentBrowserReadback(surfaceId);
    dashboardUrlRef.current = null;
    webviewRef.current?.loadURL(resolved).catch(() => {});
  }, [agentAction, surfaceId]);

  const goBack = useCallback(() => {
    if (engineRef.current === 'agent') { void agentAction({ type: 'back' }).catch(() => {}); return; }
    invalidateAgentBrowserReadback(surfaceId);
    dashboardUrlRef.current = null;
    webviewRef.current?.goBack();
  }, [agentAction, surfaceId]);
  const goForward = useCallback(() => {
    if (engineRef.current === 'agent') { void agentAction({ type: 'forward' }).catch(() => {}); return; }
    invalidateAgentBrowserReadback(surfaceId);
    dashboardUrlRef.current = null;
    webviewRef.current?.goForward();
  }, [agentAction, surfaceId]);
  const reload = useCallback(() => {
    if (engineRef.current === 'agent') { void agentAction({ type: 'reload' }).catch(() => {}); return; }
    invalidateAgentBrowserReadback(surfaceId);
    dashboardUrlRef.current = null;
    webviewRef.current?.reload();
  }, [agentAction, surfaceId]);
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const id = (event as CustomEvent<{ surfaceId?: string }>).detail?.surfaceId;
      if (id === surfaceId) reload();
    };
    document.addEventListener('wmux:refresh-surface', onRefresh);
    return () => document.removeEventListener('wmux:refresh-surface', onRefresh);
  }, [reload, surfaceId]);
  const stop = useCallback(() => webviewRef.current?.stop(), []);
  const openDevTools = useCallback(() => {
    if (engineRef.current === 'agent') return;
    const wcId = webviewRef.current?.getWebContentsId?.();
    if (typeof wcId === 'number') window.wmux?.browser?.focusDevTools?.(wcId);
  }, []);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    // The stack after a navigation, for the caller to persist (#315). Main reads
    // it off the guest: the <webview> element exposes canGoBack, not entries.
    const refreshHistory = () => {
      if (engineRef.current === 'agent' || !onHistoryChangeRef.current) return;
      let id: number | undefined;
      try { id = wv.getWebContentsId?.(); } catch { return; } // not attached yet
      if (typeof id !== 'number') return;
      window.wmux?.browser?.getHistory?.(id).then((history: BrowserHistory | null) => {
        if (!history || !mountedRef.current || engineRef.current === 'agent') return;
        if (sameBrowserHistory(history, lastHistoryRef.current)) return;
        lastHistoryRef.current = history;
        onHistoryChangeRef.current?.(history);
      }).catch(() => {});
    };

    const reportWebUrl = (url: string) => {
      if (isOutgoingDashboardUrl(url)) return false;
      // The initial guest load is not newer user intent. A different URL is,
      // including page links and CDP navigation that bypass the address bar.
      if (url !== currentUrlRef.current) invalidateAgentBrowserReadback(surfaceId);
      dashboardUrlRef.current = null;
      currentUrlRef.current = url;
      setCurrentUrl(url);
      onUrlChange?.(url);
      return true;
    };
    const onNavigate = (e: any) => {
      // In agent mode every navigation here is the dashboard SPA moving around
      // inside itself. Recording it would overwrite the surface's persisted
      // `url` with the dashboard, so flipping back to web would land on the
      // viewer instead of the page.
      if (engineRef.current === 'agent') return;
      if (!reportWebUrl(e.url)) return;
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
      refreshHistory();
      return true;
    };
    // The old page's title goes with its document. Measured on a real webview:
    // did-navigate always comes before the new page's title event, and a page
    // with no <title> fires none, so without this it would keep the old title.
    // Not for an in-page navigation: the document stays, and so does its title.
    const onNewDocument = (e: any) => {
      if (onNavigate(e)) onTitleChangeRef.current?.('');
    };
    const onTitle = (e: any) => {
      if (engineRef.current === 'agent') return; // the dashboard's own title
      onTitleChangeRef.current?.(e.title ?? '');
    };
    const onStartLoad = () => setIsLoading(true);
    const onStopLoad = () => {
      setIsLoading(false);
      if (engineRef.current === 'agent') return;
      if (!reportWebUrl(wv.getURL())) return;
      // Titles arrive after the commit; this is when the entry has its own.
      refreshHistory();
    };
    // The dashboard is optional observability. When it is not listening, the
    // webview paints ERR_CONNECTION_REFUSED, which the user reads as a broken
    // browser. Catch it and say what actually happened instead.
    const onFailLoad = (e: any) => {
      if (e?.isMainFrame === false) return;
      if (engineRef.current !== 'agent') {
        // A failed load fires no did-navigate, and the bar now shows the URL that
        // failed. -3 is ERR_ABORTED: the page was only interrupted, often by the
        // next navigation, and is not gone.
        if (e?.errorCode !== -3) onTitleChangeRef.current?.('');
        return;
      }
      const dash = dashboardUrlRef.current;
      if (!dash) return; // nothing of ours is loading; not our failure to explain
      const failed = String(e?.validatedURL ?? '');
      if (!failed || failed.startsWith(dash.split('?')[0])) setDashboardAvailable(false);
    };

    wv.addEventListener('did-navigate', onNewDocument);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('did-start-loading', onStartLoad);
    wv.addEventListener('did-stop-loading', onStopLoad);
    wv.addEventListener('did-fail-load', onFailLoad);

    return () => {
      wv.removeEventListener('did-navigate', onNewDocument);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
      wv.removeEventListener('page-title-updated', onTitle);
      wv.removeEventListener('did-start-loading', onStartLoad);
      wv.removeEventListener('did-stop-loading', onStopLoad);
      wv.removeEventListener('did-fail-load', onFailLoad);
    };
  }, []);

  // Right-click menu and link status bar (#439). Both come from the <webview>
  // tag's own events: `context-menu` carries what was under the pointer, and
  // `update-target-url` the hovered link ('' when the pointer leaves it). Not
  // in agent mode, where the page is agent-browser's dashboard, not the user's.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onTargetUrl = (e: any) => {
      setHoverUrl(engineRef.current === 'agent' ? '' : linkStatusText(e?.url));
    };
    const clearHover = () => setHoverUrl('');
    const onStartNavigation = (e: any) => {
      if (e?.isMainFrame === false) return;
      clearHover();
      if (engineRef.current !== 'agent' && e?.url && !isOutgoingDashboardUrl(e.url) && e.url !== currentUrlRef.current) {
        invalidateAgentBrowserReadback(surfaceId);
      }
    };
    const onContextMenu = (e: any) => {
      if (engineRef.current === 'agent') return;
      const params = e?.params ?? {};
      const entries = buildBrowserContextMenu(params, { canGoBack: !!wv.canGoBack?.(), canGoForward: !!wv.canGoForward?.() });
      const show = window.wmux?.browser?.showContextMenu;
      if (!show) return;
      show(labelBrowserMenu(entries, tRef.current)).then((action: Parameters<typeof runBrowserMenuAction>[0] | null) => {
        if (!action || !mountedRef.current) return;
        runBrowserMenuAction(action, {
          linkURL: params.linkURL ?? '',
          srcURL: params.srcURL ?? '',
          x: params.x ?? 0,
          y: params.y ?? 0,
          webview: wv,
          openInNewTab: (url) => {
            if (onOpenInNewTabRef.current) onOpenInNewTabRef.current(url);
            else openInNewBrowserTab(url);
          },
          openExternal: (url) => window.wmux?.system?.openExternal?.(url),
          copyText: (text) => { window.wmux?.clipboard?.writeText?.(text)?.catch?.(() => {}); },
        });
      }).catch(() => {});
    };
    wv.addEventListener('update-target-url', onTargetUrl);
    wv.addEventListener('context-menu', onContextMenu);
    // A link the page navigated away from, or a pointer that left the pane
    // without leaving the link, would otherwise leave a stale URL showing.
    wv.addEventListener('did-start-navigation', onStartNavigation);
    wv.addEventListener('mouseleave', clearHover);
    return () => {
      wv.removeEventListener('update-target-url', onTargetUrl);
      wv.removeEventListener('context-menu', onContextMenu);
      wv.removeEventListener('did-start-navigation', onStartNavigation);
      wv.removeEventListener('mouseleave', clearHover);
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
  // `target="_blank"` links and `window.open()` used to be silently dropped by
  // a webview with no `allowpopups`, so they read as dead buttons (issue #126).
  // The bridge opens them in place; a sized popup goes native (#281).
  // Re-installed on every dom-ready because each document starts clean; the
  // bridge itself is idempotent for SPA re-entry.
  //
  // It exists for arbitrary sites. The dashboard is a known SPA that does not
  // need it, so agent mode returns early — same guard placement, same reason.
  const installPopupBridge = useCallback(() => {
    if (engineRef.current === 'agent') return;
    webviewRef.current?.executeJavaScript?.(popupBridgeSource()).catch(() => {});
  }, []);

  // Clicking into the page focuses the pane (#388). See `onActivate`.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onFocus = () => activateRef.current?.();
    wv.addEventListener('focus', onFocus);
    return () => wv.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    if (focused !== false) return;
    const wv = webviewRef.current;
    if (wv && document.activeElement === wv) wv.blur();
  }, [focused]);

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
    agentConnectedRef.current = false;
    setAgentConnected(false);
    setAgentTabs([]);
    setAgentError('');
    setDashboardAvailable(false);
    setAgentUrl(url);
    if (!api) { setAgentStatus('setup'); return; }

    let result: { installed?: boolean; dashboardUrl?: string } | null;
    try {
      result = await api.enable(surfaceId, url);
    } catch (err) {
      if (!stale()) { setAgentError(String(err)); setAgentStatus('error'); }
      return;
    }
    if (stale()) return;

    if (!result?.installed) { setAgentStatus('setup'); return; }
    dashboardUrlRef.current = result.dashboardUrl ?? null;
    freshStartRef.current = false;
    setAgentStatus('live');
    // Page never waits for the optional dashboard, including its port probe.
    void api.status().then((status: { dashboardAvailable: boolean }) => {
      if (stale()) return;
      const available = status.dashboardAvailable && !!result?.dashboardUrl;
      setDashboardAvailable(available);
      if (available) webviewRef.current?.loadURL(result!.dashboardUrl!).catch(() => {});
    }).catch(() => { if (!stale()) setDashboardAvailable(false); });
  }, [surfaceId]);

  /** A fresh blank session is destructive and only this explicit action requests it. */
  const startNewAgentSession = useCallback(async () => {
    const seq = ++switchSeqRef.current;
    const stale = () => !mountedRef.current || engineRef.current !== 'agent' || switchSeqRef.current !== seq;
    freshStartRef.current = true;
    pendingNavigationRef.current = null;
    setPresentation('page');
    setAgentStatus('starting');
    agentConnectedRef.current = false;
    setAgentConnected(false);
    setAgentTabs([]);
    setAgentError('');
    try {
      await window.wmux.agentBrowser.disable(surfaceId, true);
      if (stale()) return;
      await enterAgentMode(BROWSER_BLANK_PAGE);
    } catch (err) {
      if (!stale()) { setAgentError(String(err)); setAgentStatus('error'); }
    }
  }, [enterAgentMode, surfaceId]);

  const retryAgentMode = useCallback(() => {
    if (freshStartRef.current) void startNewAgentSession();
    else void enterAgentMode(agentUrlRef.current);
  }, [enterAgentMode, startNewAgentSession]);

  const leaveAgentMode = useCallback(async () => {
    const seq = ++switchSeqRef.current;
    const stale = () => !mountedRef.current || switchSeqRef.current !== seq;
    setAgentStatus('idle');
    agentConnectedRef.current = false;
    pendingNavigationRef.current = null;

    const handoff = getAgentBrowserHandoff(surfaceId);
    const result = (await handoff?.promise) ?? null;
    const restoredUrl = getAgentBrowserHandoff(surfaceId) === handoff ? handoff?.restoredUrl : undefined;
    if (stale() || (handoff && restoredUrl === undefined && !canApplyAgentBrowserReadback(surfaceId, handoff.promise))) return;

    const showing = webviewRef.current?.getURL?.() ?? '';
    const destination = restoredUrl === undefined ? result : { url: restoredUrl || initialUrlRef.current || BROWSER_BLANK_PAGE };
    const target = disableTarget(destination, agentUrlRef.current || currentUrlRef.current, showing);
    if (target) {
      currentUrlRef.current = target;
      setCurrentUrl(target);
      webviewRef.current?.loadURL(target).catch(() => {});
    } else {
      // Still on the page, as after cancelling the setup card, so no navigation
      // will report its title.
      onTitleChangeRef.current?.(explicitPageTitle(webviewRef.current?.getTitle?.() ?? '', showing));
    }
  }, [surfaceId]);

  // Capture at render: readback may settle before this commit's passive effect.
  const joiningAgentHandoff = engine === 'web' && hasPendingAgentBrowserHandoff(surfaceId);
  useEffect(() => {
    const prev = prevEngineRef.current;
    prevEngineRef.current = engine;
    const decision = engineTransition(prev, engine, currentUrlRef.current);
    if (decision.action === 'enable') { pendingNavigationRef.current = null; freshStartRef.current = false; void enterAgentMode(decision.url); }
    else if (decision.action === 'disable' || joiningAgentHandoff) void leaveAgentMode();
  }, [engine, enterAgentMode, leaveAgentMode, joiningAgentHandoff]);

  // Streamed tabs supply the Agent title; leaving clears it for the Web page.
  const wasAgentRef = useRef(false);
  useEffect(() => {
    if (engine !== 'agent') {
      if (wasAgentRef.current) onTitleChangeRef.current?.('');
      wasAgentRef.current = false;
      return;
    }
    wasAgentRef.current = true;
  }, [engine]);

  // React unmount only detaches AgentBrowserViewer's stream. The surface owns
  // Chrome across split-tree reparenting; store close/engine transitions reap it.

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

  // Ctrl+click or middle-click on a link in this pane's page (main's
  // webviewWindowOpenPolicy). Every pane hears it; only the one hosting that
  // guest answers. Same destination as the right-click "Open link in new tab";
  // with no pane to take the tab, the link opens here rather than nowhere.
  useEffect(() => {
    return window.wmux?.browser?.onOpenInNewTab?.((guestId: number, url: string) => {
      const wv = webviewRef.current;
      let ownId: number | undefined;
      try { ownId = wv?.getWebContentsId?.(); } catch { return; } // not attached yet
      if (ownId !== guestId || !isTabOpenableUrl(url)) return;
      if (onOpenInNewTabRef.current) onOpenInNewTabRef.current(url, { background: true });
      else if (!openInNewBrowserTab(url)) wv?.loadURL?.(url)?.catch?.(() => {});
    });
  }, []);

  const showDashboard = useCallback(() => {
    setPresentation('dashboard');
    void window.wmux.agentBrowser.status().then((status: { dashboardAvailable: boolean }) => {
      if (!mountedRef.current || engineRef.current !== 'agent') return;
      setDashboardAvailable(status.dashboardAvailable);
      const url = dashboardUrlRef.current;
      if (url && status.dashboardAvailable) webviewRef.current?.loadURL(url).catch(() => {});
    }).catch(() => { if (mountedRef.current) setDashboardAvailable(false); });
  }, []);
  const newAgentTab = useCallback(() => {
    void agentAction({ type: 'tab-new' }).then(() => {
      if (!mountedRef.current || engineRef.current !== 'agent') return;
      setPresentation('page');
      setFocusAddress((request) => request + 1);
    }).catch(() => {});
  }, [agentAction]);

  const isAgent = engine === 'agent';
  const setupOverlay = isAgent && (agentStatus === 'setup' || (presentation === 'dashboard' && !dashboardAvailable));
  const pageVisible = isAgent && presentation === 'page';
  const overlay = setupOverlay || pageVisible;
  /**
   * Nothing to show yet — the state a surface is in when no page was asked for
   * (#232, where the old answer was to load the project's own GitHub repo).
   *
   * It needs a placeholder rather than just letting `about:blank` through,
   * because a blank guest page paints WHITE regardless of the app's theme, and a
   * white rectangle where a dark pane should be reads as a crash, not as "empty".
   * Hidden the same way the setup card hides it: `visibility`, never unmounting,
   * so the webview keeps its CDP registration.
   */
  const isBlank = !isAgent && (!currentUrl || currentUrl === BROWSER_BLANK_PAGE);
  /**
   * An empty address bar, not the literal `about:blank`: the surface has no
   * page, and naming the sentinel invites the user to think it is one.
   */
  let barUrl = currentUrl;
  if (isAgent) barUrl = agentUrl;
  else if (isBlank) barUrl = '';

  return (
    <div className="browser-pane" onMouseDownCapture={claimCdp}>
      <AddressBar
        url={barUrl}
        isLoading={isLoading}
        canGoBack={isAgent ? agentConnected : canGoBack}
        canGoForward={isAgent ? agentConnected : canGoForward}
        engine={engine}
        onEngineChange={onEngineChange}
        onNavigate={navigate}
        onBack={goBack}
        onForward={goForward}
        onReload={reload}
        onStop={stop}
        onDevTools={openDevTools}
        onMoveToWorkspace={onMoveToWorkspace}
        agentConnected={agentConnected}
        presentation={presentation}
        onToggleDashboard={() => presentation === 'page' ? showDashboard() : setPresentation('page')}
        onNewTab={newAgentTab}
        focusRequest={focusAddress}
      />
      {isAgent && agentTabs.length >= 2 && <div className="browser-pane__chrome-tabs" aria-label={t('browser.agent.tabs', 'Browser tabs')}>
        {agentTabs.map((tab) => <div key={tab.tabId} className={`browser-pane__chrome-tab${tab.active ? ' browser-pane__chrome-tab--active' : ''}`}>
          <button type="button" className="browser-pane__chrome-tab-select" aria-pressed={tab.active} disabled={!agentConnected}
            title={tab.url} onClick={() => { void agentAction({ type: 'tab-select', tabId: tab.tabId }).catch(() => {}); }}>
            {tab.title || (tab.url === 'about:blank' ? t('browser.agent.newTab', 'New tab') : tab.url)}
          </button>
          <button type="button" className="browser-pane__chrome-tab-close" disabled={!agentConnected}
            aria-label={t('browser.agent.closeTab', 'Close tab')} onClick={() => { void agentAction({ type: 'tab-close', tabId: tab.tabId }).catch(() => {}); }}>×</button>
        </div>)}
        <button type="button" className="browser-address-bar__btn" disabled={!agentConnected} onClick={newAgentTab}
          aria-label={t('browser.agent.newTab', 'New tab')}>+</button>
      </div>}
      <div className="browser-pane__body">
        {/* @ts-ignore — webview is an Electron-specific HTML element */}
        <webview
          ref={webviewRef}
          src={initialSrc}
          // Lets a new-window request reach main's setWindowOpenHandler at all
          // (without it Chromium drops it silently). Main lets out only a sized
          // popup — popup sign-in, #281 — and opens the rest in place. Spread
          // as a STRING: the JSX type says boolean, but React drops a boolean
          // `true` on an element it does not know rather than writing it.
          {...{ allowpopups: 'true' }}
          className="browser-pane__webview"
          // Hidden rather than unmounted: unmounting destroys the guest page and
          // its CDP registration, so the setup card would cost the user the tab
          // they were on. Same reason keep-alive tabs use visibility. A pane an
          // agent drives keeps painting while hidden: see webviewHiding.
          {...webviewHiding({ overlay, isBlank, isAgent, visible, keepRendering })}
        />
        {isAgent && agentStatus === 'starting' && pageVisible && <div className="browser-pane__blank" role="status">
          {t('browser.agent.starting', 'Starting browser session…')}
        </div>}
        {isAgent && agentStatus === 'error' && pageVisible && <div className="browser-pane__blank" role="alert">
          <p className="browser-pane__blank-title">{agentError}</p>
          <button className="browser-pane__setup-btn" onClick={retryAgentMode}>{t('agentBrowser.retry', 'Try again')}</button>
          <button className="browser-pane__setup-btn" onClick={() => void startNewAgentSession()}>
            {t('browser.agent.startNew', 'Start new session')}
          </button>
        </div>}
        {isAgent && agentStatus === 'live' && <AgentBrowserViewer ref={viewerRef}
          surfaceId={surfaceId} visible={visible && pageVisible} focused={focused} onActivate={onActivate}
          onPageState={(url, title) => { setAgentUrl(url); onUrlChange?.(url); if (title !== undefined) onTitleChangeRef.current?.(title); }}
          onTabs={setAgentTabs} onConnection={onAgentConnection} onDashboard={showDashboard} onStartNew={() => void startNewAgentSession()}
        />}
        {isBlank && !overlay && (
          <div className="browser-pane__blank">
            <p className="browser-pane__blank-title">
              {t('browser.blank.title', 'No page open')}
            </p>
            <p className="browser-pane__blank-hint">
              {t(
                'browser.blank.hint',
                'Type a URL above, or set a start page in Settings → Browser.',
              )}
            </p>
          </div>
        )}
        {setupOverlay && (
          <AgentBrowserSetup
            reason={agentStatus === 'setup' ? 'not-installed' : 'no-dashboard'}
            onInstalled={retryAgentMode}
            onRetry={retryAgentMode}
            onCancel={() => onEngineChange?.('web')}
          />
        )}
        {hoverUrl && !isAgent && !overlay && (
          // Chrome's bottom-left link readout (#439). Absolute over the page and
          // click-through, so it never moves or covers what it describes.
          <div className="browser-pane__link-status" aria-hidden="true">{hoverUrl}</div>
        )}
      </div>
    </div>
  );
}
