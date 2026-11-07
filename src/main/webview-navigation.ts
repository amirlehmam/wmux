// The one policy for "where does a URL a page tries to reach actually go?" —
// shared by the two hardening handlers in `index.ts` (`hardenWebContents`) so
// they cannot drift apart.
//
// Two handlers, two DISJOINT Electron mechanisms (verified against Electron 43's
// own electron.d.ts, not folklore):
//   - `setWindowOpenHandler` fires ONLY for a new-window request — `window.open()`,
//     a `target="_blank"` link, shift+click, `<form target="_blank">`. Returning
//     `{action:'deny'}` cancels it and the opener's main frame does NOT navigate.
//   - `will-navigate` fires ONLY for a same-frame navigation on the main frame
//     (a plain link click, `window.location=`), and never for the new-window
//     request above (that never navigates the opener) nor for programmatic
//     `loadURL`/`back` nor for in-page hash changes.
// So a single user gesture reaches EXACTLY ONE of the two — a click cannot drive
// both, and there is no in-gesture double `shell.openExternal`. What this module
// removes is the older hazard that made that non-obvious: the "open http(s) in
// the OS browser" rule was written out by hand in both places, so the two could
// answer the SAME url differently (one launching a scheme the other blocked).
// One source of truth, unit-testable with no Electron, keeps them in lockstep.

/**
 * A url the app should hand to the OS browser via `shell.openExternal`. Only
 * http/https: a `javascript:`/`data:`/`file:` url reaching openExternal would be
 * a click-triggered local execution the page was otherwise denied.
 */
export function isExternalWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * A url the MAIN app window is allowed to navigate to in place — its own UI.
 * Dev loads localhost (Vite, port 5199); a packaged build loads file://. Anything
 * else is remote content the app window must never become.
 */
export function isInternalAppUrl(url: string): boolean {
  // Parsed, never prefix-matched: `http://localhost:5199@evil.com/` starts with
  // `http://localhost:` and is a request to evil.com with a userinfo of
  // `localhost:5199`. The main window has the preload and renders network
  // content (release notes, #211), so that prefix match was a way to make the
  // app window BECOME a remote page.
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return true;
  return (
    u.protocol === 'http:' &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
    u.port !== '' &&
    !u.username &&
    !u.password
  );
}

/**
 * Decision for `setWindowOpenHandler`, on every webContents. A new window is
 * never spawned in-app (full privileges); an http(s) target goes to the OS
 * browser, everything else is dropped.
 */
export function windowOpenPolicy(url: string): {
  openExternal: boolean;
  response: { action: 'deny' };
} {
  return { openExternal: isExternalWebUrl(url), response: { action: 'deny' } };
}

/**
 * Decision for `will-navigate`, on the main app window only (webviews are exempt —
 * their navigation is the whole point). Internal urls navigate in place; anything
 * else is prevented, and an http(s) one is redirected to the OS browser so a
 * legitimate external link still opens.
 */
export function willNavigatePolicy(url: string): {
  preventDefault: boolean;
  openExternal: boolean;
} {
  if (isInternalAppUrl(url)) return { preventDefault: false, openExternal: false };
  return { preventDefault: true, openExternal: isExternalWebUrl(url) };
}

// ─── New-window requests from the BROWSER PANEL (#281) ────────────────────────
// The panel's <webview> carries `allowpopups` since #281, so every new-window
// request it makes now reaches `setWindowOpenHandler` — before, Chromium dropped
// them silently and the popup bridge (renderer/components/Browser/popup-bridge.ts)
// turned the ones it could see into in-place navigations (#126).
//
// One kind is let out as a real window: a SIZED popup, the shape every popup
// sign-in SDK (Firebase `signInWithPopup`, Google Identity, MSAL, Auth0) uses.
// Those depend on the page that opened the popup STAYING ALIVE to receive the
// result over `window.opener`; navigating the panel in place replaced that page
// with the provider's, so sign-in could never complete. Chromium's own verdict
// is the test — measured on Electron 43 against a standalone harness:
//
//   window.open(u, 'auth', 'width=500,height=600')  → 'new-window', features as given
//   window.open(u, 'p', 'popup')                   → 'new-window'
//   window.open(u)                                 → 'foreground-tab', features ''
//   window.open(u, '_blank', 'noopener')           → 'foreground-tab'
//
// and features must be non-empty as well, because a shift+click on a link is a
// 'new-window' with NO features: that is a "new window please", not a popup a
// page is waiting on.
//
// Ctrl+click and middle-click on a link arrive as 'background-tab', and those
// open in a new wmux browser tab beside this one, as they would in a browser.
// A page cannot ask for that disposition with a plain window.open() (that is
// 'foreground-tab'), so it takes a modified click by the user.
//
// Everything else that is http(s) navigates the panel in place, which is what
// the bridge has done since #126 — main now covers the requests the bridge
// cannot see (a click before dom-ready injected it, a shift+click, an odd
// feature string Chromium reads as a tab). Nothing from the panel ever goes to
// the OS browser from here: these requests never reached this handler before,
// so sending them out now would be a new behaviour nobody asked for.

export type WebviewWindowOpenDecision =
  | { kind: 'popup' }
  | { kind: 'new-tab'; url: string }
  | { kind: 'navigate-in-place'; url: string }
  | { kind: 'drop' };

export function webviewWindowOpenPolicy(details: {
  url: string;
  features?: string;
  disposition?: string;
}): WebviewWindowOpenDecision {
  if (!isExternalWebUrl(details.url)) return { kind: 'drop' };
  if (details.disposition === 'new-window' && (details.features ?? '').trim() !== '') return { kind: 'popup' };
  if (details.disposition === 'background-tab') return { kind: 'new-tab', url: details.url };
  return { kind: 'navigate-in-place', url: details.url };
}

/**
 * Whether a webContents gets the MAIN-WINDOW navigation lock (`will-navigate`
 * confined to wmux's own UI). A popup the panel opened (#281) is a `window`
 * too, and its whole job is navigating — a sign-in hops provider → consent →
 * callback, and each hop is a `will-navigate`, including the first. Locked, it
 * would bounce every hop to the OS browser. Its `opener` is what tells it
 * apart: measured, it is set by the time `web-contents-created` fires, and is
 * null for every window wmux creates itself.
 */
export function needsAppWindowNavigationLock(type: string, hasOpener: boolean, isolatedDictation = false): boolean {
  return type !== 'webview' && !hasOpener && !isolatedDictation;
}

/**
 * A popup window has no address bar, so its title has to say whose page it is:
 * a page could otherwise title itself "wmux — Sign in" from any origin. The
 * host is always shown, and first.
 */
export function popupWindowTitle(url: string, pageTitle: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = '';
  }
  const title = pageTitle.trim();
  if (!host) return title;
  return title && title !== host ? `${host} — ${title}` : host;
}
