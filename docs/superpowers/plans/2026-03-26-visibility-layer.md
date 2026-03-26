# wmux Visibility Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wmux a pure passive observer of Claude Code — CDP proxy for browser visibility, hooks for agent visibility, minimal CLAUDE.md.

**Architecture:** Three passive systems: (1) HTTP+WebSocket CDP proxy on localhost:9222 that forwards chrome-devtools-mcp commands to the Electron webview debugger, (2) auto-configured Claude Code hooks that send tool-use events to the wmux pipe for sidebar display, (3) minimal informational CLAUDE.md with no directives.

**Tech Stack:** Node.js `http`/`ws` for CDP proxy, Electron `webContents.debugger` for CDP, Claude Code hooks system, existing named pipe + IPC infrastructure.

---

### Task 1: CDP Proxy — HTTP discovery endpoints

**Files:**
- Create: `src/main/cdp-proxy.ts`

- [ ] **Step 1: Create cdp-proxy.ts with HTTP server and discovery endpoints**

```typescript
// src/main/cdp-proxy.ts
import http from 'http';
import { webContents } from 'electron';

const DEFAULT_PORT = 9222;
const MAX_PORT = 9230;

export class CDPProxy {
  private server: http.Server | null = null;
  private port = DEFAULT_PORT;
  private webContentsId: number | null = null;

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
          Browser: 'wmux/0.3.0',
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
```

- [ ] **Step 2: Build to verify compilation**

Run: `npx tsc -p tsconfig.node.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/main/cdp-proxy.ts
git commit -m "feat(cdp-proxy): HTTP discovery endpoints /json/list and /json/version"
```

---

### Task 2: CDP Proxy — WebSocket bidirectional proxy

**Files:**
- Modify: `src/main/cdp-proxy.ts`

- [ ] **Step 1: Add WebSocket upgrade handling and CDP command proxying**

Add to `CDPProxy` class, after the `getPageInfo` method:

```typescript
  private wsClient: import('http').Socket | null = null;

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

    // Accept WebSocket handshake manually
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

    // Listen for debugger events → forward to WebSocket
    const wc = webContents.fromId(this.webContentsId!);
    const onMessage = (_event: any, method: string, params: any) => {
      this.wsSend(socket, JSON.stringify({ method, params }));
    };
    wc?.debugger.on('message', onMessage);

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      // Parse WebSocket frames
      while (buffer.length >= 2) {
        const frame = this.parseWsFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.totalLength);
        if (frame.opcode === 0x8) { // Close
          socket.end();
          return;
        }
        if (frame.opcode === 0x1) { // Text
          this.handleCDPCommand(frame.payload, socket);
        }
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
      header[0] = 0x81; // FIN + text
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
```

Update the `start()` method to add the upgrade handler, after `this.server = http.createServer(...)`:

```typescript
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as import('net').Socket, head);
    });
```

- [ ] **Step 2: Build to verify compilation**

Run: `npx tsc -p tsconfig.node.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/main/cdp-proxy.ts
git commit -m "feat(cdp-proxy): WebSocket bidirectional proxy for CDP commands"
```

---

### Task 3: Wire CDP Proxy into app startup

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Import and start CDP proxy in index.ts**

In `src/main/index.ts`, add import at the top alongside other imports:

```typescript
import { CDPProxy } from './cdp-proxy';
```

Add instantiation alongside other services (after `const prPoller = new PrPoller();`):

```typescript
const cdpProxy = new CDPProxy();
```

In the `app.whenReady().then(...)` block, after `pipeServer.start();`, add:

```typescript
  cdpProxy.start();
```

In the `app.on('will-quit', ...)` handler, add `cdpProxy.stop();` alongside other stops.

- [ ] **Step 2: Forward webContentsId to CDP proxy when browser panel attaches**

In `src/main/ipc-handlers.ts`, import the CDP proxy instance. The cleanest way: export `cdpProxy` from `ipc-handlers.ts` like `cdpBridge` is already exported.

Add after `const cdpBridge = new CDPBridge();`:

```typescript
import { CDPProxy } from './cdp-proxy';
const cdpProxy = new CDPProxy();
```

Wait — the proxy is already created in `index.ts`. Instead, pass it to `registerIpcHandlers`:

In `src/main/ipc-handlers.ts`, change the function signature:

```typescript
export function registerIpcHandlers(windowManager: WindowManager, cdpProxyInstance?: CDPProxy): void {
```

In the `CDP_ATTACH` handler, also notify the proxy:

```typescript
  ipcMain.on(IPC_CHANNELS.CDP_ATTACH, (_event, webContentsId: number) => {
    cdpBridge.attach(webContentsId);
    cdpProxyInstance?.setWebContentsId(webContentsId);
  });
  ipcMain.on(IPC_CHANNELS.CDP_DETACH, () => {
    cdpBridge.detach();
    cdpProxyInstance?.setWebContentsId(null);
  });
```

