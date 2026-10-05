// The agent-browser dashboard's page served as a download (#269).
//
// wmux deep-links an agent-mode pane at `http://127.0.0.1:4848/?port=<stream>`
// (agent-browser-session.ts) — the query is how the dashboard SPA picks the
// session to show. agent-browser's embedded file server (0.38.x) takes the
// Content-Type from the RAW request target, so `/?port=9301` has no extension,
// falls through to `application/octet-stream`, and still carries the HTML.
// Chromium does not render octet-stream, it offers a download: a native Save
// dialog over the window on every launch that restores an agent-mode pane.
// Upstream fix: vercel-labs/agent-browser#2046.
//
// The repair here is to correct the header on the way in, for exactly that
// response, rather than to handle the download afterwards. The two
// alternatives proposed in the issue both lose:
//  - cancel the download and `loadURL` the same URL again: the server answers
//    the same URL with the same wrong type, so it is a download loop;
//  - cancel and log: the pane stays blank with nothing to say why.
// A web-mode pane keeps the browser's ordinary download behaviour — a Save
// dialog for a real download a user clicked is correct, and is not touched.
//
// Pure, so the decision is testable without Electron; `index.ts` installs it
// with `session.webRequest.onHeadersReceived`.

import { DASHBOARD_PORT } from './agent-browser-session';

/**
 * The filter `onHeadersReceived` is registered with. No port in it: a
 * Chromium URL pattern without one matches every port, and the port is
 * checked exactly in `correctedDashboardHeaders` — the narrowing lives in code
 * that has a test, not in pattern syntax that does not.
 */
export const DASHBOARD_HEADER_FILTER = { urls: ['http://127.0.0.1/*'] };

type Headers = Record<string, string[] | string>;

/**
 * The response headers to use instead, or null to leave the response alone.
 * Only a top-level document from the dashboard origin, at an extensionless
 * path, labelled `application/octet-stream`: an asset with an extension already
 * gets the right type from the same server, and anything else is not ours.
 */
export function correctedDashboardHeaders(
  url: string,
  resourceType: string,
  headers: Headers | undefined,
  port: number = DASHBOARD_PORT,
): Record<string, string[]> | null {
  if (!headers || (resourceType !== 'mainFrame' && resourceType !== 'subFrame')) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.port !== String(port)) return null;
  const last = u.pathname.slice(u.pathname.lastIndexOf('/') + 1);
  if (last.includes('.')) return null;

  // Header names arrive in whatever case the server used.
  const typeKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type');
  if (!typeKey) return null;
  const raw = headers[typeKey];
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  if (value.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return null;

  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === typeKey) continue;
    // A Content-Disposition: attachment would make it a download regardless.
    if (k.toLowerCase() === 'content-disposition') continue;
    out[k] = Array.isArray(v) ? v : [v];
  }
  out['Content-Type'] = ['text/html; charset=utf-8'];
  return out;
}
