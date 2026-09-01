/**
 * What quit has to do before the process is allowed to leave (issue #214).
 *
 * ## The crash this exists to close
 *
 * #214 reported six `0xc0000409` aborts at an identical fault offset, and read
 * as a 2.6.0 regression correlated with the file explorer. It is neither. Every
 * one of the six lands on a `will-quit` line in the reporter's own `main.log`,
 * to the second — `logDiagnostic('will-quit', …)` is the first statement in that
 * handler, so the process reached shutdown, wrote the line, and then aborted
 * inside it. Six crashes across thirteen quits, at PTY counts from 2 to 7: a
 * coin-flip race, which is exactly why no reproduction sequence was ever found.
 *
 * The mechanism was already written down, in the `session-end` comment in
 * index.ts. Every live PTY owns a node-pty ThreadSafeFunction whose ConPTY exit
 * callback runs on the main thread as `cb.Call({Napi::Number::New(env, code)})`
 * — two napi calls in a frame with no node-addon-api handler above it. Killing
 * the PTYs at `will-quit` fires all of those at once, and the process then
 * proceeds straight into Node's environment teardown. A napi call that loses
 * that race throws `Napi::Error` off the top of the stack, and the CRT's
 * unhandled-exception filter calls `__fastfail(FAST_FAIL_FATAL_APP_EXIT)` —
 * the `0xc0000409` / parameter `7` signature #150 and #214 both carry.
 *
 * `pty-crash-guard.ts` closes the route where the *JS* callback throws. It
 * cannot close this one: here JS is never reached, because the environment the
 * call needs is already going away.
 *
 * ## The two things quit does about it
 *
 * **Drain.** Hold the quit open briefly after `killAll()` so those callbacks
 * fire while the environment is still healthy. That is the strategy the
 * `session-end` comment already argues for ("it makes them fire while the
 * environment is still healthy, instead of racing its teardown"), applied to
 * the ordinary quit path rather than only to a Windows logoff.
 *
 * **Leave hard.** Whatever has *not* landed by the end of the drain must never
 * get to race the teardown either, so the deferred path finishes with
 * `app.exit()` instead of unwinding. That skips Node's environment destruction
 * altogether: there is no window left for the callback to lose.
 *
 * ## Why this is a decision function and not four `if`s in the handler
 *
 * `will-quit` is not reachable from a unit test — it needs a real Electron app
 * object, a real PTY manager and a real agent-browser daemon. The part worth
 * pinning is the *decision*: when to defer, how long to drain, and when leaving
 * hard is justified. So the decision is pure and lives here, and the handler
 * does nothing but carry it out.
 *
 * Note what the "nothing outstanding" case does: it defers nothing and exits
 * NORMALLY. A quit with no PTYs cannot hit this race, and a hard exit is not
 * free — it skips Chromium's own shutdown, which is where anything still
 * sitting in a renderer's storage would be flushed. The hard exit is a
 * treatment for a specific condition, not a new way of quitting.
 */

/**
 * How long to let outstanding ConPTY exit callbacks land before leaving.
 *
 * They fire within milliseconds of `kill()` — the native watcher thread is
 * already blocked on the child's process handle, and `taskkill /T /F` has just
 * signalled it. This is a wide margin on that, and it is the whole cost of the
 * fix: a quarter of a second on a quit that already tears down N shells.
 */
export const PTY_EXIT_DRAIN_MS = 250;

export interface QuitPlan {
  /** `preventDefault()` this pass and finish the sequence asynchronously. */
  defer: boolean;
  /** Milliseconds to let ConPTY exit callbacks land before leaving. */
  drainMs: number;
  /**
   * Leave via `app.exit()` rather than letting Electron unwind. False means
   * "let the normal shutdown happen" — either because nothing is outstanding,
   * or because a sequence that will exit is already in flight.
   */
  hardExit: boolean;
  /** Which of the three cases this is. Recorded in main.log, not shown to users. */
  reason: 'in-flight' | 'nothing-outstanding' | 'drain-ptys';
}

export function planQuit(input: {
  /** Live PTYs at the moment `will-quit` was entered — BEFORE `killAll()`. */
  ptysAtQuit: number;
  /** Are there agent-browser sessions or a dashboard still to close? */
  agentBrowserPending: boolean;
  /** Has an earlier `will-quit` pass already taken charge of finishing? */
  alreadyDeferred: boolean;
}): QuitPlan {
  // A second pass — `window-all-closed` firing `app.quit()` while the first is
  // still draining. Hold the quit, change nothing: cutting the in-flight drain
  // short is the one thing this must not do.
  if (input.alreadyDeferred) {
    return { defer: true, drainMs: 0, hardExit: false, reason: 'in-flight' };
  }

  // No PTYs and no browser sessions: no exit callbacks to race, nothing to
  // close. Quit the ordinary way.
  if (input.ptysAtQuit <= 0 && !input.agentBrowserPending) {
    return { defer: false, drainMs: 0, hardExit: false, reason: 'nothing-outstanding' };
  }

  return {
    defer: true,
    // Only PTYs need the drain. An agent-browser-only quit still leaves hard,
    // because it is already deferred and there is nothing to gain by unwinding.
    drainMs: input.ptysAtQuit > 0 ? PTY_EXIT_DRAIN_MS : 0,
    hardExit: true,
    reason: 'drain-ptys',
  };
}
