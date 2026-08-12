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
import { reportAgent, releaseAgent, ReportAgentParams } from './agent-state';

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

    // Claude Code wants the user. This fires both for permission/question
    // prompts and for the ~60s "still waiting on you" idle nudge, and we park
    // the pane for both: in either case the agent genuinely is waiting on a
    // human, which is exactly what `blocked` claims. Sniffing the message text
    // to tell the two apart was considered and rejected — it would silently
    // stop working the day Claude Code rewords a prompt, and the failure would
    // be the dangerous direction (a real prompt read as "not blocked").
    case 'Notification':
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

const KNOWN_EVENTS: ClaudeHookEvent[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'SessionEnd',
];

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

  // Claude Code exited. Forgetting the pane is right where clearing it is not:
  // a record set to `idle` is a CLAIM, and the sidebar ranks a declared state
  // above its own inference — so an ended session would pin the pane idle
  // forever. Dropping it hands the pane back to the shell's own state.
  if (event === 'SessionEnd') {
    releaseAgent(surfaceId);
    return;
  }

  const params = hookToAgentReport(event as ClaudeHookEvent, message);
  if (!params) return;
  reportAgent(surfaceId, { ...params, hookAt });
}
