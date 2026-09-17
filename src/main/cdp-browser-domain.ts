// src/main/cdp-browser-domain.ts
/**
 * The browser-level half of the CDP protocol, answered by wmux itself
 * (issue #237, second blocker).
 *
 * `cdp-proxy.ts` was a pipe: every message went straight to
 * `webContents.debugger.sendCommand`. That is enough for a client that speaks
 * page protocol and knows it, and it is not enough for any real CDP client,
 * because puppeteer and Playwright do not connect to a page — they connect to a
 * BROWSER and then ask it for pages. The very first thing
 * `puppeteer.connect({browserURL})` sends is `Target.getBrowserContexts`, and
 * Electron refuses browser-level `Target.*` on a page-level debugger:
 *
 *     Could not connect to Chrome. Check if Chrome is running.
 *     Cause: Protocol error (Target.getBrowserContexts): Not allowed
 *
 * So chrome-devtools-mcp initialised, listed its 29 tools, and failed on the
 * first one that touched the page. Same wall as the `Target.createTarget: Not
 * supported` seen after #233. As #237 puts it: "the proxy has to be a browser,
 * not a pipe".
 *
 * wmux has exactly one page to offer — the browser panel's webContents — so
 * being a browser is mostly bookkeeping: one target, one session, one default
 * browser context, and a translation from the flattened session protocol every
 * modern client speaks down to the single unsessioned debugger Electron gives
 * us. That translation is what lives here.
 *
 * Pure on purpose, and for the same reason `agent-browser-verbs.ts` is: this is
 * the piece most likely to drift as clients evolve, and it must be exhaustively
 * testable with no Chrome, no Electron and no port. The impure half — the
 * socket, the debugger, the event plumbing — stays in `cdp-proxy.ts`.
 *
 * ── The two details that are easy to get wrong ──────────────────────────────
 *
 * 1. **A response to a session-scoped command MUST echo its `sessionId`.**
 *    Puppeteer's connection dispatches an incoming message by looking at
 *    `sessionId` FIRST and only falls back to its own callback table when there
 *    is none. Drop the field and the reply is looked up in the wrong registry,
 *    resolves nothing, and the caller hangs until its timeout — a failure that
 *    looks like a slow page rather than a protocol bug.
 *
 * 2. **`Target.*` has to be intercepted on the PAGE session too**, not only on
 *    the browser connection. Puppeteer sends `Target.setAutoAttach` down each
 *    attached session to discover out-of-process iframes. Forwarding that to
 *    Electron's page debugger is the same "Not allowed" as before, one level
 *    down. wmux answers it with "nothing auto-attached", which is true: the
 *    panel is one webContents and exposes no child targets.
 */

/** What the page looks like right now. Read fresh per command — it navigates. */
export interface PageSnapshot {
  title: string;
  url: string;
}

export interface BrowserDomainContext {
  page: PageSnapshot;
  /** Chromium version of the running Electron, e.g. `150.0.7871.46`. */
  chromeVersion: string;
  v8Version: string;
  userAgent: string;
  /** The single target wmux exposes. Matches the `id` in `/json/list`. */
  targetId: string;
  /** The single flattened session id wmux hands out for that target. */
  sessionId: string;
}

/** A protocol event to push at the client, before the command's own response. */
export interface BrowserDomainEvent {
  method: string;
  params: Record<string, unknown>;
  /** Present for events belonging to the page session (flattened protocol). */
  sessionId?: string;
}

export type BrowserDomainAction =
  /** Answer locally with this result. */
  | {
      type: 'result';
      result: Record<string, unknown>;
      /**
       * A page-level command to run for effect after replying. Used by
       * `Target.createTarget`, which cannot create anything here: wmux has one
       * pane, so "open a new page at this URL" is honoured as "put this URL in
       * the pane" and answered with the target that was there all along. A
       * client that asked for a page gets a working page, which is a better
       * answer than an error and a truer one than a second target that does not
       * exist.
       */
      sideEffect?: { method: string; params: Record<string, unknown> };
    }
  /** Not ours — hand it to the page debugger unchanged. */
  | { type: 'forward' }
  /** Answer with a protocol error. */
  | { type: 'error'; code: number; message: string };

export interface BrowserDomainReply {
  events: BrowserDomainEvent[];
  action: BrowserDomainAction;
}

/** The `Target.TargetInfo` for wmux's single page. */
export function targetInfo(ctx: BrowserDomainContext): Record<string, unknown> {
  return {
    targetId: ctx.targetId,
    type: 'page',
    title: ctx.page.title,
    url: ctx.page.url,
    attached: true,
    canAccessOpener: false,
    // No `browserContextId`: clients read its absence as "the default context",
    // which is the only one there is. Inventing an id would mean answering
    // `Target.getBrowserContexts` with it too, and then honouring it on every
    // command that takes one.
    browserContextId: undefined,
  };
}

