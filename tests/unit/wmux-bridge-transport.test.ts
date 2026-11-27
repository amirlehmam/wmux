import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Exercises the real compiled wmux.js (resources/cli/wmux.js) `bridge` command
// end-to-end. `wmux bridge` is a pure byte relay: it accepts TCP connections and
// forwards them to the local wmux via connectTransport(). This verifies the two
// non-TCP transport branches the bridge must pick between:
//   * WMUX_PIPE=/path        → Unix-socket upstream
//   * inside WSL2            → spawn npiperelay.exe and use its stdio
// so a `wmux bridge` running inside WSL2 reaches the Windows-host named pipe.

const BRIDGE_SCRIPT = path.resolve(__dirname, '../../resources/cli/wmux.js');

// Bind to :0 to discover a free port, then release it for the bridge to reuse.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Spawn `node wmux.js bridge --port <port>` and resolve once it logs that it is
// listening. Returns the child so the test can kill it in afterEach.
//
// Deliberately without --wsl. Every test here connects over 127.0.0.1, so the
// flag only ever chose the bind ADDRESS, which is a separate question from the
// upstream transport these tests are about — and it is now a claim the CLI
// verifies against the running environment rather than a synonym for "bind
// 0.0.0.0". Passing it here would make the suite fail wherever it happens to run
// outside a real WSL2 distro, for reasons unrelated to what is being asserted.
// The bind decision has its own table test in wsl-network.test.ts.
function startBridge(port: number, env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BRIDGE_SCRIPT, 'bridge', '--port', String(port)], { env });
    const timer = setTimeout(() => reject(new Error('bridge did not start listening in time')), 5000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`bridge exited early (code ${code})`)); });
  });
}

// Round-trip a payload through the bridge: connect over TCP, send, and collect
// whatever the (echoing) upstream sends back.
function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(payload));
    let received = '';
    sock.on('data', (chunk) => { received += chunk.toString(); });
    sock.on('end', () => resolve(received));
    sock.on('close', () => resolve(received));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(received); }, 2000);
  });
}

