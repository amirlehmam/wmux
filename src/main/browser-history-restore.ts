// ─── Restoring a browser pane's back/forward stack (issue #315) ──────────────
//
// See src/shared/browser-history.ts for why the history rides in the webview's
// src. This is main's half: three Electron events, in the order they fire for
// ONE webview, measured against Electron 43 with three panes attaching at once:
//
//   host `will-attach-webview`  → decode the sentinel, blank params.src, park it
//   app  `web-contents-created` → the guest now exists: claim what was parked
//   host `did-attach-webview`   → restore into the guest that claimed it
//
// The first two run back to back inside Electron's createGuest, synchronously,
// so one slot is enough to hand the history from the webview's params to its
// own WebContents — the measured order was will-attach A, created A, did-attach
// A, then B, then C. The third is async, which is why the claim is keyed by the
// guest's id rather than by arrival order.
//
// Blanking the src is not optional: the guest must load nothing of its own.
// Left in place, its first navigation races the restore and truncates Forward
// (measured: the restore rejected with ERR_ABORTED and the stack lost an entry).
//
// Covers a restart AND a split-tree remount: every mount is a fresh
// WebContents. The sentinel src is `about:blank#wmux-history=` plus the
// URL-encoded history JSON. It is persisted as `SurfaceRef.browserHistory` /
// `workspace.browserHistory` beside the URL, and shared/browser-history.ts
// decides what is kept: url + title only, never `pageState` (it carries form
// values); http(s) only; 50 entries, keeping Back over Forward. The renderer
// (BrowserPane.tsx) uses a history only when its active entry IS the URL the
// #232 rules chose, so it can add Back/Forward but never pick the page. Reading
// a live stack back goes
// through `browser:get-history` (ipc-handlers.ts), which answers only for a
// guest the asking window hosts.

import { decodeHistoryRestoreSrc, sanitizeBrowserHistory, type BrowserHistory } from '../shared/browser-history';

/** What this module needs from a guest WebContents. */
export interface HistoryGuest {
  id: number;
  navigationHistory: {
    getAllEntries(): Array<{ url: string; title: string }>;
    getActiveIndex(): number;
    restore(options: { entries: Array<{ url: string; title: string }>; index?: number }): Promise<void>;
  };
}

let parked: BrowserHistory | null = null;
const claimed = new Map<number, BrowserHistory>();

/**
 * `will-attach-webview`: a pane asking for a restore. Blanks `params.src` and
 * parks the history for the guest about to be created. Any other src is left
 * untouched — including a sentinel whose history did not survive sanitizing,
 * which therefore loads as the plain `about:blank` it is.
 *
 * Every attach overwrites the slot, so a park whose guest was never created
 * (another listener prevented the attach) cannot leak into the next webview.
 */
export function parkHistoryRestore(params: Record<string, unknown>): void {
  parked = decodeHistoryRestoreSrc(params.src);
  if (parked) params.src = '';
}

/** `web-contents-created` for a webview: claim the parked history, if any. */
export function claimHistoryRestore(guestId: number): void {
  if (!parked) return;
  claimed.set(guestId, parked);
  parked = null;
}

/**
 * `did-attach-webview`: rebuild the guest's stack. A page that fails to load
 * still has its history (the promise only reports the active entry's load),
 * and that rejection is the page's business, not a restore failure.
 */
export function applyHistoryRestore(guest: HistoryGuest): boolean {
  const history = claimed.get(guest.id);
  if (!history) return false;
  claimed.delete(guest.id);
  guest.navigationHistory.restore({ entries: history.entries, index: history.index }).catch(() => {});
  return true;
}

/** A guest went away before it attached: never hand its history to the next id. */
export function forgetHistoryRestore(guestId: number): void {
  claimed.delete(guestId);
}

/** The stack a guest holds now, in the shape wmux persists. */
export function readGuestHistory(guest: HistoryGuest): BrowserHistory | null {
  return sanitizeBrowserHistory({
    entries: guest.navigationHistory.getAllEntries().map(({ url, title }) => ({ url, title })),
    index: guest.navigationHistory.getActiveIndex(),
  });
}

/** Test seam: the slot and the claims are module state. */
export function __resetHistoryRestore(): void {
  parked = null;
  claimed.clear();
}
