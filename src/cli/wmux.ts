#!/usr/bin/env node

import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Respect WMUX_PIPE when set (e.g. by a parent wmux running with WMUX_INSTANCE),
// so the CLI talks to the same instance that spawned the shell.
const PIPE_PATH = process.env.WMUX_PIPE || '\\\\.\\pipe\\wmux';

// ─── Remote transport (issue #78: remote wmux management) ────────────────────
// When --remote host[:port] (or WMUX_REMOTE) is set, every command connects
// over TCP instead of the local named pipe — typically through an SSH tunnel
// (`ssh -L 9787:127.0.0.1:9787 user@host`) to a `wmux bridge` running on the
// remote machine. Auth is unchanged: the remote instance's pipe token must be
// supplied via --token or WMUX_REMOTE_TOKEN (print it there with `wmux token`).
const DEFAULT_BRIDGE_PORT = 9787;
let remoteTarget: { host: string; port: number } | null = null;

function parseRemoteTarget(spec: string): { host: string; port: number } {
  const idx = spec.lastIndexOf(':');
  if (idx === -1) return { host: spec, port: DEFAULT_BRIDGE_PORT };
  const port = parseInt(spec.slice(idx + 1), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.error(`Invalid --remote target: ${spec} (expected host[:port])`);
    process.exit(1);
  }
  return { host: spec.slice(0, idx) || '127.0.0.1', port };
}

function connectTransport(onConnect: () => void): net.Socket {
  return remoteTarget
    ? net.connect({ host: remoteTarget.host, port: remoteTarget.port }, onConnect)
    : net.connect({ path: PIPE_PATH }, onConnect);
}

// Auth token for privileged (V2) pipe requests. wmux injects WMUX_PIPE_TOKEN
// into the shells it spawns; for CLIs launched elsewhere, fall back to the
// token file in the instance's APPDATA dir (readable only by this user).
function readPipeToken(): string {
  const fromEnv = process.env.WMUX_PIPE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const suffix = process.env.WMUX_INSTANCE?.trim() ? `-${process.env.WMUX_INSTANCE.trim()}` : '';
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return fs.readFileSync(path.join(base, `wmux${suffix}`, 'pipe-token'), 'utf-8').trim();
  } catch {
    return '';
  }
}
// Mutable: overridden by --token / WMUX_REMOTE_TOKEN when talking to a remote
// instance, whose token differs from this machine's.
let PIPE_TOKEN = readPipeToken();

function sendV1(command: string): Promise<string> {
  // V1 state updates authenticate with an "auth <token> " prefix (issue #72).
  const line = PIPE_TOKEN ? `auth ${PIPE_TOKEN} ${command}` : command;
  return new Promise((resolve, reject) => {
    const client = connectTransport(() => {
      client.write(line + '\n');
    });
    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });
    client.on('end', () => resolve(data.trim()));
    client.on('error', (err) => reject(err));
    setTimeout(() => { client.end(); resolve(data.trim()); }, 5000);
  });
}

function sendV2(method: string, params: Record<string, any> = {}): Promise<any> {
  // Browser commands carry the caller's surface (WMUX_SURFACE_ID) so wmux can
  // route each agent to its OWN browser pane — concurrent agents no longer share
  // and clobber a single browser window (issue #62).
  if (method.startsWith('browser.') && params.caller === undefined && process.env.WMUX_SURFACE_ID) {
    params = { ...params, caller: process.env.WMUX_SURFACE_ID };
  }
  return new Promise((resolve, reject) => {
    const client = connectTransport(() => {
      const request = JSON.stringify({ method, params, id: 1, token: PIPE_TOKEN });
      client.write(request + '\n');
    });
    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        client.end();
        try {
          const response = JSON.parse(data.trim());
          if (response.error) reject(new Error(response.error.message));
          else resolve(response.result);
        } catch { resolve(data.trim()); }
      }
    });
    client.on('error', (err) => reject(err));
    setTimeout(() => { client.end(); reject(new Error('timeout')); }, 5000);
  });
}

// Simple flag helpers shared across commands.
function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i === args.length - 1) return undefined;
  return args[i + 1];
}
function stripFlag(args: string[], name: string): string[] {
  const i = args.indexOf(name);
  if (i < 0) return args;
  const copy = args.slice();
  copy.splice(i, i === args.length - 1 ? 1 : 2);
  return copy;
}

const print = (v: any) => console.log(JSON.stringify(v, null, 2));

