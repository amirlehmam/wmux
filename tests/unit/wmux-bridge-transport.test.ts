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

// Spawn `node wmux.js bridge --wsl --port <port>` and resolve once it logs that
// it is listening. Returns the child so the test can kill it in afterEach.
function startBridge(port: number, env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BRIDGE_SCRIPT, 'bridge', '--wsl', '--port', String(port)], { env });
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

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('relays TCP ↔ a Unix-socket upstream when WMUX_PIPE is a /path', async () => {
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

  it('relays TCP ↔ npiperelay.exe stdio when running inside WSL2', async () => {
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
  it('delivers a frame from a client that closes immediately, even to a slow relay', async () => {
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

    it('spawns relays before any client connects, and refills after one is claimed', async () => {
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

    it('spawns nothing ahead of time when WMUX_BRIDGE_WARM=0', async () => {
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