In `src/main/index.ts`, update the call:

```typescript
  registerIpcHandlers(windowManager, cdpProxy);
```

And update the export:

```typescript
export { cdpProxy };
```

- [ ] **Step 3: Build to verify compilation**

Run: `npx tsc -p tsconfig.node.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/main/ipc-handlers.ts src/main/cdp-proxy.ts
git commit -m "feat: wire CDP proxy into app startup, share webContentsId with bridge"
```

---

### Task 4: Hook CLI command + pipe handler

**Files:**
- Modify: `src/cli/wmux.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add HOOK_EVENT IPC channel**

In `src/shared/types.ts`, add after the CDP channels (before the closing `} as const`):

```typescript
  // Hook events (Claude Code hooks → main → renderer)
  HOOK_EVENT: 'hook:event',
```

- [ ] **Step 2: Add `hook` CLI command**

In `src/cli/wmux.ts`, add a new case before `default:`:

```typescript
      case 'hook': {
        const params: Record<string, string> = {};
        for (let i = 1; i < args.length; i += 2) {
          if (args[i] === '--event') params.event = args[i + 1];
          if (args[i] === '--tool') params.tool = args[i + 1];
          if (args[i] === '--agent') params.agentId = args[i + 1];
        }
        await sendV2('hook.event', params);
        break;
      }
```

Update the usage string to include: `Hook:       hook --event <type> --tool <name> [--agent <id>]`

- [ ] **Step 3: Add pipe handler for `hook.event`**

In `src/main/index.ts`, inside the `pipeServer.on('v2', ...)` switch, add before `default:`:

```typescript
      case 'hook.event': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.HOOK_EVENT, request.params);
        });
        respond({ ok: true });
        break;
      }
```

- [ ] **Step 4: Expose hook listener in preload**

In `src/preload/index.ts`, add after the `agent` section:

```typescript
  hook: {
    onEvent: (callback: (event: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.HOOK_EVENT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.HOOK_EVENT, handler);
    },
  },
```

- [ ] **Step 5: Build to verify compilation**

Run: `npx tsc -p tsconfig.node.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/cli/wmux.ts src/main/index.ts src/shared/types.ts src/preload/index.ts
git commit -m "feat: hook CLI command + pipe handler + IPC for Claude Code hooks"
```

---

### Task 5: Auto-configure Claude Code hooks in settings.json

**Files:**
- Modify: `src/main/claude-context.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add ensureClaudeHooks() function**

In `src/main/claude-context.ts`, add after the `ensureClaudeContext()` function:

```typescript
const HOOK_MARKER = 'WMUX_CLI';

function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Ensures Claude Code's ~/.claude/settings.json has a PostToolUse hook
 * that notifies wmux. Identified by WMUX_CLI in the command string.
 * Never touches other hook entries.
 */
export function ensureClaudeHooks(): void {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return; // No settings.json — skip

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    let settings: any;
    try { settings = JSON.parse(raw); } catch { return; } // Malformed — skip

    const wmuxHookCommand = 'node "$WMUX_CLI" hook --event post_tool --tool $CLAUDE_TOOL_USE_NAME 2>/dev/null || true';

    // Ensure hooks.PostToolUse exists as array
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

    const hooks: any[] = settings.hooks.PostToolUse;

    // Check if wmux hook already exists
    const existingIdx = hooks.findIndex((h: any) => h.command?.includes(HOOK_MARKER));

    const wmuxHook = {
      matcher: '',
      command: wmuxHookCommand,
    };

    if (existingIdx === -1) {
      // Not present — add it
      hooks.push(wmuxHook);
      console.log('[wmux] Added PostToolUse hook to ~/.claude/settings.json');
    } else if (hooks[existingIdx].command !== wmuxHookCommand) {
      // Present but outdated — update
      hooks[existingIdx] = wmuxHook;
      console.log('[wmux] Updated PostToolUse hook in ~/.claude/settings.json');
    } else {
      // Already up to date
      return;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[wmux] Failed to update Claude hooks:', err);
  }
}
```

- [ ] **Step 2: Call ensureClaudeHooks() at startup**

In `src/main/index.ts`, update the import:

```typescript
import { ensureClaudeContext, ensureClaudeHooks } from './claude-context';
```

In the `app.whenReady()` block, after `ensureClaudeContext();`:

```typescript
  ensureClaudeHooks();
```

- [ ] **Step 3: Build to verify compilation**

Run: `npx tsc -p tsconfig.node.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/claude-context.ts src/main/index.ts
git commit -m "feat: auto-configure Claude Code PostToolUse hook in settings.json"
```

---