describe('wmux bridge transport selection (WSL2 devcontainer path)', () => {
  const cleanups: Array<() => void> = [];
  // Only a Linux process can be inside a WSL2 distro. `WSLENV` alone is not proof: Windows Terminal sets it
  // (`WT_SESSION:WT_PROFILE_ID:`) for every Windows profile, and a Windows process that reads it as "WSL2" runs
  // the tests below with a `#!/usr/bin/env node` fake it cannot execute, then talks to the user's real wmux pipe.
  const isWslRuntime = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSLENV);

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  // The one thing about --wsl that a pure function cannot cover: whether the
  // environment probe reads what it thinks it reads. chooseBridgeHost() is given
  // `inWsl2`; readWslEnvironment() is what has to produce it, from
  // /proc/sys/kernel/osrelease and the interop vars, on the real machine.
  //
  // Worth an end-to-end assertion because the obvious spelling of that probe is
  // wrong in a way that is easy to ship: a Linux container on a Windows host runs
  // on the WSL2 KERNEL, so its osrelease says "microsoft-standard-WSL2" while it
  // is emphatically not a WSL2 distro with a Windows host to reach. Matching
  // osrelease alone would bind 0.0.0.0 in every devcontainer on Windows. The
  // interop vars are what tell the two apart — and this suite runs in exactly
  // that container, so the case is covered rather than imagined.
  it.skipIf(isWslRuntime || process.platform === 'win32')('refuses --wsl outside a WSL2 distro rather than binding 0.0.0.0', async () => {
    const port = await freePort();
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn('node', [BRIDGE_SCRIPT, 'bridge', '--wsl', '--port', String(port)], {
        env: { ...process.env, WMUX_REMOTE: '', WMUX_PIPE: '' } as Record<string, string>,
      });
      let err = '';
      child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('error', reject);
      child.on('exit', (c) => resolve({ code: c, stderr: err }));
    });

    expect(code).toBe(1);
    // Naming what it looked for, so the failure is actionable rather than a bare
    // refusal the user has to guess at.
    expect(stderr).toContain('--wsl');
    expect(stderr).toMatch(/osrelease|WSL_INTEROP|WSL_DISTRO_NAME/);
    // And it must point at the way forward, not just the way blocked.
    expect(stderr).toContain('--host');
  });

  it.skipIf(process.platform === 'win32')('relays TCP ↔ a Unix-socket upstream when WMUX_PIPE is a /path', async () => {
    // Stand-in for the local pipe: a Unix-socket echo server.
    const sockPath = path.join(os.tmpdir(), `wmux-bridge-test-${process.pid}.sock`);
    try { fs.unlinkSync(sockPath); } catch { /* not present */ }
    const upstream = net.createServer((c) => c.pipe(c)); // echo
    await new Promise<void>((r) => upstream.listen(sockPath, r));
    cleanups.push(() => { upstream.close(); try { fs.unlinkSync(sockPath); } catch { /* gone */ } });

    const port = await freePort();
    // WMUX_PIPE starting with '/' selects the Unix-socket branch regardless of
    // WSL detection, so this branch needs no fake npiperelay. WMUX_REMOTE must
    // be cleared: it takes precedence (TCP) and is set when this suite itself
    // runs inside a wmux devcontainer.
    const child = await startBridge(port, {
      ...process.env,
      WMUX_REMOTE: '',
      WMUX_REMOTE_TOKEN: '',
      WMUX_PIPE: sockPath,
    } as Record<string, string>);
    cleanups.push(() => child.kill());

    const echoed = await roundTrip(port, 'ping-unix\n');
    expect(echoed).toContain('ping-unix');
  });

  it.skipIf(!isWslRuntime)('relays TCP ↔ npiperelay.exe stdio when running inside WSL2', async () => {
    // Fake npiperelay.exe: ignores its args (-ei -s //./pipe/wmux) and echoes
    // stdin→stdout, standing in for the Windows named pipe over interop.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-npiperelay-'));
    const fakeBin = path.join(binDir, 'npiperelay.exe');
    fs.writeFileSync(fakeBin, '#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout);\n');
    fs.chmodSync(fakeBin, 0o755);
    cleanups.push(() => fs.rmSync(binDir, { recursive: true, force: true }));

    const port = await freePort();
    // WSL_DISTRO_NAME set + WMUX_PIPE cleared (falls back to the \\.\pipe\wmux
    // default, which is not a '/path') selects the npiperelay branch;
    // findNpiperelay() picks up our fake via PATH.
    const child = await startBridge(port, {
      ...process.env,
      WMUX_PIPE: '',
      WMUX_REMOTE: '',
      WSL_DISTRO_NAME: 'test-distro',
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    } as Record<string, string>);
    cleanups.push(() => child.kill());

    const echoed = await roundTrip(port, 'ping-npiperelay\n');
    expect(echoed).toContain('ping-npiperelay');
  });

  // Regression: the bridge used to destroy BOTH sides on either 'close', so a
  // client that wrote a frame and closed immediately — which is exactly what
  // wmux-hook.js does for every Claude Code hook — had its frame killed inside a
  // still-draining npiperelay relay (the Duplex's destroy() is child.kill()). The
  // hook exited 0, the sidebar never updated, and nothing logged an error.
  //
  // Measured against a live bridge before the fix, delivery depended purely on how
  // long the client held the socket open relative to the ~7s pipe round-trip:
  //     end() after 0ms ✗   2000ms ✗   6000ms ~   9000ms ✓
  // 0ms is what the hook actually does, hence the bug.
  it.skipIf(!isWslRuntime)('delivers a frame from a client that closes immediately, even to a slow relay', async () => {
    // Fake npiperelay that takes its time, standing in for a real one that needs
    // seconds to attach to the Windows pipe over WSL interop. It records what it
    // received to a file, so the assertion is "the upstream actually got the
    // bytes" rather than "a reply came back" — pre-fix the relay is killed before
    // either could happen.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-slowrelay-'));
    const fakeBin = path.join(binDir, 'npiperelay.exe');
    const received = path.join(binDir, 'received.txt');
    const RELAY_DELAY_MS = 1500;
    fs.writeFileSync(
      fakeBin,
      '#!/usr/bin/env node\n' +
        "const fs = require('fs');\n" +
        "let buf = '';\n" +
        "process.stdin.on('data', (d) => { buf += d; });\n" +
        // Forward only once stdin has been ENDED and the delay has elapsed. A
        // bridge that kills us on client close never gets here.
        "process.stdin.on('end', () => {\n" +
        `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(received)}, buf); process.stdout.write(buf); }, ${RELAY_DELAY_MS});\n` +
        '});\n'
    );
    fs.chmodSync(fakeBin, 0o755);
    cleanups.push(() => fs.rmSync(binDir, { recursive: true, force: true }));

    const port = await freePort();
    const child = await startBridge(port, {
      ...process.env,
      WMUX_PIPE: '',
      WMUX_REMOTE: '',
      WSL_DISTRO_NAME: 'test-distro',
      // Comfortably longer than RELAY_DELAY_MS, short enough to keep the suite
      // quick. Pinned rather than inherited so the test does not depend on the
      // shipped default.
      WMUX_BRIDGE_DRAIN_MS: '8000',
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    } as Record<string, string>);
    cleanups.push(() => child.kill());

    // The bug trigger: write one frame, then close at once without awaiting a reply.
    const frame = JSON.stringify({ method: 'hook.event', params: { event: 'Notification' }, id: 1 });
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.write(frame + '\n', () => sock.end());
      });
      sock.on('close', () => resolve());
      sock.on('error', reject);
    });

    // Poll rather than sleep a fixed span, so a fast machine finishes early and a
    // slow one still gets its full window.
    const deadline = Date.now() + RELAY_DELAY_MS + 6000;
    let got = '';
    while (Date.now() < deadline) {
      if (fs.existsSync(received)) {
        got = fs.readFileSync(received, 'utf-8');
        if (got.includes('hook.event')) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(got).toContain('hook.event');
  }, 20000);

  // The other half of the devcontainer latency problem: the bridge used to spawn a
  // fresh npiperelay.exe per connection, so every hook paid the exec (AV/EDR-scanned
  // on a corporate host) plus the pipe dial — ~7s measured. The pool spawns relays
  // ahead of demand so a client gets one already attached.
  describe('warm relay pool', () => {
    // Fake npiperelay that records each spawn to a log file, then echoes. Counting
    // the log is how the test distinguishes "pre-warmed" from "spawned on demand".
    function makeCountingRelay(): { binDir: string; spawnLog: string } {
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-warm-'));
      const spawnLog = path.join(binDir, 'spawns.log');
      fs.writeFileSync(
        path.join(binDir, 'npiperelay.exe'),
        '#!/usr/bin/env node\n' +
          `require('fs').appendFileSync(${JSON.stringify(spawnLog)}, 'x');\n` +
          'process.stdin.pipe(process.stdout);\n'
      );
      fs.chmodSync(path.join(binDir, 'npiperelay.exe'), 0o755);
      return { binDir, spawnLog };
    }

    const spawnCount = (logPath: string): number =>
      (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').length : 0);

    async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !fn()) await new Promise((r) => setTimeout(r, 50));
    }

    it.skipIf(!isWslRuntime)('spawns relays before any client connects, and refills after one is claimed', async () => {
      const { binDir, spawnLog } = makeCountingRelay();
      cleanups.push(() => fs.rmSync(binDir, { recursive: true, force: true }));

      const port = await freePort();
      const child = await startBridge(port, {
        ...process.env,
        WMUX_PIPE: '',
        WMUX_REMOTE: '',
        WSL_DISTRO_NAME: 'test-distro',
        WMUX_BRIDGE_WARM: '2',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      } as Record<string, string>);
      cleanups.push(() => child.kill());

      // Pre-warm happens in the listen callback — no client has connected yet.
      await waitFor(() => spawnCount(spawnLog) >= 2);
      expect(spawnCount(spawnLog)).toBe(2);

      // The warm relay must be a working transport, not just a spawned process.
      expect(await roundTrip(port, 'ping-warm\n')).toContain('ping-warm');

      // Claiming one triggers a replacement, so the next client is served warm too.
      await waitFor(() => spawnCount(spawnLog) >= 3);
      expect(spawnCount(spawnLog)).toBe(3);
    }, 20000);

    it.skipIf(!isWslRuntime)('spawns nothing ahead of time when WMUX_BRIDGE_WARM=0', async () => {
      const { binDir, spawnLog } = makeCountingRelay();
      cleanups.push(() => fs.rmSync(binDir, { recursive: true, force: true }));

      const port = await freePort();
      const child = await startBridge(port, {
        ...process.env,
        WMUX_PIPE: '',
        WMUX_REMOTE: '',
        WSL_DISTRO_NAME: 'test-distro',
        WMUX_BRIDGE_WARM: '0',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      } as Record<string, string>);
      cleanups.push(() => child.kill());

      await new Promise((r) => setTimeout(r, 500));
      expect(spawnCount(spawnLog)).toBe(0);

      // Opting out restores spawn-per-connection, which must still work.
      expect(await roundTrip(port, 'ping-cold\n')).toContain('ping-cold');
      expect(spawnCount(spawnLog)).toBe(1);
    }, 20000);
  });
});

