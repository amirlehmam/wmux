/**
 * surfaceId → agent-browser session.
 *
 * Sessions are EPHEMERAL: a session's process lifetime equals its surface's
 * lifetime. Nothing is persisted — no --profile dir, no --restore. That makes
 * orphan handling correct by construction rather than by heuristic: there is no
 * such thing as a legitimately-surviving wmux-owned session, so any `wmux-`
 * prefixed session with no live surface is garbage. This is the property the
 * #139 post-mortem wanted and did not have.
 *
 * wmux allocates the stream port ITSELF rather than letting agent-browser pick
 * one, because the dashboard deep-link keys on port
 * (packages/dashboard/src/store/sessions.ts reads `?port=` into activePortAtom).
 * Discovering an OS-assigned port after the fact is a race against the webview
 * load.
 *
 * IMPORTANT — this registry is NOT ground truth for what is live. `sessions`
 * and `usedPorts` are in-memory and start empty on every fresh
 * `SessionRegistry` (a new wmux process after a restart or a crash). The
 * "correct by construction" claim above holds only while THIS process stays
 * up: a `wmux-`-prefixed agent-browser session that survived a wmux crash is
 * real on the OS and completely invisible here. Reconciliation after a crash
 * therefore asks `agent-browser session list` — the real ground truth — never
 * this registry (see `reconcileOrphanSessions` in agent-browser-runtime.ts),
 * and must not assume a port this registry believes is free is actually free:
 * an orphaned process from a previous run may still be bound to it. That
 * second half is `ensureBindable` below.
 */
import type { SurfaceId } from '../shared/types';

/** agent-browser's dashboard default. */
export const DASHBOARD_PORT = 4848;

/** First stream port wmux hands out. Above the CDP proxy's 9222-9230 range. */
export const STREAM_PORT_BASE = 9300;

/**
 * Session names are prefixed so the reaper and `agent-browser session list` can
 * tell a wmux-owned session from one the user made by hand. Never close a
 * session without this prefix.
 */
export const WMUX_SESSION_PREFIX = 'wmux-';

/**
 * wmux mints surface ids itself as `surf-<uuid>`, so this should never reject
 * a real one. The check exists anyway because `sessionName` reaches a command
 * line as `--session <name>` (see agent-browser-cli.ts's `runAgentBrowser`),
 * and the same reasoning that makes `CLAUDE_SESSION_ID_RE` a security boundary
 * in claude-resume.ts applies here: an id beginning with `-` would be parsed
 * by agent-browser as a FLAG rather than a value, and an id containing
 * whitespace or a path separator could produce a session agent-browser cannot
 * address, or a state file outside its own directory. `sessionNameFor` throws
 * rather than sanitising — a surface id that does not look like one means
 * wmux's own invariants are already broken, and silently rewriting it would
 * hide that.
 *
 * Bounded at 128 characters after the `surf-` prefix, matching the same bound
 * `CLAUDE_SESSION_ID_RE` uses (`{8,128}`) for the same reason — an unbounded
 * pattern is not actually a boundary. A real wmux surface id is `surf-<uuid>`
 * (36 chars), so 128 leaves generous headroom without accepting an
 * arbitrarily long string onto a command line.
 */
export const SURFACE_ID_RE = /^surf-[A-Za-z0-9-]{1,128}$/;

/**
 * Characters a `WMUX_INSTANCE` name may contribute to a session name.
 *
 * That variable is user-supplied and this value ends up on a command line, so
 * it is filtered rather than trusted — same reasoning as `SURFACE_ID_RE`.
 * Bounded for the same reason too: an unbounded pattern is not a boundary.
 */
const INSTANCE_NAME_RE = /[^A-Za-z0-9-]/g;

