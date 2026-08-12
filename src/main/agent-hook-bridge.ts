/**
 * Claude Code hooks → declared agent state (issue #128).
 *
 * The protocol in agent-state.ts is agent-agnostic: anything that can write a
 * line of JSON to the wmux pipe can drive it. But Claude Code is what most wmux
 * panes actually run, and wmux ALREADY configures four of its hooks in
 * ~/.claude/settings.json (see ensureClaudeHooks in claude-context.ts):
 *
 *   PostToolUse   — a tool just finished running
 *   Notification  — Claude Code wants the user's attention
 *   Stop          — the turn is over
 *   SubagentStop  — one parallel subagent finished
 *
 * Translating those into report_agent calls means the "which pane needs me?"
 * signal works for Claude Code with zero install: no plugin, no wrapper, no
 * opt-in. Other agents (OpenCode, custom harnesses) call the pipe directly.
 *
 * These hooks are lifecycle truth from the agent process itself, which is the
 * same reasoning that made hooks — not output parsing — authoritative for the
 * sidebar's agent lines (issue #81 class).
 */

import { SurfaceId } from '../shared/types';
import { getAgentState, reportAgent, releaseAgent, ReportAgentParams } from './agent-state';

/** The hook events wmux registers. */
export type ClaudeHookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionEnd';

const KNOWN_EVENTS: ClaudeHookEvent[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'SessionEnd',
];

/**
 * Which event a `hook.event` wire payload denotes, or null for one outside the
 * model.
 *
 * This exists because the payload does not always say. `wmux-hook.js` is
 * invoked two ways (see its usage block): `--event <Event>` for the lifecycle
 * hooks, and a bare `<tool-name>` for the per-tool PostToolUse entries
 * claude-context.ts installs — and the bare form sends `{ tool }` with NO
 * `event` field. Reading `params.event` directly therefore admits every
 * lifecycle event while silently dropping every PostToolUse, which makes the
 * `case 'PostToolUse'` below unreachable.
 *
 * Since 0.48.0 that is no longer catastrophic — matcher-less `PreToolUse`
 * declares the run at the START of every tool, so a pane still reads `working`.
 * What is lost is the other end: PostToolUse is the event that says a tool
 * FINISHED without the turn ending, and it is the one report that arrives
 * during the stretch between approving a permission prompt and the turn
 * closing. Dropping it also drops the freshness stamp that keeps a long turn
 * inside the trust window, so a turn spent in tracked tools ages out of
 * `working` on nothing but the clock.
 *
 * Resolved here rather than by teaching the hook helper to send `event`: hooks
 * are written into settings.json once at install, so the bare-tool form is
 * already out in every existing config and will keep arriving from helper
 * vintages this build does not control. The main process is the single place
 * that sees every payload regardless of who produced it.
 */
export function hookEventName(
  params: { event?: unknown; tool?: unknown } | null | undefined,
): ClaudeHookEvent | null {
  const explicit = typeof params?.event === 'string' ? params.event.trim() : '';
  if (explicit) {
    return KNOWN_EVENTS.includes(explicit as ClaudeHookEvent) ? (explicit as ClaudeHookEvent) : null;
  }
  // No event named, but a tool did run — that is PostToolUse by construction,
  // since it is the only hook wmux registers by bare tool name.
  const tool = typeof params?.tool === 'string' ? params.tool.trim() : '';
  return tool ? 'PostToolUse' : null;
}

/**
 * What the pane had already declared when a hook arrived.
 *
 * Only `Notification` reads it, and only to tell a real prompt from the ~60s
 * idle nudge — see that case for why the discriminator is state and not text.
 */
export interface HookTurnContext {
  /**
   * Whether this pane has a declared record at all. Absent means wmux has
   * observed nothing about the turn — a main process restarted mid-turn sees
   * exactly this — so `runDepth` is a default, not an observation.
   */
  known: boolean;
  /** The pane's current declared run refcount. */
  runDepth: number;
  /**
   * Whether the turn-opening hooks are known to be firing at all. False means
   * `runDepth` carries no information about turn boundaries, so nothing may be
   * concluded from it.
   */
  turnStartTracked: boolean;
}

