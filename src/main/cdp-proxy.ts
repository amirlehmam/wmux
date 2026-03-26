// src/main/cdp-proxy.ts
import http from 'http';
import { webContents } from 'electron';

const DEFAULT_PORT = 9222;
const MAX_PORT = 9230;

export class CDPProxy {
  private server: http.Server | null = null;
  private port = DEFAULT_PORT;
  private webContentsId: number | null = null;
  private wsClient: import('net').Socket | null = null;

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

  private handleUpgrade(req: http.IncomingMessage, socket: import('net').Socket, head: Buffer): void {
    if (!req.url?.startsWith('/devtools/page/')) {
      socket.destroy();
      return;
    }

    if (!this.webContentsId) {
      socket.write('HTTP/1.1 503 Browser Not Open\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const crypto = require('crypto');
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC799073')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    this.wsClient = socket;
    let buffer = Buffer.alloc(0);

    const wc = webContents.fromId(this.webContentsId!);
    const onMessage = (_event: any, method: string, params: any) => {
      this.wsSend(socket, JSON.stringify({ method, params }));
    };
    wc?.debugger.on('message', onMessage);

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const frame = this.parseWsFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.totalLength);
        if (frame.opcode === 0x8) { socket.end(); return; }
        if (frame.opcode === 0x1) { this.handleCDPCommand(frame.payload, socket); }
      }
    });

    socket.on('close', () => {
      wc?.debugger.removeListener('message', onMessage);
      this.wsClient = null;
    });

    socket.on('error', () => {
      wc?.debugger.removeListener('message', onMessage);
      this.wsClient = null;
    });
  }

  private async handleCDPCommand(json: string, socket: import('net').Socket): Promise<void> {
    try {
      const msg = JSON.parse(json);
      const wc = this.webContentsId ? webContents.fromId(this.webContentsId) : null;
      if (!wc || !wc.debugger.isAttached()) {
        this.wsSend(socket, JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Browser not attached' } }));
        return;
      }
      try {
        const result = await wc.debugger.sendCommand(msg.method, msg.params || {});
        this.wsSend(socket, JSON.stringify({ id: msg.id, result }));
      } catch (err: any) {
        this.wsSend(socket, JSON.stringify({ id: msg.id, error: { code: -32000, message: err.message } }));
      }
    } catch {
      // Malformed JSON — ignore
    }
  }

  private wsSend(socket: import('net').Socket, data: string): void {
    const payload = Buffer.from(data, 'utf-8');
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    try { socket.write(Buffer.concat([header, payload])); } catch {}
  }

  private parseWsFrame(buf: Buffer): { opcode: number; payload: string; totalLength: number } | null {
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < 4) return null;
      payloadLen = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buf.length < 10) return null;
      payloadLen = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }

    const maskSize = masked ? 4 : 0;
    const totalLength = offset + maskSize + payloadLen;
    if (buf.length < totalLength) return null;

    let payload: Buffer;
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      payload = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buf[offset + 4 + i] ^ mask[i % 4];
      }
    } else {
      payload = buf.subarray(offset, offset + payloadLen);
    }

    return { opcode, payload: payload.toString('utf-8'), totalLength };
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/json/version') {
        res.end(JSON.stringify({
          Browser: 'wmux/0.4.0',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: `ws://localhost:${this.port}/devtools/page/1`,
        }));
        return;
      }

      if (req.url === '/json/list' || req.url === '/json') {
        const page = this.getPageInfo();
        res.end(JSON.stringify([{
          id: '1',
          type: 'page',
          title: page.title,
          url: page.url,
          webSocketDebuggerUrl: `ws://localhost:${this.port}/devtools/page/1`,
        }]));
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });

    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as import('net').Socket, head);
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
    this.server?.close();
    this.server = null;
  }

  getPort(): number {
    return this.port;
  }
}
