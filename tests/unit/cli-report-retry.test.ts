import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

/**
 * The real shipped CLI, against a pipe that fails the first connection and
 * answers the second. This is the path a session report takes during a restore
 * burst: the first attempt gets a busy/reset answer, the retry lands.
 *
 * It runs `resources/cli/wmux.js` rather than importing src/cli/wmux.ts because
 * that is the file the plugin actually executes.
 */
const CLI = path.resolve(__dirname, '../../resources/cli/wmux.js');
const SESSION = 'ses_e4ec0000000000000000000000';

function runCli(socketPath: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CLI,
      'report-session', SESSION,
      '--provider', 'opencode',
      '--surface', 'surf-retry-test',
    ], {
      env: {
        ...process.env,
        WMUX_PIPE: socketPath,
        WMUX_PIPE_TOKEN: 'test-token',
        WMUX_SURFACE_ID: 'surf-retry-test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout }));
  });
}

describe('report-session against a busy pipe', () => {
  it('asks again after the first connection is reset', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cli-retry-'));
    const socketPath = path.join(dir, 'pipe.sock');
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      if (connections === 1) {
        // Close before reading the request, like a busy named pipe. The client
        // sees no reply and retries the idempotent report.
        socket.destroy();
        return;
      }
      socket.on('data', () => {
        socket.write(JSON.stringify({ id: 1, result: { accepted: true } }) + '\n');
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.on('error', reject);
        server.listen(socketPath, () => resolve());
      });

      const { code, stdout } = await runCli(socketPath);

      expect(code).toBe(0);
      expect(stdout).toContain('"accepted": true');
      expect(connections).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
