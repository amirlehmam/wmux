/**
 * browser-keep-rendering.ts — keep a hidden browser surface painting while an
 * agent drives it.
 *
 * A browser surface the user is not looking at (another workspace, a background
 * tab, the browser panel of another workspace) is hidden with CSS. Chromium
 * reads that as "this frame is not rendered" and stops the guest altogether:
 * no compositor frames, no requestAnimationFrame, timers throttled to about one
 * a second. Verbs that only read the DOM (`eval`, `get-text`, `snapshot`) still
 * answer, but `Page.captureScreenshot` and `capturePage()` both wait for a frame
 * that never comes, so `wmux browser screenshot` timed out the moment the user
 * switched workspace, and a CDP client attached through the proxy
 * (chrome-devtools-mcp) hung on anything that waits for the page to move.
 *
 * Measured in a bare Electron 43 harness, a workspace hidden the way App.tsx
 * hides one:
 *
 *   webview inherits visibility:hidden        raf 0/s, timers ~1/s, both captures time out
 *   webview visibility:visible + opacity:0    raf 60/s, timers 20/s, CDP capture ~200 ms,
 *                                             the window still shows the active workspace
 *   an ancestor with display:none             no override possible, same as hidden
 *
 * `incrementCapturerCount` is not an answer: Electron 23 removed it, and the
 * capturer that `capturePage()` holds while it runs cannot show a frame whose
 * owner element is not rendered (both captures time out in the hidden row).
 *
 * The renderer therefore keeps such a webview on the visible-but-transparent
 * path (BrowserPane's `webviewHiding`: `visibility: visible; opacity: 0;
 * pointer-events: none` plus `tabIndex -1`). It does so only on a LEASE that
 * main grants when an agent drives the surface: every web verb (v2-browser's
 * runner) and every proxied CDP command renews it through
 * `window.__wmux_keepBrowserRendering`. A page the user left open in another
 * workspace stays throttled like any background tab, and an agent's page goes
 * back to sleep KEEP_RENDERING_MS after its last command instead of painting
 * forever.
 *
 * The parent that hides a pane passes `visible` (BrowserPane's prop), and the
 * panel hides inactive workspaces with `visibility`, never `display: none`,
 * which no descendant can override.
 *
 * A MINIMIZED window gets no CDP frame at all: `withFrameKick`
 * (cdp-bridge.ts) falls back to `capturePage({ stayHidden: true })` (viewport
 * only) after 1 s, which works if the pane was painting when the window went
 * down.
 */
import { BrowserWindow } from 'electron';

/**
 * How long a surface keeps painting after the last command that reached it.
 * An agent's turn can spend minutes between two browser commands (it edits
 * code, then looks again). Expiry costs little: the next command renews the
 * lease before it runs, and a screenshot's frame kick waits out the wake-up
 * (measured at ~200 ms from frozen to captured).
 */
export const KEEP_RENDERING_MS = 5 * 60_000;

/**
 * Renew a lease at most this often per webContents. Every verb asks, and asking
 * is a round-trip to each renderer, so a burst of clicks costs one renewal.
 */
export const KEEP_RENDERING_RENEW_MS = 30_000;

/**
 * How long a verb waits for the renderers to take a lease. Every web verb and
 * every proxied CDP command awaits the grant before it runs, and
 * `executeJavaScript` on a HUNG renderer never settles (#289), so an unbounded
 * wait would hang `wmux browser` and chrome-devtools-mcp along with it, where
 * before leases they kept working. A healthy renderer answers in a few ms.
 */
export const KEEP_RENDERING_GRANT_TIMEOUT_MS = 250;

/** Tells the renderers; true when one of them took the lease. */
export type KeepRenderingGrant = (surfaceId: string, ms: number) => Promise<boolean>;

export class KeepRenderingLeases {
  /** webContents id → when its lease was last granted. Keyed by webContents, not
   *  surface: a remounted pane is a new guest and must be told again at once. */
  private readonly renewedAt = new Map<number, number>();

  constructor(
    private readonly grant: KeepRenderingGrant,
    private readonly now: () => number = Date.now,
  ) {}

  /** An agent is driving `wcId`. Never throws: a lease is an optimisation, not
   *  a precondition, so a renderer that cannot be reached must not fail the verb. */
  async touch(wcId: number, surfaceId: string | null): Promise<void> {
    if (!surfaceId) return;
    const t = this.now();
    for (const [id, at] of this.renewedAt) {
      if (t - at >= KEEP_RENDERING_MS) this.renewedAt.delete(id);
    }
    const last = this.renewedAt.get(wcId);
    if (last !== undefined && t - last < KEEP_RENDERING_RENEW_MS) return;
    // Recorded before the await so a concurrent verb does not grant twice.
    this.renewedAt.set(wcId, t);
    let granted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), KEEP_RENDERING_GRANT_TIMEOUT_MS);
      });
      granted = await Promise.race([this.grant(surfaceId, KEEP_RENDERING_MS), timedOut]);
    } catch {
      // Treated as not granted, below.
    } finally {
      clearTimeout(timer);
    }
    // A renderer that was reloading, or one that predates the hook, gets asked
    // again on the next verb rather than after the renewal interval.
    if (!granted) this.renewedAt.delete(wcId);
  }
}

/**
 * Every window is told, not only the one that hosts the surface: main has no
 * copy of the split tree, and a lease for a surface a window does not host is
 * an unused map entry that expires on its own.
 */
async function grantInRenderers(surfaceId: string, ms: number): Promise<boolean> {
  const script = `window.__wmux_keepBrowserRendering?.(${JSON.stringify(surfaceId)}, ${ms}) ?? false`;
  const answers = await Promise.all(
    BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .map((win) => win.webContents.executeJavaScript(script).catch(() => false)),
  );
  return answers.some((answer) => answer === true);
}

export const keepRenderingLeases = new KeepRenderingLeases(grantInRenderers);
