import { useState, useRef, useCallback, useEffect } from 'react';
import AddressBar from './AddressBar';
import { popupBridgeSource } from './popup-bridge';
import '../../styles/browser.css';

interface BrowserPaneProps {
  initialUrl?: string;
  surfaceId: string;
  workspaceId?: string;
  onUrlChange?: (url: string) => void;
}

export default function BrowserPane({ initialUrl = 'https://github.com/amirlehmam/wmux', surfaceId, workspaceId, onUrlChange }: BrowserPaneProps) {
  // src is fixed to the initial page; all later navigation goes through loadURL
  // (below). Binding src to a mutable url state AND calling loadURL made every
  // navigation trigger two loads of the same URL, which raced and produced a
  // spurious ERR_ABORTED (logged by the main process' guest-view handler).
  const [initialSrc] = useState(initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const webviewRef = useRef<any>(null);

  const navigate = useCallback((newUrl: string) => {
    let resolved = newUrl;
    if (!newUrl.match(/^https?:\/\//)) {
      if (newUrl.includes('.') && !newUrl.includes(' ')) {
        resolved = 'https://' + newUrl;
      } else {
        resolved = `https://www.google.com/search?q=${encodeURIComponent(newUrl)}`;
      }
    }
    // Single navigation. loadURL can still reject with ERR_ABORTED for genuine
    // cases (a client-side redirect, an unreachable host, navigating again
    // mid-load); those are reflected by the did-*-load handlers below, so
    // swallow the promise rejection rather than leaving it unhandled.
    webviewRef.current?.loadURL(resolved).catch(() => {});
  }, []);

  const goBack = useCallback(() => webviewRef.current?.goBack(), []);
  const goForward = useCallback(() => webviewRef.current?.goForward(), []);
  const reload = useCallback(() => webviewRef.current?.reload(), []);
  const stop = useCallback(() => webviewRef.current?.stop(), []);
  const openDevTools = useCallback(() => webviewRef.current?.openDevTools(), []);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onNavigate = (e: any) => {
      setCurrentUrl(e.url);
      onUrlChange?.(e.url);
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    };
    const onStartLoad = () => setIsLoading(true);
    const onStopLoad = () => {
      setIsLoading(false);
      const finalUrl = wv.getURL();
      setCurrentUrl(finalUrl);
      onUrlChange?.(finalUrl);
    };

    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    wv.addEventListener('did-start-loading', onStartLoad);
    wv.addEventListener('did-stop-loading', onStopLoad);

    return () => {
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
      wv.removeEventListener('did-start-loading', onStartLoad);
      wv.removeEventListener('did-stop-loading', onStopLoad);
    };
  }, []);

  const wcIdRef = useRef<number | null>(null);
  // Register this pane's webview as a CDP target, tagged with its surface and
  // workspace so main can route per-caller browser commands here (issues #27, #62).
  const claimCdp = useCallback(() => {
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
  const installPopupBridge = useCallback(() => {
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

  return (
    <div className="browser-pane" onMouseDownCapture={claimCdp}>
      <AddressBar
        url={currentUrl}
        isLoading={isLoading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onNavigate={navigate}
        onBack={goBack}
        onForward={goForward}
        onReload={reload}
        onStop={stop}
        onDevTools={openDevTools}
      />
      {/* @ts-ignore — webview is an Electron-specific HTML element */}
      <webview
        ref={webviewRef}
        src={initialSrc}
        className="browser-pane__webview"
      />
    </div>
  );
}
