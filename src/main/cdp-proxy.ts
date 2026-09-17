// src/main/cdp-proxy.ts
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { webContents } from 'electron';
import {
  BrowserDomainContext,
  connectionKind,
  handleBrowserCommand,
  tagEventSession,
} from './cdp-browser-domain';

const DEFAULT_PORT = 9222;
const MAX_PORT = 9230;

/**
 * The single target and session wmux exposes (issue #237).
 *
 * `TARGET_ID` is `'1'` because `/json/list` has always advertised `id: '1'`
 * and a client that read the target list must find the same target on the
 * socket. The session id is wmux's own invention — Electron's debugger has no
 * session of its own to borrow, which is the entire reason this translation
 * exists — and is prefixed so it is recognisable in a protocol log.
 */
const TARGET_ID = '1';
const PAGE_SESSION_ID = 'wmux-page-1';

// DNS-rebinding guard. The proxy binds to loopback only, but a browser on the
// same machine can still reach it if a malicious page resolves an attacker
// domain to 127.0.0.1. Chrome's own remote-debugging endpoint rejects such
// requests by requiring the Host header to be a loopback literal (or absent,
// as with non-HTTP WebSocket/native clients). We mirror that policy so the
// full CDP surface (Runtime.evaluate ⇒ arbitrary JS in the webview) can't be
// driven from a web origin.
export function isAllowedCdpHost(hostHeader: string | undefined): boolean {
  // Native CDP clients (e.g. raw ws) may omit Host — allow only when absent.
  if (hostHeader === undefined) return true;
  // Strip optional :port. Bracketed IPv6 arrives as "[::1]:9222"; a bare IPv6
  // literal ("::1") has multiple colons and no port to strip.
  let host = hostHeader.trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else {
    const colon = host.indexOf(':');
    // Only treat a single trailing :port as a port (IPv4 / hostname). Multiple
    // colons with no brackets ⇒ bare IPv6 literal, leave intact.
    if (colon !== -1 && host.indexOf(':', colon + 1) === -1) {
      host = host.slice(0, colon);
    }
  }
  host = host.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

// Origin guard for the WebSocket upgrade. The Host check alone is NOT enough:
// WebSocket connections are exempt from CORS preflight, so a malicious page in
// the user's browser can open ws://127.0.0.1:9222 directly — the browser sends
// Host: 127.0.0.1:9222 (which passes isAllowedCdpHost) but also an Origin
// header identifying the web page. Driving the proxy then yields
// Runtime.evaluate (arbitrary JS in the webview) ⇒ RCE-equivalent.
//
// Legit CDP clients (chrome-devtools-mcp / puppeteer-core / raw `ws`) do NOT
// send an Origin header, while browsers ALWAYS send one for a page-initiated
// WebSocket. So we allow only an absent Origin (plus the DevTools front-end
// scheme) and reject every web/file origin — mirroring Chrome's own
// --remote-allow-origins policy.
export function isAllowedCdpOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  if (origin.toLowerCase().startsWith('devtools://')) return true;
  return false;
}

/**
 * The route an HTTP request is asking for, with the spellings Chrome accepts
 * folded onto one (issue #233).
 *
 * The handler below used to compare `req.url` against a literal, which made
 * the proxy stricter than the thing it impersonates: Chrome serves
 * `/json/version` and `/json/version/` alike, and Playwright's
 * `connectOverCDP` probes the TRAILING-SLASH form. So a client that attaches
 * to real Chrome got a 404 here and could not reach the browser panel at all,
 * while `curl /json/version` returned 200 — which is what made the report look
 * like a Playwright bug rather than ours.
 *
 * A query string is dropped for the same reason: it is not part of the route,
 * and an exact-match comparison silently treats `/json/list?for=me` as unknown.
 *
 * Pure and exported so the whole table of accepted spellings is testable
 * without binding a port, exactly as the two guards above are.
 */
