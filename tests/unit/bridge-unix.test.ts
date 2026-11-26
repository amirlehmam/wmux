import { describe, it, expect } from 'vitest';
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  checkSocketDir,
  checkUnixBridgeRequest,
  decideSocketPath,
  type UnixBridgeRequest,
} from '../../src/cli/bridge-unix';

/**
 * `wmux bridge --unix <path>` listens on a Unix socket instead of a TCP port, so
 * a container that has the socket's directory bind-mounted can reach wmux without
 * any address being opened. These are the rules for where it may listen, as pure
 * functions so the whole table runs on any platform. The end-to-end behaviour
 * (mode 0600, stale-socket recovery, relaying to the pipe) is in
 * wmux-bridge-transport.test.ts.
 */

const req = (over: Partial<UnixBridgeRequest> = {}): UnixBridgeRequest => ({
  unixPath: '/home/dev/.cache/wmux/sock/wmux.sock',
  wsl: false,
  portGiven: false,
  platform: 'linux',
  upstreamPath: '\\\\.\\pipe\\wmux',
  ...over,
});

describe('checkUnixBridgeRequest', () => {
  it('accepts an absolute path on the distro filesystem', () => {
    expect(checkUnixBridgeRequest(req())).toBeNull();
  });

  // Each of these describes a TCP listener. Passing one next to --unix means the
  // user believes a port is being opened; quietly opening a socket instead would
  // leave them pointing a client at a port nobody listens on.
  it.each([
    ['--host', { host: '127.0.0.1' }],
    ['--wsl', { wsl: true }],
    ['--port', { portGiven: true }],
  ])('refuses --unix together with %s', (flag, over) => {
    const err = checkUnixBridgeRequest(req(over));
    expect(err).toContain('--unix');
    expect(err).toContain(flag);
  });

  it('names every clashing flag, not just the first', () => {
    const err = checkUnixBridgeRequest(req({ host: '0.0.0.0', wsl: true, portGiven: true }));
    expect(err).toContain('--host');
    expect(err).toContain('--wsl');
    expect(err).toContain('--port');
  });

  it('refuses on Windows, where Node turns a socket path into a named pipe', () => {
    expect(checkUnixBridgeRequest(req({ platform: 'win32' }))).toContain('named pipe');
  });

  it.each([[undefined], ['']])('refuses --unix with no path (%j)', (unixPath) => {
    expect(checkUnixBridgeRequest(req({ unixPath }))).toContain('takes the path');
  });

  it('refuses a relative path', () => {
    const err = checkUnixBridgeRequest(req({ unixPath: 'sock/wmux.sock' }));
    expect(err).toContain('absolute');
    expect(err).toContain('sock/wmux.sock');
  });

  // 9P (the Windows drives under /mnt) does not forward AF_UNIX, so a socket
  // there either cannot be bound or cannot be dialled. docs/DEVCONTAINER.md lists
  // that as the reason cross-boundary Unix sockets were dropped.
  it.each(['/mnt/c/Users/me/wmux.sock', '/mnt/d/wmux.sock', '/mnt/C'])('refuses %s as a 9P path', (unixPath) => {
    const err = checkUnixBridgeRequest(req({ unixPath }));
    expect(err).toContain('9P');
    expect(err).toContain('AF_UNIX');
  });

  it.each(['/mnt/wsl/wmux.sock', '/mnt/cache/wmux.sock', '/home/mnt/c/wmux.sock'])(
    'does not mistake %s for a Windows drive',
    (unixPath) => {
      expect(checkUnixBridgeRequest(req({ unixPath }))).toBeNull();
    }
  );

  it('allows a path of exactly the maximum length and refuses one byte more', () => {
    const base = '/tmp/';
    const ok = base + 'a'.repeat(MAX_UNIX_SOCKET_PATH_BYTES - base.length);
    expect(Buffer.byteLength(ok)).toBe(MAX_UNIX_SOCKET_PATH_BYTES);
    expect(checkUnixBridgeRequest(req({ unixPath: ok }))).toBeNull();
    expect(checkUnixBridgeRequest(req({ unixPath: ok + 'a' }))).toContain('bytes');
  });

  it('counts bytes, not characters, for the length limit', () => {
    // 'é' is two bytes in UTF-8: 54 of them is 108 bytes in 54 characters.
    const unixPath = '/' + 'é'.repeat(54);
    expect(unixPath.length).toBeLessThan(MAX_UNIX_SOCKET_PATH_BYTES);
    expect(Buffer.byteLength(unixPath)).toBeGreaterThan(MAX_UNIX_SOCKET_PATH_BYTES);
    expect(checkUnixBridgeRequest(req({ unixPath }))).toContain('bytes');
  });

  it('refuses the path the bridge itself relays to, which would loop', () => {
    const p = '/home/dev/.cache/wmux/sock/wmux.sock';
    const err = checkUnixBridgeRequest(req({ unixPath: p, upstreamPath: p }));
    expect(err).toContain('WMUX_PIPE');
  });
});

describe('checkSocketDir', () => {
  const dir = '/home/dev/.cache/wmux/sock';

  it('accepts a directory only its owner can write', () => {
    expect(checkSocketDir(dir, { exists: true, isDirectory: true, mode: 0o040700 })).toBeNull();
    expect(checkSocketDir(dir, { exists: true, isDirectory: true, mode: 0o040755 })).toBeNull();
  });

  it('says how to create a missing directory', () => {
    expect(checkSocketDir(dir, { exists: false, isDirectory: false, mode: 0 })).toContain('mkdir -p -m 700');
  });

  it('refuses a parent that is not a directory', () => {
    expect(checkSocketDir(dir, { exists: true, isDirectory: false, mode: 0o100600 })).toContain('not a directory');
  });

  // A socket's own mode only stops other users connecting. A directory they can
  // write to lets them swap the socket (or the mount source) for their own.
  it.each([
    ['group-writable', 0o040775],
    ['world-writable', 0o040757],
    ['sticky world-writable like /tmp', 0o041777],
  ])('refuses a %s directory', (_label, mode) => {
    const err = checkSocketDir(dir, { exists: true, isDirectory: true, mode });
    expect(err).toContain('writable by group or others');
    expect(err).toContain('chmod 700');
  });
});

describe('decideSocketPath', () => {
  const p = '/home/dev/.cache/wmux/sock/wmux.sock';

  it('listens straight away when nothing is there', () => {
    expect(decideSocketPath(p, { kind: 'absent' })).toEqual({ action: 'listen', error: null });
  });

  it('never deletes a file that is not a socket', () => {
    const d = decideSocketPath(p, { kind: 'not-a-socket' });
    expect(d.action).toBe('refuse');
    expect(d.error).toContain('not a socket');
  });

  // What a bridge killed with SIGKILL, or a WSL shutdown, leaves behind.
  it('removes a socket nobody listens on (ECONNREFUSED)', () => {
    expect(decideSocketPath(p, { kind: 'socket', probe: 'refused' })).toEqual({
      action: 'unlink-then-listen',
      error: null,
    });
  });

  it('leaves a live listener alone', () => {
    const d = decideSocketPath(p, { kind: 'socket', probe: 'listening' });
    expect(d.action).toBe('refuse');
    expect(d.error).toContain('already has a listener');
  });

  it('does not delete on a probe that proved nothing', () => {
    const d = decideSocketPath(p, { kind: 'socket', probe: 'unknown', probeError: 'EACCES' });
    expect(d.action).toBe('refuse');
    expect(d.error).toContain('EACCES');
    expect(decideSocketPath(p, { kind: 'socket', probe: 'unknown' }).error).not.toContain('(');
  });
});