const ok = (result: Record<string, unknown> = {}): BrowserDomainReply => ({
  events: [],
  action: { type: 'result', result },
});

const forward = (): BrowserDomainReply => ({ events: [], action: { type: 'forward' } });

const fail = (message: string, code = -32000): BrowserDomainReply => ({
  events: [],
  action: { type: 'error', code, message },
});

/** `Browser.*`, which is browser-level wherever it arrives. */
function handleBrowserDomain(method: string, ctx: BrowserDomainContext): BrowserDomainReply | null {
  switch (method) {
    case 'Browser.getVersion':
      return ok({
        protocolVersion: '1.3',
        product: `Chrome/${ctx.chromeVersion}`,
        revision: '',
        userAgent: ctx.userAgent,
        jsVersion: ctx.v8Version,
      });
    case 'Browser.setDownloadBehavior':
    case 'Browser.setPermission':
    case 'Browser.grantPermissions':
    case 'Browser.resetPermissions':
      // Accepted and ignored. A client sets these to make a run deterministic;
      // refusing aborts the run, while accepting costs it nothing it can see —
      // the panel is a webview with the app's own download and permission
      // behaviour, which is not wmux's to hand over to an automation client.
      return ok();
    case 'Browser.getWindowForTarget':
      return ok({ windowId: 1, bounds: { windowState: 'normal' } });
    case 'Browser.close':
      // Never. The "browser" is the user's wmux window, and a stray
      // `browser.close()` in an agent's script must not take it down.
      return ok();
    default:
      return null;
  }
}

/**
 * `Target.*` arriving ON THE PAGE SESSION — puppeteer sends these down every
 * attached session to discover out-of-process iframes.
 *
 * The answer is always "nothing here", and the part that matters is that it
 * emits NO EVENTS. This is not tidiness, it is the difference between working
 * and hanging the machine: when the page session answered `setAutoAttach` the
 * way the browser connection does — with an `attachedToTarget` for the page —
 * puppeteer treated it as a newly discovered child, attached to it, sent
 * `setAutoAttach` down the session it got back, and received another
 * attachment for the same target. Real puppeteer 24 went from `connect()` to
 * a 4 GB heap and `Ineffective mark-compacts near heap limit` inside
 * `browser.pages()`. A single webContents has no child targets, and saying so
 * is what terminates the recursion.
 */
function handleSessionTargetDomain(
  method: string,
  params: Record<string, any>,
  ctx: BrowserDomainContext,
): BrowserDomainReply {
  switch (method) {
    case 'Target.setAutoAttach':
    case 'Target.setDiscoverTargets':
    case 'Target.setRemoteLocations':
      return ok();
    case 'Target.getTargetInfo':
      return params?.targetId && params.targetId !== ctx.targetId
        ? fail(`No target with given id found: ${params.targetId}`)
        : ok({ targetInfo: targetInfo(ctx) });
    case 'Target.getTargets':
      // The page itself, and nothing below it.
      return ok({ targetInfos: [targetInfo(ctx)] });
    default:
      // Including `attachToTarget`: there is nothing under this page to attach
      // to, and inventing a second session is how the loop above started.
      return fail(`'${method}' is not available on a wmux page session`, -32601);
  }
}

