#!/usr/bin/env node

import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { Duplex } from 'stream';
import {
  chooseBridgeHost,
  isWsl2,
  parseNetworkingMode,
  type WslEnvironment,
} from './wsl-network';
import {
  DEFAULT_V2_TIMEOUT_MS,
  transportDeadline,
  usesNpiperelay as usesNpiperelayFor,
  type Transport,
} from './transport-deadline';

/** The two signals wsl-network.ts uses to decide we are inside a WSL distro. */
function readWslEnvironment(): WslEnvironment {
  let osRelease: string | null = null;
  try {
    osRelease = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf-8');
  } catch {
    // Not Linux, or a kernel that does not expose it — either way, not WSL.
  }
  return {
    osRelease,
    hasInteropEnv: !!(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME),
  };
}

/**
 * `wslinfo --networking-mode`, or null if it cannot answer. Absent before WSL
 * 2.0.5, so a null here is ordinary rather than exceptional; parseNetworkingMode
 * turns it into `unknown` and the caller refuses to guess from there.
 */
function readWslNetworkingMode(): string | null {
  try {
    // Absolute: only ever reached from inside a WSL 2 distro, where wslinfo is
    // a distro binary at a fixed location. Resolving it through PATH would let
    // anything earlier on a user-writable PATH answer a question we then use to
    // decide what address the bridge binds.
    const probe = spawnSync('/usr/bin/wslinfo', ['--networking-mode'], { encoding: 'utf-8', timeout: 5000 });
    if (probe.error || probe.status !== 0) return null;
    return probe.stdout;
  } catch {
    return null;
  }
}

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

// How long `wmux bridge` lets a relay keep draining after its client socket has
// closed, before forcing teardown. Must exceed the pipe round-trip, or the frame
// a write-then-close client just sent is discarded mid-flight. Measured worst
// case inside a devcontainer on a corporate-managed Windows host is ~7s (a fresh
// npiperelay.exe is spawned per connection over WSL interop, and AV/EDR scans it
// on every exec), so the default leaves generous headroom. The relay normally
// exits on its own well before this — the timer is only the backstop.
const BRIDGE_DRAIN_GRACE_MS = parseInt(process.env.WMUX_BRIDGE_DRAIN_MS || '', 10) || 15000;