/**
 * Map one Claude Code hook event to a report_agent payload, or null to ignore it.
 *
 * The original four events (issue #128) were all *terminal* — a tool finished, a
 * turn finished, a subagent finished. Nothing said when work STARTED, so the
 * entire stretch between the user pressing Enter and the first tool completing
 * resolved to `idle`, which for a turn that thinks for a minute or runs one long
 * command is most of the turn (issue #151). The three opening events below are
 * the missing half of the lifecycle.
 */
export function hookToAgentReport(
  event: ClaudeHookEvent,
  message: string | null,
  ctx: HookTurnContext,
): ReportAgentParams | null {
  switch (event) {
    // Claude Code just started (launch, resume, /clear, /compact). Nothing is
    // running yet, and that is precisely the point: registering the pane as a
    // known agent session at depth 0 is what makes it read `idle` instead of
    // inheriting the shell's verdict. `claude` is a foreground command, so shell
    // integration correctly calls the pane "running" for the entire life of the
    // session — a brand-new session that has done nothing showed "Running" with
    // no session state to outrank it (issue #151).
    case 'SessionStart':
      return { awaitingHuman: false, runDepth: 0 };

    // The human just sent a message. Two facts in one event, and both matter:
    // the turn is now in flight (no tool has run yet, so nothing else would say
    // so), and whatever the pane was waiting to be told, it has now been told.
    // This is the event that ends a "needs you" the moment the user replies,
    // rather than whenever the next tool happens to finish.
    case 'UserPromptSubmit':
      return { awaitingHuman: false, runDepth: 1 };

    // A tool is about to run. Fires BEFORE the permission check, so it cannot
    // clear a prompt that has not appeared yet — its job is the long tool: a
    // three-minute test run reported nothing at all until it finished.
    case 'PreToolUse':
      return { awaitingHuman: false, runDepth: 1 };

    // Claude Code wants the user. This fires for two different situations: a
    // permission/question prompt, and the ~60s "Claude is waiting for your
    // input" idle nudge it arms when a turn ends.
    //
    // Only the first is `blocked`. "Needs you" claims there is something to
    // answer, and after a turn has ended there is nothing — the pane is idle,
    // and saying otherwise is how a pane nobody has touched starts asking for
    // attention a minute after it goes quiet. Observed exactly that way: Stop
    // at T, nudge at T+60s, on a session that had just been /clear'd and left
    // alone. /clear wipes the transcript but not Claude Code's idle timer, so
    // the nudge landed on an empty conversation and the pane said "Needs you".
    //
    // The two are told apart by STATE, not by the message text. Sniffing the
    // text was considered and rejected: it would stop working the day Claude
    // Code rewords a prompt, and would fail in the dangerous direction (a real
    // permission prompt read as "not blocked"). Run depth cannot drift that way
    // — a prompt can only occur inside a live turn, and both UserPromptSubmit
    // and PreToolUse declare depth 1 before Claude Code can ask anything, so
    // depth 0 at Notification time means the turn is over, which means nudge.
    //
    // Gated on `turnStartTracked` because that argument only holds while the
    // opening hooks are firing. A settings.json written before 0.48.0 carries
    // only the four terminal hooks, sits at depth 0 through an entire turn, and
    // would read every real prompt as a nudge — the dangerous direction again.
    // Until wmux has seen one opening event it declines to draw the distinction
    // and parks the pane for both, exactly as it did before.
    //
    // Gated on `known` for the same reason at the pane level. A pane wmux holds
    // no record for has a depth of 0 by DEFAULT, not by observation — which is
    // what a main process restarted in the middle of someone's turn sees, and
    // what a prompt arriving before any other hook on that pane sees. Reading
    // that as "the turn is over" would swallow a real prompt.
    //
    // This is the other half of noteHumanInput's bargain in agent-state.ts.
    // That code clears a block when the human types, and leans on "if the
    // keystroke didn't satisfy the agent, the 60-second nudge puts the pane
    // back to asking" — which is only sound if the nudge cannot ALSO invent a
    // block on a pane that is simply idle. It now cannot.
    case 'Notification':
      if (ctx.known && ctx.turnStartTracked && ctx.runDepth === 0) return null;
      return { awaitingHuman: true, reason: message };

    // A tool finished, so a turn is in flight — and nobody is parked on a
    // prompt, because a pending permission dialog would have stopped the tool
    // from running at all.
    //
    // Absolute runDepth rather than a delta: this fires on EVERY tool call and
    // nothing decrements per-call, so `runDelta: +1` would climb forever. An
    // absolute value is idempotent — five hundred tool calls still leave the
    // depth at 1.
    case 'PostToolUse':
      return { awaitingHuman: false, runDepth: 1 };

    // One parallel subagent finished — and the parent turn is, by construction,
    // still running: it has a result to read, and Claude Code fires the parent's
    // `Stop` after every subagent has stopped.
    //
    // This used to decrement the refcount, which was wrong in the way that
    // produced the loudest half of issue #151. Subagent hooks inherit the
    // parent's WMUX_SURFACE_ID, so all of them report to ONE pane: three
    // subagents' PostToolUse events each pin the depth to the absolute value 1,
    // and then the FIRST SubagentStop drains it to 0 — the pane reads `idle`
    // with the parent and two siblings still working. A refcount only survives
    // contact with reality when every increment is paired, and these are not
    // paired; the parent's `Stop` is the pairing, and it is already decisive.
    case 'SubagentStop':
      return { awaitingHuman: false, runDepth: 1 };

    // The turn is over: nothing can still be running and nothing can still be
    // waiting on the user. Decisive on purpose — this is the backstop that
    // guarantees no ghost state survives a turn even if an earlier event was
    // dropped, the same role Stop already plays for the sidebar's agent lines
    // (issue #81 class).
    case 'Stop':
      return { awaitingHuman: false, runDepth: 0 };

    // The session is over — handled by release, not by a report. See below.
    case 'SessionEnd':
      return null;

    default:
      return null;
  }
}

