import { useState, useRef, useCallback, useEffect } from 'react';
import AddressBar from './AddressBar';
import '../../styles/browser.css';

interface BrowserPaneProps {
  initialUrl?: string;
  surfaceId: string;
  workspaceId?: string;
  onUrlChange?: (url: string) => void;
}

export default function BrowserPane({ initialUrl = 'https://github.com/amirlehmam/wmux', surfaceId, workspaceId, onUrlChange }: BrowserPaneProps) {
  const [url, setUrl] = useState(initialUrl);
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
    setUrl(resolved);
    if (webviewRef.current) {
      webviewRef.current.loadURL(resolved);
    }
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
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    wv.addEventListener('dom-ready', claimCdp);
    return () => {
      wv.removeEventListener('dom-ready', claimCdp);
      // Only detach if this pane still owns the connection — closing a split-tree
      // browser pane must not kill another open pane's CDP (issue #27).
      if (wcIdRef.current !== null) window.wmux?.cdp?.detach?.(wcIdRef.current);
    };
  }, [claimCdp]);

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
        src={url}
        className="browser-pane__webview"
      />
    </div>
  );
}
