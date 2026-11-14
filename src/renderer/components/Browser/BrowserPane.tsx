import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import AddressBar from './AddressBar';
import { useT } from '../../i18n';
import AgentBrowserSetup from './AgentBrowserSetup';
import { popupBridgeSource } from './popup-bridge';
import type { BrowserEngine } from '../../../shared/types';
import { browserUrlLabel } from '../SplitPane/surface-label';
import { BROWSER_BLANK_PAGE } from '../../utils/browser-start-page';
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
   * pane has always been; `agent` points the SAME webview at agent-browser's
   * dashboard, deep-linked to this surface's session, while the actual pages
   * are driven in a real Chrome outside wmux.
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
type AgentStatus = 'idle' | 'starting' | 'live' | 'setup' | 'no-dashboard';

/**
 * How often the address bar re-asks the session where Chrome actually is.
 *
 * In agent mode the bar can only otherwise show the last URL the PANE asked
 * for, and the agent navigates on its own — so without a poll the bar reports a
 * page nobody is on for as long as the pane is open.
 *
 * 3s, chosen against the two costs. Each poll is a real agent-browser
 * invocation, measured at ~170ms against 0.35.0 for a `get url` on a live
 * session, so 3s is a ~6% duty cycle for one visible agent pane — noticeable if
 * it ran unconditionally, which is why it does not (see `shouldPollAgentUrl`:
 * agent mode only, visible only, never overlapping itself). Going slower makes
 * the bar visibly wrong after a click; going faster buys accuracy nobody reads,
 * since this is a status readout and not a control.
 *
 * Issue #141 is the reason this is a constant and not a nice round 2000 pulled
 * out of a hook: there, a 2s poll ran at RENDER speed because an unstable
 * `useT()` identity invalidated its dependency array every commit. The effect
 * driving this interval depends on primitives only — engine, status, surfaceId
 * — and calls nothing it closes over from render.
 */
export const AGENT_URL_POLL_MS = 3_000;

/**
 * How long after the pane asks for a URL the poll stops being believed.
 *
 * `open` is asynchronous and Chrome takes a moment to commit the navigation, so
 * a poll landing in that window reports the page the user just navigated AWAY
 * from — and the bar would visibly snap back to it. Slightly longer than one
 * poll interval would be wasteful; slightly less than one is enough, because
 * the tick after that reads the real answer either way.
 */
export const AGENT_URL_POLL_SUPPRESS_MS = 2_000;

/** Statuses in which a session exists and can be asked where it is. */
const POLLABLE_STATUSES: ReadonlySet<string> = new Set(['live', 'no-dashboard']);

/**
 * Should this tick actually spend an agent-browser invocation?
 *
 * Pure, so every reason to skip is testable without a timer, a webview or a
 * preload bridge — and so the list of reasons is readable in one place rather
 * than spread across an effect body.
 */
export function shouldPollAgentUrl(s: {
  engine: BrowserEngine;
  status: string;
  /** The whole window is minimised/backgrounded — nobody is reading anything. */
  documentHidden: boolean;
  /** This pane is a hidden keep-alive tab, or an overlaid one. */
  paneHidden: boolean;
  /** A previous poll has not answered yet; a second would just queue behind it. */
  inFlight: boolean;
  now: number;
  suppressUntil: number;
}): boolean {
  if (s.engine !== 'agent') return false;
  if (!POLLABLE_STATUSES.has(s.status)) return false;
  if (s.documentHidden || s.paneHidden) return false;
  if (s.inFlight) return false;
  return s.now >= s.suppressUntil;
}

/**
 * Is this element not being shown? Used to keep hidden tabs from polling.
 *
 * wmux's keep-alive tabs stay mounted and are hidden with `visibility`, which
 * `offsetParent` does NOT report — hence `checkVisibility`, which does, with
 * the older property as the fallback for environments that lack it (jsdom).
 * A missing element answers "not hidden": that is the first-render case, and
 * suppressing the first poll of a pane the user is looking at would be the
 * wrong way to be wrong.
 */
