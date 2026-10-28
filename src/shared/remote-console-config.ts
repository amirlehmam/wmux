/**
 * Remote Console configuration, status and bridge types (#254).
 *
 * Shared by main (runtime, IPC), the preload bridge and Settings, and compiled
 * by BOTH tsconfigs — so no node imports and nothing from instance.ts. URL
 * checks use the global `URL`, which both the DOM lib and @types/node declare.
 *
 * Nothing in this file ever carries a device token, a token hash or a pairing
 * secret. Status types are what Settings and the pipe see; the only credential
 * that leaves main is the pairing URL in `PairOffer`, shown to the human who
 * clicked "Pair a device" (I2).
 */
import type { RemoteScope } from './remote-console-protocol';

/** Clear of the bridge (9787), CDP (9222-9230), agent-browser (9300+) and the dashboard (4848). */
export const REMOTE_DEFAULT_PORT = 9790;
/**
 * Vite's manifest, emitted at `dist/renderer/remote-manifest.json` rather than
 * the default `.vite/manifest.json`: electron-builder's `dist/**` glob is not
 * guaranteed to keep a dot directory.
 */
export const REMOTE_MANIFEST_FILE = 'remote-manifest.json';
/** The phone page's key in that manifest; the static server walks its closure only. */
export const REMOTE_ENTRY_KEY = 'remote/index.html';

// ── Config ───────────────────────────────────────────────────────────────

export interface RemoteConsoleConfig {
  enabled: boolean;
  bind: 'loopback' | 'lan';
  /** The one LAN IPv4 to listen on. Never 0.0.0.0 (I3). `null` unless `bind === 'lan'`. */
  lanHost: string | null;
  port: number;
  /** '' or a bare http(s) origin, e.g. a `tailscale serve` URL. */
  publicUrl: string;
  /** Operator scope on a plain-HTTP LAN bind. Forced false on loopback. */
  allowInsecureControl: boolean;
}

export const DEFAULT_REMOTE_CONFIG: Readonly<RemoteConsoleConfig> = Object.freeze({
  enabled: false,
  bind: 'loopback',
  lanHost: null,
  port: REMOTE_DEFAULT_PORT,
  publicUrl: '',
  allowInsecureControl: false,
});

export type RemoteConfigError =
  | 'bad-shape' | 'bad-enabled' | 'bad-bind' | 'bad-lan-host'
  | 'bad-port' | 'bad-public-url' | 'bad-allow-insecure';

export type RemoteConfigResult =
  | { ok: true; config: RemoteConsoleConfig }
  | { ok: false; error: RemoteConfigError };

/**
 * Whether plain `http:` to this host keeps the pairing secret, cookie and
 * page key off an open network: this machine (`ssh -L`), or a Tailscale name
 * or address, whose traffic WireGuard already encrypts. Anything else — a
 * reverse proxy on the LAN, say — would carry them in the clear, which is
 * exactly what a LAN bind gates behind "allow control over plain HTTP"; a
 * Public URL must not be a way around that rule, so it is refused instead.
 */
function plainHttpStaysPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '[::1]' || h.endsWith('.ts.net')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  // 127.0.0.0/8, and Tailscale's 100.64.0.0/10.
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Normalise a public URL to its origin, or `null` when it is not a bare
 * https origin (or an http one that stays private: plainHttpStaysPrivate). Path, query, hash and userinfo are refused rather than
 * dropped: the value becomes an Origin allowlist entry and the base of the
 * pairing URL, and silently keeping half of what the user typed would make
 * both quietly differ from what they think they configured.
 */
export function normalizePublicUrl(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return '';
  if (text.includes('?') || text.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.protocol === 'http:' && !plainHttpStaysPrivate(url.hostname)) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A dotted-quad IPv4 a LAN bind may name: four decimal octets, no leading
 * zeros, and never the wildcard `0.0.0.0` (I3 — the console binds ONE
 * interface or none). Split rather than one regex so each rule reads alone.
 */
export function isLanBindableIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p.startsWith('0')) || Number(p) > 255) return false;
  }
  return host !== '0.0.0.0';
}

/** The LAN host to keep, or `null` when it is not acceptable (see `validateRemoteConfig`). */
function acceptLanHost(host: unknown, lanAddresses: readonly string[] | null): string | null {
  if (typeof host !== 'string') return null;
  const ok = lanAddresses === null ? isLanBindableIpv4(host) : lanAddresses.includes(host);
  return ok ? host : null;
}

/**
 * Validate a config from disk or from Settings. Absent fields take their
 * default (a file written by an older build stays loadable); present fields
 * must be the right type.
 *
 * `lanAddresses` is the set of IPv4s the machine has NOW, and a Settings
 * change (`setConfig`) must pass it: the user may only pick an interface that
 * exists. Loading `remote-console.json` at start passes `null` instead, which
 * checks only that `lanHost` is a bindable IPv4. With the live list there, a
 * saved LAN config whose interface has gone (Wi-Fi off, VPN down) would fail
 * validation and be replaced by the default — silently rewriting the user's
 * choice — and `start()` could never report the `lan-address-gone` that
 * actually happened. The presence check is `start()`'s job on that path.
 */