// How many npiperelay relays `wmux bridge` keeps spawned and attached to the pipe
// ahead of demand (see the pool in cmdBridge). 0 disables pre-warming and restores
// spawn-per-connection. Only ever used on the npiperelay path — the Unix-socket and
// native-pipe transports connect instantly and have nothing to pre-warm.
const BRIDGE_WARM_RELAYS = (() => {
  const raw = process.env.WMUX_BRIDGE_WARM?.trim();
  if (!raw) return 2;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();

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

// ─── WSL2 transport: reach the Windows \\.\pipe\wmux from inside WSL2 ─────────
//
// A wmux CLI (or `wmux bridge`) running inside WSL2 needs to talk to the wmux
// process on the Windows host over the \\.\pipe\wmux named pipe. AF_VSOCK,
// TCP-over-gateway and cross-boundary Unix sockets were all evaluated and
// rejected (HCS-managed WSL2 UVMs ignore GuestCommunicationServices; gateway
// IPs/firewall policy are unreliable on corporate networks; 9P does not forward
// AF_UNIX). The chosen mechanism is npiperelay.exe:
//
//   npiperelay.exe is a tiny (~2MB) open-source Windows binary that forwards a
//   named pipe to its own stdin/stdout. WSL2 executes Windows binaries via
//   interop, so from inside WSL2 we spawn it and use its stdio as the transport
//   duplex — zero pre-setup, no socat needed. Install it (SHA-256 pinned) with
//   scripts/install-npiperelay.sh; see docs/DEVCONTAINER.md for the full setup.
//   Source: https://github.com/albertony/npiperelay (MIT, fork of jstarks/npiperelay)
//   Pinned version: v1.11.4  SHA-256: cea82cf5c9c22a28bef8075750acb7958f766393baebff4597cf21442f71c4b3
//
//   Transport selection order:
//     0. remoteTarget set (--remote / WMUX_REMOTE) → TCP (the devcontainer path,
//        served by a `wmux bridge` reachable at host.docker.internal:9787)
//     1. WMUX_PIPE starts with '/' → use as a Unix socket path
//     2. WSL_DISTRO_NAME / WSLENV set → spawn npiperelay.exe automatically
//     3. native Windows → connect directly to the named pipe
// ─────────────────────────────────────────────────────────────────────────────
function connectTransport(onConnect: () => void): net.Socket | Duplex {
  if (remoteTarget) return net.connect({ host: remoteTarget.host, port: remoteTarget.port }, onConnect);
  if (PIPE_PATH.startsWith('/')) return net.connect({ path: PIPE_PATH }, onConnect);
  if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) return connectViaNpiperelay(PIPE_PATH, onConnect);
  return net.connect({ path: PIPE_PATH }, onConnect);
}

// Mirrors the selection order above: true when connectTransport() will take the
// npiperelay branch. That is the only transport whose setup costs anything worth
// pre-warming — a Unix socket or a native named pipe connects in microseconds.
/**
 * This process's transport, as transport-deadline.ts wants it described.
 *
 * A function rather than a constant: `remoteTarget` is set while parsing argv,
 * after module load.
 */
function currentTransport(): Transport {
  return { remote: !!remoteTarget, pipePath: PIPE_PATH, env: process.env };
}

function usesNpiperelay(): boolean {
  return usesNpiperelayFor(currentTransport());
}

// Search common installation locations for npiperelay.exe.
function findNpiperelay(): string | null {
  const readable = (p: string): boolean => {
    try {
      fs.accessSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const binPaths = (process.env.PATH || process.env.Path || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(d, 'npiperelay.exe'));
  const fromPath = binPaths.find(readable);
  if (fromPath) return fromPath;
  return (
    [
      path.join(os.homedir(), '.local', 'bin', 'npiperelay.exe'),
      '/usr/local/bin/npiperelay.exe',
      '/usr/bin/npiperelay.exe',
    ].find(readable) ?? null
  );
}

// Spawn npiperelay.exe and expose its stdin/stdout as a Duplex stream.
function connectViaNpiperelay(pipePath: string, onConnect: () => void): Duplex {
  const bin = findNpiperelay();
  if (!bin) {
    console.error('wmux: npiperelay.exe not found.');
    console.error('  Install it with scripts/install-npiperelay.sh, or fetch it from:');
    console.error('  https://github.com/albertony/npiperelay/releases/latest');
    process.exit(1);
  }
  // npiperelay names the pipe with forward slashes: \\.\pipe\wmux → //./pipe/wmux
  const child = spawn(bin, ['-ei', '-s', pipePath.replace(/\\/g, '/')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const duplex = new Duplex({
    read() {},
    write(chunk, enc, cb) {
      if (!child.stdin?.writable) {
        cb(new Error('npiperelay stdin closed'));
        return;
      }
      child.stdin.write(chunk, enc, cb);
    },
    final(cb) {
      child.stdin?.end();
      cb();
    },
    // Kills the relay, discarding anything still buffered in its stdin. Callers
    // must only reach here on error or after the stream has drained — see the
    // teardown in cmdBridge.
    destroy(err, cb) {
      child.kill();
      cb(err);
    },
    allowHalfOpen: true,
  });
  child.stdout?.on('data', (chunk: Buffer) => duplex.push(chunk));
  child.stdout?.on('end', () => duplex.push(null));
  child.on('error', (err: Error) => duplex.destroy(err));
  child.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) duplex.destroy(new Error(`npiperelay exited with code ${code}`));
  });
  // "Ready" here means the relay process exists — NOT that it has attached to the
  // named pipe, which over WSL interop can take seconds longer. onConnect must
  // still fire now regardless: callers write their request from inside it, and the
  // Duplex buffers those bytes until the pipe is live. (Deferring it until the
  // first byte comes back would deadlock — nothing would ever be written.)
  //
  // The cost is that a caller's deadline starts before the pipe is up, so it has
  // to cover the attach latency too — that is what SLOW_TRANSPORT_FLOOR_MS is for.
  process.nextTick(onConnect);
  return duplex;
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
    const timer = setTimeout(() => { client.end(); resolve(data.trim()); }, deadline(5000));
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

/**
 * How long to wait for a V2 reply before giving up. Only the browser verbs
 * currently need more than this — see BROWSER_CMDS. The reasoning behind the
 * number, and behind the floor that raises it on a slow transport, lives with
 * it in transport-deadline.ts.
 */

/** `base`, raised to the slow-transport floor when the transport is a slow one. */
function deadline(base: number): number {
  return transportDeadline(base, currentTransport());
}

/**
 * What a stalled request says when it gives up.
 *
 * The bare 'timeout' this used to reject with named neither the method nor the
 * deadline, so an operation that was merely slow was indistinguishable from a
 * broken install — and since the deadline was also shorter than the server's own
 * budget, it was usually the *only* thing a slow browser command ever printed.
 */
export function timeoutMessage(method: string, timeoutMs: number): string {
  return `${method} timed out after ${timeoutMs}ms — wmux accepted the request but sent no reply. The command may still have completed.`;
}

function sendV2(
  method: string,
  params: Record<string, any> = {},
  timeoutMs: number = DEFAULT_V2_TIMEOUT_MS,
): Promise<any> {
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
    const deadlineMs = deadline(timeoutMs);
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(timeoutMessage(method, deadlineMs)));
    }, deadlineMs);
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

/**
 * Server-side budgets a browser command can legitimately spend before it is even
 * able to reply. Mirrored from the main process so the CLI can outwait it:
 *
 *   BROWSER_READY_MS   v2-browser.ts readies a browser first — it splits a pane
 *                      and then polls up to 5s for CDP to attach.
 *   CDP_NAVIGATE_MS    cdp-bridge.ts navigate() waits for did-finish-load.
 *   CDP_WAIT_MS        cdp-bridge.ts wait() polls for a ref.
 *
 * Both cdp-bridge budgets already exceeded the old flat 5s CLI deadline on their
 * own, so `browser open` on any slow page and `browser wait` on any absent ref
 * could not report anything but 'timeout' — including when they went on to
 * succeed. Keep these in step if the main-process defaults change.
 */
const BROWSER_READY_MS = 5000;
const CDP_NAVIGATE_MS = 30000;
const CDP_WAIT_MS = 10000;
/** Pane split plus the executeJavaScript round-trips around it. */
const BROWSER_SLACK_MS = 5000;

/** The CLI deadline for a browser verb whose own server-side budget is `verbMs`. */
const browserDeadline = (verbMs: number): number => BROWSER_READY_MS + verbMs + BROWSER_SLACK_MS;

export interface BrowserRequest {
  method: string;
  params: Record<string, any>;
  timeoutMs: number;
}

// Each browser subcommand maps to the V2 request it issues.
const BROWSER_CMDS: Record<string, (args: string[]) => BrowserRequest> = {
  open: (args) => ({
    method: 'browser.navigate',
    params: { url: args[2] },
    timeoutMs: browserDeadline(CDP_NAVIGATE_MS),
  }),
  snapshot: () => ({ method: 'browser.snapshot', params: {}, timeoutMs: browserDeadline(0) }),
  click: (args) => ({ method: 'browser.click', params: { ref: args[2] }, timeoutMs: browserDeadline(0) }),
  type: (args) => ({
    method: 'browser.type',
    params: { ref: args[2], text: args.slice(3).join(' ') },
    timeoutMs: browserDeadline(0),
  }),
  fill: (args) => ({
    method: 'browser.fill',
    params: { ref: args[2], value: args.slice(3).join(' ') },
    timeoutMs: browserDeadline(0),
  }),
  screenshot: (args) => ({
    method: 'browser.screenshot',
    params: { fullPage: args.includes('--full') },
    timeoutMs: browserDeadline(0),
  }),
  'get-text': (args) => ({ method: 'browser.get_text', params: { ref: args[2] }, timeoutMs: browserDeadline(0) }),
  eval: (args) => ({ method: 'browser.eval', params: { js: args.slice(2).join(' ') }, timeoutMs: browserDeadline(0) }),
  wait: (args) => {
    const explicit = parseInt(args[3]) || undefined;
    return {
      method: 'browser.wait',
      params: { ref: args[2], timeout: explicit },
      // An explicit ms is the budget the server will honour; outwait that one.
      timeoutMs: browserDeadline(explicit ?? CDP_WAIT_MS),
    };
  },
  back: () => ({ method: 'browser.back', params: {}, timeoutMs: browserDeadline(0) }),
  forward: () => ({ method: 'browser.forward', params: {}, timeoutMs: browserDeadline(0) }),
  reload: () => ({ method: 'browser.reload', params: {}, timeoutMs: browserDeadline(0) }),
  // `wmux browser engine [web|agent]` — get or flip which engine a browser
  // surface runs on. Unlike every verb above, this is two distinct V2 methods
  // (get vs set) rather than one passthrough shape, and the value is validated
  // HERE rather than left to the server: rejecting a typo before a single byte
  // reaches the pipe matches `checkFlags`'s reasoning elsewhere in this file
  // (issue #143) and names both valid values in one place instead of two.
  // `--surface`/`$WMUX_SURFACE_ID` reaches this like any other browser verb —
  // via `caller`, merged in by `browserRequest` below — so the routing
  // subtlety (a terminal surface is not a browser surface) is main's problem
  // to resolve, not the CLI's; see `resolveCallerBrowserSurface` in index.ts.
  engine: (args) => {
    const value = args[2];
    if (value === undefined) {
      return { method: 'browser.get_engine', params: {}, timeoutMs: browserDeadline(0) };
    }
    if (value !== 'web' && value !== 'agent') {
      throw new Error(`wmux browser engine: engine must be "web" or "agent" (got "${value}")`);
    }
    return { method: 'browser.set_engine', params: { engine: value }, timeoutMs: browserDeadline(0) };
  },
};

/**
 * Resolve `wmux browser <verb> …` to the request it issues. Null for an unknown
 * verb. Pure, so the deadlines and the caller wiring are testable without a
 * running app.
 *
 * `caller` is the *terminal* surface the command is issued on behalf of, not a
 * browser surface: the main process maps it to that pane's own browser, which is
 * what keeps concurrent agents isolated (issue #62). Passing it explicitly does
 * not change that routing — it only supplies from a flag what a shell inside a
 * pane supplies from $WMUX_SURFACE_ID.
 */
export function browserRequest(args: string[], caller?: string): BrowserRequest | null {
  const build = BROWSER_CMDS[args[1]];
  if (!build) return null;
  const req = build(args);
  return caller ? { ...req, params: { ...req.params, caller } } : req;
}

/**
 * What a group command says when its subcommand is missing or unknown.
 *
 * `browser`, `agent`, `pane` and `layout` all dispatched on `args[1]` and
 * interpolated it into the error unchecked, so a bare `wmux browser` — the
 * natural thing to type when you want to know the verbs — answered
 * `Unknown browser command: undefined` (issue #156). That reads like the CLI
 * malfunctioned rather than like a usage error, and it was a dead end: nothing
 * in it pointed at `wmux help browser`, and `wmux browser --help` cannot fill
 * the gap because browser is passthrough (`--help` is text to send, not a
 * request for usage). `markdown` and `config` already printed usage here.
 */
export function subcommandError(command: string, sub: string | undefined): string {
  return sub === undefined || sub === ''
    ? `wmux ${command} needs a subcommand.`
    : `Unknown ${command} subcommand: ${sub}`;
}

/** Print why the subcommand was rejected, then that group's usage, then exit 1. */
function failSubcommand(command: CommandName, sub: string | undefined): never {
  return fail(command, COMMAND_SPECS[command] as CommandSpec, subcommandError(command, sub));
}

async function cmdBrowser(args: string[]): Promise<void> {
  // --surface says which pane's browser to drive, mirroring send / read-screen /
  // agent-activity. Strip it before the verb reads its positional args, or
  // `browser type e5 --surface surf-x hi` would type the flag into the page.
  const caller = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
  const rest = stripFlag(args, '--surface');
  const req = browserRequest(rest, caller);
  if (!req) failSubcommand('browser', rest[1]);
  print(await sendV2(req.method, req.params, req.timeoutMs));
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
  if (!handler) failSubcommand('agent', args[1]);
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
    failSubcommand('pane', sub);
  }
}