/**
 * This wmux instance's session-name prefix.
 *
 * `WMUX_INSTANCE=<name>` runs wmux side by side with another wmux (the
 * documented use is a dev build alongside an installed one — see
 * shared/instance.ts, which suffixes the pipe and the APPDATA dir the same
 * way). agent-browser's session namespace is MACHINE-global and has no such
 * suffix, so without this the two instances share it — and startup
 * reconciliation, whose whole premise is "every `wmux-` session with no live
 * surface is garbage", would close the OTHER instance's live browsers. Another
 * wmux is exactly as much "not us" as a human's hand-made session is.
 *
 * The default instance is deliberately left alone (`wmux-`), so this changes
 * nothing for anyone not opting into a named instance. The two forms cannot be
 * confused in either direction because `SURFACE_ID_RE` anchors on `surf-`:
 * `wmux-dev-surf-x` read with the default prefix leaves `dev-surf-x`, which is
 * not a surface id, and `wmux-surf-x` does not start with `wmux-dev-` at all.
 *
 * Read from the environment at call time rather than captured at module load,
 * matching how `shared/instance.ts` derives its own suffix. Duplicated from
 * there rather than imported because that module's `suffix()` is private and
 * builds a different string (`-name`, for a path).
 */
export function sessionPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.WMUX_INSTANCE?.trim() ?? '';
  const name = raw.replace(INSTANCE_NAME_RE, '').slice(0, 32);
  return name ? `${WMUX_SESSION_PREFIX}${name}-` : WMUX_SESSION_PREFIX;
}

export function sessionNameFor(surfaceId: SurfaceId, env?: NodeJS.ProcessEnv): string {
  if (!SURFACE_ID_RE.test(surfaceId)) {
    throw new Error(`agent-browser: refusing to derive a session name from an invalid surface id: ${JSON.stringify(surfaceId)}`);
  }
  return `${sessionPrefix(env)}${surfaceId}`;
}

/**
 * Is this a session name wmux itself could have minted?
 *
 * The exact inverse of `sessionNameFor`, and it is a SECURITY boundary, not a
 * tidiness check. Its one consumer is startup reconciliation, which reads names
 * out of `agent-browser session list` — i.e. out of a shared, machine-global
 * namespace that any other tool or human can write into — and then puts each
 * one back on a command line as `--session <name> close`. Two rules follow, and
 * both are enforced here rather than at the call site so a second caller cannot
 * reintroduce either bug:
 *
 *   1. THIS INSTANCE's prefix must be present (`sessionPrefix`). A session
 *      without it belongs to somebody else — a human, another tool, or a
 *      side-by-side wmux — and closing it would kill a browser this process
 *      never started.
 *   2. What follows the prefix must still be a valid surface id. The prefix
 *      alone is not enough: `wmux-` is a string anyone can type, and a name
 *      like `wmux- --all` or `wmux-;rm` would reach argv. wmux only ever mints
 *      `<prefix>surf-<uuid>`, so requiring the full shape rejects nothing this
 *      process could have created while rejecting everything it could not.
 *
 * Rule 2 makes reconciliation strictly more conservative than "close anything
 * `wmux-` prefixed", which is the correct direction to err: leaking a session
 * is recoverable at the next launch, closing a stranger's browser is not.
 */
export function isWmuxSessionName(name: unknown, env?: NodeJS.ProcessEnv): boolean {
  const prefix = sessionPrefix(env);
  if (typeof name !== 'string' || !name.startsWith(prefix)) return false;
  return SURFACE_ID_RE.test(name.slice(prefix.length));
}

/** The surface a wmux session name belongs to, or undefined if it is not one. */
export function surfaceIdFromSessionName(name: string, env?: NodeJS.ProcessEnv): SurfaceId | undefined {
  return isWmuxSessionName(name, env) ? (name.slice(sessionPrefix(env).length) as SurfaceId) : undefined;
}

/**
 * How many stream ports to test before giving up and using the last candidate.
 *
 * Bounded because the probe is the only thing standing between a squatting
 * process and an unbounded scan: a machine where every port from 9300 up is
 * held (a container with a tiny ephemeral range, a firewall that refuses every
 * bind) would otherwise walk to 65535 one loopback listen at a time, on the
 * path that opens a browser pane. 16 is comfortably more than the number of
 * agent panes anyone opens, and the give-up path is degraded-but-working (see
 * `ensureBindable`), not an error.
 */
export const MAX_PORT_PROBES = 16;

/** Can a server actually bind this port right now? Injected so tests need no sockets. */
export type PortProbe = (port: number) => Promise<boolean>;