// Each browser subcommand maps to the V2 request it issues. sendV2 auto-attaches
// the caller surface so concurrent agents get isolated browsers (issue #62).
const BROWSER_CMDS: Record<string, (args: string[]) => Promise<any>> = {
  open: (args) => sendV2('browser.navigate', { url: args[2] }),
  snapshot: () => sendV2('browser.snapshot'),
  click: (args) => sendV2('browser.click', { ref: args[2] }),
  type: (args) => sendV2('browser.type', { ref: args[2], text: args.slice(3).join(' ') }),
  fill: (args) => sendV2('browser.fill', { ref: args[2], value: args.slice(3).join(' ') }),
  screenshot: (args) => sendV2('browser.screenshot', { fullPage: args.includes('--full') }),
  'get-text': (args) => sendV2('browser.get_text', { ref: args[2] }),
  eval: (args) => sendV2('browser.eval', { js: args.slice(2).join(' ') }),
  wait: (args) => sendV2('browser.wait', { ref: args[2], timeout: parseInt(args[3]) || undefined }),
  back: () => sendV2('browser.back'),
  forward: () => sendV2('browser.forward'),
  reload: () => sendV2('browser.reload'),
};

async function cmdBrowser(args: string[]): Promise<void> {
  const handler = BROWSER_CMDS[args[1]];
  if (!handler) { console.error(`Unknown browser command: ${args[1]}`); process.exit(1); return; }
  print(await handler(args));
}

function agentSpawn(args: string[]): Promise<any> {
  const params: any = {};
  for (let i = 2; i < args.length; i += 2) {
    if (args[i] === '--cmd') params.cmd = args[i + 1];
    if (args[i] === '--label') params.label = args[i + 1];
    if (args[i] === '--cwd') params.cwd = args[i + 1];
    if (args[i] === '--pane') params.paneId = args[i + 1];
    if (args[i] === '--workspace') params.workspaceId = args[i + 1];
  }
  if (!params.cmd) { console.error('--cmd is required'); process.exit(1); }
  if (!params.label) params.label = params.cmd.split(/\s+/)[0];
  return sendV2('agent.spawn', params);
}

function agentSpawnBatch(args: string[]): Promise<any> {
  const jsonIdx = args.indexOf('--json');
  if (jsonIdx === -1) { console.error('Usage: wmux agent spawn-batch --json \'[...]\''); process.exit(1); }
  const parsed = JSON.parse(args[jsonIdx + 1]);
  const strategy = args.find((a, i) => args[i - 1] === '--strategy') || 'distribute';
  return sendV2('agent.spawn_batch', { agents: parsed, strategy });
}

const AGENT_CMDS: Record<string, (args: string[]) => Promise<any>> = {
  spawn: agentSpawn,
  'spawn-batch': agentSpawnBatch,
  status: (args) => sendV2('agent.status', { agentId: args[2] }),
  list: (args) => sendV2('agent.list', { workspaceId: args.find((a, i) => args[i - 1] === '--workspace') }),
  kill: (args) => sendV2('agent.kill', { agentId: args[2] }),
};

async function cmdAgent(args: string[]): Promise<void> {
  const handler = AGENT_CMDS[args[1]];
  if (!handler) { console.error(`Unknown agent command: ${args[1]}`); process.exit(1); return; }
  print(await handler(args));
}

async function cmdPane(args: string[]): Promise<void> {
  const sub = args[1];
  if (sub === 'new' || sub === 'split') {
    const rest = args.slice(2);
    const direction = rest.includes('--down') ? 'down' : 'right';
    const type = getFlag(rest, '--type') || 'terminal';
    const colorScheme = getFlag(rest, '--color-scheme');
    print(await sendV2('pane.split', { direction, type, ...(colorScheme ? { colorScheme } : {}) }));
  } else if (sub === 'close') {
    print(await sendV2('pane.close', { id: args[2] }));
  } else if (sub === 'focus') {
    print(await sendV2('pane.focus', { id: args[2] }));
  } else if (sub === 'list') {
    print(await sendV2('pane.list', { workspaceId: getFlag(args, '--workspace') }));
  } else {
    console.error(`Unknown pane subcommand: ${sub}`); process.exit(1);
  }
}

async function cmdConfig(args: string[]): Promise<void> {
  const sub = args[1];
  if (sub === 'show' || sub === 'get') {
    print(await sendV2('config.get'));
  } else if (sub === 'reload') {
    print(await sendV2('config.reload'));
  } else if (sub === 'path') {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    console.log(`${home}\\.wmux\\config.toml`);
  } else {
    console.error('Usage: wmux config <show|reload|path>'); process.exit(1);
  }
}

