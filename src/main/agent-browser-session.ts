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
 * (Task 11) must ask `agent-browser session list` — the real ground truth —
 * never this registry, and must not assume a port this registry believes is
 * free is actually free: an orphaned process from a previous run may still be
 * bound to it.
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

export function sessionNameFor(surfaceId: SurfaceId): string {
  if (!SURFACE_ID_RE.test(surfaceId)) {
    throw new Error(`agent-browser: refusing to derive a session name from an invalid surface id: ${JSON.stringify(surfaceId)}`);
  }
  return `${WMUX_SESSION_PREFIX}${surfaceId}`;
}

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

  ensure(surfaceId: SurfaceId): AgentSession {
    const existing = this.sessions.get(surfaceId);
    if (existing) return existing;
    const streamPort = this.nextPort();
    const session: AgentSession = {
      surfaceId,
      sessionName: sessionNameFor(surfaceId),
      streamPort,
      dashboardUrl: `http://127.0.0.1:${DASHBOARD_PORT}/?port=${streamPort}`,
    };
    this.sessions.set(surfaceId, session);
    return session;
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