/** `Target.*` as asked by a client attached to `/devtools/browser/…`. */
function handleTargetDomain(
  method: string,
  params: Record<string, any>,
  ctx: BrowserDomainContext,
): BrowserDomainReply | null {
  const info = targetInfo(ctx);
  switch (method) {
    case 'Target.getBrowserContexts':
      // The exact call #237 died on. Empty means "only the default context",
      // which is the truth for a single webview.
      return ok({ browserContextIds: [] });

    case 'Target.setDiscoverTargets':
      // Chrome emits the existing targets before answering, and a client that
      // waits for `targetCreated` before doing anything else would otherwise
      // wait forever.
      return params?.discover === false
        ? ok()
        : { events: [{ method: 'Target.targetCreated', params: { targetInfo: info } }], action: { type: 'result', result: {} } };

    case 'Target.getTargets':
      return ok({ targetInfos: [info] });

    case 'Target.getTargetInfo':
      // A client may ask about the browser target itself (no targetId, or one
      // that is not the page). Only the page is describable here.
      if (params?.targetId && params.targetId !== ctx.targetId) {
        return fail(`No target with given id found: ${params.targetId}`);
      }
      return ok({ targetInfo: info });

    case 'Target.setAutoAttach':
      if (params?.autoAttach === false) return ok();
      return {
        events: [{
          method: 'Target.attachedToTarget',
          params: { sessionId: ctx.sessionId, targetInfo: info, waitingForDebugger: false },
        }],
        action: { type: 'result', result: {} },
      };

    case 'Target.attachToTarget':
      if (params?.targetId && params.targetId !== ctx.targetId) {
        return fail(`No target with given id found: ${params.targetId}`);
      }
      return {
        events: [{
          method: 'Target.attachedToTarget',
          params: { sessionId: ctx.sessionId, targetInfo: info, waitingForDebugger: false },
        }],
        action: { type: 'result', result: { sessionId: ctx.sessionId } },
      };

    case 'Target.detachFromTarget':
      return {
        events: [{
          method: 'Target.detachedFromTarget',
          params: { sessionId: ctx.sessionId, targetId: ctx.targetId },
        }],
        action: { type: 'result', result: {} },
      };

    case 'Target.activateTarget':
    case 'Target.setRemoteLocations':
    case 'Target.disposeBrowserContext':
      return ok();

    case 'Target.createTarget': {
      // One pane: honour this as a navigation and answer with the target that
      // was already there. See `sideEffect` above.
      const url = typeof params?.url === 'string' && params.url ? params.url : 'about:blank';
      return {
        events: [],
        action: {
          type: 'result',
          result: { targetId: ctx.targetId },
          sideEffect: { method: 'Page.navigate', params: { url } },
        },
      };
    }

    case 'Target.closeTarget':
      // `success: false` rather than a lie or a silent no-op: the page is the
      // user's browser panel and does not close on an automation client's say-so,
      // and a client told `true` would go on to wait for a target that never
      // goes away.
      return ok({ success: false });

    case 'Target.createBrowserContext':
      // Incognito. There is one webview and it has the app's session; pretending
      // otherwise would hand a client a context that silently shares cookies
      // with the default one.
      return fail('wmux exposes a single browser context', -32601);

    default:
      return null;
  }
}

/**
 * Decide what to do with one message from a client attached to the browser
 * endpoint.
 *
 * `sessionId` is the message's own field: absent for a browser-level command,
 * `ctx.sessionId` for one aimed at the page through the flattened protocol.
 * Anything else names a session wmux never handed out.
 */
export function handleBrowserCommand(
  method: string,
  params: Record<string, any> | undefined,
  sessionId: string | undefined,
  ctx: BrowserDomainContext,
): BrowserDomainReply {
  if (sessionId !== undefined && sessionId !== ctx.sessionId) {
    return fail(`Session with given id not found: ${sessionId}`, -32001);
  }

  const p = params ?? {};

  const browserDomain = handleBrowserDomain(method, ctx);
  if (browserDomain) return browserDomain;

  if (method.startsWith('Target.')) {
    // Scope decides, and it decides more than politeness — see
    // `handleSessionTargetDomain`.
    if (sessionId !== undefined) return handleSessionTargetDomain(method, p, ctx);
    const handled = handleTargetDomain(method, p, ctx);
    if (handled) return handled;
    // An unknown `Target.*` is still browser-level, and forwarding it to the page
    // debugger yields Electron's "Not allowed" — which reads to the client as
    // wmux's page being broken rather than as a command wmux does not implement.
    return fail(`'${method}' wasn't found`, -32601);
  }

  // Everything else is page protocol: `Page.*`, `Runtime.*`, `DOM.*`, `Input.*`
  // and the rest go to the debugger exactly as they always did, whether they
  // arrived on the page session or on a browser connection speaking page
  // protocol directly (which is what every client of this proxy did before
  // this module existed, and must keep working).
  return forward();
}

/**
 * Whether an event coming off the page debugger belongs to the page session.
 *
 * Everything Electron's debugger emits does — it is attached to exactly one
 * page — so on a browser connection every event is tagged with the page
 * session id, and on a page connection none of them are. Stated as a function
 * because the tagging decision is the part worth pinning, not the `if`.
 */
export function tagEventSession(
  connection: 'browser' | 'page',
  sessionId: string,
): string | undefined {
  return connection === 'browser' ? sessionId : undefined;
}

/**
 * Which kind of connection a WebSocket path is.
 *
 * `/devtools/browser/…` is what `/json/version`'s `webSocketDebuggerUrl`
 * advertises and what every puppeteer/Playwright client opens;
 * `/devtools/page/…` is what `/json/list` advertises and what a client driving
 * one page directly opens. Anything else is treated as a page connection: that
 * is the behaviour this proxy has always had, and a client relying on it must
 * not start getting `Target.*` interception it never asked for.
 */
export function connectionKind(urlPath: string | undefined): 'browser' | 'page' {
  return (urlPath ?? '').startsWith('/devtools/browser') ? 'browser' : 'page';
}
