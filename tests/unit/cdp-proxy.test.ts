import { describe, it, expect, vi } from 'vitest';
import net from 'net';

// cdp-proxy.ts imports `electron` at module scope; stub it so the pure
// host-check function can be tested without an Electron runtime.
vi.mock('electron', () => ({
  webContents: { fromId: () => undefined },
}));

import { CDPProxy, isAllowedCdpHost, isAllowedCdpOrigin } from '../../src/main/cdp-proxy';

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
    expect(isAllowedCdpHost('0.0.0.0:9222')).toBe(false);
    expect(isAllowedCdpHost('192.168.1.10:9222')).toBe(false);
    expect(isAllowedCdpHost('10.0.0.1')).toBe(false);
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

describe('CDPProxy.start (port fallback when a first instance holds 9222)', () => {
  it('falls back to a free port instead of raising an uncaught error', async () => {
    // Occupy the default port to reproduce the second-instance condition. If it
    // is already taken (a real wmux is running), that serves the same purpose.
    const blocker = net.createServer();
    const blocked = await new Promise<boolean>((resolve) => {
      blocker.once('error', () => resolve(false));
      blocker.listen(DEFAULT_PORT, '127.0.0.1', () => resolve(true));
    });

    const proxy = new CDPProxy();
    try {
      // Before the fix this rejected/crashed: `ws` re-emits the http server's
      // EADDRINUSE onto the WebSocketServer, which had no 'error' listener, so
      // the failed listen() surfaced as an uncaught exception rather than
      // advancing the fallback loop.
      await proxy.start();

      const port = proxy.getPort();
      expect(port).not.toBe(DEFAULT_PORT);
      expect(port).toBeGreaterThan(DEFAULT_PORT);
      expect(port).toBeLessThanOrEqual(MAX_PORT);

      // Both emitters must still carry an 'error' handler after a successful
      // bind — the old removeAllListeners('error') stripped the safety net and
      // ws's forwarder, so any later server error became uncaught again.
      const internals = proxy as unknown as { server: net.Server; wss: { listenerCount(e: string): number } };
      expect(internals.server.listenerCount('error')).toBeGreaterThan(0);
      expect(internals.wss.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      proxy.stop();
      if (blocked) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