export interface AgentSession {
  surfaceId: SurfaceId;
  sessionName: string;
  streamPort: number;
  dashboardUrl: string;
}

export class SessionRegistry {
  private readonly sessions = new Map<SurfaceId, AgentSession>();
  private readonly usedPorts = new Set<number>();

  constructor(private readonly basePort: number = STREAM_PORT_BASE) {}

  private nextPort(): number {
    let p = this.basePort;
    while (this.usedPorts.has(p)) p++;
    this.usedPorts.add(p);
    return p;
  }

  private record(surfaceId: SurfaceId, streamPort: number): AgentSession {
    const session: AgentSession = {
      surfaceId,
      sessionName: sessionNameFor(surfaceId),
      streamPort,
      dashboardUrl: `http://127.0.0.1:${DASHBOARD_PORT}/?port=${streamPort}`,
    };
    this.sessions.set(surfaceId, session);
    return session;
  }

  ensure(surfaceId: SurfaceId): AgentSession {
    const existing = this.sessions.get(surfaceId);
    if (existing) return existing;
    return this.record(surfaceId, this.nextPort());
  }

  /**
   * `ensure`, but the port is one the OS agreed we could bind.
   *
   * `nextPort()` tracks only what THIS registry handed out, so a port it
   * believes is free may be held by an orphan from a previous wmux, by a second
   * wmux instance, or by an unrelated program. The session then launches with
   * `AGENT_BROWSER_STREAM_PORT=<taken>`, its stream server cannot bind, and the
   * dashboard deep-link (`?port=<streamPort>`) points at nothing — a pane that
   * renders an empty viewer with no error anywhere. Nothing downstream can
   * detect that: streaming is configured at browser LAUNCH and cannot be moved
   * afterwards (`stream enable --port` on a live session exits 1, "Streaming is
   * already enabled"), so the only cheap remedy is to not pick a bad port.
   *
   * Hence verify-before-use rather than detect-and-retry: a probe is one
   * loopback listen with no child process, while detecting after the fact costs
   * a `stream status` round trip AND a session relaunch to act on the answer.
   *
   * A rejected candidate stays in `usedPorts` deliberately: whatever is
   * squatting it will most likely still be squatting it in a minute, and
   * re-testing it for every new pane is pure waste.
   *
   * ── What this does NOT claim ──────────────────────────────────────────────
   * The probe is a point-in-time answer, so a port can still be taken between
   * the probe and agent-browser's own bind. That race is milliseconds wide;
   * the hole it replaces was "an orphan has held this port since the last
   * crash". And an ALREADY-KNOWN session short-circuits before any probing:
   * its port is bound by our own stream server, so probing it would report
   * "unbindable" and move a perfectly working pane to a port Chrome is not
   * streaming on.
   */
  async ensureBindable(
    surfaceId: SurfaceId,
    isBindable: PortProbe,
    maxProbes: number = MAX_PORT_PROBES,
  ): Promise<AgentSession> {
    const existing = this.sessions.get(surfaceId);
    if (existing) return existing;
    // Derive the name BEFORE spending any probes: an invalid surface id must
    // throw the same way `ensure` does, not after a round of socket work.
    sessionNameFor(surfaceId);

    let candidate = this.nextPort();
    for (let probes = 1; probes < Math.max(1, maxProbes); probes++) {
      if (await isBindable(candidate)) return this.record(surfaceId, candidate);
      candidate = this.nextPort();
    }
    // Out of budget. Use the last candidate anyway rather than refusing to open
    // the pane: an unbindable stream port costs the user the live viewer, while
    // failing here costs them the browser itself.
    return this.record(surfaceId, candidate);
  }

  get(surfaceId: SurfaceId): AgentSession | undefined {
    return this.sessions.get(surfaceId);
  }

  all(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /** Forget a surface's session and free its port. Caller closes the browser. */
  release(surfaceId: SurfaceId): AgentSession | undefined {
    const s = this.sessions.get(surfaceId);
    if (!s) return undefined;
    this.usedPorts.delete(s.streamPort);
    this.sessions.delete(surfaceId);
    return s;
  }

  get size(): number {
    return this.sessions.size;
  }
}
