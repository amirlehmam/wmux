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
  return (
    url.startsWith('http://localhost:') ||
    url.startsWith('http://127.0.0.1:') ||
    url.startsWith('file://')
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