async function cmdLayout(args: string[]): Promise<void> {
  if (args[1] !== 'grid') { console.error(`Unknown layout command: ${args[1]}`); process.exit(1); }
  const params: any = {};
  for (let i = 2; i < args.length; i += 2) {
    if (args[i] === '--count') params.count = parseInt(args[i + 1], 10);
    if (args[i] === '--type') params.type = args[i + 1];
    if (args[i] === '--anchor-surface') params.anchorSurfaceId = args[i + 1];
    if (args[i] === '--anchor-pane') params.anchorPaneId = args[i + 1];
    if (args[i] === '--workspace') params.workspaceId = args[i + 1];
  }
  if (!params.count || params.count < 1) { console.error('--count <N> is required and must be >= 1'); process.exit(1); }
  // If no explicit anchor, fall back to the current shell's surface so the command "just works" from inside a pane.
  if (!params.anchorSurfaceId && !params.anchorPaneId && process.env.WMUX_SURFACE_ID) {
    params.anchorSurfaceId = process.env.WMUX_SURFACE_ID;
  }
  print(await sendV2('layout.grid', params));
}

async function cmdMarkdown(args: string[]): Promise<void> {
  const sub = args[1];
  if (sub === 'set') {
    // Existing behaviour: target an existing surface by id.
    const surfaceId = args[2];
    const contentFlag = args.indexOf('--content');
    const fileFlag = args.indexOf('--file');
    if (contentFlag !== -1) {
      print(await sendV2('markdown.set_content', { surfaceId, markdown: args.slice(contentFlag + 1).join(' ') }));
    } else if (fileFlag !== -1) {
      // Resolve against the terminal's cwd — the main-process cwd differs.
      const filePath = path.resolve(process.cwd(), args[fileFlag + 1] || '');
      print(await sendV2('markdown.load_file', { surfaceId, filePath }));
    } else {
      console.error('Usage: wmux markdown set <id> --content <text> | --file <path>'); process.exit(1);
    }
  } else if (sub) {
    // One-shot: `wmux markdown <file>` — create a markdown surface and load the
    // file into it. Relative paths resolve against the caller's cwd.
    const filePath = path.resolve(process.cwd(), sub);
    const created = await sendV2('surface.create', { type: 'markdown' });
    const surfaceId = created?.surfaceId;
    if (!surfaceId) { console.error('Failed to create markdown surface'); process.exit(1); }
    print(await sendV2('markdown.load_file', { surfaceId, filePath }));
  } else {
    console.error('Usage: wmux markdown <file>  |  wmux markdown set <id> --content <text> | --file <path>');
    process.exit(1);
  }
}

async function cmdNewWorkspace(args: string[]): Promise<void> {
  const params: any = {};
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === '--title') params.title = args[i + 1];
    if (args[i] === '--shell') params.shell = args[i + 1];
    if (args[i] === '--cwd') params.cwd = args[i + 1];
  }
  print(await sendV2('workspace.create', params));
}

// Remote terminal (issue #78): open a workspace whose shell is the OpenSSH
// client connecting to <target>. Everything that isn't a wmux flag is passed
// through to ssh, so `wmux ssh -p 2222 user@host` works as expected.
async function cmdSsh(args: string[]): Promise<void> {
  const title = getFlag(args, '--title');
  const sshArgs: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--title') { i++; continue; }
    sshArgs.push(args[i]);
  }
  if (sshArgs.length === 0) {
    console.error('Usage: wmux ssh [ssh options] <user@host> [--title T]');
    process.exit(1);
  }
  // Title heuristic: the last non-flag token is the destination (`-p 2222
  // user@host` → "user@host"), matching how ssh itself orders its argv.
  const target = [...sshArgs].reverse().find((a) => !a.startsWith('-')) ?? sshArgs[sshArgs.length - 1];
  print(await sendV2('workspace.create', {
    title: title || `ssh ${target}`,
    shell: `ssh ${sshArgs.join(' ')}`,
  }));
}

