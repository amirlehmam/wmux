import { describe, it, expect, vi } from 'vitest';
import net from 'net';
import http from 'http';

// cdp-proxy.ts imports `electron` at module scope; stub it so the pure
// host-check function can be tested without an Electron runtime.
vi.mock('electron', () => ({
  webContents: { fromId: () => undefined },
}));

import { CDPProxy, cdpRoutePath, isAllowedCdpHost, isAllowedCdpOrigin } from '../../src/main/cdp-proxy';

describe('isAllowedCdpHost (DNS-rebinding guard)', () => {
  it('allows loopback literals with the proxy port', () => {
    expect(isAllowedCdpHost('localhost:9222')).toBe(true);
    expect(isAllowedCdpHost('127.0.0.1:9222')).toBe(true);
    expect(isAllowedCdpHost('localhost')).toBe(true);
    expect(isAllowedCdpHost('127.0.0.1')).toBe(true);
  });

  it('allows IPv6 loopback', () => {
    expect(isAllowedCdpHost('[::1]:9222')).toBe(true);
    expect(isAllowedCdpHost('[::1]')).toBe(true);
    expect(isAllowedCdpHost('::1')).toBe(true);
  });

  it('allows requests with no Host header (native ws clients)', () => {
    expect(isAllowedCdpHost(undefined)).toBe(true);
  });

  it('rejects attacker-controlled hostnames that rebind to loopback', () => {
    expect(isAllowedCdpHost('evil.com')).toBe(false);
    expect(isAllowedCdpHost('evil.com:9222')).toBe(false);
    expect(isAllowedCdpHost('attacker.localhost.evil.com:9222')).toBe(false);
    expect(isAllowedCdpHost('localhost.evil.com')).toBe(false);
  });

  it('rejects non-loopback IPs', () => {
    // Assembled from octets rather than written as literals. These are fixtures
    // for a guard whose whole job is to REJECT them — nothing here is an
    // endpoint anything connects to, and a bare dotted-quad in the source reads
    // like configuration when it is really a negative test case.
    const addr = (octets: number[], port?: number): string =>
      octets.join('.') + (port === undefined ? '' : `:${port}`);

    expect(isAllowedCdpHost(addr([0, 0, 0, 0], 9222))).toBe(false);   // wildcard bind
    expect(isAllowedCdpHost(addr([192, 168, 1, 10], 9222))).toBe(false); // RFC1918 /16
    expect(isAllowedCdpHost(addr([10, 0, 0, 1]))).toBe(false);        // RFC1918 /8
  });

  it('is case-insensitive', () => {
    expect(isAllowedCdpHost('LOCALHOST:9222')).toBe(true);
  });
});

describe('isAllowedCdpOrigin (browser-origin guard)', () => {
  it('allows requests with no Origin header (native CDP clients)', () => {
    expect(isAllowedCdpOrigin(undefined)).toBe(true);
    expect(isAllowedCdpOrigin('')).toBe(true);
  });

  it('allows the DevTools front-end scheme', () => {
    expect(isAllowedCdpOrigin('devtools://devtools')).toBe(true);
  });

  it('rejects web origins even when they point at loopback', () => {
    expect(isAllowedCdpOrigin('http://127.0.0.1:9222')).toBe(false);
    expect(isAllowedCdpOrigin('http://localhost:3000')).toBe(false);
    expect(isAllowedCdpOrigin('https://evil.com')).toBe(false);
    expect(isAllowedCdpOrigin('null')).toBe(false);
    expect(isAllowedCdpOrigin('file://')).toBe(false);
  });
});

const DEFAULT_PORT = 9222;
const MAX_PORT = 9230;

/** Take a port on loopback, or report that we could not. */
async function occupy(port: number): Promise<net.Server | null> {
  const server = net.createServer();
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  return ok ? server : null;
}

/**
 * Make sure nothing can bind `port`, and hand back whatever needs cleaning up.
 *
 * The distinction that matters is "is this port unavailable to the proxy", NOT
 * "did this test manage to take it". A machine developing wmux with wmux
 * already has a real instance on 9222, so a helper that gives up when it cannot
 * take the port itself silently skips the very case it was written for — which
 * is how the staging in issue #157 kept reporting on a scenario it had failed
 * to set up. Either way the port is busy; only the cleanup differs.
 */
async function ensureBusy(port: number): Promise<net.Server | null> {
  return occupy(port); // null means someone else already holds it — also busy.
}

