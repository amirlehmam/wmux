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
    const timer = setTimeout(() => { client.end(); resolve(data.trim()); }, 5000);
    const finish = () => { clearTimeout(timer); resolve(data.trim()); };
    client.on('data', (chunk) => {
      data += chunk.toString();
      // V1 replies are a single newline-terminated line (pong/ok/unauthorized).
      // Resolve as soon as it arrives instead of blocking on the server closing
      // the socket (it doesn't) — otherwise every call waited the full 5s timer.
      if (data.includes('\n')) { client.end(); finish(); }
    });
    client.on('end', finish);
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function sendV2(method: string, params: Record<string, any> = {}): Promise<any> {
  // Every command carries the caller's surface (WMUX_SURFACE_ID). Browser
  // commands use it to route each agent to its OWN browser pane, so concurrent
  // agents no longer share and clobber one browser window (issue #62); the
  // workspace/pane/surface commands use it to answer about the window the
  // calling shell actually lives in rather than an arbitrary one (issue #141).
  if (params.caller === undefined && process.env.WMUX_SURFACE_ID) {
    params = { ...params, caller: process.env.WMUX_SURFACE_ID };
  }
  return new Promise((resolve, reject) => {
    const client = connectTransport(() => {
      const request = JSON.stringify({ method, params, id: 1, token: PIPE_TOKEN });
      client.write(request + '\n');
    });
    let data = '';
    const timer = setTimeout(() => { client.end(); reject(new Error('timeout')); }, 5000);
    client.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        clearTimeout(timer);
        client.end();
        try {
          const response = JSON.parse(data.trim());
          if (response.error) reject(new Error(response.error.message));
          else resolve(response.result);
        } catch { resolve(data.trim()); }
      }
    });
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
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
  // Valueless flags must be stripped before the pairwise --flag value loop.
  const rest = args.slice(2).filter((a) => {
    if (a === '--replace-tab') { params.replaceTab = true; return false; }
    return true;
  });
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '--cmd') params.cmd = rest[i + 1];
    if (rest[i] === '--label') params.label = rest[i + 1];
    if (rest[i] === '--cwd') params.cwd = rest[i + 1];
    if (rest[i] === '--pane') params.paneId = rest[i + 1];
    if (rest[i] === '--workspace') params.workspaceId = rest[i + 1];
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

/**
 * Community translations (issue #147). `list` is the default because the whole
 * point is telling a translator which of their files loaded and which were
 * rejected — silence on a typo'd filename is the failure mode to avoid.
 */