export function cdpRoutePath(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  // `req.url` is origin-form (no scheme/host), so everything from the first
  // `?` or `#` onwards is query/fragment and never part of the route.
  const mark = rawUrl.search(/[?#]/);
  let path = mark === -1 ? rawUrl : rawUrl.slice(0, mark);
  // Fold trailing slashes away. Guarded at length 1 so "/" stays "/" rather
  // than collapsing to the empty string a missing url already maps to.
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

export class CDPProxy {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  /**
   * The port this proxy actually bound, or null when it holds none (issue #157).
   *
   * Deliberately not seeded with DEFAULT_PORT. That initialiser was an optimistic
   * claim made before anything was bound, and `start()` resolves even when the
   * whole 9222-9230 range is busy — so exhausting the range left the field
   * asserting 9222, a port the proxy does not own and never listened on.
   * "Nothing bound" and "bound the default" then became indistinguishable to
   * every reader, including the test written to catch exactly this.
   */
  private port: number | null = null;
  private webContentsId: number | null = null;
  private activeWs: WebSocket | null = null;

  setWebContentsId(wcId: number | null): void {
    this.webContentsId = wcId;
  }

  get currentWebContentsId(): number | null {
    return this.webContentsId;
  }

  /**
   * Everything the browser-domain answers need. Rebuilt per command rather
   * than cached: `title` and `url` change under a client's feet on every
   * navigation, and a stale `Target.getTargetInfo` is how a client concludes
   * its own `Page.navigate` did not happen.
   */
  private browserDomainContext(): BrowserDomainContext {
    const chromeVersion = process.versions.chrome || '0.0.0.0';
    const chromeMajor = chromeVersion.split('.')[0];
    return {
      page: this.getPageInfo(),
      chromeVersion,
      v8Version: (process.versions.v8 || '').split('-')[0],
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
      targetId: TARGET_ID,
      sessionId: PAGE_SESSION_ID,
    };
  }

  private getPageInfo(): { title: string; url: string } {
    if (!this.webContentsId) return { title: '', url: '' };
    try {
      const wc = webContents.fromId(this.webContentsId);
      return { title: wc?.getTitle() || '', url: wc?.getURL() || '' };
    } catch {
      return { title: '', url: '' };
    }
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');

      // Reject cross-origin (DNS-rebinding) requests before exposing any
      // CDP target metadata or WebSocket debugger URLs.
      if (!isAllowedCdpHost(req.headers.host)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'Forbidden host' }));
        return;
      }

      // One normalization for every route below (issue #233).
      const route = cdpRoutePath(req.url);

      if (route === '/json/version') {
        // Derive from the running Electron's actual versions so strict CDP
        // clients (chrome-devtools-mcp, puppeteer-core) negotiate correctly and
        // this never goes stale across Electron/Chromium bumps.
        const chrome = process.versions.chrome || '0.0.0.0';
        const chromeMajor = chrome.split('.')[0];
        const v8 = (process.versions.v8 || '').split('-')[0];
        res.end(JSON.stringify({
          Browser: `Chrome/${chrome}`,
          'Protocol-Version': '1.3',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
          'V8-Version': v8,
          'WebKit-Version': '537.36',
          webSocketDebuggerUrl: `ws://localhost:${this.port}/devtools/browser/${TARGET_ID}`,
        }));
        return;
      }

      if (route === '/json/list' || route === '/json') {
        const page = this.getPageInfo();
        res.end(JSON.stringify([{
          description: '',
          devtoolsFrontendUrl: '',
          id: TARGET_ID,
          type: 'page',
          title: page.title,
          url: page.url,
          webSocketDebuggerUrl: `ws://localhost:${this.port}/devtools/page/${TARGET_ID}`,
        }]));
        return;
      }

      // Chrome DevTools also queries /json/protocol
      if (route === '/json/protocol') {
        res.end('{}');
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });

    // WebSocket server using ws library (handles handshake properly).
    // verifyClient applies BOTH a loopback-only Host policy AND an Origin policy
    // to the WS upgrade. The Host check stops DNS-rebinding; the Origin check
    // stops a page in the user's own browser from opening this debugger socket
    // directly (WebSockets bypass CORS, so a passing Host isn't sufficient).
    this.wss = new WebSocketServer({
      server: this.server,
      verifyClient: (info: { req: http.IncomingMessage }) =>
        isAllowedCdpHost(info.req.headers.host) && isAllowedCdpOrigin(info.req.headers.origin),
    });

    this.wss.on('connection', (ws, req) => {
      if (!this.webContentsId) {
        ws.close(1011, 'Browser panel is not open');
        return;
      }

      // Which protocol this client thinks it is speaking (issue #237). A
      // browser connection gets the emulated browser domains and flattened
      // sessions; a page connection keeps the raw forwarding this proxy has
      // always done, so nothing that works today starts behaving differently.
      const kind = connectionKind(cdpRoutePath(req.url));

      this.activeWs = ws;
      const wc = webContents.fromId(this.webContentsId);

      if (!wc) {
        ws.close(1011, 'Browser webContents not found');
        return;
      }

      // Forward debugger events → WebSocket client. On a browser connection
      // every event carries the page session id, because that is the session
      // the client was told it attached to — an untagged event is dropped by a
      // flattened-protocol client as belonging to no session it knows.
      const eventSessionId = tagEventSession(kind, PAGE_SESSION_ID);
      const onDebuggerMessage = (_event: any, method: string, params: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(eventSessionId ? { method, params, sessionId: eventSessionId } : { method, params }));
        }
      };
      wc.debugger.on('message', onDebuggerMessage);

      const cleanup = () => {
        try { wc?.debugger.removeListener('message', onDebuggerMessage); } catch {}
        this.activeWs = null;
      };

      // Every reply echoes the request's `sessionId`. Puppeteer routes an
      // incoming message by `sessionId` before it ever looks at `id`, so a
      // reply that drops the field lands in the connection's callback table
      // instead of the session's, resolves nothing, and the caller hangs until
      // its own timeout — which reads as a slow page, not a protocol bug.
      const reply = (msg: any, body: Record<string, unknown>): void => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(msg.sessionId ? { id: msg.id, ...body, sessionId: msg.sessionId } : { id: msg.id, ...body }));
      };
      const emit = (event: { method: string; params: Record<string, unknown>; sessionId?: string }): void => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
      };
      const send = async (msg: any, method: string, params: Record<string, unknown>): Promise<void> => {
        try {
          reply(msg, { result: await wc.debugger.sendCommand(method, params) });
        } catch (err: any) {
          reply(msg, { error: { code: -32000, message: err.message } });
        }
      };

      // Handle incoming CDP commands from WebSocket client
      ws.on('message', async (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return; // Malformed JSON — ignore
        }
        if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) {
          reply(msg, { error: { code: -32000, message: 'Browser not attached' } });
          return;
        }
        // A page connection is the old pipe, unchanged.
        if (kind === 'page') {
          await send(msg, msg.method, msg.params || {});
          return;
        }
        const { events, action } = handleBrowserCommand(
          msg.method, msg.params, msg.sessionId, this.browserDomainContext(),
        );
        // Events first: Chrome emits the targets a command implies before
        // answering it, and a client that waits on `targetCreated` before
        // continuing would otherwise wait forever.
        events.forEach(emit);
        if (action.type === 'forward') {
          await send(msg, msg.method, msg.params || {});
        } else if (action.type === 'error') {
          reply(msg, { error: { code: action.code, message: action.message } });
        } else {
          reply(msg, { result: action.result });
          // Answered, then acted on: `Target.createTarget` is reported against
          // the target that already exists, and the navigation it stands for
          // runs afterwards. A failure here is the page's to report through
          // its own lifecycle events, not this command's.
          if (action.sideEffect) {
            try { await wc.debugger.sendCommand(action.sideEffect.method, action.sideEffect.params); } catch {}
          }
        }
      });

      ws.on('close', cleanup);
      ws.on('error', cleanup);

      console.log('[wmux] CDP proxy: client connected');
    });

    // Safety nets: never let an 'error' event become an uncaught exception.
    // BOTH emitters need one. `ws` forwards the http server's 'error' events
    // onto the WebSocketServer, so without a wss listener the failed listen()
    // below (port busy — the common case when a second wmux instance starts and
    // the first already holds 9222) is re-emitted on the wss as an unhandled
    // 'error'. That crashes the main process with Electron's modal error dialog,
    // which in turn blocks the event loop and wedges the whole instance.
    this.server.on('error', () => {});
    this.wss.on('error', () => {});

    // Try ports 9222-9230
    for (let p = DEFAULT_PORT; p <= MAX_PORT; p++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onListenError = (err: Error): void => {
            // Drop this probe's SUCCESS listener too. `listen(port, host, cb)`
            // registers cb via once('listening'), and a probe that fails never
            // consumes it — so nine failures leave nine live callbacks, which
            // is the MaxListenersExceededWarning seen in issue #157. They are
            // not inert: they all fire when a later port succeeds, each one
            // assigning its own `p`. That is harmless today only because
            // listeners run in registration order and the winner registers
            // last. Removing it makes that harmless by construction instead.
            this.server!.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = (): void => {
            // Drop only THIS probe's listener. removeAllListeners('error') would
            // also strip the safety net above and ws's own forwarder, leaving a
            // post-bind server error with no handler — uncaught again.
            this.server!.removeListener('error', onListenError);
            this.port = p;
            resolve();
          };
          this.server!.once('error', onListenError);
          this.server!.once('listening', onListening);
          this.server!.listen(p, '127.0.0.1');
        });
        console.log(`[wmux] CDP proxy listening on localhost:${p}`);
        return;
      } catch {
        continue;
      }
    }
    // Nothing bound. `port` stays null rather than reverting to an optimistic
    // DEFAULT_PORT, so getPort()/isListening() cannot present an unbound proxy
    // as a bound one (issue #157). Still resolves rather than rejecting: the
    // call site in index.ts treats the proxy as optional and would swallow a
    // rejection anyway — it is the STATE that has to be truthful, not the
    // control flow.
    console.warn(
      `[wmux] CDP proxy: all ports ${DEFAULT_PORT}-${MAX_PORT} busy — browser automation is unavailable`,
    );
  }

  stop(): void {
    this.activeWs?.close();
    this.wss?.close();
    this.server?.close();
    this.server = null;
    this.wss = null;
    // A stopped proxy holds nothing, and must not keep claiming otherwise.
    this.port = null;
  }

  /** The port this proxy bound, or null when it holds none (issue #157). */
  getPort(): number | null {
    return this.port;
  }

  /** Whether the proxy actually holds a port. */
  isListening(): boolean {
    return this.port !== null;
  }
}
