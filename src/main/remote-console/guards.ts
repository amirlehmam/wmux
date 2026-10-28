/**
 * Request guards for the Remote Console HTTP/WS server (#254, spec §7).
 *
 * Pure: every function here is a decision over header strings, so the whole
 * table — rebinding Host, `null` Origin, scheme mismatch, IPv6 loopback,
 * traversal — is testable without binding a port, the way cdp-proxy.ts keeps
 * `isAllowedCdpHost` / `cdpRoutePath` pure (#233).
 *
 * Two rules carry the security weight, and both are EXACT matches on purpose:
 *
 * - Host. A DNS-rebinding page gets the victim's browser to send requests to
 *   127.0.0.1 under the attacker's own hostname; the only thing that tells
 *   that request apart from the real one is the Host header. So Host is
 *   matched against a closed list built from the config, never parsed for
 *   "looks local".
 * - Origin. A cross-site page can POST and open a WebSocket to any address
 *   the browser can reach, and the cookie is what would make it count.
 *   SameSite=Strict stops the cookie on a POST, but a WebSocket handshake is
 *   not a "site" navigation in every browser, so Origin is checked on every
 *   POST and every upgrade, and a missing or `null` one is a refusal rather
 *   than a pass — `null` is exactly what a sandboxed iframe or a file:// page
 *   sends.
 *
 * The cookie is host-scoped, not port-scoped, so on plain http every other
 * server on the same host receives it; it is therefore never enough on its
 * own — see the page key in devices.ts.
 *
 * `X-Forwarded-*` is never read. The console sits behind `tailscale serve` or
 * `ssh -L` at most, and both forward the Host header untouched; a header any
 * client can set is not evidence of anything.
 */
import { WS_KEY_PROTOCOL_PREFIX } from '../../shared/remote-console-protocol';

export interface AllowlistInput {
  port: number;
  bind: 'loopback' | 'lan';
  lanHost: string | null;
  publicUrl: string;
}

export interface Allowlists {
  hosts: ReadonlySet<string>;
  origins: ReadonlySet<string>;
  /** The publicUrl host, default port folded, or null when none is configured. */
  publicHost: string | null;
  publicHttps: boolean;
}

/** Lower-case, and drop `:80` / `:443` — what a browser omits for its scheme's default. */
export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.endsWith(':80')) return lower.slice(0, -3);
  if (lower.endsWith(':443')) return lower.slice(0, -4);
  return lower;
}

export function buildAllowlists(input: AllowlistInput): Allowlists {
  const p = String(input.port);
  const local = ['127.0.0.1', 'localhost', '[::1]'];
  if (input.bind === 'lan' && input.lanHost) local.push(input.lanHost);

  const hosts = new Set<string>(local.map((h) => normalizeHost(`${h}:${p}`)));
  const origins = new Set<string>(local.map((h) => `http://${h}:${p}`));

  let publicHost: string | null = null;
  let publicHttps = false;
  if (input.publicUrl) {
    try {
      const url = new URL(input.publicUrl);
      publicHost = normalizeHost(url.host);
      publicHttps = url.protocol === 'https:';
      hosts.add(publicHost);
      origins.add(url.origin);
    } catch {
      // validateRemoteConfig already refused anything URL cannot parse; a
      // value that slipped through simply adds nothing to either list.
    }
  }
  return { hosts, origins, publicHost, publicHttps };
}

export function isAllowedHost(host: string | undefined, lists: Allowlists): boolean {
  if (!host) return false;
  return lists.hosts.has(normalizeHost(host));
}

export function isAllowedOrigin(origin: string | undefined, lists: Allowlists): boolean {
  if (!origin || origin === 'null') return false;
  return lists.origins.has(origin);
}

/**
 * The route a request names, or `null` (404) for anything that could be a
 * traversal. The static server looks files up in a map and never joins request
 * data onto a path, so this is the second line, not the only one — but a
 * request that SPELLS a traversal has no legitimate reason to be answered at
 * all, and refusing it here keeps it out of every later branch.
 */
