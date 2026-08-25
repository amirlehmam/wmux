/**
 * The agent-browser observability dashboard process.
 *
 * Refcounted by the number of live agent-mode surfaces: first acquire starts
 * it, last release stops it.
 *
 * ── Adopt, never fight ────────────────────────────────────────────────────
 * If :4848 already answers when we go to start, a human (or another wmux)
 * started it. We use it and record `adopted`. An adopted dashboard is NEVER
 * stopped — not on the last release, not on shutdown. wmux did not start it, so
 * stopping it is not wmux's to do, and killing a dashboard the user is watching
 * in their own Chrome would be a genuinely baffling bug to report.
 *
 * Process control is injected so this is testable with no child processes.
 *
 * ── Scope: this only guards the DASHBOARD port ───────────────────────────
 * `probe` answers one question — is something already listening on the
 * dashboard's port (4848)? It says nothing about the PER-SESSION stream ports
 * that `agent-browser-session.ts`'s `SessionRegistry` hands out (9300+):
 * that registry tracks only the ports it has itself allocated and never
 * verifies the OS can actually bind them, so a squatting process — including
 * an orphan from a previous wmux — could make a handed-out stream port
 * unbindable. That is a real gap, but it is a Task 11 (teardown/orphan
 * cleanup) concern, not this file's. Do not assume `probe()` here covers it.
 */

export interface DaemonHooks {
  /** True when something is already listening on the dashboard port. */
  probe: () => Promise<boolean>;
  /** Start the dashboard. Returns false if it could not be started. */
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
}

export class DashboardDaemon {
  private refs = 0;
  private running = false;
  /** True when the dashboard was already up and we merely attached to it. */
  private _adopted = false;

  /**
   * (a) Concurrency guard. Two browser surfaces flipping to agent mode in the
   * same tick both see `!running && !adopted` before either has a chance to
   * act — without this, both would call `hooks.start()`. Every concurrent
   * `acquire()` instead awaits the SAME in-flight attempt, so probe/start
   * runs at most once per outage. Cleared once the attempt settles (success
   * OR failure) so the next fresh `acquire()` probes/starts again rather than
   * replaying a stale result forever.
   */
  private starting: Promise<void> | null = null;

  constructor(private readonly hooks: DaemonHooks) {}

  /** Public getter, no public setter — see (c) below the class. */
  get adopted(): boolean {
    return this._adopted;
  }

  get isAvailable(): boolean {
    return this.running || this._adopted;
  }

  /**
   * @throws when the dashboard fails to start (`hooks.start()` resolves
   * `false`, or `hooks.probe()`/`hooks.start()` itself rejects). The
   * refcount is rolled back to what it was before this call BEFORE the
   * rejection reaches the caller — see the rollback comment below — so this
   * is not void-safe: a caller that fires-and-forgets a failed `acquire()`
   * gets an unhandled rejection, not a silently-wrong refcount.
   */
  async acquire(): Promise<void> {
    this.refs++;
    if (this.running || this._adopted) return;

    if (!this.starting) {
      this.starting = this.beginStart();
    }
    const attempt = this.starting;
    try {
      await attempt;
    } catch (err) {
      // (b) A failed start must not leave a phantom ref. This call did not
      // actually obtain a running dashboard, so its increment above is
      // undone rather than left standing. Two consequences of NOT doing
      // this: `refs` would report demand this daemon cannot serve, and a
      // later `release()` — believing it is paying down a real start —
      // would either call `hooks.stop()` on nothing or, worse, silently
      // swallow the failure and leave the surface thinking a dashboard is
      // available when none is. Rolling back and rethrowing lets the caller
      // (the surface flipping into agent mode) see the failure and decide
      // whether to retry, while every OTHER concurrent caller sharing this
      // same rejected `attempt` rolls back its own increment too.
      //
      // Clamped rather than unconditional: a concurrent `release()`/
      // `shutdown()` may have already raced this refcount down to zero while
      // this same failing attempt was still in flight (they both await the
      // in-flight `starting` before deciding anything — see `settleStarting`
      // below), and an unconditional `refs--` here would then drive it to
      // -1. `refs` must never go negative; see the same clamp in `release()`.
      if (this.refs > 0) this.refs--;
      throw err;
    }
  }

  private async beginStart(): Promise<void> {
    try {
      if (await this.hooks.probe()) {
        // Adopt: see file header. Never our dashboard to stop.
        this._adopted = true;
        return;
      }
      const ok = await this.hooks.start();
      if (!ok) {
        throw new Error('agent-browser: dashboard failed to start');
      }
      this.running = true;
    } finally {
      this.starting = null;
    }
  }

  /**
   * If there is an in-flight `acquire()` attempt, wait for it to settle
   * before `release()`/`shutdown()` decide whether there is anything to
   * stop. Without this, both read `running`/`adopted` while an attempt is
   * still probing/starting, see neither flag set yet, and conclude "nothing
   * to do" — and then the attempt settles a moment later with ZERO live
   * refs, having started a dashboard nothing will ever stop. Via
   * `shutdown()` specifically this is a leaked child process that outlives
   * wmux entirely: shutdown runs at app quit, and there is no later
   * opportunity to notice.
   *
   * A rejected attempt (failed start) is swallowed here, not rethrown: a
   * failed start means there is nothing running to stop, which is exactly
   * the outcome `release()`/`shutdown()` want — they must not fail teardown
   * over a start attempt that never succeeded in the first place. `acquire()`
   * is the one place that surfaces the rejection to a caller.
   */
  private async settleStarting(): Promise<void> {
    if (!this.starting) return;
    try {
      await this.starting;
    } catch {
      // Nothing started; nothing to stop. See doc comment above.
    }
  }

  async release(): Promise<void> {
    // Clamp at zero. A double-release — e.g. an unmount racing a surface
    // close — must not drive the count negative and strand a running
    // dashboard that a later, legitimate release can never reach zero on.
    if (this.refs > 0) this.refs--;
    if (this.refs > 0) return;

    await this.settleStarting();

    // Re-check: a new acquire() may have arrived (and been credited) while
    // we were waiting for the in-flight attempt above to settle. If so, that
    // acquire is now relying on the dashboard staying up — this release must
    // not stop it out from under it.
    if (this.refs > 0) return;

    if (this.running && !this._adopted) {
      await this.hooks.stop();
      this.running = false;
    }
  }

  /** Teardown on app quit. Ignores the refcount; still respects adoption. */
  async shutdown(): Promise<void> {
    this.refs = 0;

    // Must not return before a start that was in flight at quit time is
    // accounted for — see `settleStarting`'s doc comment. There is no later
    // opportunity: this is the last thing that runs before the process exits.
    await this.settleStarting();

    if (this.running && !this._adopted) {
      await this.hooks.stop();
      this.running = false;
    }
  }
}

// (c) `adopted` is exposed only via the getter above. There is deliberately no
// setter: anything holding this daemon that could write `d.adopted = false`
// could then make `release()`/`shutdown()` stop a dashboard wmux does not
// own — exactly the outcome the "adopt, never fight" rule exists to prevent.
// TypeScript already refuses `d.adopted = x` at compile time (no setter in
// the type); the class field being private additionally means a `(d as
// any).adopted = x` escape hatch fails too, since `_adopted` is what actually
// holds the value and `adopted` (the accessor) has no setter to invoke.
