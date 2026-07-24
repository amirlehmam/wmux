// ─── TRACE mode signal derivation ────────────────────────────────────────────
// Pure functions mapping real wmux signals onto the visual vocabulary of the
// TRACE sidebar mode. No React, no store, no DOM — so the rules that decide
// "is this agent working, stuck, or lying to me" are unit-testable on their own.
//
// Design rule for this whole file: every output must be derivable from a signal
// that already exists. Nothing here invents activity, and nothing animates at a
// constant rate independent of state — a spinner that spins whether or not work
// is happening is a lie, and this sidebar exists to be believed.

/**
 * Tool channels. Bound to `lastTool`, which the Claude Code hook writes as a
 * closed vocabulary, so the mapping is exhaustive rather than heuristic.
 *
 * This is the payload of the mode: at a glance you can tell an agent that is
 * *rewriting your code* from one that is only reading it, without reading a
 * single word.
 */
export type ToolChannel = 'ingest' | 'mutate' | 'exec' | 'delegate';

const CHANNEL_BY_TOOL: Readonly<Record<string, ToolChannel>> = {
  // Reading the world — cheap, reversible, and by far the most common.
  read: 'ingest',
  grep: 'ingest',
  glob: 'ingest',
  webfetch: 'ingest',
  websearch: 'ingest',
  notebookread: 'ingest',
  ls: 'ingest',
  // Changing your files — the only channel that leaves a diff behind.
  edit: 'mutate',
  write: 'mutate',
  multiedit: 'mutate',
  notebookedit: 'mutate',
  // Running things — the channel that can take minutes and emit nothing.
  bash: 'exec',
  bashoutput: 'exec',
  killshell: 'exec',
  // Handing work to something else.
  task: 'delegate',
  agent: 'delegate',
  skill: 'delegate',
};

/**
 * Channel for a raw tool name, or null when the tool is unknown.
 *
 * Returning null rather than a fallback channel is deliberate: an unrecognised
 * tool renders in the neutral bus colour, so a future tool name shows up as
 * "working, channel unknown" instead of being silently miscoloured as a read.
 */
export function toolChannel(tool: string | null | undefined): ToolChannel | null {
  if (!tool) return null;
  const key = tool.toLowerCase().replace(/^mcp__.*?__/, '');
  return CHANNEL_BY_TOOL[key] ?? (tool.toLowerCase().startsWith('mcp__') ? 'delegate' : null);
}

/** How long a hook/observer signal counts as fresh before it starts decaying. */
export const FRESH_MS = 5_000;
/** Past this, a session is presumed stuck rather than working. */
export const STALE_MS = 45_000;

/**
 * Confidence that a session is *actually* working right now, 0..1.
 *
 * Drives the bus brightness. The point is that "working" is not a boolean: a
 * hung agent and a busy agent both report `working: true`, and the difference
 * between them is the single most useful thing this sidebar can tell you.
 * A bus that visibly dims over 45s is a stuck agent reporting itself as stuck,
 * instead of glowing at full brightness forever.
 */
export function liveness(lastSeen: number, now: number): number {
  if (!lastSeen) return 0;
  const age = now - lastSeen;
  if (age <= FRESH_MS) return 1;
  if (age >= STALE_MS) return 0;
  return 1 - (age - FRESH_MS) / (STALE_MS - FRESH_MS);
}

/** Bounds for the flow animation period, in milliseconds. */
export const FLOW_FASTEST_MS = 420;
export const FLOW_SLOWEST_MS = 2600;

/**
 * Period of the travelling-dash animation on the bus, from the observed tool
 * rate (tool calls per second).
 *
 * The clamp floor matters more than the ceiling. PostToolUse fires *after* a
 * tool completes, so a three-minute `npm test` legitimately emits zero events
 * for three minutes. Without a floor the bus — the element the whole mode is
 * named for — would go dark during the longest real work in the session. A
 * working session therefore never flows slower than FLOW_SLOWEST_MS; going
 * fully dark is reserved for sessions that are genuinely not working.
 */
export function flowDurationMs(toolsPerSecond: number): number {
  if (!Number.isFinite(toolsPerSecond) || toolsPerSecond <= 0) return FLOW_SLOWEST_MS;
  const period = 1000 / toolsPerSecond;
  return Math.min(FLOW_SLOWEST_MS, Math.max(FLOW_FASTEST_MS, period));
}

/** Everything TRACE needs to render one session's bus segment. */
export interface TraceState {
  /** No motion at all when false — an idle row declares zero animations. */
  live: boolean;
  /** 0..1 brightness; below 1 means the signal is going stale. */
  lit: number;
  /** Animation period for the travelling dashes. */
  flowMs: number;
  channel: ToolChannel | null;
  /** Waiting on the user (permission / input) — urgent, and NOT the same as idle. */
  blocked: boolean;
  /** Hooks have never reported for this session: we cannot know what it's doing. */
  noTelemetry: boolean;
}

export interface TraceInput {
  working: boolean;
  tool: string | null;
  /** Monotonic per-session tool counter from the Claude Code hook. */
  toolCount: number;
  lastSeen: number;
  /** Previous sample, for rate derivation. */
  prev?: { toolCount: number; at: number };
  blockedSince?: number | null;
  now: number;
}

/**
 * Fold the live signals for one session into its render state.
 *
 * Ordering of the states is a claim about urgency: blocked outranks working,
 * because an agent waiting on your permission is the one thing in this sidebar
 * that only you can unblock — the original design rendered it as the calmest
 * state on screen, which is exactly backwards.
 */
export function traceState(input: TraceInput): TraceState {
  const { working, tool, toolCount, lastSeen, prev, blockedSince, now } = input;

  // Never any hook traffic for this session. Rendering a confident "idle" here
  // would be a lie: wmux shipped a build where the hook script was missing from
  // the package entirely (issue #81), and a broken install looked exactly like
  // a quiet one. This state is drawn dashed, not solid.
  const noTelemetry = toolCount === 0 && !lastSeen;

  if (blockedSince) {
    return { live: true, lit: 1, flowMs: FLOW_SLOWEST_MS, channel: null, blocked: true, noTelemetry };
  }

  if (!working) {
    return { live: false, lit: 0, flowMs: FLOW_SLOWEST_MS, channel: null, blocked: false, noTelemetry };
  }

  let toolsPerSecond = 0;
  if (prev && now > prev.at && toolCount > prev.toolCount) {
    toolsPerSecond = ((toolCount - prev.toolCount) * 1000) / (now - prev.at);
  }

  return {
    live: true,
    lit: liveness(lastSeen, now),
    flowMs: flowDurationMs(toolsPerSecond),
    channel: toolChannel(tool),
    blocked: false,
    noTelemetry,
  };
}