async function cmdConfig(args: string[]): Promise<void> {
  const sub = args[1];
  if (sub === 'show' || sub === 'get') {
    print(await sendV2('config.get'));
  } else if (sub === 'reload') {
    print(await sendV2('config.reload'));
  } else if (sub === 'path') {
    // Ask the instance rather than reconstructing the path here. The config lives
    // on the Windows host, but this CLI routinely runs somewhere that cannot name
    // it: inside WSL, or inside a devcontainer reaching wmux over the TCP bridge.
    // There $HOME is the Linux home and the old `${home}\.wmux\config.toml` form
    // produced `/home/vscode\.wmux\config.toml` — neither the file wmux reads nor
    // a well-formed path on either OS. loadUserConfig() already reports the real
    // one in `path` (user-config.ts), which config.get returns verbatim.
    try {
      const cfg = await sendV2('config.get');
      if (cfg && typeof cfg.path === 'string') {
        console.log(cfg.path);
        return;
      }
    } catch {
      // No reachable instance — fall through to a local guess. path.join at least
      // keeps it self-consistent with whichever filesystem we are actually on.
    }
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const fallbackPath = home.includes('/') && !home.includes('\\')
      ? path.posix.join(home, '.wmux', 'config.toml')
      : path.join(home, '.wmux', 'config.toml');
    console.log(fallbackPath);
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
    // No locales equivalent of config.get to ask, so this stays a guess — but a
    // guess spelled for the filesystem the CLI is on. $HOME first: under WSL both
    // are set, and USERPROFILE is the Windows one leaking in over interop.
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const fallbackPath = home.includes('/') && !home.includes('\\')
      ? path.posix.join(home, '.wmux', 'locales')
      : path.join(home, '.wmux', 'locales');
    console.log(fallbackPath);
  } else {
    console.error('Usage: wmux locales [list|reload|path]'); process.exit(1);
  }
}

