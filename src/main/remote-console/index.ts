/**
 * The Remote Console facade (#254): the only module the rest of main imports.
 *
 * The implementation (`./runtime`) is loaded LAZILY with a bare `require`, the
 * idiom cli-paths.ts and agent-instructions.ts already use. Two reasons. It
 * keeps the console's server, ws and crypto work off startup for the (default)
 * user who never turns it on. And tsc does not resolve a bare `require()`, so
 * main compiles whether or not the runtime is present — a `typeof
 * import('./runtime')` here would fail the build until it is.
 *
 * A missing runtime is logged as `remote-console-missing` and answered with
 * `null`, never a throw into startup. That makes a packaging miss SILENT to the
 * user, which is why release.yml checks for `runtime.js` in the packaged asar.
 */
import type { RemoteV2Status } from '../../shared/remote-console-config';
import { DEFAULT_REMOTE_CONFIG } from '../../shared/remote-console-config';
import type { ConsoleOps, CreateRemoteConsoleRuntime, RemoteConsoleRuntime } from './contract';

type RuntimeModule = { createRemoteConsoleRuntime: CreateRemoteConsoleRuntime };

const defaultLoader = (): RuntimeModule => require('./runtime') as RuntimeModule;

let loadRuntime: () => RuntimeModule = defaultLoader;
let runtime: RemoteConsoleRuntime | null = null;

/**
 * Only the FIRST line of Node's message names the module that is missing; the
 * rest is the "Require stack", which lists runtime.js itself whenever one of
 * ITS dependencies (`ws`, say) is the thing absent from the asar. Matching the
 * whole message therefore filed "runtime shipped, its dependency did not" as
 * "runtime not shipped" — the two faults this function exists to tell apart.
 */
function isMissingRuntime(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code !== 'MODULE_NOT_FOUND' || typeof e.message !== 'string') return false;
  return e.message.split('\n', 1)[0].includes("'./runtime'");
}

export function initRemoteConsole(ops: ConsoleOps): RemoteConsoleRuntime | null {
  if (runtime) return runtime;
  let mod: RuntimeModule;
  try {
    mod = loadRuntime();
  } catch (err) {
    if (isMissingRuntime(err)) {
      ops.log('remote-console-missing', {});
    } else {
      // Present but broken (a dependency missing from the asar, a syntax error):
      // a different fault from "not shipped", so it gets a different line.
      ops.log('remote-console-load-failed', { message: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
  try {
    runtime = mod.createRemoteConsoleRuntime(ops);
  } catch (err) {
    ops.log('remote-console-load-failed', { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  return runtime;
}

export function getRemoteConsole(): RemoteConsoleRuntime | null {
  return runtime;
}

/** What `remote.status` answers when there is no runtime: off, and nothing to count. */
export function disabledV2Status(): RemoteV2Status {
  return {
    enabled: false,
    running: false,
    bind: DEFAULT_REMOTE_CONFIG.bind,
    port: DEFAULT_REMOTE_CONFIG.port,
    publicUrl: '',
    deviceCount: 0,
    connectedCount: 0,
    lastError: null,
  };
}

/**
 * The console's ONLY pipe surface: read-only `remote.status` (I2). Pairing,
 * enabling, rebinding and revoking have no pipe method on purpose — a process
 * holding the pipe token (A3) must not be able to mint itself a phone.
 */
export function handleRemoteConsoleV2(
  method: string,
  _params: unknown,
  respond: (result: unknown) => void,
  respondError: (code: number, message: string) => void,
): void {
  if (method === 'remote.status') {
    respond(runtime?.v2Status() ?? disabledV2Status());
    return;
  }
  respondError(-32601, 'Unknown: ' + method);
}

/** Tests only: swap the loader (vitest cannot `require` a .ts runtime) and drop the singleton. */
export function __resetRemoteConsoleForTests(loader?: () => RuntimeModule): void {
  runtime = null;
  loadRuntime = loader ?? defaultLoader;
}