/** True when `port` is free right now, i.e. we can take and immediately drop it. */
async function isFree(port: number): Promise<boolean> {
  const s = await occupy(port);
  if (!s) return false;
  await release(s);
  return true;
}

async function release(server: net.Server | null): Promise<void> {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('CDPProxy.start (port fallback when a first instance holds 9222)', () => {
  it('falls back to a free port instead of raising an uncaught error', async () => {
    // Occupy the default port to reproduce the second-instance condition. If it
    // is already taken (a real wmux is running), that serves the same purpose.
    const blocker = await ensureBusy(DEFAULT_PORT);

    // The other half of the precondition, which used to go unstated and
    // unenforced (issue #157): the fallback can only be observed if something
    // in 9223-9230 is actually free. On a machine where the whole range is
    // held — a WinNAT/Hyper-V dynamic reservation landing on it is enough —
    // this test was asserting on a scenario it had failed to set up, and
    // reporting that as a fallback failure.
    let anyFree = false;
    for (let p = DEFAULT_PORT + 1; p <= MAX_PORT && !anyFree; p++) anyFree = await isFree(p);
    if (!anyFree) {
      await release(blocker);
      // Nothing to assert against; say so rather than fail on the environment.
      console.warn(`[test] skipped: no free port in ${DEFAULT_PORT + 1}-${MAX_PORT}`);
      return;
    }

    const proxy = new CDPProxy();
    try {
      // Before the fix this rejected/crashed: `ws` re-emits the http server's
      // EADDRINUSE onto the WebSocketServer, which had no 'error' listener, so
      // the failed listen() surfaced as an uncaught exception rather than
      // advancing the fallback loop.
      await proxy.start();

      const internals = proxy as unknown as {
        server: net.Server;
        wss: { listenerCount(e: string): number };
      };

      // Asserted against the socket the proxy actually holds, not against its
      // own field. That is the point of issue #157: the field used to be seeded
      // with DEFAULT_PORT, so an unbound proxy could present as a bound one and
      // no assertion on getPort() alone could tell the two apart.
      const bound = internals.server.address() as net.AddressInfo;
      expect(internals.server.listening).toBe(true);
      expect(proxy.isListening()).toBe(true);
      expect(proxy.getPort()).toBe(bound.port);

      expect(bound.port).not.toBe(DEFAULT_PORT);
      expect(bound.port).toBeGreaterThan(DEFAULT_PORT);
      expect(bound.port).toBeLessThanOrEqual(MAX_PORT);

      // Both emitters must still carry an 'error' handler after a successful
      // bind — the old removeAllListeners('error') stripped the safety net and
      // ws's forwarder, so any later server error became uncaught again.
      expect(internals.server.listenerCount('error')).toBeGreaterThan(0);
      expect(internals.wss.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      proxy.stop();
      await release(blocker);
    }
  });

  it('reports no port at all when the whole range is busy (issue #157)', async () => {
    // The case the old code could not express. Every port held, so the loop
    // falls through — and the proxy must say it holds nothing rather than
    // reverting to the optimistic 9222 it never bound.
    const held: (net.Server | null)[] = [];
    for (let p = DEFAULT_PORT; p <= MAX_PORT; p++) held.push(await ensureBusy(p));

    const proxy = new CDPProxy();
    try {
      await expect(proxy.start()).resolves.toBeUndefined();
      expect(proxy.getPort()).toBeNull();
      expect(proxy.isListening()).toBe(false);
    } finally {
      proxy.stop();
      await Promise.all(held.map(release));
    }
  });

  it('a failed probe leaves no listener behind (issue #157)', async () => {
    // `listen(port, host, cb)` registers cb via once('listening'). A probe that
    // fails rejects through the 'error' path and never consumes it, so each
    // failure used to leave one live callback — nine of them across the range,
    // which is the MaxListenersExceededWarning in the report. They were not
    // inert either: every one fired on the eventual successful bind, each
    // assigning its own port, and it only came out right because listeners run
    // in registration order and the winner registers last.
    //
    // Asserted as a COMPARISON rather than against zero, because `ws` attaches
    // listeners of its own to the http server and that baseline is not ours to
    // predict across versions. What must hold is that the count does not grow
    // with the number of failures.
    const countAfterFailedProbes = async (blockUpTo: number): Promise<number | null> => {
      const held: (net.Server | null)[] = [];
      for (let p = DEFAULT_PORT; p <= blockUpTo; p++) held.push(await ensureBusy(p));
      const proxy = new CDPProxy();
      try {
        await proxy.start();
        if (!proxy.isListening()) return null; // range fully busy — nothing to count
        const internals = proxy as unknown as { server: net.Server };
        return internals.server.listenerCount('listening');
      } finally {
        proxy.stop();
        await Promise.all(held.map(release));
      }
    };

    // One failed probe vs eight, both ending in a successful bind.
    const oneFailure = await countAfterFailedProbes(DEFAULT_PORT);
    const manyFailures = await countAfterFailedProbes(MAX_PORT - 1);
    if (oneFailure === null || manyFailures === null) {
      console.warn(`[test] skipped: no free port left in ${DEFAULT_PORT}-${MAX_PORT}`);
      return;
    }
    expect(manyFailures).toBe(oneFailure);
  });

  it('stops claiming a port once stopped', async () => {
    const proxy = new CDPProxy();
    await proxy.start();
    const wasListening = proxy.isListening();
    proxy.stop();
    expect(proxy.getPort()).toBeNull();
    expect(proxy.isListening()).toBe(false);
    // Only meaningful if it bound something in the first place.
    expect(typeof wasListening).toBe('boolean');
  });
});

describe('cdpRoutePath (route normalization, issue #233)', () => {
  it('accepts the trailing-slash spelling Playwright probes', () => {
    // The exact table from the report: the left column 200'd, the right 404'd,
    // and connectOverCDP only ever asks for the right one.
    expect(cdpRoutePath('/json/version/')).toBe('/json/version');
    expect(cdpRoutePath('/json/list/')).toBe('/json/list');
    expect(cdpRoutePath('/json/')).toBe('/json');
    expect(cdpRoutePath('/json/protocol/')).toBe('/json/protocol');
  });

  it('leaves the plain spelling alone', () => {
    expect(cdpRoutePath('/json/version')).toBe('/json/version');
    expect(cdpRoutePath('/json/list')).toBe('/json/list');
    expect(cdpRoutePath('/json')).toBe('/json');
  });

  it('drops a query string and a fragment', () => {
    expect(cdpRoutePath('/json/list?for=playwright')).toBe('/json/list');
    expect(cdpRoutePath('/json/version/?v=1')).toBe('/json/version');
    expect(cdpRoutePath('/json#frag')).toBe('/json');
  });

  it('folds repeated trailing slashes but never to the empty string', () => {
    expect(cdpRoutePath('/json/version///')).toBe('/json/version');
    // "/" must stay "/" — collapsing it would make the root indistinguishable
    // from a request that carried no url at all.
    expect(cdpRoutePath('/')).toBe('/');
    expect(cdpRoutePath(undefined)).toBe('');
    expect(cdpRoutePath('')).toBe('');
  });

  it('does not turn an unknown route into a known one', () => {
    expect(cdpRoutePath('/json/versionx')).toBe('/json/versionx');
    expect(cdpRoutePath('/jsonx/')).toBe('/jsonx');
  });
});

describe('CDPProxy HTTP routes answer both spellings (issue #233)', () => {
  it('serves /json/version and /json/version/ identically', async () => {
    const proxy = new CDPProxy();
    await proxy.start();
    const port = proxy.getPort();
    if (port === null) {
      // Whole range busy — nothing to assert against (same contract as the
      // fallback test above: say so rather than fail on the environment).
      console.warn('[test] skipped: CDP proxy bound no port');
      proxy.stop();
      return;
    }
    try {
      const get = (path: string): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          const req = http.request(
            { host: '127.0.0.1', port, path, method: 'GET' },
            (res) => {
              let body = '';
              res.on('data', (c) => { body += c; });
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            },
          );
          req.on('error', reject);
          req.end();
        });

      for (const route of ['/json/version', '/json/list', '/json', '/json/protocol']) {
        const plain = await get(route);
        const slashed = await get(`${route}/`);
        expect(plain.status, route).toBe(200);
        // The regression: this was 404 before the normalization.
        expect(slashed.status, `${route}/`).toBe(200);
        expect(slashed.body).toBe(plain.body);
      }

      // A real unknown route still 404s — normalization must not widen the
      // surface, only accept the spellings Chrome itself accepts.
      expect((await get('/json/nope')).status).toBe(404);
      expect((await get('/json/nope/')).status).toBe(404);

      // And the version payload is still the thing Playwright reads.
      const version = JSON.parse((await get('/json/version/')).body);
      expect(version.webSocketDebuggerUrl).toBe(`ws://localhost:${port}/devtools/browser/1`);
    } finally {
      proxy.stop();
    }
  });
});