async function cmdLayout(args: string[]): Promise<void> {
  if (args[1] !== 'grid') failSubcommand('layout', args[1]);
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

/**
 * The workspace this shell lives in. An agent knows its own surface
 * (`WMUX_SURFACE_ID`), but nothing maps that back to a workspace:
 * `list-workspaces`' `isActive` reports the FOCUSED workspace, which is the
 * right answer for a UI query and a different question from "the pane I'm in".
 * `--surface <id>` asks on another pane's behalf. A surface that resolves to
 * nothing is an error, not a guess.
 */
async function cmdCurrentWorkspace(args: string[]): Promise<void> {
  const surface = getFlag(args, '--surface');
  print(await sendV2('workspace.current', surface ? { caller: surface } : {}));
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
  // --wsl binds 0.0.0.0 so a container on the Windows host can reach a bridge
  // running inside WSL2 (issue #19). Under NAT — WSL2's default — the distro has
  // its own network namespace, so that address is an eth0 on a private 172.x the
  // container resolves as host.docker.internal, and 127.0.0.1 inside the distro
  // is not it. Under mirrored networking the distro shares the Windows host's
  // interfaces instead and 0.0.0.0 is the LAN, so the mode is read at runtime
  // rather than assumed; see wsl-network.ts for the full reasoning. The pipe
  // token authenticates every request end to end either way.
  const wslMode = args.includes('--wsl');
  const wslEnv = readWslEnvironment();
  const inWsl2 = isWsl2(wslEnv);
  const decision = chooseBridgeHost({
    explicitHost: getFlag(args, '--host'),
    wslMode,
    inWsl2,
    mode: inWsl2 ? parseNetworkingMode(readWslNetworkingMode()) : 'unknown',
    port,
  });
  if (decision.host === null) {
    console.error(`wmux bridge: ${decision.error}`);
    process.exit(1);
  }
  const host = decision.host;
  for (const line of decision.notices) console.warn(line);

  // ── Warm relay pool ─────────────────────────────────────────────────────────
  // Spawn-per-connection made every request pay the relay's whole startup: a fresh
  // npiperelay.exe launched over WSL interop (AV/EDR scans the binary on each exec
  // on a corporate-managed host) and then the pipe dial. Measured worst case from a
  // devcontainer is ~7s — on every hook. Keeping relays open ahead of demand moves
  // that cost off the request path: a warm relay has already spawned AND attached
  // by the time a client arrives, so hand-off is just pipe().
  //
  // Deliberately a POOL of exclusive relays, not one shared relay multiplexed
  // across clients. Multiplexing would force the bridge to parse frames and rewrite
  // JSON-RPC ids to route replies back to the right socket, which:
  //   * breaks V1 entirely — `pong` / `ok` / `unauthorized` carry no id to route on;
  //   * makes every client a casualty when the single relay dies;
  //   * costs the bridge its one real virtue, being a transparent byte pipe (any
  //     future streaming or server-pushed method would have to be taught to it).
  // Pooling buys the same latency win and the bridge stays dumb.
  //
  // Only on the npiperelay path — elsewhere this would hold idle sockets open to
  // buy nothing.
  const warmSize = usesNpiperelay() ? BRIDGE_WARM_RELAYS : 0;
  const warm: Array<{ stream: net.Socket | Duplex; claim: () => void }> = [];
  let warmFailures = 0;
  let refillTimer: NodeJS.Timeout | null = null;

  const scheduleRefill = (delayMs: number): void => {
    if (refillTimer || warm.length >= warmSize) return;
    refillTimer = setTimeout(() => {
      refillTimer = null;
      fillWarm();
    }, delayMs);
    refillTimer.unref();
  };

  function fillWarm(): void {
    while (warm.length < warmSize) {
      const stream = connectTransport(() => {});
      const entry = { stream, claim: () => {} };
      // Dying before being claimed means the upstream isn't there — wmux not
      // running, or the pipe gone. npiperelay exits immediately in that case, so
      // without a backoff the bridge would respawn a Windows process in a tight
      // loop for as long as wmux stays down.
      const onDead = (): void => {
        const i = warm.indexOf(entry);
        if (i === -1) return; // already claimed — the client's teardown owns it now
        warm.splice(i, 1);
        warmFailures = Math.min(warmFailures + 1, 6);
        scheduleRefill(Math.min(30000, 500 * 2 ** warmFailures));
      };
      entry.claim = () => {
        stream.off('error', onDead);
        stream.off('close', onDead);
      };
      stream.on('error', onDead);
      stream.on('close', onDead);
      warm.push(entry);
    }
  }

  // An idle relay reads nothing, so anything the upstream sent while it waited stays
  // buffered in the stream and is delivered the moment the client pipes it — no need
  // to drain before hand-off.
  const takeWarm = (): net.Socket | Duplex | null => {
    while (warm.length) {
      const entry = warm.pop()!;
      entry.claim();
      // wmux may have restarted since this relay attached.
      if (!entry.stream.destroyed && entry.stream.writable) {
        warmFailures = 0;
        return entry.stream;
      }
      entry.stream.destroy();
    }
    return null;
  };

  const server = net.createServer((sock) => {
    // Connect to the local wmux through the same selector the CLI uses. In the
    // bridge process remoteTarget is always null, so this resolves to a Unix
    // socket, npiperelay (inside WSL2), or the named pipe directly — which is
    // what lets `wmux bridge` run inside WSL2 and still reach the Windows pipe.
    // A warm relay is the same thing, already connected.
    const pipe = takeWarm() ?? connectTransport(() => {});
    // Replace what we just consumed so the next client is served warm too.
    scheduleRefill(0);
    sock.pipe(pipe);
    pipe.pipe(sock);

    // Teardown is half-close-aware on purpose. Destroying BOTH sides on either
    // 'close' silently ate hook events: wmux-hook.js writes its frame and end()s
    // immediately, and over npiperelay the Duplex's destroy() is child.kill() —
    // so the relay died with the frame still buffered in its stdin and never
    // forwarded it. Clients that write-then-close are the normal case here
    // (every Claude Code hook is one), not an abort.
    //
    // 'end' (peer finished sending) therefore FLUSHES rather than destroys: end()
    // the other side so its buffered bytes drain and the pipe sees a clean EOF.
    // destroy() is reserved for 'error', where there is nothing left to save.
    let done = false;
    const destroyBoth = (): void => {
      if (done) return;
      done = true;
      sock.destroy();
      pipe.destroy();
    };
    // A closed socket can no longer drain anything, so 'close' still tears down —
    // but only after a grace period, giving an in-flight relay time to finish
    // forwarding what it already holds.
    const closeAfterDrain = (): void => {
      if (done) return;
      setTimeout(destroyBoth, BRIDGE_DRAIN_GRACE_MS).unref();
    };

    sock.on('error', destroyBoth);
    pipe.on('error', destroyBoth);
    sock.on('end', () => { pipe.end(); });
    pipe.on('end', () => { sock.end(); });
    sock.on('close', closeAfterDrain);
    pipe.on('close', closeAfterDrain);
  });
  server.on('error', (err) => { console.error(`bridge error: ${err.message}`); process.exit(1); });

  // Warm relays hold a live pipe connection (and an npiperelay.exe) for as long as
  // the bridge runs, so retire them on the way out rather than orphaning them.
  const shutdown = (): void => {
    if (refillTimer) clearTimeout(refillTimer);
    warm.splice(0).forEach((e) => { e.claim(); e.stream.destroy(); });
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  server.listen(port, host, () => {
    console.log(`wmux bridge listening on ${host}:${port} ↔ ${PIPE_PATH}`);
    if (warmSize > 0) {
      fillWarm();
      console.log(`Keeping ${warmSize} npiperelay relay(s) warm (WMUX_BRIDGE_WARM=0 to disable).`);
    }
    if (wslMode) {
      console.log('WSL2 mode. From a container on this host:');
      console.log(`  WMUX_REMOTE=host.docker.internal:${port}`);
      console.log("  WMUX_REMOTE_TOKEN=<run 'wmux token' here>");
    } else {
      console.log('From another machine:');
      console.log(`  ssh -L ${port}:127.0.0.1:${port} <user>@<this-host>`);
      console.log(`  wmux --remote 127.0.0.1:${port} --token <run 'wmux token' here> list-workspaces`);
    }
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

/** One prompt line: `#<seq>  <hh:mm>  <summary>`. */
function promptLine(entry: any): string {
  const at = new Date(Number(entry?.at) || 0);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const tag = `#${entry?.seq ?? '?'}`.padEnd(4);
  // `summary` is empty by design until the boundary knows the text — a shell
  // entry between its B and C marks, or an agent hook that carried no payload.
  // Say so rather than printing a line that trails off into nothing.
  return `${tag}  ${hh}:${mm}  ${entry?.summary || '(no text yet)'}`;
}

/**
 * What an empty list means, said out loud.
 *
 * There is nothing to print in this case, so the line IS the whole answer, and
 * "No prompts recorded" was the same answer to two different questions: a log
 * that is switched off records nothing by design, and telling the user to wait
 * for prompts that can never arrive is the one unhelpful thing this command
 * could do. (The third case — an id that names no surface — never reaches here:
 * the server rejects it and `main` prints `Error: ...` and exits 1.)
 */
export function emptyPromptNote(enabled: boolean, scope: string): string {
  return enabled
    ? `No prompts recorded${scope}`
    : `The prompt log is off (Settings → Prompts), so nothing is being recorded${scope}.`;
}

/**
 * Say when the reply was capped.
 *
 * The untargeted form now defaults to a per-pane cap (the server picks it, and
 * echoes it back rather than making the CLI hardcode a second copy of the
 * number), so silence here would read as "that is all there is" for a pane that
 * has ten times more.
 */
export function promptTruncationNote(result: any, perSurface: boolean): string | null {
  if (!result?.truncated) return null;
  const cap = Number(result?.limit);
  const scope = perSurface && Number.isFinite(cap) ? ` (${cap} per pane)` : '';
  return `… older prompts omitted${scope} — raise it with --limit N`;
}

function printPromptTruncation(result: any, perSurface: boolean): void {
  const note = promptTruncationNote(result, perSurface);
  if (note) console.log(note);
}

/** The targeted form: one pane's prompts, oldest first. */
function printSurfacePrompts(surfaceId: string, result: any): void {
  const prompts: any[] = result?.prompts ?? [];
  if (prompts.length === 0) { console.log(emptyPromptNote(result?.enabled !== false, ` for ${surfaceId}`)); return; }
  for (const entry of prompts) console.log(promptLine(entry));
  printPromptTruncation(result, false);
}

/** The untargeted form: every tracked pane, its id as a heading. */
function printAllPrompts(result: any): void {
  const surfaces: Record<string, any[]> = result?.surfaces ?? {};
  const ids = Object.keys(surfaces);
  if (ids.length === 0) { console.log(emptyPromptNote(result?.enabled !== false, '')); return; }
  for (const id of ids) {
    console.log(id);
    for (const entry of surfaces[id]) console.log(`  ${promptLine(entry)}`);
  }
  printPromptTruncation(result, true);
}

/**
 * What has this pane been asked to do? (issue #207)
 *
 * The prompt log is the one thing `read-screen` cannot recover: an agent TUI
 * repaints over its own scrollback, so by the time anyone asks, the prompt text
 * is no longer on screen to be read. Defaults to $WMUX_SURFACE_ID like send and
 * read-screen, so an agent inside a pane needs no id; run outside a pane with no
 * --surface it reports every tracked pane, which is the only useful answer there.
 *
 * Human output is one line per prompt because that is what makes it skimmable;
 * --json is the scripting contract and carries the fields the line drops — the
 * full text, the source, and the buffer `line` (null when not jumpable).
 *
 * --json prints the WHOLE reply, not just the entries, for the same reason the
 * human form grew two extra lines: `enabled` and `truncated` are the difference
 * between "nothing yet", "this feature is off" and "there is more than this",
 * and a script that only ever saw the array had to guess between them. An
 * unrecognised surface is not in the reply at all — the server rejects it, and
 * `main` turns that into `Error: ...` and a non-zero exit, which is what every
 * other command does with a bad id.
 */
async function cmdPrompts(args: string[]): Promise<void> {
  const surfaceId = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
  const rawLimit = getFlag(args, '--limit');
  const limit = rawLimit === undefined ? 0 : Number(rawLimit);
  if (rawLimit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error('prompts: --limit must be a positive integer');
    process.exit(1);
  }
  const result = await sendV2('surface.list_prompts', {
    ...(surfaceId ? { surfaceId } : {}),
    ...(limit ? { limit } : {}),
  });
  if (args.includes('--json')) { print(result); return; }
  if (surfaceId) printSurfacePrompts(surfaceId, result);
  else printAllPrompts(result);
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

/**
 * V1 passthrough for the shell integration (issue #19: devcontainer support).
 *
 * wmux-bash-integration.sh writes its state lines straight to the local pipe
 * when it can reach one. Inside a devcontainer it can't, so it calls
 * `wmux raw-v1` instead and gets the CLI's transport — including TCP via
 * --remote / WMUX_REMOTE to a `wmux bridge` (issue #78) — without the CLI
 * growing a near-identical wrapper per verb. Auth is unchanged: sendV1 still
 * prefixes `auth <token>`.
 *
 * Restricted to the verbs the integration actually emits. A generic passthrough
 * would make this a permanent side door into V1: every future V1 command becomes
 * reachable from a container the day it is added, with no review of whether that
 * was intended, and the pipe's V1 surface stops being something the V1 handler
 * alone defines. Nothing is lost by naming them — the set is short, and a real
 * new caller wants a real CLI command anyway.
 */
export const RAW_V1_VERBS = [
  'report_pwd',
  'report_git_branch',
  'clear_git_branch',
  'report_shell_state',
  'ports_kick',
  'report_startup_command',
  // The command line a pane just ran, so wmux can tell it has ssh'd somewhere
  // and upload a pasted file to that host instead of typing a local path.
  'report_command',
] as const;

export function rawV1Error(verb: string | undefined): string | null {
  if (!verb) return 'Usage: wmux raw-v1 <command> [surfaceId] [args...]';
  if ((RAW_V1_VERBS as readonly string[]).includes(verb)) return null;
  return `raw-v1: ${verb} is not a passthrough command. Accepted: ${RAW_V1_VERBS.join(', ')}`;
}

/**
 * Split a `raw-v1` argv into the V1 line to send and the verb to check.
 *
 * The two callers disagree about argv, and both are legitimate. A hand-typed
 * call splits naturally — `wmux raw-v1 report_pwd surf-1 /tmp` — but
 * wmux-bash-integration.sh builds the line as a single string and passes it
 * quoted: `wmux raw-v1 "report_pwd $surface_id $(pwd)"`. There the whole line
 * is args[1].
 *
 * Checking args[1] against the allowlist therefore rejected every report the
 * shell integration ever sent: "report_pwd surf-1 /tmp" is not in RAW_V1_VERBS,
 * so the CLI exited 1 before sendV1 was reached. Nothing reached the wire, and
 * because the integration fires into `>/dev/null 2>&1 &` there was no symptom
 * beyond a sidebar that never showed a cwd or a branch.
 *
 * Taking the first whitespace token is not a loosening — it is what the server
 * already does. pipe-server.ts handleV1() parses the command as the first token
 * of the line, so this makes the allowlist agree with the parser it guards
 * rather than with one caller's argv habits.
 */
export function rawV1Parse(args: string[]): { line: string; verb: string } {
  const line = args.slice(1).join(' ');
  return { line, verb: line.trim().split(/\s+/)[0] ?? '' };
}

async function cmdRawV1(args: string[]): Promise<void> {
  const { line, verb } = rawV1Parse(args);
  const problem = rawV1Error(verb);
  if (problem) { console.error(problem); process.exit(1); }
  console.log(await sendV1(line));
}

// ─── Crash reports (issue #174) ──────────────────────────────────────────────
//
// "wmux crashed, here's a dump" is a request a maintainer makes casually and a
// user answers casually. On Windows a minidump carries the process ENVIRONMENT
// BLOCK, and wmux's users are by construction developers who keep credentials
// in the environment so the shells wmux spawns can see them. The reporter who
// raised this checked eight dumps before uploading; every one held live
// credentials, the worst eleven of them.
//
// So this command exists to make the safe answer the easy one. Everything the
// maintainer actually needed in #150 — same-signature or new — is in the
// Windows Event Log line, which carries no memory at all. Asking for a warning
// and still making the dump the path of least resistance would change nothing.
//
// It deliberately runs with no wmux instance: the moment you want it is after
// the process died.

/** Fields of an `Application Error` record — the crash fingerprint, no memory. */
export interface CrashEventFields {
  time: string;
  version: string;
  faultingModule: string;
  exceptionCode: string;
  faultOffset: string;
  additionalParameter: string;
}

/**
 * Fold the two records Windows writes for one crash into a single fingerprint.
 *
 * ## Why not parse the rendered message
 *
 * Because it is localised. On a French Windows the label is "Nom du module
 * défaillant", and an English-only regex quietly reports "(not found)" for
 * every field — the exact failure mode where a diagnostic looks like it ran.
 * Reading the event's positional `Properties` (the raw insertion strings) is
 * language-independent, and it also means the executable and module PATHS are
 * never read at all rather than stripped afterwards. Those carry the home
 * directory, and on a work machine the Windows username is usually a real name.
 *
 * ## Why two records
 *
 * `Application Error` (1000) carries the module, exception code and fault
 * offset. The `Additional parameter` — the one that says 0xc0000409 was a
 * deliberate `__fastfail(7)` rather than memory corruption, and the field #150
 * turns on — lives only in the `Windows Error Reporting` (1001) record. They
 * share a report id, so the join is exact rather than by timestamp proximity.
 */
export function joinCrashRecords(
  appErrors: Array<Omit<CrashEventFields, 'additionalParameter'> & { reportId: string }>,
  werReports: Array<{ reportId: string; additionalParameter: string; eventType: string }>,
): CrashEventFields[] {
  const byReport = new Map(werReports.map((w) => [w.reportId.toLowerCase(), w]));
  return appErrors.map((e) => {
    const wer = byReport.get(e.reportId.toLowerCase());
    return {
      time: e.time,
      version: e.version || '(not recorded)',
      faultingModule: e.faultingModule || '(not recorded)',
      exceptionCode: e.exceptionCode || '(not recorded)',
      faultOffset: e.faultOffset || '(not recorded)',
      additionalParameter: wer
        ? `${wer.additionalParameter} (${wer.eventType})`
        : '(no Windows Error Reporting record)',
    };
  });
}

/** One `<TAB>`-separated row emitted by the PowerShell probe. */
export function parseEventRows(stdout: string): CrashEventFields[] {
  const appErrors: Array<Omit<CrashEventFields, 'additionalParameter'> & { reportId: string }> = [];
  const werReports: Array<{ reportId: string; additionalParameter: string; eventType: string }> = [];
  for (const row of stdout.split(/\r?\n/)) {
    const f = row.split('\t');
    // 0x-prefix here rather than in PowerShell: the properties are raw hex and
    // every published report of this crash quotes them prefixed.
    if (f[0] === 'AE' && f.length >= 8) {
      appErrors.push({
        time: f[1], version: f[3], faultingModule: f[4],
        exceptionCode: `0x${f[5]}`, faultOffset: `0x${f[6]}`, reportId: f[7],
      });
    } else if (f[0] === 'WER' && f.length >= 5) {
      werReports.push({ eventType: f[2], additionalParameter: `0x${f[3]}`, reportId: f[4] });
    }
  }
  return joinCrashRecords(appErrors, werReports);
}

/** Windows Error Reporting local-dump config for wmux.exe, if any. */
export interface WerDumpConfig {
  configured: boolean;
  /** 1 = mini, 2 = full (heap — every secret the process holds). */
  dumpType?: string;
  folder?: string;
}

/**
 * True when this machine is set up to write dumps of wmux on the next crash.
 *
 * Worth surfacing unprompted: a user who turned this on did so because a
 * maintainer asked, and is therefore precisely the user about to hand the file
 * over. `DumpType=2` is the one that matters most — a full dump adds the heap
 * to the environment block, so it carries secrets a minidump would have missed.
 */
export function describeWerConfig(cfg: WerDumpConfig): string[] {
  if (!cfg.configured) return [];
  const full = cfg.dumpType === '2';
  return [
    '',
    `!! Local crash dumps are ENABLED for wmux.exe on this machine (DumpType=${cfg.dumpType ?? '?'}${full ? ', full memory' : ', minidump'}).`,
    `!! ${full
      ? 'A full dump contains your environment block AND the process heap.'
      : 'A minidump contains your environment block.'}`,
    '!! Do not attach one to a public issue without reading docs/crash-reports.md first.',
    ...(cfg.folder ? [`!! Dumps are written to: ${cfg.folder}`] : []),
  ];
}

/**
 * Absolute path to a Windows system binary.
 *
 * Never resolved through PATH: this command is the one a user runs *because*
 * something went wrong, so it must not be the one that runs a `reg.exe` or
 * `powershell.exe` that a writable PATH entry got in front of. The whole value
 * of the output is that it can be trusted enough to paste into a public issue.
 */
function system32(...parts: string[]): string {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...parts);
}

function readWerConfig(): WerDumpConfig {
  if (process.platform !== 'win32') return { configured: false };
  const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\wmux.exe';
  const res = spawnSync(system32('reg.exe'), ['query', key], { encoding: 'utf-8', windowsHide: true, timeout: 5000 });
  if (res.status !== 0 || !res.stdout) return { configured: false };
  return {
    configured: true,
    dumpType: res.stdout.match(/DumpType\s+REG_DWORD\s+0x([0-9a-f]+)/i)?.[1],
    folder: res.stdout.match(/DumpFolder\s+REG_\w+\s+(.+)/i)?.[1]?.trim(),
  };
}

/**
 * The last N crashes of wmux.exe, from both providers.
 *
 * The app name is matched on the property rather than anywhere in the rendered
 * text. Substring-matching the message attributes any crash whose *path*
 * happens to contain the string — on the machine this was written, a sibling
 * project at `...\newmux\smux.exe` was being reported as a wmux crash, with a
 * fault offset identical to the one #150 is about. A crash report that
 * confidently hands the maintainer another program's crash is worse than none.
 */
function readCrashEvents(limit: number): CrashEventFields[] {
  if (process.platform !== 'win32') return [];
  const EXE = 'wmux.exe';
  // -Oldest is invalid for a hashtable filter, so the newest come back first.
  // Both queries scan a fixed window and are then narrowed, because Get-WinEvent
  // cannot filter on a property value server-side.
  const script = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$n=${limit}`,
    `Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Error';Id=1000} -MaxEvents 400 |`,
    ` Where-Object { $_.Properties[0].Value -eq '${EXE}' } | Select-Object -First $n |`,
    ` ForEach-Object { @('AE',$_.TimeCreated.ToString('o'),$_.Properties[0].Value,$_.Properties[1].Value,`,
    `   $_.Properties[3].Value,$_.Properties[6].Value,$_.Properties[7].Value,$_.Properties[12].Value) -join "\`t" }`,
    `Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Windows Error Reporting';Id=1001} -MaxEvents 400 |`,
    ` Where-Object { $_.Properties[5].Value -eq '${EXE}' } | Select-Object -First $n |`,
    ` ForEach-Object { @('WER',$_.TimeCreated.ToString('o'),$_.Properties[2].Value,`,
    `   $_.Properties[13].Value,$_.Properties[19].Value) -join "\`t" }`,
  ].join('\n');
  const res = spawnSync(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { encoding: 'utf-8', windowsHide: true, timeout: 60000 });
  return res.stdout ? parseEventRows(res.stdout) : [];
}

/** Last N lines of the diagnostics log wmux writes to its own data directory. */
function readDiagnosticsTail(lines: number): string[] {
  try {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const suffix = process.env.WMUX_INSTANCE?.trim() ? `-${process.env.WMUX_INSTANCE.trim()}` : '';
    const file = path.join(base, `wmux${suffix}`, 'logs', 'main.log');
    return fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Assemble the report. Pure, so a test can assert on what it does and does not
 * contain without a Windows Event Log — the promise that this output is safe to
 * paste is the whole point of the command, and an untested promise is a wish.
 */
export function formatCrashReport(input: {
  events: CrashEventFields[];
  diagnostics: string[];
  wer: WerDumpConfig;
  platform: string;
  osVersion: string;
}): string {
  // Every `start` line carries version=. Taking it from there rather than from
  // a package.json lookup means it reports the wmux that actually ran, not the
  // one whose CLI you happen to be invoking — which on a machine mid-upgrade
  // are different answers, and the crash belongs to the first one.
  const lastStart = [...input.diagnostics].reverse().find((l) => l.includes(' start '));
  const version = lastStart?.match(/\bversion=(\S{1,32})/)?.[1] ?? 'unknown (no log)';

  const out: string[] = [
    '# wmux crash report',
    '',
    'This output is what a wmux crash report should contain: the Windows crash',
    'fingerprint and wmux\'s own process-lifecycle log. It carries no memory —',
    'no environment variables, no pane contents, no command lines.',
    '',
    'Do NOT attach a crash dump unless it is asked for by name. See',
    'docs/crash-reports.md for what a Windows minidump actually contains.',
    '',
    `platform    : ${input.platform} ${input.osVersion}`,
    `wmux version: ${version}`,
  ];

  out.push('', '## Windows Event Log — Application Error, wmux.exe', '');
  if (input.platform !== 'win32') {
    out.push('(not Windows — no Application Error log to read)');
  } else if (!input.events.length) {
    out.push('No matching entries. wmux may never have crashed on this machine, or the');
    out.push('records have aged out of the Application log.');
    out.push('');
    out.push('You can also read them by hand: Event Viewer > Windows Logs > Application,');
    out.push('filter by source "Application Error". The four fields that identify a crash');
    out.push('are: Faulting module name, Exception code, Fault offset, Additional parameter.');
  } else {
    for (const e of input.events) {
      out.push(
        `- ${e.time}`,
        `    wmux version        : ${e.version}`,
        `    faulting module     : ${e.faultingModule}`,
        `    exception code      : ${e.exceptionCode}`,
        `    fault offset        : ${e.faultOffset}`,
        `    additional parameter: ${e.additionalParameter}`,
      );
    }
  }

  out.push('', '## wmux main.log (process lifecycle only)', '');
  out.push(...(input.diagnostics.length ? input.diagnostics : ['(no log — wmux 1.1.1+ writes one on every launch)']));

  out.push(...describeWerConfig(input.wer));
  return out.join('\n');
}

async function cmdCrashReport(args: string[]): Promise<void> {
  const events = Math.max(1, parseInt(getFlag(args, '--events') || '5', 10) || 5);
  const logLines = Math.max(1, parseInt(getFlag(args, '--log-lines') || '40', 10) || 40);
  console.log(formatCrashReport({
    events: readCrashEvents(events),
    diagnostics: readDiagnosticsTail(logLines),
    wer: readWerConfig(),
    platform: process.platform,
    osVersion: os.release(),
  }));
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
  /**
   * Why does a pane read the way it does?
   *
   * `--file` is the mode worth having: it replays a captured screen through the
   * same engine, with no running detection and without the agent installed. A
   * rule regression is then debuggable from a `wmux read-screen` capture, on any
   * machine, which is also how the bundled manifests were authored.
   */
  'detect': async (args: string[]) => {
    // args[0] is the command name itself — every handler is called with the
    // full argv, as cmdAgent/cmdPane do. Reading args[0] as the subcommand made
    // `wmux detect explain` refuse itself.
    const sub = args[1];
    if (sub === 'reload') {
      print(await sendV2('detect.reload', {}));
      return;
    }
    if (sub !== 'explain') {
      console.error('detect: expected `explain` or `reload`');
      process.exit(1);
    }
    const rest = args.slice(2);
    const file = getFlag(rest, '--file');
    const surfaceId = getFlag(rest, '--surface') || process.env.WMUX_SURFACE_ID;
    if (file) {
      print(await sendV2('detect.explain', { file, agent: getFlag(rest, '--agent') }));
      return;
    }
    if (!surfaceId) {
      console.error('detect explain: --surface <id> or --file <path> required');
      process.exit(1);
    }
    print(await sendV2('detect.explain', { surfaceId }));
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
    usage: [
      'wmux bridge [--port P] [--host H] [--wsl]   (expose this wmux\'s pipe over TCP, default 127.0.0.1:9787)',
      '  --wsl   bind 0.0.0.0 so a container on this host can reach a bridge running in WSL2',
    ].join('\n'),
    value: ['--port', '--host'],
    bool: ['--wsl'],
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
  'current-workspace': { usage: 'wmux current-workspace [--surface <id>]', value: ['--surface'] },
  whoami: { usage: 'wmux whoami [--surface <id>]   (alias of current-workspace)', value: ['--surface'] },

  // Surface
  'new-surface': {
    usage: 'wmux new-surface [--type terminal|browser|markdown|prompts] [--color-scheme NAME]',
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
    usage: 'wmux split [--down] [--type terminal|browser|markdown|prompts] [--color-scheme NAME]',
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
  prompts: {
    usage: [
      `wmux prompts [--surface <id>] [--limit N] [--json]   ${SURFACE_NOTE}`,
      '  The prompts this pane has been given, oldest first: "#<seq>  <hh:mm>  <summary>".',
      '  --limit N keeps only the N most recent; no --surface reports every tracked pane,',
      '  20 per pane by default (the targeted form is uncapped). Says so when it truncates.',
      '  --json prints the whole reply — the entries (full text, source, and buffer line,',
      '  null = not jumpable) plus `enabled` and `truncated`, so "nothing yet", "the log',
      '  is off" and "there is more" stay distinguishable. An unknown --surface is an error.',
    ].join('\n'),
    value: ['--surface', '--limit'],
    bool: ['--json'],
  },
  'trigger-flash': { usage: 'wmux trigger-flash [surfaceId]' },

  // Browser (free-form text for type/fill/eval)
  browser: {
    usage: [
      'wmux browser open <url> | snapshot | click <ref> | type <ref> <text> | fill <ref> <value>',
      'wmux browser screenshot [--full] | get-text [ref] | eval <js> | wait <ref> [ms]',
      'wmux browser back | forward | reload',
      'wmux browser engine [web|agent]   # print, or switch, this surface\'s engine',
      `  [--surface <id>]   ${SURFACE_NOTE}`,
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
  'crash-report': {
    usage: 'wmux crash-report [--events N] [--log-lines N]\n'
      + '  Collect the crash fingerprint from the Windows Event Log plus wmux\'s own\n'
      + '  process-lifecycle log. Safe to paste into an issue — it contains no memory.\n'
      + '  Needs no running wmux, which is the point: you run it after wmux died.',
    value: ['--events', '--log-lines'],
  },

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
  'raw-v1': {
    usage: 'wmux raw-v1 <command> [surfaceId] [args...]   (send a raw V1 line; used by shell integration)',
    passthrough: true,
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
    usage: 'wmux agent-state [--surface <id>]   (no --surface → every pane, the blocked list, and every identified agent)',
    value: ['--surface'],
  },
  detect: {
    usage: [
      'wmux detect explain [--surface <id>]              (why this pane reads the way it does)',
      'wmux detect explain --file <path> [--agent <k>]   (replay a captured screen, no live wmux needed)',
      'wmux detect reload                                (re-read %APPDATA%\\wmux\\agent-detection)',
    ].join('\n'),
    value: ['--surface', '--file', '--agent'],
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
  'current-workspace': cmdCurrentWorkspace,
  whoami: cmdCurrentWorkspace,

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
  prompts: cmdPrompts,
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
  'crash-report': cmdCrashReport,

  diff: async (args) => {
    const file = args.find((a, i) => args[i - 1] === '--file') || '';
    print(await sendV2('diff.refresh', { file }));
  },
  hook: cmdHook,
  'agent-activity': cmdAgentActivity,
  // Devcontainer support (issue #19)
  'raw-v1': cmdRawV1,
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
            current-workspace | whoami [--surface <id>]   (the workspace THIS pane is in)
Remote:     ssh [ssh options] <user@host> [--title T]   (remote terminal in a new workspace)
            bridge [--port P] [--host H] [--wsl]   (expose this wmux's pipe over TCP, default 127.0.0.1:9787)
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
            prompts [--surface <id>] [--limit N] [--json]
            (the prompts this pane was given — the one thing read-screen cannot
             recover, since an agent TUI repaints over its own scrollback)
Browser:    browser open|snapshot|click|type|fill|screenshot|get-text|eval|wait|back|forward|reload
            browser engine [web|agent]   (print, or switch, which engine drives this browser surface)
            browser <verb> [--surface <id>]   # which pane's browser to drive
Agent:      agent spawn [--cmd C] [--label L] [--cwd D] [--pane P] [--replace-tab] | spawn-batch|status|list|kill
Markdown:   markdown <file>   (open a file in a new markdown view)
            markdown set <id> --content <text> | --file <path>
Diff:       diff [--file <path>]
Notify:     notify <text>, list-notifications, clear-notifications
Sidebar:    set-status, set-progress, log, sidebar-state
Hook:       hook --event <type> --tool <name> [--agent <id>]
Crash:      crash-report [--events N] [--log-lines N]
            (Event Log fingerprint + wmux's own log. No memory, so no secrets —
             paste this instead of a crash dump. See docs/crash-reports.md.)
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

// Run only when invoked as the CLI. The pure helpers above are exported so the
// unit tests can import this file without it trying to execute a command.
if (require.main === module) main();