// TCP↔pipe bridge (issue #78): exposes this machine's wmux pipe on a TCP port
// so a remote CLI can drive it through an SSH tunnel. Pure byte relay — no
// parsing, no auth of its own; the pipe token is still verified end-to-end by
// wmux's pipe server, so the bridge grants nothing by itself.
async function cmdBridge(args: string[]): Promise<void> {
  const port = parseInt(getFlag(args, '--port') || '', 10) || DEFAULT_BRIDGE_PORT;
  const host = getFlag(args, '--host') || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn('WARNING: binding beyond localhost exposes the wmux pipe to the network.');
    console.warn(`Prefer the default 127.0.0.1 + an SSH tunnel: ssh -L ${port}:127.0.0.1:${port} user@host`);
  }
  const server = net.createServer((sock) => {
    const pipe = net.connect({ path: PIPE_PATH });
    sock.pipe(pipe);
    pipe.pipe(sock);
    const drop = () => { sock.destroy(); pipe.destroy(); };
    sock.on('error', drop);
    pipe.on('error', drop);
    sock.on('close', drop);
    pipe.on('close', drop);
  });
  server.on('error', (err) => { console.error(`bridge error: ${err.message}`); process.exit(1); });
  server.listen(port, host, () => {
    console.log(`wmux bridge listening on ${host}:${port} ↔ ${PIPE_PATH}`);
    console.log('From another machine:');
    console.log(`  ssh -L ${port}:127.0.0.1:${port} <user>@<this-host>`);
    console.log(`  wmux --remote 127.0.0.1:${port} --token <run 'wmux token' here> list-workspaces`);
    console.log('Ctrl+C to stop.');
  });
}

// Prints this instance's pipe auth token so it can be passed to --token /
// WMUX_REMOTE_TOKEN on the machine that will drive this one remotely.
function cmdToken(): void {
  if (!PIPE_TOKEN) {
    console.error('No pipe token found — has wmux been started on this machine?');
    process.exit(1);
  }
  console.log(PIPE_TOKEN);
}

async function cmdSetColorScheme(args: string[]): Promise<void> {
  // Two forms:
  //   wmux set-color-scheme <scheme>             → apply to current surface
  //   wmux set-color-scheme <surfaceId> <scheme> → apply to a specific surface
  let surfaceId = args[1];
  let scheme = args[2];
  if (!scheme) {
    scheme = surfaceId;
    surfaceId = process.env.WMUX_SURFACE_ID || '';
  }
  if (!surfaceId) { console.error('No surface id. Pass one as argument or run inside a wmux pane.'); process.exit(1); }
  if (!scheme) { console.error('Usage: wmux set-color-scheme [surfaceId] <scheme>'); process.exit(1); }
  print(await sendV2('surface.set_color_scheme', { surfaceId, colorScheme: scheme }));
}

async function cmdSend(args: string[]): Promise<void> {
  // Drop --surface <id> (and its value) from the free-form text args.
  const surfaceId = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
  const textArgs = stripFlag(args.slice(1), '--surface');
  const payload: Record<string, any> = { text: textArgs.join(' ') };
  if (surfaceId) payload.surfaceId = surfaceId;
  print(await sendV2('surface.send_text', payload));
}

async function cmdSendKey(args: string[]): Promise<void> {
  const key = args[1];
  const modifiers: string[] = [];
  if (args.includes('--ctrl')) modifiers.push('ctrl');
  if (args.includes('--shift')) modifiers.push('shift');
  if (args.includes('--alt')) modifiers.push('alt');
  const surfaceId = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
  const payload: Record<string, any> = { key, modifiers };
  if (surfaceId) payload.surfaceId = surfaceId;
  print(await sendV2('surface.send_key', payload));
}

async function cmdNotify(args: string[]): Promise<void> {
  const titleIdx = args.indexOf('--title');
  const bodyIdx = args.indexOf('--body');
  const body = bodyIdx !== -1 ? args[bodyIdx + 1] : undefined;
  const text = args.filter((_, i) => i > 0 && ![titleIdx, titleIdx + 1, bodyIdx, bodyIdx + 1].includes(i)).join(' ') || body || '';
  await sendV1(`notify ${process.env.WMUX_SURFACE_ID || ''} ${text}`);
  console.log('Notification sent');
}

async function cmdHook(args: string[]): Promise<void> {
  const params: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === '--event') params.event = args[i + 1];
    if (args[i] === '--tool') params.tool = args[i + 1];
    if (args[i] === '--agent') params.agentId = args[i + 1];
  }
  await sendV2('hook.event', params);
}