async function cmdLocales(args: string[]): Promise<void> {
  const sub = args[1];
  if (!sub || sub === 'list' || sub === 'show') {
    print(await sendV2('locales.get'));
  } else if (sub === 'reload') {
    print(await sendV2('config.reload'));
  } else if (sub === 'path') {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    console.log(`${home}\\.wmux\\locales`);
  } else {
    console.error('Usage: wmux locales [list|reload|path]'); process.exit(1);
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
    const titleFlag = args.indexOf('--title');
    const title = titleFlag !== -1 ? args[titleFlag + 1] : undefined;
    if (contentFlag !== -1) {
      // Stop at --title so it isn't swallowed into the content when it comes last.
      const end = titleFlag > contentFlag ? titleFlag : args.length;
      print(await sendV2('markdown.set_content', {
        surfaceId, markdown: args.slice(contentFlag + 1, end).join(' '), title,
      }));
    } else if (fileFlag !== -1) {
      // Resolve against the terminal's cwd — the main-process cwd differs.
      const filePath = path.resolve(process.cwd(), args[fileFlag + 1] || '');
      print(await sendV2('markdown.load_file', { surfaceId, filePath }));
    } else {
      console.error('Usage: wmux markdown set <id> --content <text> [--title T] | --file <path>'); process.exit(1);
    }
  } else if (sub === 'get') {
    // Read a surface's buffer back out — mirrors `read-screen` for terminals.
    print(await sendV2('markdown.get_content', { surfaceId: args[2] }));
  } else if (sub) {
    // One-shot: `wmux markdown <file>` — create a markdown surface and load the
    // file into it. Relative paths resolve against the caller's cwd.
    const filePath = path.resolve(process.cwd(), sub);
    const created = await sendV2('surface.create', { type: 'markdown' });
    const surfaceId = created?.surfaceId;
    if (!surfaceId) { console.error('Failed to create markdown surface'); process.exit(1); }
    print(await sendV2('markdown.load_file', { surfaceId, filePath }));
  } else {
    console.error('Usage: wmux markdown <file>  |  wmux markdown set <id> --content <text> [--title T] | --file <path>  |  wmux markdown get <id>');
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

// ─── Declared agent state (issue #128) ───────────────────────────────────────
// The reporting side of the protocol. An agent running inside a wmux pane can
// call these with no arguments beyond the state itself — WMUX_SURFACE_ID is
// already in its environment, so it never has to discover which pane it is in.

/** Resolve the pane this command is about: --surface, else the ambient pane. */
function reportingSurface(args: string[], command: string): string {
  const surfaceId = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
  if (!surfaceId) {
    console.error(`${command}: --surface or WMUX_SURFACE_ID required`);
    process.exit(1);
  }
  return surfaceId;
}

/** Optional monotonic sequence — wmux drops any report at or below the last seen. */
function seqFlag(args: string[]): number | undefined {
  const raw = getFlag(args, '--seq');
  if (!raw) return undefined;
  const seq = Number(raw);
  return Number.isFinite(seq) ? seq : undefined;
}

async function cmdReportAgent(args: string[]): Promise<void> {
  const surfaceId = reportingSurface(args, 'report-agent');
  const params: Record<string, any> = { surfaceId, seq: seqFlag(args) };

  // --blocked [reason] parks the pane on the user; --unblocked releases it.
  if (args.includes('--blocked')) {
    params.awaitingHuman = true;
    params.reason = getFlag(args, '--blocked') || getFlag(args, '--reason') || null;
  } else if (args.includes('--unblocked')) {
    params.awaitingHuman = false;
  }

  if (args.includes('--run-start')) params.runDelta = 1;
  if (args.includes('--run-end')) params.runDelta = -1;
  const depth = getFlag(args, '--run-depth');
  if (depth !== undefined) params.runDepth = Number(depth);

  // --choices declares what wmux may offer as an answer (issue #128). JSON
  // rather than a packed string because each choice carries four fields and the
  // payload is exact bytes — the one place a cramped syntax would be a bug
  // waiting to happen. Mirrors `agent spawn-batch --json`.
  const choices = getFlag(args, '--choices');
  if (choices !== undefined) {
    try {
      params.choices = JSON.parse(choices);
    } catch (err: any) {
      console.error(`report-agent: --choices is not valid JSON: ${err.message}`);
      process.exit(1);
    }
  }

  print(await sendV2('pane.report_agent', params));
}

/**
 * `answer-agent` — reply to a blocked pane from outside it (issue #128).
 *
 * Note this one defaults to NO ambient surface: the other verbs are an agent
 * describing itself, where WMUX_SURFACE_ID is exactly right, but answering is
 * aimed at a DIFFERENT pane — the whole point is to not be in it. Defaulting to
 * the caller's own pane would make `wmux answer-agent --choice allow` type into
 * whatever terminal you happen to be sitting in.
 */
async function cmdAnswerAgent(args: string[]): Promise<void> {
  const surfaceId = getFlag(args, '--surface');
  if (!surfaceId) {
    console.error('answer-agent: --surface required (run `wmux agent-state` to see which panes are blocked)');
    process.exit(1);
  }
  const choiceId = getFlag(args, '--choice') ?? args[1];
  print(await sendV2('pane.answer_agent', { surfaceId, choiceId: choiceId ?? null }));
}

async function cmdReportMetadata(args: string[]): Promise<void> {
  const surfaceId = reportingSurface(args, 'report-metadata');
  const params: Record<string, any> = { surfaceId, seq: seqFlag(args) };
  const model = getFlag(args, '--model'); if (model) params.model = model;
  const tokens = getFlag(args, '--tokens'); if (tokens) params.tokens = tokens;
  const pct = getFlag(args, '--context-pct'); if (pct) params.contextPct = Number(pct);
  const ttl = getFlag(args, '--ttl'); if (ttl) params.ttlMs = Number(ttl);
  print(await sendV2('pane.report_metadata', params));
}

// Keys stay inferred (no Record<string, …> annotation) so spreading this into
// COMMANDS still satisfies the exhaustive Record<CommandName, …> check.
const AGENT_STATE_COMMANDS = {
  'report-agent': cmdReportAgent,
  'report-metadata': cmdReportMetadata,
  'report-session': async (args: string[]) => {
    const surfaceId = reportingSurface(args, 'report-session');
    print(await sendV2('pane.report_agent_session', {
      surfaceId,
      seq: seqFlag(args),
      sessionId: getFlag(args, '--session') ?? args[1] ?? null,
    }));
  },
  'answer-agent': cmdAnswerAgent,
  'release-agent': async (args: string[]) => {
    const surfaceId = reportingSurface(args, 'release-agent');
    print(await sendV2('pane.release_agent', { surfaceId, seq: seqFlag(args) }));
  },
  // No --surface → the whole picture, including a `blocked` list that answers
  // "which pane needs me?" in one call.
  'agent-state': async (args: string[]) => {
    const surfaceId = getFlag(args, '--surface');
    print(await sendV2('pane.agent_state', surfaceId ? { surfaceId } : {}));
  },
};

// ─── Per-command usage + flag validation (issue #143) ────────────────────────
// `getFlag()` picks out the flags it knows and ignores the rest, so a typo or an
// exploratory `--help` used to fall through to "run with defaults" — probing the
// CLI mutated the user's layout (`wmux split --help` split a pane) and returned
// a JSON reply that read as success. Every command now declares its flags, so
// anything else is an error, and `--help` prints usage without touching wmux.
interface CommandSpec {
  /** Printed by `--help`, by `wmux help <command>`, and after a rejected flag. */
  usage: string;
  /** Flags that consume the following argv token. */
  value?: string[];
  /** Flags that stand alone. */
  bool?: string[];
  /**
   * Arguments are free-form text or belong to another program (ssh), so nothing
   * here can be judged a typo. Their argv is never validated and `--help` is
   * left alone — `wmux send --help` must type "--help" into the pane, not print
   * usage. `wmux help <command>` is the way in for these.
   */
  passthrough?: boolean;
}

const SURFACE_NOTE = '(surface defaults to $WMUX_SURFACE_ID inside a pane)';

const COMMAND_SPECS = {
  // System
  ping: { usage: 'wmux ping' },
  identify: { usage: 'wmux identify' },
  capabilities: { usage: 'wmux capabilities' },
  'list-windows': { usage: 'wmux list-windows' },
  'focus-window': { usage: 'wmux focus-window <windowId>' },
  'new-window': { usage: 'wmux new-window' },

  // Remote management (issue #78)
  bridge: {
    usage: 'wmux bridge [--port P] [--host H]   (expose this wmux\'s pipe over TCP, default 127.0.0.1:9787)',
    value: ['--port', '--host'],
  },
  token: { usage: 'wmux token   (print this instance\'s pipe auth token)' },

  // Workspace
  'new-workspace': {
    usage: 'wmux new-workspace [--title T] [--shell S] [--cwd D]',
    value: ['--title', '--shell', '--cwd'],
  },
  ssh: { usage: 'wmux ssh [ssh options] <user@host> [--title T]', passthrough: true },
  'close-workspace': { usage: 'wmux close-workspace [workspaceId]' },
  'select-workspace': { usage: 'wmux select-workspace <workspaceId>' },
  'rename-workspace': { usage: 'wmux rename-workspace <workspaceId> <title>', passthrough: true },
  'list-workspaces': { usage: 'wmux list-workspaces' },

  // Surface
  'new-surface': {
    usage: 'wmux new-surface [--type terminal|browser|markdown] [--color-scheme NAME]',
    value: ['--type', '--color-scheme'],
  },
  'close-surface': { usage: 'wmux close-surface [surfaceId]' },
  'rename-surface': {
    usage: 'wmux rename-surface [surfaceId] <title>   (renames the current surface inside a pane)',
    passthrough: true,
  },
  'focus-surface': { usage: 'wmux focus-surface <surfaceId>' },
  'list-surfaces': {
    usage: 'wmux list-surfaces [--pane <paneId>] [--workspace <workspaceId>]',
    value: ['--pane', '--workspace'],
  },
  'set-color-scheme': { usage: 'wmux set-color-scheme [surfaceId] <scheme>' },
  'clear-color-scheme': { usage: 'wmux clear-color-scheme [surfaceId]' },
  'list-themes': { usage: 'wmux list-themes' },
  themes: { usage: 'wmux themes   (alias of list-themes)' },

  // User config
  'reload-config': { usage: 'wmux reload-config' },
  config: { usage: 'wmux config <show|reload|path>' },
  locales: { usage: 'wmux locales [list|reload|path]' },

  // Pane
  split: {
    usage: 'wmux split [--down] [--type terminal|browser|markdown] [--color-scheme NAME]',
    value: ['--type', '--color-scheme'],
    bool: ['--down'],
  },
  pane: {
    usage: [
      'wmux pane new [--down] [--type T] [--color-scheme NAME]',
      'wmux pane close <paneId> | focus <paneId> | list [--workspace <id>]',
    ].join('\n'),
    value: ['--type', '--color-scheme', '--workspace'],
    bool: ['--down'],
  },
  'close-pane': { usage: 'wmux close-pane [paneId]' },
  'focus-pane': { usage: 'wmux focus-pane <paneId>' },
  'zoom-pane': { usage: 'wmux zoom-pane [paneId]' },
  'list-panes': { usage: 'wmux list-panes [--workspace <workspaceId>]', value: ['--workspace'] },
  tree: { usage: 'wmux tree [--workspace <workspaceId>]', value: ['--workspace'] },

  // Layout
  layout: {
    usage: 'wmux layout grid --count <N> [--type T] [--anchor-surface <id>] [--anchor-pane <id>] [--workspace <id>]',
    value: ['--count', '--type', '--anchor-surface', '--anchor-pane', '--workspace'],
  },

  // Terminal interaction
  send: { usage: 'wmux send [--surface <id>] <text>', passthrough: true },
  'send-key': {
    usage: 'wmux send-key <key> [--ctrl] [--shift] [--alt] [--surface <id>]',
    value: ['--surface'],
    bool: ['--ctrl', '--shift', '--alt'],
  },
  'read-screen': {
    usage: `wmux read-screen [--lines N] [--surface <id>]   ${SURFACE_NOTE}`,
    value: ['--lines', '--surface'],
  },
  'trigger-flash': { usage: 'wmux trigger-flash [surfaceId]' },

  // Browser (free-form text for type/fill/eval)
  browser: {
    usage: [
      'wmux browser open <url> | snapshot | click <ref> | type <ref> <text> | fill <ref> <value>',
      'wmux browser screenshot [--full] | get-text [ref] | eval <js> | wait <ref> [ms]',
      'wmux browser back | forward | reload',
    ].join('\n'),
    passthrough: true,
  },

  // Agent
  agent: {
    usage: [
      'wmux agent spawn --cmd <C> [--label L] [--cwd D] [--pane P] [--workspace W] [--replace-tab]',
      'wmux agent spawn-batch --json \'[...]\' [--strategy distribute|stack|split]',
      'wmux agent status <agentId> | list [--workspace <id>] | kill <agentId>',
    ].join('\n'),
    value: ['--cmd', '--label', '--cwd', '--pane', '--workspace', '--json', '--strategy'],
    bool: ['--replace-tab'],
  },

  // Markdown (--content takes free-form text)
  markdown: {
    usage: [
      'wmux markdown <file>                                   (open a file in a new markdown view)',
      'wmux markdown set <id> --content <text> [--title T]',
      'wmux markdown set <id> --file <path>',
      'wmux markdown get <id>',
    ].join('\n'),
    passthrough: true,
  },

  // Notifications
  notify: { usage: 'wmux notify <text>', passthrough: true },
  'list-notifications': { usage: 'wmux list-notifications' },
  'clear-notifications': { usage: 'wmux clear-notifications [notificationId]' },

  // Sidebar
  'set-status': {
    usage: [
      'wmux set-status --workspace <id> --state <idle|running|interrupted> [--text "<label>"]',
      'wmux set-status <key> <value>                          (legacy positional form)',
    ].join('\n'),
    value: ['--workspace', '--state', '--text'],
  },
  'set-progress': { usage: 'wmux set-progress <value> [--label L]', value: ['--label'] },
  log: { usage: 'wmux log <level> <message>', passthrough: true },
  'sidebar-state': { usage: 'wmux sidebar-state' },

  diff: { usage: 'wmux diff [--file <path>]', value: ['--file'] },
  hook: {
    usage: 'wmux hook --event <type> --tool <name> [--agent <id>]',
    value: ['--event', '--tool', '--agent'],
  },
  'agent-activity': {
    usage: `wmux agent-activity [--tool T] [--skill S] [--done|--active] [--surface <id>]   ${SURFACE_NOTE}`,
    value: ['--tool', '--skill', '--surface'],
    bool: ['--done', '--active'],
  },

  // Declared agent state (issue #128)
  'report-agent': {
    usage: [
      'wmux report-agent --blocked [reason] [--choices <json>] | --unblocked',
      'wmux report-agent --run-start | --run-end | --run-depth <N>',
      `  [--seq N] [--surface <id>]   ${SURFACE_NOTE}`,
    ].join('\n'),
    // --blocked's reason is optional; treating it as value-taking only ever
    // skips one token that a later flag would have re-validated anyway.
    value: ['--blocked', '--reason', '--choices', '--run-depth', '--seq', '--surface'],
    bool: ['--unblocked', '--run-start', '--run-end'],
  },
  'report-metadata': {
    usage: `wmux report-metadata [--model M] [--tokens T] [--context-pct N] [--ttl ms] [--seq N] [--surface <id>]   ${SURFACE_NOTE}`,
    value: ['--model', '--tokens', '--context-pct', '--ttl', '--seq', '--surface'],
  },
  'report-session': {
    usage: `wmux report-session <sessionId> [--seq N] [--surface <id>]   ${SURFACE_NOTE}`,
    value: ['--session', '--seq', '--surface'],
  },
  'answer-agent': {
    usage: 'wmux answer-agent --surface <id> --choice <choiceId>   (reply to ANOTHER pane; no ambient default)',
    value: ['--surface', '--choice'],
  },
  'release-agent': {
    usage: `wmux release-agent [--seq N] [--surface <id>]   ${SURFACE_NOTE}`,
    value: ['--seq', '--surface'],
  },
  'agent-state': {
    usage: 'wmux agent-state [--surface <id>]   (no --surface → every pane, plus the blocked list)',
    value: ['--surface'],
  },
} satisfies Record<string, CommandSpec>;

type CommandName = keyof typeof COMMAND_SPECS;

/**
 * Reject flags the command does not declare, instead of running with defaults.
 *
 * Only `--` flags are judged: single-dash tokens belong to passthrough commands
 * (ssh options) and bare words are positional arguments.
 */
function checkFlags(command: string, args: string[], spec: CommandSpec): void {
  if (spec.passthrough) return;
  const takesValue = new Set(spec.value ?? []);
  const standalone = new Set(spec.bool ?? []);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    if (standalone.has(arg)) continue;
    if (takesValue.has(arg)) {
      // A trailing value flag is the same silent default in a different
      // costume: `getFlag` returns undefined and the command runs anyway.
      // --blocked is the one flag whose value is genuinely optional.
      if (i === args.length - 1 && arg !== '--blocked') {
        fail(command, spec, `Flag '${arg}' needs a value.`);
      }
      i++;
      continue;
    }
    fail(command, spec, `Unknown flag for '${command}': ${arg}`);
  }
}

/** Print why the argv was rejected, then that command's usage, then exit 1. */
function fail(command: string, spec: CommandSpec, message: string): never {
  console.error(message);
  console.error('');
  console.error(spec.usage);
  process.exit(1);
}

/** `wmux help [command]` — the only help route that works for passthrough commands. */
function cmdHelp(args: string[]): void {
  const topic = args[1];
  if (!topic) { printUsage(); return; }
  const spec = (COMMAND_SPECS as Record<string, CommandSpec>)[topic];
  if (!spec) {
    console.error(`Unknown command: ${topic}`);
    printUsage();
    process.exit(1);
  }
  console.log(spec.usage);
}

// Command dispatch table. Each handler receives the raw argv (args[0] is the
// command name). Replaces a single giant switch so each command stays small and
// independently testable. Typed against COMMAND_SPECS so the compiler — not a
// bug report — catches a command that ships without usage text, or usage text
// for a command that no longer exists.
const COMMANDS: Record<CommandName, (args: string[]) => Promise<void> | void> = {
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
  // `rename-surface <id> <title>`, or `rename-surface <title>` from inside a
  // pane (renames the current surface via WMUX_SURFACE_ID).
  'rename-surface': async (args) => {
    let id = args[1];
    let title = args[2];
    if (title === undefined && process.env.WMUX_SURFACE_ID) {
      title = id;
      id = process.env.WMUX_SURFACE_ID;
    }
    print(await sendV2('surface.rename', { id, title }));
  },
  'focus-surface': async (args) => print(await sendV2('surface.focus', { id: args[1] })),
  'list-surfaces': async (args) => print(await sendV2('surface.list', {
    paneId: getFlag(args, '--pane'),
    workspaceId: getFlag(args, '--workspace'),
  })),
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
  // Community translations (~/.wmux/locales/*.json)
  locales: cmdLocales,

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
  // `--workspace` used to be parsed by nobody: the flag was accepted on the
  // command line and silently dropped here, so every call reported the ACTIVE
  // workspace's tree whatever id you passed (issue #141).
  tree: async (args) => print(await sendV2('system.tree', { workspaceId: getFlag(args, '--workspace') })),

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
  ...AGENT_STATE_COMMANDS,
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

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    cmdHelp(command === 'help' ? args : []);
    process.exit(0);
  }

  const handler = COMMANDS[command as CommandName];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  // Usage and flag checks both happen before a single byte reaches the pipe, so
  // probing the CLI can no longer mutate the user's layout (issue #143).
  const spec: CommandSpec = COMMAND_SPECS[command as CommandName];
  if (!spec.passthrough && (args.includes('--help') || args.includes('-h'))) {
    console.log(spec.usage);
    process.exit(0);
  }
  checkFlags(command, args, spec);

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
            rename-surface [surfaceId] <title>   (renames the current surface when run inside a pane)
            set-color-scheme [surfaceId] <scheme>, clear-color-scheme [surfaceId], list-themes
Pane:       split [--down] [--type T] [--color-scheme NAME], close-pane, focus-pane, zoom-pane, list-panes, tree
            pane new|close|focus|list   (verb form, mirrors issue #4 example)
Layout:     layout grid --count <N> [--type terminal] [--anchor-surface <id>]
Terminal:   send <text>, send-key <key>, read-screen [--lines N] [--surface <id>], trigger-flash
Browser:    browser open|snapshot|click|type|fill|screenshot|get-text|eval|wait|back|forward|reload
Agent:      agent spawn [--cmd C] [--label L] [--cwd D] [--pane P] [--replace-tab] | spawn-batch|status|list|kill
Markdown:   markdown <file>   (open a file in a new markdown view)
            markdown set <id> --content <text> | --file <path>
Diff:       diff [--file <path>]
Notify:     notify <text>, list-notifications, clear-notifications
Sidebar:    set-status, set-progress, log, sidebar-state
Hook:       hook --event <type> --tool <name> [--agent <id>]
Agent state: report-agent --blocked [reason] [--choices <json>] | --unblocked
            report-agent --run-start | --run-end
            answer-agent --surface <id> --choice <id>   # reply without leaving your pane
                          [--run-depth N] [--seq N] [--surface <id>]
            report-metadata [--model M] [--tokens T] [--context-pct N] [--ttl ms]
            report-session <id> | release-agent | agent-state [--surface <id>]
            (surface defaults to $WMUX_SURFACE_ID — an agent in a pane needs no id)
Config:     config show|reload|path   (edits ~/.wmux/config.toml — see docs)
            reload-config             (shorthand for 'config reload')
Locales:    locales [list|reload|path] (community UI translations in ~/.wmux/locales)

Help:       wmux help <command>       (per-command usage; works for every command)
            wmux <command> --help     (same, except for free-form commands such as
                                       send / notify / log / ssh / browser / markdown,
                                       where --help is part of the text you are sending)
`);
}

main();
