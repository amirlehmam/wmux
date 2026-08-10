/**
 * Stops a PTY-side error from taking the whole app down (issue #150).
 *
 * wmux runs every pane's PTY in the Electron *main* process. That makes main a
 * single point of failure that no pane can survive: a throw anywhere on the PTY
 * path doesn't kill one terminal, it kills the window, every workspace and every
 * agent mid-run. #150 reported exactly that — 12 disappearances between
 * 2026-06-27 and 2026-08-04, every one with the same Windows signature
 * (`0xc0000409` / `FAST_FAIL_FATAL_APP_EXIT`, i.e. the CRT `abort()` path) and
 * no error dialog at all.
 *
 * Two distinct routes get there. Both are inside node-pty rather than wmux,
 * which is why neither is fixable by a try/catch around our own calls, and both
 * are closed from this file.
 *
 * ── 1. The C++ throw that aborts the process ─────────────────────────────────
 *
 * node-pty's ConPTY backend reports process exit from a native watcher thread
 * through a napi ThreadSafeFunction (src/win/conpty.cc, `SetupExitCallback`):
 *
 *     auto callback = [](Napi::Env env, Napi::Function cb, ExitEvent *e) {
 *       cb.Call({Napi::Number::New(env, e->exit_code)});   // <- throws Napi::Error
 *       delete e;
 *     };
 *
 * `Napi::Function::Call` is compiled with C++ exceptions enabled, so when the
 * JS callback leaves an exception pending it does not return an error code — it
 * `throw`s a C++ `Napi::Error`. Napi method wrappers catch that and convert it
 * into a JS throw, but this lambda is invoked by the TSFN dispatcher, which has
 * no such wrapper above it. The exception unwinds off the top of the main
 * thread's stack, the CRT unhandled-exception filter calls `abort()`, and the
 * process is gone. #150 proved this from minidumps: the thrown type resolves to
 * `.?AVError@Napi@@` and the throw's image base equals the load address of
 * `conpty.node` in all eight dumps.
 *
 * The JS end of that call is `WindowsPtyAgent._$onProcessExit`, so *anything* it
 * throws is an instant process abort. It is one line under `useConptyDll: true`,
 * but the fallback branch (pty-manager retries with `useConptyDll: false` when
 * the bundled conpty.dll fails to load) touches `this._outSocket`, which is
 * exactly the sort of thing that is null when a spawn half-failed.
 *
 * We cannot patch conpty.cc — wmux ships node-pty's prebuilt binaries and never
 * compiles them. But the C++ throw is only reachable *through* a JS throw, so
 * making the JS callback total closes it: wrap `_$onProcessExit` so nothing
 * escapes it, and `cb.Call` has no pending exception to convert.
 *
 * ── 2. The JS re-throw that crashes main ─────────────────────────────────────
 *
 * Separately, node-pty's `WindowsTerminal` re-throws socket errors it doesn't
 * recognise (lib/windowsTerminal.js):
 *
 *     this._socket.on('error', err => {
 *       this._close();
 *       if (err.code) { if (~err.code.indexOf('errno 5') || ~err.code.indexOf('EIO')) return; }
 *       if (this.listeners('error').length < 2) { throw err; }   // <- uncaught
 *     });
 *
 * That runs in a libuv callback, so the throw becomes an unhandled exception in
 * main. `Terminal._forwardEvents()` only registers `data` and `exit`, so the
 * count is 0 for every PTY wmux spawns and the guard never holds. The threshold
 * is node-pty's, not ours, so `attachErrorSink` reads the live listener count
 * rather than hardcoding 2 — if node-pty changes it, this still satisfies it.
 *
 * ── On swallowing ────────────────────────────────────────────────────────────
 *
 * Both guards log and continue rather than rethrow. That is the point: an error
 * on one pane's exit path is worth a console warning, and is never worth
 * killing eleven other panes and an in-flight agent run. Nothing here hides a
 * wmux bug that used to be visible — the previous behaviour was not a stack
 * trace, it was the window vanishing.
 */

/** Marks a prototype we have already wrapped, so repeated installs are free. */
const GUARDED = Symbol.for('wmux.ptyExitCallbackGuarded');

type ExitCallbackHost = {
  _$onProcessExit?: (exitCode: number) => void;
  [GUARDED]?: boolean;
};

/**
 * Wrap `_$onProcessExit` so it cannot throw into conpty.node's TSFN callback.
 *
 * Takes the prototype rather than reaching for it, so the wrapping logic is
 * testable without node-pty (and on platforms where it has no ConPTY at all).
 * Returns whether a guard was installed: `false` means already guarded, or the
 * method is gone — a node-pty upgrade that renames it should not throw here,
 * but it must be visible to the caller, which logs it.
 */
export function guardExitCallback(
  host: ExitCallbackHost,
  onError: (err: unknown) => void = defaultOnError,
): boolean {
  if (!host || typeof host._$onProcessExit !== 'function') return false;
  if (host[GUARDED]) return false;

  const original = host._$onProcessExit;
  host._$onProcessExit = function guardedOnProcessExit(this: unknown, exitCode: number): void {
    try {
      original.call(this, exitCode);
    } catch (err) {
      // Deliberately terminal. Rethrowing re-arms the abort this exists to stop.
      onError(err);
    }
  };
  host[GUARDED] = true;
  return true;
}

function defaultOnError(err: unknown): void {
  console.warn('[wmux] node-pty exit callback threw (contained, see #150):', err);
}

/** Minimal shape of the EventEmitter side of node-pty's Terminal. */
type ErrorEmitter = {
  on(event: 'error', listener: (err: Error) => void): unknown;
  listeners(event: 'error'): unknown[];
};

/**
 * Register enough `error` listeners that node-pty stops re-throwing.
 *
 * node-pty's check is `listeners('error').length < 2`, so a single handler is
 * not enough — hence the loop, which also survives node-pty raising the
 * threshold. Capped so a misbehaving emitter can't spin forever.
 */
export function attachErrorSink(
  emitter: ErrorEmitter,
  onError: (err: Error) => void,
): number {
  let attached = 0;
  const MAX = 4;
  while (emitter.listeners('error').length < 2 && attached < MAX) {
    // Only the first gets the real handler; any extra exists purely to satisfy
    // node-pty's count, and must not report the same error twice.
    emitter.on('error', attached === 0 ? onError : () => { /* count filler */ });
    attached++;
  }
  return attached;
}

/**
 * Install the exit-callback guard on node-pty's real WindowsPtyAgent.
 *
 * Called once from pty-manager at module load. Windows-only because ConPTY is,
 * and fully defensive: this is a hardening pass, so failing to apply it must
 * never be worse than not having it.
 */
export function installPtyCrashGuard(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node-pty/lib/windowsPtyAgent') as {
      WindowsPtyAgent?: { prototype?: ExitCallbackHost };
    };
    const proto = mod?.WindowsPtyAgent?.prototype;
    if (!proto) {
      console.warn('[wmux] could not reach WindowsPtyAgent — #150 exit guard not installed');
      return false;
    }
    return guardExitCallback(proto);
  } catch (err) {
    console.warn('[wmux] #150 exit guard not installed:', err);
    return false;
  }
}