### Task 6: Renderer — agent activity display in sidebar

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/Sidebar/WorkspaceRow.tsx`
- Modify: `src/renderer/styles/sidebar.css`

- [ ] **Step 1: Listen for hook events in App.tsx**

In `src/renderer/App.tsx`, add a new state and effect. After the existing `useEffect` for metadata updates:

```typescript
  // Listen for Claude Code hook events (agent activity)
  const [hookActivity, setHookActivity] = useState<Record<string, { tool: string; count: number; lastSeen: number }>>({});

  useEffect(() => {
    if (!window.wmux?.hook?.onEvent) return;
    const unsub = window.wmux.hook.onEvent((event: any) => {
      if (!event?.tool) return;
      setHookActivity(prev => {
        const key = event.agentId || 'main';
        const existing = prev[key];
        return {
          ...prev,
          [key]: {
            tool: event.tool,
            count: (existing?.count || 0) + 1,
            lastSeen: Date.now(),
          },
        };
      });
    });
    return unsub;
  }, []);

  // Clear stale activity after 10 seconds of no hooks
  useEffect(() => {
    if (Object.keys(hookActivity).length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setHookActivity(prev => {
        const next: typeof prev = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (now - v.lastSeen < 10000) {
            next[k] = v;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [hookActivity]);
```

Pass `hookActivity` to the Sidebar component (find where `<Sidebar` is rendered and add the prop).

- [ ] **Step 2: Update WorkspaceRow to display agent activity**

In `src/renderer/components/Sidebar/WorkspaceRow.tsx`, add a prop:

```typescript
  hookActivity?: Record<string, { tool: string; count: number; lastSeen: number }>;
```

In the metadata section, after the agent count block, add:

```typescript
          {/* Hook activity (Claude Code tool use) */}
          {hookActivity && Object.keys(hookActivity).length > 0 && (
            <div className="workspace-row__meta-line workspace-row__hook-activity">
              {Object.values(hookActivity).some(a => Date.now() - a.lastSeen < 5000)
                ? `${Object.keys(hookActivity).length} agent${Object.keys(hookActivity).length > 1 ? 's' : ''} working...`
                : 'Agents done'}
            </div>
          )}
```

- [ ] **Step 3: Add CSS for hook activity**

In `src/renderer/styles/sidebar.css`, after `.workspace-row__agents`:

```css
.workspace-row__hook-activity {
  color: rgba(255, 152, 0, 0.7);
  font-size: 11px;
}
```

- [ ] **Step 4: Build to verify compilation**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/Sidebar/WorkspaceRow.tsx src/renderer/styles/sidebar.css
git commit -m "feat: display Claude Code agent activity in sidebar via hooks"
```

---

### Task 7: Minimal CLAUDE.md + cleanup

**Files:**
- Modify: `resources/claude-instructions.md`

- [ ] **Step 1: Replace claude-instructions.md with minimal text**

```markdown
<!-- wmux:start — AUTO-MANAGED BY wmux. Do not edit this section manually. -->

# wmux

You are running inside wmux, a terminal multiplexer. The user can see
your browser activity in a panel on the right side of their screen,
and your agent activity in the sidebar. When relevant, you can mention
this to the user (e.g. "you can see the page in your browser panel").

<!-- wmux:end -->
```

- [ ] **Step 2: Re-inject into local ~/.claude/CLAUDE.md**

Run: `node -e "const { ensureClaudeContext } = require('./dist/main/claude-context'); ensureClaudeContext();"`
Expected: `[wmux] Updated wmux context in ~/.claude/CLAUDE.md`

- [ ] **Step 3: Commit**

```bash
git add resources/claude-instructions.md
git commit -m "feat: minimal CLAUDE.md — wmux as visibility layer, no directives"
```

---

### Task 8: Build, package, test, release

**Files:**
- Various build/release files

- [ ] **Step 1: Full build**

Run: `npx tsc -p tsconfig.node.json && npx vite build`
Expected: No errors

- [ ] **Step 2: Test CDP proxy manually**

Start wmux with `npm run dev`. Open browser panel (`Ctrl+Shift+I`). Then in a terminal:

```bash
curl http://localhost:9222/json/version
curl http://localhost:9222/json/list
```

Expected: JSON responses with wmux browser info.

- [ ] **Step 3: Test hook CLI**

```bash
node dist/cli/wmux.js hook --event post_tool --tool Agent
```

Expected: No error (hook event sent to pipe, broadcast to renderer).

- [ ] **Step 4: Repack asar, update zip, upload release**

Follow the established release process:
1. Repack asar from clean dist + node_modules
2. Update resources (claude-instructions, cli, shell-integration)
3. Zip as `wmux-0.3.0-win-x64.zip`
4. `gh release upload v0.3.0 ... --clobber`

- [ ] **Step 5: Commit all remaining changes**

```bash
git add -A
git commit -m "chore: v0.3.0 — visibility layer architecture"
git push origin master
```
