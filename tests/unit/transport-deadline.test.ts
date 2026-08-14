import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_V2_TIMEOUT_MS,
  SLOW_TRANSPORT_FLOOR_MS,
  isSlowTransport,
  transportDeadline,
  usesNpiperelay,
  type Transport,
} from '../../src/cli/transport-deadline';

/**
 * The CLI and the Claude Code hook helper are two processes talking to the same
 * socket, and they each used to carry their own deadline. The CLI derived one
 * from the transport; the hook wrote `remote ? 30000 : 5000`. Same intent, two
 * spellings, and the hook's did not know about npiperelay — so a WSL hook armed
 * a 5s timer for a hop that measures ~7s and destroyed the socket mid-flight.
 *
 * Sharing the derivation is the fix. These tests cover the derivation itself and
 * then check the two call sites still go through it, because a re-hardcoded
 * literal is exactly how this came back the first time.
 */

const WIN_PIPE = '\\\\.\\pipe\\wmux';

const t = (over: Partial<Transport> = {}): Transport => ({
  remote: false,
  pipePath: WIN_PIPE,
  env: {},
  ...over,
});

describe('usesNpiperelay', () => {
  it('is true only for a Windows pipe path dialled from inside WSL', () => {
    expect(usesNpiperelay(t({ env: { WSL_DISTRO_NAME: 'Ubuntu' } }))).toBe(true);
    expect(usesNpiperelay(t({ env: { WSLENV: 'PATH/l' } }))).toBe(true);
    // Native Windows: the pipe is dialled directly.
    expect(usesNpiperelay(t({ env: {} }))).toBe(false);
    // A POSIX socket path is not a Windows pipe, whatever the environment says.
    expect(usesNpiperelay(t({ pipePath: '/tmp/wmux.sock', env: { WSL_DISTRO_NAME: 'Ubuntu' } }))).toBe(false);
  });

  it('is false when a remote target has taken over the transport', () => {
    // TCP to a bridge replaces the local hop; there is no pipe left to relay.
    expect(usesNpiperelay(t({ remote: true, env: { WSL_DISTRO_NAME: 'Ubuntu' } }))).toBe(false);
  });
});

describe('transportDeadline', () => {
  it('leaves a local pipe exactly as it was', () => {
    // The floor must not move timings for the platform wmux ships for.
    expect(transportDeadline(DEFAULT_V2_TIMEOUT_MS, t())).toBe(DEFAULT_V2_TIMEOUT_MS);
    expect(transportDeadline(45000, t())).toBe(45000);
  });

  it('raises a short deadline to the floor on both slow transports', () => {
    for (const slow of [t({ remote: true }), t({ env: { WSL_DISTRO_NAME: 'Ubuntu' } })]) {
      expect(isSlowTransport(slow)).toBe(true);
      expect(transportDeadline(DEFAULT_V2_TIMEOUT_MS, slow)).toBe(SLOW_TRANSPORT_FLOOR_MS);
    }
  });

  it('is a floor, not a replacement — a browser verb keeps its longer budget', () => {
    expect(transportDeadline(45000, t({ remote: true }))).toBe(45000);
  });

  it('lets WMUX_RPC_TIMEOUT_MS lengthen a deadline but never shorten one', () => {
    const env = { WMUX_RPC_TIMEOUT_MS: '90000' };
    expect(transportDeadline(DEFAULT_V2_TIMEOUT_MS, t({ env }))).toBe(90000);
    // Below the base it cannot truncate: the override is itself a floor, so
    // setting it can never cause the mid-flight cutoff this all exists to avoid.
    expect(transportDeadline(45000, t({ env: { WMUX_RPC_TIMEOUT_MS: '1000' } }))).toBe(45000);
  });

  it('ignores an override that is not a positive number', () => {
    for (const raw of ['', 'soon', '0', '-1', 'NaN']) {
      expect(transportDeadline(DEFAULT_V2_TIMEOUT_MS, t({ env: { WMUX_RPC_TIMEOUT_MS: raw } }))).toBe(
        DEFAULT_V2_TIMEOUT_MS,
      );
    }
  });
});

describe('the CLI and the hook agree', () => {
  const read = (f: string): string => fs.readFileSync(path.resolve(__dirname, '../../src/cli', f), 'utf8');

  it('both derive their deadline from this module', () => {
    for (const file of ['wmux.ts', 'wmux-hook.ts']) {
      expect(read(file), `${file} should import the shared derivation`).toMatch(
        /from '\.\/transport-deadline'/,
      );
    }
  });

  it('neither declares its own copy of the two constants', () => {
    // The literals belong in transport-deadline.ts and nowhere else. This is the
    // regression that already happened once, so it is asserted rather than
    // trusted: `remote ? 30000 : 5000` in the hook was a copy of the CLI's rule
    // that stopped tracking it. (A bare /30000/ scan would be stricter but wrong
    // — wmux.ts legitimately spends 30s elsewhere, on CDP navigation and the
    // warm-pool backoff.)
    for (const file of ['wmux.ts', 'wmux-hook.ts']) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, `${file} should import the floor, not redeclare it`).not.toMatch(
        /const\s+(DEFAULT_V2_TIMEOUT_MS|SLOW_TRANSPORT_FLOOR_MS)\s*=/,
      );
      // The hook's original spelling, in any arrangement of the ternary.
      expect(code, `${file} should not pick a deadline inline`).not.toMatch(
        /\?[^;]*\b(30000|5000)\b[^;]*:[^;]*\b(30000|5000)\b/,
      );
    }
  });

  it('gives the same answer for the same connection', () => {
    // Both describe a connection with {remote, pipePath, env} and get one number
    // back, so "the hook waits 5s where the CLI waits 30s" cannot recur without
    // one of them ceasing to call this.
    const inContainer = t({ remote: true, pipePath: WIN_PIPE, env: {} });
    const inWsl = t({ remote: false, pipePath: WIN_PIPE, env: { WSL_DISTRO_NAME: 'Ubuntu' } });
    expect(transportDeadline(DEFAULT_V2_TIMEOUT_MS, inContainer)).toBe(SLOW_TRANSPORT_FLOOR_MS);
    expect(transportDeadline(DEFAULT_V2_TIMEOUT_MS, inWsl)).toBe(SLOW_TRANSPORT_FLOOR_MS);
  });
});