async function cmdAgentActivity(args: string[]): Promise<void> {
  const surfaceId = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
  if (!surfaceId) { console.error('agent-activity: --surface or WMUX_SURFACE_ID required'); process.exit(1); }
  const params: Record<string, any> = { surfaceId };
  const tool = getFlag(args, '--tool'); if (tool) params.tool = tool;
  const skill = getFlag(args, '--skill'); if (skill) params.skill = skill;
  if (args.includes('--done')) params.done = true;
  if (args.includes('--active')) params.done = false;
  await sendV2('agent.activity', params);
}

// Command dispatch table. Each handler receives the raw argv (args[0] is the
// command name). Replaces a single giant switch so each command stays small and
// independently testable.
const COMMANDS: Record<string, (args: string[]) => Promise<void> | void> = {
  // System
  ping: async () => console.log(await sendV1('ping')),
  identify: async () => print(await sendV2('system.identify')),
  capabilities: async () => print(await sendV2('system.capabilities')),
  'list-windows': async () => print(await sendV2('window.list')),
  'focus-window': async (args) => print(await sendV2('window.focus', { id: args[1] })),
  'new-window': async () => print(await sendV2('window.create')),

  // Remote management (issue #78)
  bridge: cmdBridge,
  token: cmdToken,

  // Workspace
  'new-workspace': cmdNewWorkspace,
  ssh: cmdSsh,
  'close-workspace': async (args) => print(await sendV2('workspace.close', { id: args[1] })),
  'select-workspace': async (args) => print(await sendV2('workspace.select', { id: args[1] })),
  'rename-workspace': async (args) => print(await sendV2('workspace.rename', { id: args[1], title: args[2] })),
  'list-workspaces': async () => print(await sendV2('workspace.list')),

  // Surface
  'new-surface': async (args) => {
    const type = getFlag(args, '--type') || 'terminal';
    const colorScheme = getFlag(args, '--color-scheme');
    print(await sendV2('surface.create', { type, ...(colorScheme ? { colorScheme } : {}) }));
  },
  'close-surface': async (args) => print(await sendV2('surface.close', { id: args[1] })),
  'focus-surface': async (args) => print(await sendV2('surface.focus', { id: args[1] })),
  'list-surfaces': async (args) => print(await sendV2('surface.list', { paneId: getFlag(args, '--pane') })),
  'set-color-scheme': cmdSetColorScheme,
  'clear-color-scheme': async (args) => {
    const surfaceId = args[1] || process.env.WMUX_SURFACE_ID || '';
    if (!surfaceId) { console.error('No surface id. Pass one as argument or run inside a wmux pane.'); process.exit(1); }
    print(await sendV2('surface.set_color_scheme', { surfaceId, colorScheme: null }));
  },
  'list-themes': async () => print(await sendV2('theme.list')),
  themes: async () => print(await sendV2('theme.list')),

  // User config (~/.wmux/config.toml)
  'reload-config': async () => print(await sendV2('config.reload')),
  config: cmdConfig,

  // Pane
  split: async (args) => {
    const direction = args.includes('--down') ? 'down' : 'right';
    const type = getFlag(args, '--type') || 'terminal';
    const colorScheme = getFlag(args, '--color-scheme');
    print(await sendV2('pane.split', { direction, type, ...(colorScheme ? { colorScheme } : {}) }));
  },
  pane: cmdPane,
  'close-pane': async (args) => print(await sendV2('pane.close', { id: args[1] })),
  'focus-pane': async (args) => print(await sendV2('pane.focus', { id: args[1] })),
  'zoom-pane': async (args) => print(await sendV2('pane.zoom', { id: args[1] })),
  'list-panes': async (args) => print(await sendV2('pane.list', { workspaceId: getFlag(args, '--workspace') })),
  tree: async () => print(await sendV2('system.tree')),

  // Layout
  layout: cmdLayout,

  // Terminal interaction
  send: cmdSend,
  'send-key': cmdSendKey,
  'read-screen': async (args) => {
    const lines = args.find((a, i) => args[i - 1] === '--lines');
    // Same targeting rule as send/send-key: inside a pane the caller's own
    // surface is the default; cross-pane reads take --surface explicitly.
    const surfaceId = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
    print(await sendV2('surface.read_text', {
      ...(surfaceId ? { surfaceId } : {}),
      lines: lines ? parseInt(lines) : 50,
    }));
  },
  'trigger-flash': async (args) => print(await sendV2('surface.trigger_flash', { id: args[1] })),

  // Browser
  browser: cmdBrowser,

  // Agent
  agent: cmdAgent,

  // Markdown
  markdown: cmdMarkdown,

  // Notifications
  notify: cmdNotify,
  'list-notifications': async () => print(await sendV2('notification.list')),
  'clear-notifications': async (args) => print(await sendV2('notification.clear', { id: args[1] })),

  // Sidebar
  'set-status': async (args) => {
    // `set-status --workspace <id> --state <idle|running|interrupted> [--text "<label>"]`
    // sets a named workspace's sidebar status from anywhere (works outside a
    // pane, unlike the surface-scoped shell integration). Without --workspace it
    // falls back to the legacy positional `set-status <key> <value>` form.
    const workspaceId = getFlag(args, '--workspace');
    if (workspaceId) {
      const state = getFlag(args, '--state');
      const valid = ['idle', 'running', 'interrupted'];
      if (!state || !valid.includes(state)) {
        console.error(`set-status --workspace requires --state <${valid.join('|')}>`);
        process.exit(1);
      }
      const text = getFlag(args, '--text');
      print(await sendV2('workspace.set_status', { workspaceId, state, ...(text ? { text } : {}) }));
      return;
    }
    print(await sendV2('sidebar.set_status', { key: args[1], value: args[2] }));
  },
  'set-progress': async (args) => {
    const label = args.find((a, i) => args[i - 1] === '--label');
    print(await sendV2('sidebar.set_progress', { value: parseFloat(args[1]), label }));
  },
  log: async (args) => print(await sendV2('sidebar.log', { level: args[1], message: args.slice(2).join(' ') })),
  'sidebar-state': async () => print(await sendV2('sidebar.get_state')),

  diff: async (args) => {
    const file = args.find((a, i) => args[i - 1] === '--file') || '';
    print(await sendV2('diff.refresh', { file }));
  },
  hook: cmdHook,
  'agent-activity': cmdAgentActivity,
};