export function elementHidden(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  const check = (el as { checkVisibility?: (o?: unknown) => boolean }).checkVisibility;
  if (typeof check === 'function') return !check.call(el, { visibilityProperty: true });
  return el.offsetParent === null;
}

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
  // Render-only: the #141 warning on AGENT_URL_POLL_MS is about `useT()`'s
  // unstable identity in a dependency ARRAY. This one is read in JSX and never
  // closed over by an effect.
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

  // Poll bookkeeping. Refs rather than state on purpose: neither value is
  // rendered, and putting them in state would re-render the pane (and churn the
  // interval effect's dependencies) on every tick — the shape of #141.
  const pollInFlightRef = useRef(false);
  const suppressPollUntilRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * Ask the agent-browser session to open a URL.
   *
   * `open`, not `enable`. This used to reuse `enable` because it was the only
   * verb the renderer had, but `enable` also acquires a dashboard reference and
   * relaunches with the stream env — neither of which does anything for a
   * session that is already live, since the stream port is read at browser
   * launch and cannot be moved afterwards. `enable` stays as the FALLBACK for
   * the one case `open` legitimately refuses: no session yet, because the user
   * typed a URL while the flip into agent mode was still in flight.
   */
  const openInAgent = useCallback(async (url: string) => {
    setAgentUrl(url);
    // The page is about to change; a poll that lands before Chrome commits
    // would report where we came FROM and snap the bar back to it.
    suppressPollUntilRef.current = Date.now() + AGENT_URL_POLL_SUPPRESS_MS;
    const api = window.wmux?.agentBrowser;
    try {
      const res = await api?.open?.(surfaceId, url);
      if (res?.ok) return;
      await api?.enable?.(surfaceId, url);
    } catch {
      /* the bar already shows the intent; nothing here can recover a dead CLI */
    }
  }, [surfaceId]);

  const navigate = useCallback((newUrl: string) => {
    const resolved = resolveInputUrl(newUrl);
    // In agent mode the address bar addresses the REMOTE browser. The webview
    // stays on the dashboard; navigating it would throw away the viewer the
    // user just asked to watch.
    if (engineRef.current === 'agent') {
      openInAgent(resolved).catch(() => {});
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
      refreshHistory();
    };
    // The old page's title goes with its document. Measured on a real webview:
    // did-navigate always comes before the new page's title event, and a page
    // with no <title> fires none, so without this it would keep the old title.
    // Not for an in-page navigation: the document stays, and so does its title.
    const onNewDocument = (e: any) => {
      onNavigate(e);
      if (engineRef.current !== 'agent') onTitleChangeRef.current?.('');
    };
    const onTitle = (e: any) => {
      if (engineRef.current === 'agent') return; // the dashboard's own title
      onTitleChangeRef.current?.(e.title ?? '');
    };
    const onStartLoad = () => setIsLoading(true);
    const onStopLoad = () => {
      setIsLoading(false);
      if (engineRef.current === 'agent') return;
      const finalUrl = wv.getURL();
      setCurrentUrl(finalUrl);
      onUrlChange?.(finalUrl);
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
      if (!failed || failed.startsWith(dash.split('?')[0])) setAgentStatus('no-dashboard');
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
    const onStartNavigation = (e: any) => { if (e?.isMainFrame !== false) clearHover(); };
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
            else if (!openInNewBrowserTab(url)) wv?.loadURL?.(url)?.catch?.(() => {});
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
    } else {
      // Still on the page, as after cancelling the setup card, so no navigation
      // will report its title.
      onTitleChangeRef.current?.(explicitPageTitle(webviewRef.current?.getTitle?.() ?? '', showing));
    }
  }, [surfaceId]);

  useEffect(() => {
    const prev = prevEngineRef.current;
    prevEngineRef.current = engine;
    const decision = engineTransition(prev, engine, currentUrlRef.current);
    if (decision.action === 'enable') void enterAgentMode(decision.url);
    else if (decision.action === 'disable') void leaveAgentMode();
  }, [engine, enterAgentMode, leaveAgentMode]);

  // The tab's label in agent mode. The webview's title is the dashboard's, and
  // `url` stops updating, so the URL last read from the session is the only true
  // answer. Leaving agent mode clears it, and the page's own title takes over.
  const wasAgentRef = useRef(false);
  useEffect(() => {
    if (engine !== 'agent') {
      if (wasAgentRef.current) onTitleChangeRef.current?.('');
      wasAgentRef.current = false;
      return;
    }
    wasAgentRef.current = true;
    onTitleChangeRef.current?.(browserUrlLabel(agentUrl) ?? '');
  }, [engine, agentUrl]);

  // ── keeping the address bar honest ────────────────────────────────────────
  //
  // The agent drives a Chrome outside wmux, so the pane cannot observe its
  // navigation the way it observes the webview's. Without this the bar shows
  // the last URL the PANE asked for — which is a lie the moment the agent
  // clicks anything.
  //
  // Dependencies are three primitives and nothing else. That is the #141
  // lesson, stated as code: a poll whose effect depends on a callback or a hook
  // result gets torn down and re-created on every commit, and a 3s interval
  // that is re-armed at render speed is a render-speed poll.
  useEffect(() => {
    if (engine !== 'agent' || !POLLABLE_STATUSES.has(agentStatus)) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      const decide = shouldPollAgentUrl({
        engine,
        status: agentStatus,
        documentHidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
        paneHidden: elementHidden(rootRef.current),
        inFlight: pollInFlightRef.current,
        now: Date.now(),
        suppressUntil: suppressPollUntilRef.current,
      });
      if (!decide) return;
      pollInFlightRef.current = true;
      try {
        const res = await window.wmux?.agentBrowser?.currentUrl?.(surfaceId);
        // A URL we could not read leaves the bar showing its last value. That
        // is the honest degradation: the alternative is blanking the bar every
        // time one invocation fails.
        if (!cancelled && res?.url) setAgentUrl((prev) => (prev === res.url ? prev : res.url as string));
      } catch {
        /* see above */
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const timer = setInterval(() => { tick().catch(() => {}); }, AGENT_URL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [engine, agentStatus, surfaceId]);

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

  const isAgent = engine === 'agent';
  const overlay = isAgent && (agentStatus === 'setup' || agentStatus === 'no-dashboard');
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
    <div className="browser-pane" ref={rootRef} onMouseDownCapture={claimCdp}>
      <AddressBar
        url={barUrl}
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
        onMoveToWorkspace={onMoveToWorkspace}
      />
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
        {overlay && (
          <AgentBrowserSetup
            reason={agentStatus === 'setup' ? 'not-installed' : 'no-dashboard'}
            onInstalled={() => void enterAgentMode(agentUrlRef.current)}
            onRetry={() => void enterAgentMode(agentUrlRef.current)}
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
