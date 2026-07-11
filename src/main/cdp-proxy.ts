// src/main/cdp-proxy.ts
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { webContents } from 'electron';

const DEFAULT_PORT = 9222;
const MAX_PORT = 9230;

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

export class CDPProxy {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = DEFAULT_PORT;
  private webContentsId: number | null = null;
  private activeWs: WebSocket | null = null;

  setWebContentsId(wcId: number | null): void {
    this.webContentsId = wcId;
  }

  get currentWebContentsId(): number | null {
    return this.webContentsId;
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

      if (req.url === '/json/version') {
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
          webSocketDebuggerUrl: `ws://localhost:${this.port}/devtools/browser/1`,
        }));
        return;
      }

      if (req.url === '/json/list' || req.url === '/json') {
        const page = this.getPageInfo();
        res.end(JSON.stringify([{
          description: '',
          devtoolsFrontendUrl: '',
          id: '1',
          type: 'page',
          title: page.title,
          url: page.url,
          webSocketDebuggerUrl: `ws://localhost:${this.port}/devtools/page/1`,
        }]));
        return;
      }

      // Chrome DevTools also queries /json/protocol
      if (req.url === '/json/protocol') {
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

    this.wss.on('connection', (ws) => {
      if (!this.webContentsId) {
        ws.close(1011, 'Browser panel is not open');
        return;
      }

      this.activeWs = ws;
      const wc = webContents.fromId(this.webContentsId);

      if (!wc) {
        ws.close(1011, 'Browser webContents not found');
        return;
      }

      // Forward debugger events → WebSocket client
      const onDebuggerMessage = (_event: any, method: string, params: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method, params }));
        }
      };
      wc.debugger.on('message', onDebuggerMessage);

      const cleanup = () => {
        try { wc?.debugger.removeListener('message', onDebuggerMessage); } catch {}
        this.activeWs = null;
      };

      // Handle incoming CDP commands from WebSocket client
      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) {
            ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Browser not attached' } }));
            return;
          }
          try {
            const result = await wc.debugger.sendCommand(msg.method, msg.params || {});
            ws.send(JSON.stringify({ id: msg.id, result }));
          } catch (err: any) {
            ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: err.message } }));
          }
        } catch {
          // Malformed JSON — ignore
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
          const onListenError = (err: Error): void => reject(err);
          this.server!.once('error', onListenError);
          this.server!.listen(p, '127.0.0.1', () => {
            // Drop only THIS probe's listener. removeAllListeners('error') would
            // also strip the safety net above and ws's own forwarder, leaving a
            // post-bind server error with no handler — uncaught again.
            this.server!.removeListener('error', onListenError);
            this.port = p;
            resolve();
          });
        });
        console.log(`[wmux] CDP proxy listening on localhost:${p}`);
        return;
      } catch {
        continue;
      }
    }
    console.warn('[wmux] CDP proxy: all ports 9222-9230 busy');
  }

  stop(): void {
    this.activeWs?.close();
    this.wss?.close();
    this.server?.close();
    this.server = null;
    this.wss = null;
  }

  getPort(): number {
    return this.port;
  }
}
