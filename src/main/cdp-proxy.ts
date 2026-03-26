// src/main/cdp-proxy.ts
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { webContents } from 'electron';

const DEFAULT_PORT = 9222;
const MAX_PORT = 9230;

export class CDPProxy {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = DEFAULT_PORT;
  private webContentsId: number | null = null;
  private activeWs: WebSocket | null = null;

  setWebContentsId(wcId: number | null): void {
    this.webContentsId = wcId;
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

      if (req.url === '/json/version') {
        res.end(JSON.stringify({
          Browser: 'Chrome/133.0.0.0',
          'Protocol-Version': '1.3',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          'V8-Version': '13.3.0',
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

    // WebSocket server using ws library (handles handshake properly)
    this.wss = new WebSocketServer({ server: this.server });

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

      // Handle incoming CDP commands from WebSocket client
      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (!wc || !wc.debugger.isAttached()) {
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

      ws.on('close', () => {
        wc?.debugger.removeListener('message', onDebuggerMessage);
        this.activeWs = null;
      });

      ws.on('error', () => {
        wc?.debugger.removeListener('message', onDebuggerMessage);
        this.activeWs = null;
      });

      console.log('[wmux] CDP proxy: client connected');
    });

    // Try ports 9222-9230
    for (let p = DEFAULT_PORT; p <= MAX_PORT; p++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server!.once('error', reject);
          this.server!.listen(p, '127.0.0.1', () => {
            this.server!.removeAllListeners('error');
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
