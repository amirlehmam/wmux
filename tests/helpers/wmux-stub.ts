import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASH_CALL_TIMEOUT_MS, forBash } from './bash-path';

/**
 * A stand-in `wmux` for testing the orchestrator's bash scripts without ever
 * reaching a real wmux. It appends each call's argv to a log, answers `ping`
 * with `pong` (or fails, with `pingFails`), and answers every other verb from a
 * per-test reply: `reply('close-surface', ...)` matches `wmux close-surface …`,
 * and `reply('layout agents', ...)` beats `reply('layout', ...)`.
 */
export interface StubReply {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

export interface WmuxStub {
  readonly dir: string;
  reply(verb: string, r: StubReply): void;
  /** argv of every call so far, one string per call, `ping` included. */
  calls(): string[];
  clearCalls(): void;
  /**
   * Run a bash snippet with the stub first on PATH and every ambient wmux
   * variable unset. Done inside the command line, not through `env:`, because a
   * WSL bash launched from Windows does not inherit the Windows environment.
   * `env` entries are assigned after the unset, so a test can opt one back in.
   */
  bash(script: string, env?: Record<string, string>): { stdout: string; stderr: string; status: number };
  /** Proves the stub is what `wmux` resolves to, so a "no call" assertion cannot pass against nothing. */
  assertReachable(): void;
}

const STUB_SCRIPT = `#!/usr/bin/env bash
dir="$(cd "$(dirname "$0")" && pwd)"
printf '%s\n' "$*" >> "$dir/calls.log"
if [ "$1" = ping ]; then
  [ -f "$dir/ping-fails" ] && exit 1
  echo pong
  exit 0
fi
for key in "$1 $2" "$1"; do
  f="$dir/replies/$(printf '%s' "$key" | tr ' ' '_')"
  if [ -f "$f" ]; then
    [ -f "$f.err" ] && cat "$f.err" >&2
    cat "$f"
    exit "$(cat "$f.exit" 2>/dev/null || echo 0)"
  fi
done
exit 0
`;

export function createWmuxStub(opts: { pingFails?: boolean } = {}): WmuxStub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-stub-'));
  fs.mkdirSync(path.join(dir, 'replies'));
  fs.writeFileSync(path.join(dir, 'wmux'), STUB_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'calls.log'), '');
  if (opts.pingFails) fs.writeFileSync(path.join(dir, 'ping-fails'), '');
  const bashDir = forBash(dir);

  const stub: WmuxStub = {
    dir,
    reply(verb, r) {
      const f = path.join(dir, 'replies', verb.replace(/ /g, '_'));
      fs.writeFileSync(f, r.stdout ?? '');
      fs.writeFileSync(`${f}.exit`, String(r.exit ?? 0));
      if (r.stderr) fs.writeFileSync(`${f}.err`, r.stderr);
    },
    calls() {
      return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
    },
    clearCalls() {
      fs.writeFileSync(path.join(dir, 'calls.log'), '');
    },
    bash(script, env = {}) {
      const assigns = Object.entries(env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(v)}; `)
        .join('');
      const full = `export PATH="${bashDir}:$PATH"; unset WMUX_CLI WMUX_SURFACE_ID WMUX_PIPE WMUX; ${assigns}${script}`;
      // Killed rather than left to block the worker: see BASH_CALL_TIMEOUT_MS.
      const r = spawnSync('bash', ['-c', full], { encoding: 'utf8', timeout: BASH_CALL_TIMEOUT_MS });
      if (r.error) throw new Error(`bash did not finish: ${r.error.message}`);
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
    },
    assertReachable() {
      const before = stub.calls().length;
      const r = stub.bash('command -v wmux >/dev/null && wmux ping');
      if (r.stdout.trim() !== 'pong' && !opts.pingFails) {
        throw new Error(`wmux stub is not what "wmux" resolves to (got ${JSON.stringify(r)})`);
      }
      if (stub.calls().length !== before + 1) {
        throw new Error('wmux stub did not log the sanity ping, so it is not reachable');
      }
      stub.clearCalls();
    },
  };
  return stub;
}

export function removeWmuxStub(stub: WmuxStub): void {
  fs.rmSync(stub.dir, { recursive: true, force: true });
}
