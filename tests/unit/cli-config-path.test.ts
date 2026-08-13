import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

/**
 * `wmux config path` used to build the path client-side:
 *
 *   console.log(`${os.homedir()}\\.wmux\\config.toml`)
 *
 * Run from inside WSL or a devcontainer — where this CLI spends most of its
 * life, reaching wmux over the TCP bridge — that prints
 * `/home/vscode\.wmux\config.toml`: neither the file wmux reads (it lives on the
 * Windows host) nor a well-formed path on either OS. Someone editing "the config
 * file" at that path is editing nothing, which is a long way to walk before
 * finding out why a setting had no effect.
 *
 * The instance already knows: loadUserConfig() records the real path and
 * `config.get` returns it. Exercised against the shipped resources/cli/wmux.js,
 * because that is the file a released wmux actually runs.
 */

const CLI = path.resolve(__dirname, '../../resources/cli/wmux.js');
const WINDOWS_PATH = 'C:\\Users\\lsi2abt\\.wmux\\config.toml';

let server: net.Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

/**
 * A wmux instance that answers `config.get` and nothing else, over the same
 * newline-delimited JSON-RPC the real pipe server speaks.
 */
function startFakeInstance(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let req: { id?: unknown; method?: string; token?: string };
          try { req = JSON.parse(line); } catch { continue; }
          if (req.token !== token) {
            sock.write(JSON.stringify({ id: req.id, error: 'unauthorized' }) + '\n');
            continue;
          }
          const result = req.method === 'config.get'
            ? { path: WINDOWS_PATH, errors: [], terminal: { fontSize: 13 } }
            : {};
          sock.write(JSON.stringify({ id: req.id, result }) + '\n');
        }
      });
      sock.on('error', () => { /* client hangs up after its one call */ });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

// Async, not spawnSync: the fake instance lives in this process, and a blocking
// spawn would stop its event loop from ever accepting the CLI's connection —
// every call would "fail to reach an instance" and take the fallback.
function runCli(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, HOME: '/home/vscode', ...env },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
}

describe('wmux config path', () => {
  it("prints the instance's own path, not one rebuilt from the local $HOME", async () => {
    const port = await startFakeInstance('tok');
    const out = await runCli(['config', 'path'], {
      WMUX_REMOTE: `127.0.0.1:${port}`,
      WMUX_REMOTE_TOKEN: 'tok',
    });
    expect(out).toBe(WINDOWS_PATH);
  });

  it('agrees with what `config show` reports', async () => {
    // The two disagreeing is exactly the failure: `show` was right all along,
    // so a user comparing them had one true answer and one plausible fiction.
    const port = await startFakeInstance('tok');
    const env = { WMUX_REMOTE: `127.0.0.1:${port}`, WMUX_REMOTE_TOKEN: 'tok' };
    const shown = JSON.parse(await runCli(['config', 'show'], env)) as { path: string };
    expect(await runCli(['config', 'path'], env)).toBe(shown.path);
  });

  it('falls back to a well-formed local path when no instance answers', async () => {
    // Still a guess, but a self-consistent one: path.join on POSIX cannot emit
    // the `/home/vscode\.wmux\config.toml` hybrid the old string template did.
    const out = await runCli(['config', 'path'], {
      WMUX_REMOTE: '127.0.0.1:1',
      WMUX_REMOTE_TOKEN: 'tok',
    });
    expect(out).toBe(path.join('/home/vscode', '.wmux', 'config.toml'));
    expect(out).not.toContain('\\');
  });
});