export function routeOf(url: string | undefined): string | null {
  if (!url?.startsWith('/')) return null;
  const q = url.search(/[?#]/);
  const path = q === -1 ? url : url.slice(0, q);
  const lower = path.toLowerCase();
  if (path.includes('..') || path.includes('\\') || path.includes('//')) return null;
  if (lower.includes('%2e') || lower.includes('%2f') || lower.includes('%5c') || lower.includes('%00')) return null;
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

/**
 * Whether this request reached us over HTTPS — which the console itself never
 * serves, so the only way is a TLS-terminating proxy the user configured as
 * publicUrl. True only when that URL is https AND the request is addressed to
 * its host; that decides the cookie's `Secure` flag.
 */
export function isHttpsRequest(host: string | undefined, lists: Allowlists): boolean {
  if (!lists.publicHttps || !lists.publicHost || !host) return false;
  return normalizeHost(host) === lists.publicHost;
}

export const COOKIE_NAME = 'wmux_rc';
/** 30 days — the same window after which an idle device is forgotten (devices.ts). */
export const COOKIE_MAX_AGE_S = 2592000;

export function cookieHeader(value: string, secure: boolean): string {
  const base = `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
  return secure ? `${base}; Secure` : base;
}

export function clearCookieHeader(secure: boolean): string {
  const base = `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  return secure ? `${base}; Secure` : base;
}

/** The `wmux_rc` value from a Cookie header, or null. First occurrence wins. */
export function readCookie(header: string | undefined): string | null {
  return readCookies(header)[0] ?? null;
}

/** At most this many `wmux_rc` values are tried from one Cookie header. */
export const MAX_COOKIE_CANDIDATES = 4;

/**
 * Every non-empty `wmux_rc` value, in header order, capped. Another server on
 * this host can SET cookies for it too (plain http is not port-scoped), and a
 * `wmux_rc=<junk>; Path=/api` it tosses is sent BEFORE the phone's own
 * Path=/ one — so taking only the first made a paired phone read as "not
 * paired" and throw its page key away. The server tries each instead.
 */
export function readCookies(header: string | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const v = part.slice(eq + 1).trim();
    if (v !== '') out.push(v);
    if (out.length >= MAX_COOKIE_CANDIDATES) break;
  }
  return out;
}

/**
 * Sent on EVERY response, errors included. The CSP is byte-exact with spec §7,
 * pinned by remote-console-guards.test.ts.
 * `connect-src ws: wss:` rather than a host: the page cannot know which of the
 * allowlisted names it was opened under, and the server's Origin check is what
 * actually decides who may connect. No `Server` header is ever set.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

/**
 * What to record as `lastRejectedOrigin` for Settings' "Use as Public URL".
 * An upgrade or POST carries Origin, which is the exact value to offer. A
 * top-level GET carries none, only Host: a bare host there is almost always a
 * TLS-terminating proxy on 443 (tailscale serve), a host:port a plain http
 * reach. Printable ASCII only and capped — it is rendered in Settings.
 */
export function rejectedOriginValue(origin: string | undefined, host: string | undefined): string | null {
  let value: string | null = null;
  if (origin && origin !== 'null') value = origin;
  else if (host) value = (host.includes(':') ? 'http://' : 'https://') + host.trim().toLowerCase();
  if (value === null) return null;
  if (!/^[\x21-\x7e]+$/.test(value)) return null;
  return value.slice(0, 200);
}

/** The page key offered as `wmux-key.<key>` in Sec-WebSocket-Protocol, or null. */
export function keyFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  for (const raw of header.split(',')) {
    const p = raw.trim();
    if (p.startsWith(WS_KEY_PROTOCOL_PREFIX)) {
      const key = p.slice(WS_KEY_PROTOCOL_PREFIX.length);
      return key === '' ? null : key;
    }
  }
  return null;
}

/** A socket peer on this machine: IPv6 loopback, or 127/8 (bare or IPv4-mapped). */
export function isLoopbackPeer(peer: string | undefined): boolean {
  if (!peer) return false;
  const v4 = peer.startsWith('::ffff:') ? peer.slice('::ffff:'.length) : peer;
  return peer === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Whether a refused origin may be OFFERED as a one-click "Use as Public URL".
 * A refusal is recorded before any authentication, so anything that can make
 * one — a DNS-rebinding page in any browser on this machine, any peer on the
 * LAN — could otherwise plant a name of its choosing on that card; one click
 * then allowlists it AND points the pairing QR at it. So only the shape the
 * card exists for qualifies: arriving from loopback (the proxy runs on this
 * machine), over https (a rebinding page reaches the plain-http listener and
 * cannot present one), on a Tailscale name. Anything else is only logged; a
 * user with another proxy types the Public URL in Settings.
 */
export function offersAsPublicUrl(value: string, peer: string | undefined): boolean {
  if (!isLoopbackPeer(peer)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.port === '' && url.hostname.endsWith('.ts.net')
    && url.username === '' && url.password === '' && (url.pathname === '/' || url.pathname === '');
}