export function validateRemoteConfig(raw: unknown, lanAddresses: readonly string[] | null): RemoteConfigResult {
  if (!isRecord(raw)) return { ok: false, error: 'bad-shape' };
  const merged: Record<string, unknown> = { ...DEFAULT_REMOTE_CONFIG, ...raw };

  if (typeof merged.enabled !== 'boolean') return { ok: false, error: 'bad-enabled' };
  if (merged.bind !== 'loopback' && merged.bind !== 'lan') return { ok: false, error: 'bad-bind' };
  const port = merged.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, error: 'bad-port' };
  }
  if (typeof merged.allowInsecureControl !== 'boolean') return { ok: false, error: 'bad-allow-insecure' };
  if (typeof merged.publicUrl !== 'string') return { ok: false, error: 'bad-public-url' };
  const publicUrl = normalizePublicUrl(merged.publicUrl);
  if (publicUrl === null) return { ok: false, error: 'bad-public-url' };

  let lanHost: string | null = null;
  if (merged.bind === 'lan') {
    lanHost = acceptLanHost(merged.lanHost, lanAddresses);
    if (lanHost === null) return { ok: false, error: 'bad-lan-host' };
  }

  return {
    ok: true,
    config: {
      enabled: merged.enabled,
      bind: merged.bind,
      lanHost,
      port,
      publicUrl,
      allowInsecureControl: merged.bind === 'lan' && merged.allowInsecureControl,
    },
  };
}

// ── Status ───────────────────────────────────────────────────────────────

export type RemoteLastError = 'port-busy' | 'bind-failed' | 'ui-not-built' | 'lan-address-gone';

export interface RemoteDeviceView {
  id: string;
  name: string;
  scope: RemoteScope;
  createdAt: number;
  lastSeenAt: number;
  /** Its credentials once crossed plain HTTP: view-only off a LAN bind until paired again. Absent when clean. */
  cleartext?: true;
}

/** What Settings renders. Never a token, a hash or a secret. */
export interface RemoteConsoleStatus {
  config: RemoteConsoleConfig;
  running: boolean;
  listening: { host: string; port: number } | null;
  lastError: RemoteLastError | null;
  lastRejectedOrigin: string | null;
  lanAddresses: string[];
  devices: RemoteDeviceView[];
  connected: { deviceId: string; count: number }[];
  pairing: { expiresAt: number; scope: RemoteScope } | null;
}

/** `remote.status` over the pipe: counts only, no device names (I2). */
export interface RemoteV2Status {
  enabled: boolean;
  running: boolean;
  bind: 'loopback' | 'lan';
  port: number;
  publicUrl: string;
  deviceCount: number;
  connectedCount: number;
  lastError: RemoteLastError | null;
}

/** The pairing secret rides in the URL FRAGMENT (`/#pair=…`), never path or query (I5). */
export interface PairOffer {
  url: string;
  expiresAt: number;
  scope: RemoteScope;
}

// ── Main ↔ desktop renderer (terminal snapshots, modes) ─────────────────

export interface RemoteRendererRequest {
  kind: 'snapshot' | 'modes';
  surfaceId: string;
  reqId: string;
}

export type RemoteSnapshotResult = { data: string; cols: number; rows: number } | { error: 'no-terminal' };
export type RemoteModesResult = { bracketedPaste: boolean } | { error: 'no-terminal' };

/**
 * One entry of `window.__wmux_remoteRoster()`. An explicit mapping of the
 * renderer's roster, NOT the roster itself: no metadata, no detectedState, no
 * paneId, and choices reduced to `{id,label,isDefault}` so a declared choice's
 * `key`/`text` never leaves the renderer for the wire. Main still validates it
 * field by field — it arrives from `executeJavaScript` and is trusted no further
 * than that.
 */
export interface RemoteRosterSource {
  surfaceId: string;
  workspaceId: string;
  workspaceTitle: string;
  label: string;
  kind: string | null;
  /**
   * A CLOSED set, and narrower than the desktop's: the desktop roster also has
   * `question` (an agent that ended its turn on an ordinary question). The
   * phone has no such state, so `toRemoteRosterSource` sends it as the declared
   * `idle` it refines. Adding it here is a protocol change —
   * main's validation and the phone UI both have to learn it first.
   */
  state: 'blocked' | 'working' | 'idle' | 'unknown';
  stateSource: 'declared' | 'detected' | null;
  blockedReason: string | null;
  choices: { id: string; label: string; isDefault?: boolean }[];
  answerPending: boolean;
  dwellMs: number;
}

/**
 * A desktop bell about the console (#254). Sent as FACTS — kind, device name,
 * scope — and worded by the renderer in the UI language, with the scope named
 * the way Settings names it ("Control" / "View only"), never the internal
 * `operator`/`viewer`.
 */
export interface RemoteDesktopNotice {
  kind: 'paired' | 'connected';
  name: string;
  scope: RemoteScope;
}

// ── Preload bridge (`window.wmux.remoteConsole`) ────────────────────────

export type RemoteBridgeError = { error: string };

export interface RemoteConsoleBridge {
  getState(): Promise<RemoteConsoleStatus | RemoteBridgeError>;
  setConfig(raw: unknown): Promise<{ ok: true } | { ok: false; error: string } | RemoteBridgeError>;
  pairStart(o: { name: string; scope: RemoteScope }): Promise<PairOffer | RemoteBridgeError>;
  pairCancel(): Promise<void | RemoteBridgeError>;
  revoke(id: string): Promise<void | RemoteBridgeError>;
  revokeAll(): Promise<void | RemoteBridgeError>;
  rename(id: string, name: string): Promise<void | RemoteBridgeError>;
  /** Hide the refused-origin card until another origin is refused. */
  dismissRejectedOrigin(): Promise<void | RemoteBridgeError>;
  onState(cb: (status: RemoteConsoleStatus) => void): () => void;
  onRendererRequest(cb: (req: RemoteRendererRequest) => void): () => void;
  replyRenderer(reqId: string, result: RemoteSnapshotResult | RemoteModesResult): void;
}