async function main() {
  let args = process.argv.slice(2);

  // Global flags (issue #78 remote management) — may appear anywhere in argv.
  const remoteSpec = getFlag(args, '--remote') ?? process.env.WMUX_REMOTE;
  const tokenOverride = getFlag(args, '--token') ?? process.env.WMUX_REMOTE_TOKEN;
  args = stripFlag(stripFlag(args, '--remote'), '--token');
  if (remoteSpec) remoteTarget = parseRemoteTarget(remoteSpec);
  if (tokenOverride) PIPE_TOKEN = tokenOverride;

  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(0);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      console.error('wmux is not running (could not connect to pipe)');
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

function printUsage() {
  console.log(`wmux CLI — Windows terminal multiplexer

Usage: wmux <command> [options]

System:     ping, identify, capabilities, list-windows, focus-window <id>, new-window
Workspace:  new-workspace, close-workspace, select-workspace, rename-workspace, list-workspaces
Remote:     ssh [ssh options] <user@host> [--title T]   (remote terminal in a new workspace)
            bridge [--port P] [--host H]   (expose this wmux's pipe over TCP, default 127.0.0.1:9787)
            token                          (print this instance's auth token, for --token)
Global:     --remote host[:port] --token <T>   (drive a REMOTE wmux through an SSH tunnel;
            env equivalents: WMUX_REMOTE, WMUX_REMOTE_TOKEN)
Surface:    new-surface [--type T] [--color-scheme NAME], close-surface, focus-surface, list-surfaces
            set-color-scheme [surfaceId] <scheme>, clear-color-scheme [surfaceId], list-themes
Pane:       split [--down] [--type T] [--color-scheme NAME], close-pane, focus-pane, zoom-pane, list-panes, tree
            pane new|close|focus|list   (verb form, mirrors issue #4 example)
Layout:     layout grid --count <N> [--type terminal] [--anchor-surface <id>]
Terminal:   send <text>, send-key <key>, read-screen [--lines N] [--surface <id>], trigger-flash
Browser:    browser open|snapshot|click|type|fill|screenshot|get-text|eval|wait|back|forward|reload
Agent:      agent spawn|spawn-batch|status|list|kill
Markdown:   markdown <file>   (open a file in a new markdown view)
            markdown set <id> --content <text> | --file <path>
Diff:       diff [--file <path>]
Notify:     notify <text>, list-notifications, clear-notifications
Sidebar:    set-status, set-progress, log, sidebar-state
Hook:       hook --event <type> --tool <name> [--agent <id>]
Config:     config show|reload|path   (edits ~/.wmux/config.toml — see docs)
            reload-config             (shorthand for 'config reload')
`);
}

main();