/** The events that prove the turn-opening hooks are installed and firing. */
const TURN_START_EVENTS: ClaudeHookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse'];

/**
 * Whether any pane has ever delivered one of the turn-opening hooks.
 *
 * Deliberately global rather than per-surface: what it is really asking is
 * "does ~/.claude/settings.json carry the 0.48.0 hook set", and that is one
 * file for every pane. A per-surface flag would answer the narrower "has THIS
 * pane opened a turn yet", which is false for a pane whose very first turn
 * opens with a permission prompt — and would then mis-gate it. One opening
 * event anywhere proves the hooks are live everywhere.
 *
 * Starts false, so a fresh main process parks the pane for every Notification
 * until it has that proof. Safe direction, and it self-corrects on the first
 * turn anyone starts.
 */
let turnStartTracked = false;

/** Test seam: forget what this module has learned about the hook config. */
export function resetHookBridge(): void {
  turnStartTracked = false;
}

/**
 * Apply a Claude Code hook event to the declared agent state for `surfaceId`.
 * Called from the hook.event pipe handler in index.ts.
 *
 * `hookAt` is the wall-clock the hook helper stamped at process start. Each hook
 * is its own node process and they race to the pipe, so without it a slow
 * `PostToolUse` can land after the `Stop` it preceded and re-assert a run that
 * has ended (issue #151).
 */
export function applyHookToAgentState(
  surfaceId: SurfaceId,
  event: string,
  message: string | null,
  hookAt?: number,
): void {
  if (!KNOWN_EVENTS.includes(event as ClaudeHookEvent)) return;
  const hookEvent = event as ClaudeHookEvent;

  if (TURN_START_EVENTS.includes(hookEvent)) turnStartTracked = true;

  // Claude Code exited. Forgetting the pane is right where clearing it is not:
  // a record set to `idle` is a CLAIM, and the sidebar ranks a declared state
  // above its own inference — so an ended session would pin the pane idle
  // forever. Dropping it hands the pane back to the shell's own state.
  if (hookEvent === 'SessionEnd') {
    releaseAgent(surfaceId);
    return;
  }

  const state = getAgentState(surfaceId);
  const params = hookToAgentReport(hookEvent, message, {
    known: state !== undefined,
    runDepth: state?.runDepth ?? 0,
    turnStartTracked,
  });
  if (!params) return;
  reportAgent(surfaceId, { ...params, hookAt });
}