// `wmux bridge --unix <path>`: the same bridge, listening on a Unix socket instead
// of a TCP port. A container that has the socket's directory bind-mounted dials it
// with the clients it already has (WMUX_PIPE=<path> is the Unix-socket branch of
// connectTransport), so nothing about the networking mode matters. The rules for
// where it may listen are table-tested in bridge-unix.test.ts; these are the
// behaviours that need a real process and a real socket file.
describe.skipIf(process.platform === 'win32')('wmux bridge --unix', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  const makeDir = (mode = 0o700): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-unix-'));
    fs.chmodSync(dir, mode);
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  // Stand-in for the local pipe. It records every line it receives, answers a
  // V1 `ping` the way wmux does, and echoes anything else.
  async function startUpstream(dir: string): Promise<{ sockPath: string; lines: string[] }> {
    const sockPath = path.join(dir, 'upstream.sock');
    const lines: string[] = [];
    const server = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          lines.push(line);
          c.write(line.endsWith('ping') ? 'pong\n' : line + '\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    cleanups.push(() => server.close());
    return { sockPath, lines };
  }

  const bridgeEnv = (upstream: string): Record<string, string> => ({
    ...process.env,
    WMUX_PIPE: upstream,
    WMUX_REMOTE: '',
    WMUX_REMOTE_TOKEN: '',
  } as Record<string, string>);

  function startUnixBridge(args: string[], env: Record<string, string>): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [BRIDGE_SCRIPT, 'bridge', ...args], { env });
      const timer = setTimeout(() => reject(new Error('bridge did not start listening in time')), 5000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('listening')) {
          clearTimeout(timer);
          resolve(child);
        }
      });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`bridge exited early (code ${code})`)); });
    });
  }

  function runToExit(args: string[], env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [BRIDGE_SCRIPT, 'bridge', ...args], { env });
      let err = '';
      child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stderr: err }));
    });
  }

  const exited = (child: ChildProcess): Promise<number | null> =>
    new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  function socketRoundTrip(sockPath: string, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ path: sockPath }, () => sock.write(payload));
      let received = '';
      sock.on('data', (chunk) => { received += chunk.toString(); });
      sock.on('end', () => resolve(received));
      sock.on('close', () => resolve(received));
      sock.on('error', reject);
      setTimeout(() => { sock.destroy(); resolve(received); }, 2000);
    });
  }

  it('relays a Unix-socket client to the upstream, with no port opened', async () => {
    const dir = makeDir();
    const { sockPath: upstream } = await startUpstream(dir);
    const sock = path.join(dir, 'wmux.sock');
    const child = await startUnixBridge(['--unix', sock], bridgeEnv(upstream));
    cleanups.push(() => child.kill());

    expect(await socketRoundTrip(sock, 'hello-unix\n')).toContain('hello-unix');
  });

  it('creates the socket mode 0600, whatever the umask of the parent shell', async () => {
    const dir = makeDir();
    const { sockPath: upstream } = await startUpstream(dir);
    const sock = path.join(dir, 'wmux.sock');
    const child = await startUnixBridge(['--unix', sock], bridgeEnv(upstream));
    cleanups.push(() => child.kill());

    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  });

  // The container-side claim: an unmodified client, given only WMUX_PIPE and
  // WMUX_PIPE_TOKEN, reaches wmux through the bridge's socket. `wmux ping` is the
  // plain CLI, so no change on the client side is involved.
  it('serves the stock CLI with WMUX_PIPE=<socket> and WMUX_PIPE_TOKEN, token intact', async () => {
    const dir = makeDir();
    const { sockPath: upstream, lines } = await startUpstream(dir);
    const sock = path.join(dir, 'wmux.sock');
    const child = await startUnixBridge(['--unix', sock], bridgeEnv(upstream));
    cleanups.push(() => child.kill());

    const out = await new Promise<string>((resolve, reject) => {
      const cli = spawn('node', [BRIDGE_SCRIPT, 'ping'], {
        env: { ...process.env, WMUX_PIPE: sock, WMUX_PIPE_TOKEN: 'sekret-token', WMUX_REMOTE: '', WMUX_REMOTE_TOKEN: '' } as Record<string, string>,
      });
      let stdout = '';
      cli.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
      cli.on('error', reject);
      cli.on('exit', () => resolve(stdout));
    });

    expect(out.trim()).toBe('pong');
    // The bridge is a byte relay: the token the client sent is what the upstream saw.
    expect(lines).toContain('auth sekret-token ping');
  });

  it('prints the container-side environment on start', async () => {
    const dir = makeDir();
    const { sockPath: upstream } = await startUpstream(dir);
    const sock = path.join(dir, 'wmux.sock');
    const lines: string[] = [];
    const child = spawn('node', [BRIDGE_SCRIPT, 'bridge', '--unix', sock], { env: bridgeEnv(upstream) });
    cleanups.push(() => child.kill());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ready line')), 5000);
      child.stdout.on('data', (c: Buffer) => {
        lines.push(c.toString());
        if (lines.join('').includes('Ctrl+C')) { clearTimeout(timer); resolve(); }
      });
    });
    const out = lines.join('');
    expect(out).toContain(`listening on unix:${sock}`);
    expect(out).toContain('WMUX_PIPE=');
    expect(out).toContain('WMUX_PIPE_TOKEN=');
    expect(out).not.toContain('WMUX_REMOTE');
  });

  it('removes its socket file on SIGTERM', async () => {
    const dir = makeDir();
    const { sockPath: upstream } = await startUpstream(dir);
    const sock = path.join(dir, 'wmux.sock');
    const child = await startUnixBridge(['--unix', sock], bridgeEnv(upstream));
    expect(fs.existsSync(sock)).toBe(true);

    const done = exited(child);
    child.kill('SIGTERM');
    expect(await done).toBe(0);
    expect(fs.existsSync(sock)).toBe(false);
  });

  // What SIGKILL, a crash, or a WSL shutdown leaves behind: a socket file with no
  // process behind it. The next start must take it over, not fail on EADDRINUSE.
  it('takes over a stale socket whose bridge was killed', async () => {
    const dir = makeDir();
    const { sockPath: upstream } = await startUpstream(dir);
    const sock = path.join(dir, 'wmux.sock');
    const first = await startUnixBridge(['--unix', sock], bridgeEnv(upstream));
    const killed = exited(first);
    first.kill('SIGKILL');
    await killed;
    expect(fs.existsSync(sock)).toBe(true); // proof the file really is stale

    const second = await startUnixBridge(['--unix', sock], bridgeEnv(upstream));
    cleanups.push(() => second.kill());
    expect(await socketRoundTrip(sock, 'after-restart\n')).toContain('after-restart');
  });

  it('refuses a path that already has a live listener, and leaves that listener serving', async () => {
    const dir = makeDir();
    const { sockPath: upstream } = await startUpstream(dir);
    const sock = path.join(dir, 'wmux.sock');
    const first = await startUnixBridge(['--unix', sock], bridgeEnv(upstream));
    cleanups.push(() => first.kill());

    const { code, stderr } = await runToExit(['--unix', sock], bridgeEnv(upstream));
    expect(code).toBe(1);
    expect(stderr).toContain('already has a listener');
    expect(await socketRoundTrip(sock, 'still-up\n')).toContain('still-up');
  });

  it('never deletes a regular file at the path', async () => {
    const dir = makeDir();
    const { sockPath: upstream } = await startUpstream(dir);
    const file = path.join(dir, 'wmux.sock');
    fs.writeFileSync(file, 'precious');

    const { code, stderr } = await runToExit(['--unix', file], bridgeEnv(upstream));
    expect(code).toBe(1);
    expect(stderr).toContain('not a socket');
    expect(fs.readFileSync(file, 'utf-8')).toBe('precious');
  });

  // The socket is removed on exit only while it is still the bridge's own. A
  // bridge started later on the same path has replaced it, and deleting that one
  // would cut off its clients.
  it('does not delete a socket that replaced its own', async () => {
    const dir = makeDir();
    const { sockPath: upstream } = await startUpstream(dir);
    const sock = path.join(dir, 'wmux.sock');
    const child = await startUnixBridge(['--unix', sock], bridgeEnv(upstream));

    fs.unlinkSync(sock);
    const replacement = net.createServer();
    await new Promise<void>((r) => replacement.listen(sock, r));
    cleanups.push(() => replacement.close());

    const done = exited(child);
    child.kill('SIGTERM');
    await done;
    expect(fs.existsSync(sock)).toBe(true);
  });

  it.each([
    ['--host', ['--host', '127.0.0.1']],
    ['--wsl', ['--wsl']],
    ['--port', ['--port', '9999']],
  ])('refuses --unix together with %s without opening anything', async (flag, extra) => {
    const dir = makeDir();
    const sock = path.join(dir, 'wmux.sock');
    const { code, stderr } = await runToExit(['--unix', sock, ...extra], bridgeEnv('/nonexistent'));
    expect(code).toBe(1);
    expect(stderr).toContain(flag);
    expect(fs.existsSync(sock)).toBe(false);
  });

  it('refuses a socket on a Windows drive mount, naming 9P', async () => {
    const { code, stderr } = await runToExit(['--unix', '/mnt/c/Users/me/wmux.sock'], bridgeEnv('/nonexistent'));
    expect(code).toBe(1);
    expect(stderr).toContain('9P');
  });

  it('refuses a directory that group or others can write to', async () => {
    const dir = makeDir(0o775);
    const { code, stderr } = await runToExit(['--unix', path.join(dir, 'wmux.sock')], bridgeEnv('/nonexistent'));
    expect(code).toBe(1);
    expect(stderr).toContain('writable by group or others');
  });

  it('refuses a missing directory and says how to make it', async () => {
    const dir = makeDir();
    const { code, stderr } = await runToExit(['--unix', path.join(dir, 'missing', 'wmux.sock')], bridgeEnv('/nonexistent'));
    expect(code).toBe(1);
    expect(stderr).toContain('mkdir -p -m 700');
  });
});
