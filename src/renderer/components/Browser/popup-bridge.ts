/**
 * Popup bridge for the browser pane.
 *
 * A `<webview>` without `allowpopups` doesn't just refuse to open a popup — it
 * drops the request on the floor. No window, no navigation, and no event on
 * either side, so the main process' `setWindowOpenHandler` never even runs.
 * Every `target="_blank"` link and every `window.open()` in the browser panel
 * was therefore a dead click (issue #126, reported against a note-taking app
 * whose "+ New" button is `<a href="#new" target="_blank">`).
 *
 * The fix routes those intents into the pane itself rather than turning on
 * `allowpopups`: a real popup would be a detached BrowserWindow outside wmux's
 * layout and outside the webview hardening in main. Opening in place keeps the
 * page in the panel, and the address bar's Back button is the way out — the
 * same bargain every docked browser view makes.
 *
 * Written as a self-contained function taking its globals as an argument so it
 * can be shipped through `webview.executeJavaScript` (see BrowserPane) *and*
 * exercised directly against a stub in tests, without a DOM environment.
 * Because it is serialised with `Function.prototype.toString`, it must not
 * reference anything from module scope.
 */
export function installPopupBridge(scope: any): void {
  if (scope.__wmuxPopupBridge) return;
  scope.__wmuxPopupBridge = true;

  // Only http(s) is routed. javascript:, data:, blob: and custom schemes stay
  // with the default (blocked) behaviour — turning one of those into a
  // same-frame navigation would hand a hostile page a way to run in the
  // panel's context on a click it didn't otherwise get.
  function resolve(href: any): string | null {
    if (href === null || href === undefined || href === '') return null;
    try {
      const url = new scope.URL(String(href), scope.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function isNewWindowTarget(value: any): boolean {
    const target = String(value || '').toLowerCase();
    return target === '_blank' || target === '_new';
  }

  // Bubble phase, and `defaultPrevented` is honoured: a page that handles its
  // own anchor clicks keeps winning. We only step in where the click would
  // otherwise have gone nowhere.
  scope.document.addEventListener('click', function (event: any) {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
    if (!anchor || !isNewWindowTarget(anchor.getAttribute('target'))) return;
    const url = resolve(anchor.getAttribute('href'));
    if (!url) return;
    event.preventDefault();
    scope.location.href = url;
  }, false);

  // `<form target="_blank">` submits into the same void. Dropping the attribute
  // in the capture phase lets the browser submit it normally, in place —
  // method, body and all — which rewriting it to a GET navigation would lose.
  scope.document.addEventListener('submit', function (event: any) {
    const form = event.target;
    if (form && typeof form.getAttribute === 'function' && isNewWindowTarget(form.getAttribute('target'))) {
      form.removeAttribute('target');
    }
  }, true);

  const nativeOpen = scope.open;
  scope.open = function (href?: any, name?: any, features?: any) {
    const url = resolve(href);
    if (url) {
      scope.location.href = url;
      // Null, as before. Pages that write into the handle (`w.document.write`)
      // already got null here while popups were blocked outright, so this
      // changes nothing for them — and handing back the panel's own window
      // would let a page overwrite the document it just navigated.
      return null;
    }
    return typeof nativeOpen === 'function' ? nativeOpen.call(scope, href, name, features) : null;
  };
}

/** The bridge as a self-executing snippet, ready for `executeJavaScript`. */
export function popupBridgeSource(): string {
  return `(${installPopupBridge.toString()})(window)`;
}
