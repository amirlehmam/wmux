#!/usr/bin/env node
/**
 * wmux hook helper — sends a hook event to the wmux pipe.
 * Called by Claude Code hooks (PostToolUse, Notification, Stop, SubagentStop).
 *
 * Usage:
 *   node wmux-hook.js <tool-name>        # PostToolUse — sidebar/diff tracking
 *   node wmux-hook.js --event <Event>    # Notification/Stop fire a wmux notification;
 *                                        # Stop/SubagentStop also drive sidebar agent lifecycle
 *
 * Reads stdin for the Claude Code hook payload (JSON):
 *   - PostToolUse Edit/Write → extracts tool_input.file_path
 *   - Notification           → extracts the `message` (what the agent is waiting for)
 *   - PreToolUse             → extracts `tool_name` (registered matcher-less)
 *   - UserPromptSubmit       → extracts `prompt` (the prompt log, issue #207)
 * WMUX_SURFACE_ID (set by wmux in each pane's shell) ties the event to its pane.
 */
import net from 'net';
import { DEFAULT_V2_TIMEOUT_MS, transportDeadline } from './transport-deadline';

const argv = process.argv.slice(2);
let tool = '';
let event = '';
if (argv[0] === '--event') {
  event = argv[1] || 'Notification';
} else {
  tool = argv[0] || 'unknown';
}

/**
 * When Claude Code fired this hook, near enough (issue #151).
 *
 * Taken at process start rather than at send time because the interesting delay
 * is everything after: node boot, reading stdin, connecting to the pipe. Each
 * hook is its own process and they race, so a `PostToolUse` can reach wmux after
 * the `Stop` that followed it and re-assert a run that has already ended. wmux
 * orders reports by this stamp instead of by arrival.
 */
const firedAt = Date.now();

const pipePath = process.env.WMUX_PIPE || '\\\\.\\pipe\\wmux';
const surfaceId = process.env.WMUX_SURFACE_ID || '';

/**
 * TCP transport for a hook firing where the pipe does not exist (issue #19).
 *
 * Inside a devcontainer, Claude Code runs on Linux while wmux runs on the
 * Windows host: `\\.\pipe\wmux` is unreachable, so every hook failed silently
 * and the sidebar never left "Running". WMUX_REMOTE points at a `wmux bridge`
 * (issue #78) instead — same JSON-RPC frame, same auth, different socket. The
 * env-var form is deliberate: Claude Code owns this process's argv, so there is
 * nowhere to put a --remote flag.
 *
 * The token is the REMOTE instance's, which is not this machine's: on the
 * container side WMUX_PIPE_TOKEN is either absent or something else entirely.
 */
const remote = (() => {
  const spec = process.env.WMUX_REMOTE?.trim();
  if (!spec) return null;
  const idx = spec.lastIndexOf(':');
  const port = idx === -1 ? NaN : parseInt(spec.slice(idx + 1), 10);
  return Number.isFinite(port) && port > 0 && port <= 65535
    ? { host: spec.slice(0, idx) || '127.0.0.1', port }
    : { host: spec, port: 9787 };
})();
const token = (remote ? process.env.WMUX_REMOTE_TOKEN : process.env.WMUX_PIPE_TOKEN) || '';

let stdinData = '';
let sent = false;

/**
 * Ceiling on the hook payload this process will hold, in characters.
 *
 * It was 64 KB, set when the only things read out of stdin were short — a file
 * path, a notification message — so a payload that hit the cap lost nothing
 * anyone would miss. The prompt log (issue #207) changed that: stdin now
 * carries whatever the user typed, and a user who pastes a file into a prompt
 * reaches 64 KB routinely rather than never.
 *
 * The damage is not confined to the prompt, which is the reason this number
 * moved rather than being left alone. Cutting the payload off mid-string leaves
 * INVALID JSON, so `JSON.parse` throws for the whole object and every field
 * goes with it — including `session_id`, which is what makes `claude --resume`
 * work on a workspace restore (issue #186). Losing a prompt too large to
 * forward is tolerable; silently disabling session resume because of it is not.
 *
 * 10 MB, and still a cap rather than unbounded: stdin is a pipe of a length
 * this process does not control, so an unbounded accumulator is memory
 * exhaustion in a process the user cannot see. The size costs nothing — this
 * process reads stdin, writes one frame and exits inside ~100 ms, so the string
 * is transient next to the tens of MB a bare node process maps before running a
 * line of our code — and it is ~2500x the 4000 characters of prompt actually
 * forwarded, so any paste a human could plausibly make still parses.
 */
const MAX_STDIN = 10 * 1024 * 1024;

/**
 * Backstop ceiling on this process's lifetime once it starts talking to the
 * pipe. Every other way out of here is event-driven; this is the one that does
 * not depend on an event arriving.
 *
 * Deliberately a backstop and not a fix for an observed hang: against an absent
 * server the connect errors out, and against a responsive one the first reply
 * chunk is the exit (see sendHook) — only a wedged server (accepts, never
 * answers) ever reaches this. The wmux CLI has always armed this same timer
 * before connecting (see sendV1/sendV2); the hook helper was the one client
 * without it, and matching costs nothing.
 *
 * Derived rather than written down. This used to be `remote ? 30000 : 5000` —
 * the same intent as the CLI's `deadline()` in a second spelling that did not
 * know about npiperelay, so the two could drift and only one would be found by
 * anyone changing a number. Both now ask transport-deadline.ts, describing the
 * same connection the same way.
 */
const PIPE_DEADLINE_MS = transportDeadline(DEFAULT_V2_TIMEOUT_MS, {
  remote: !!remote,
  pipePath,
  env: process.env,
});

/** Cleared once we stop reading, so the happy path is not held open by it. */
let stdinTimer: NodeJS.Timeout | null = null;

/**
 * Pull the fields wmux cares about out of the Claude Code hook payload.
 *
 * Split out of sendHook so the transport below stays the only thing that
 * function is about — every new field extracted here used to add another branch
 * to a function that also owns socket setup, the deadline and process exit.
 */
/**
 * Longest prompt forwarded, in characters.
 *
 * The prompt is the first payload BODY this helper has ever sent beyond a
 * Notification's message, so it gets a limit of its own rather than relying on
 * the stdin cap above — which is now 10 MB and exists to keep this process from
 * eating memory, not to bound what travels the pipe. Two reasons, both: the value
 * lands in a renderer (a web context) and is held there per pane, and a pasted
 * 60 KB file would otherwise travel the pipe on every submission to be shown as
 * one truncated line. The renderer clamps again on arrival — this end cannot
 * assume the version at the other end agrees, since wmux-hook.js is written to
 * the user's ~/.claude and an old copy can outlive an upgrade.
 */
const MAX_PROMPT = 4000;

/**
 * How far into a payload that would not parse the salvage below looks, in
 * characters.
 *
 * Bounding the scan is what makes the salvage safe as well as cheap. Every
 * Claude Code hook payload puts its top-level scalar fields — `session_id`
 * first among them — in the first few hundred bytes, well ahead of `prompt`,
 * so 4 KB is an order of magnitude of headroom for the field we want. It is
 * also a wall: a user can paste a document that itself contains the characters
 * `"session_id": "..."`, and a scan of the whole payload would happily resume
 * whatever session that text names. Refusing to look past the head means the
 * only thing reachable is a real top-level key.
 *
 * If a payload ever puts `prompt` first and pushes `session_id` past 4 KB, this
 * finds nothing and we are back to today's behaviour — an empty field. Missing
 * a session id costs a `--resume`; salvaging the wrong one resumes a
 * conversation the user never asked for, so a miss is the outcome to prefer.
 */
const SESSION_ID_SCAN_CHARS = 4096;

/**
 * `"session_id": "<id>"`, and deliberately nothing else.
 *
 * NOT a hand-rolled JSON parser and not the start of one: a truncated payload
 * has no recoverable object in it, and the ONE field worth rescuing from the
 * wreckage is short, well delimited and shaped like an identifier. The value
 * class matches `CLAUDE_SESSION_ID_RE` in src/main/claude-resume.ts (which
 * re-validates it before it ever reaches a `claude --resume` command line, so
 * this end is a filter and not the security boundary), and it excludes the
 * closing quote — so the quantifier has exactly one way to stop and the match
 * is linear in the length of the window, with nothing to backtrack over.
 */
const SESSION_ID_RE = /"session_id"\s*:\s*"([A-Za-z0-9_-]{8,128})"/;

function salvageSessionId(raw: string): string {
  return SESSION_ID_RE.exec(raw.slice(0, SESSION_ID_SCAN_CHARS))?.[1] ?? '';
}

/**
 * `notification_type`'s shape: a short snake_case identifier
 * (`permission_prompt`, `idle_prompt`, ...). Anything else is dropped rather
 * than forwarded — this helper's whitelist is what keeps arbitrary payload
 * content off the pipe, and a value that is not an identifier is not one wmux
 * can act on anyway.
 */
const NOTIFICATION_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;

interface HookPayloadFields {
  file: string;
  message: string;
  sessionId: string;
  toolName: string;
  prompt: string;
  notificationType: string;
  /** Grok puts `subagentType` on events fired inside a subagent's own session. */
  subagent: boolean;
  /**
   * Claude Code's `agent_id` / `agent_type`: present only on a hook fired from
   * INSIDE a subagent (and on SubagentStart/SubagentStop), absent on the main
   * thread. They name the sidebar line under the parent pane (issue #272).
   */
  agentId: string;
  agentType: string;
}

/** An agent id or type: an identifier, never free text. Anything else is dropped. */
const AGENT_IDENT_RE = /^[\w.:@-]{1,128}$/;

function parsePayload(raw: string): HookPayloadFields {
  const out: HookPayloadFields = {
    file: '', message: '', sessionId: '', toolName: '', prompt: '', notificationType: '', subagent: false,
    agentId: '', agentType: '',
  };
  if (!raw.trim()) return out;
  let data: Record<string, any>;
  try {
    data = JSON.parse(raw);
  } catch {
    // Truncated at MAX_STDIN, or simply not JSON at all. Either way there is no
    // object to read fields off — but degrade instead of failing whole: a
    // payload whose only real problem is an oversized PROMPT (issue #207) must
    // not also cost the user `claude --resume` on their next restore (issue
    // #186), and `session_id` survives in the raw text where the rest does not.
    out.sessionId = salvageSessionId(raw);
    return out;
  }
  // Grok Build runs these same hooks out of ~/.claude/settings.json (its Claude
  // compatibility, on by default) but sends a camelCase envelope: `toolInput`,
  // `toolName`, `notificationType`. Read both spellings, or every Grok
  // `idle_prompt` — which it fires at the end of EVERY turn — loses its type
  // and is classified on message text alone (the #253 "Needs you" bug again).
  // Grok's session id is never forwarded — see the GROK_HOOK_EVENT guard in
  // sendHook, which is needed because Grok sends a snake_case `session_id` too.
  const toolInput = data.tool_input ?? data.toolInput;
  // Claude Code provides tool_input with file_path for Edit/Write.
  out.file = toolInput?.file_path || toolInput?.path || data.input?.file_path || '';
  // The Notification hook payload carries the prompt text in `message`.
  out.message = data.message || '';
  // Which KIND of Notification this is (issue #253). Claude Code fires the one
  // hook for a permission prompt and for the ~60s idle reminder alike, and only
  // the payload's `notification_type` tells them apart reliably — wmux read the
  // message alone, so an idle reminder that followed a background subagent was
  // taken for a question and the pane said "Needs you" with nothing to answer.
  const notificationType = data.notification_type ?? data.notificationType;
  if (event === 'Notification' && typeof notificationType === 'string'
      && NOTIFICATION_TYPE_RE.test(notificationType)) {
    out.notificationType = notificationType;
  }
  // PreToolUse is registered matcher-less (one entry for every tool rather than
  // one entry per tracked tool), so the tool name arrives on stdin not argv.
  const toolName = data.tool_name ?? data.toolName;
  if (typeof toolName === 'string') out.toolName = toolName;
  // Every Claude Code hook payload carries the conversation's session_id. wmux
  // parsed this payload for years and threw it away, which is the only reason
  // `AgentStateRecord.sessionId` — a slot that has always existed and is
  // documented as surviving a restart — was never populated (issue #186).
  // Forwarding it is what makes `claude --resume` possible on restore.
  if (typeof data.session_id === 'string') out.sessionId = data.session_id;
  out.subagent = typeof data.subagentType === 'string' && data.subagentType !== '';
  if (typeof data.agent_id === 'string' && AGENT_IDENT_RE.test(data.agent_id)) {
    out.agentId = data.agent_id;
    if (typeof data.agent_type === 'string' && AGENT_IDENT_RE.test(data.agent_type)) out.agentType = data.agent_type;
  }
  // UserPromptSubmit carries what the user actually typed, and wmux threw it
  // away — which is why the prompt-log features in issue #207 had no source of
  // truth for an agent pane. It cannot be recovered from the screen: an agent
  // TUI repaints over its own input box, so by the time anything looks, the
  // prompt is gone or reflowed.
  //
  // Read ONLY for that event. Every other hook payload may carry unrelated
  // fields under names that could collide, and this helper's whitelist is the
  // boundary that keeps a transcript out of the pipe.
  if (event === 'UserPromptSubmit' && typeof data.prompt === 'string') {
    out.prompt = data.prompt.slice(0, MAX_PROMPT);
  }
  return out;
}

/**
 * The event wmux is told about for the hook that fired, or null for none.
 *
 * Only Grok makes this anything but the identity. Two things differ from Claude
 * Code, and both are about whose event it is:
 *
 * - `StopCancelled` (Ctrl+C, a declined permission, the turn limit) and
 *   `StopFailure` (an API error) run INSTEAD of `Stop`, so to wmux they are the
 *   turn ending — grok-context.ts registers them for exactly that.
 *
 * - A Grok subagent runs its OWN session, and that session fires the same hooks
 *   on the parent's pane (they inherit WMUX_SURFACE_ID), marked with
 *   `subagentType`. Claude Code keeps a subagent inside the parent's session and
 *   gives its ending a name of its own, so none of this arises there. Read as
 *   the pane's own, a child's `SessionEnd` releases the pane's record while the
 *   parent is still mid-turn, and a child's `UserPromptSubmit` — its task brief,
 *   not something the user typed — clears a "Needs you" nobody answered and
 *   lands in the prompt log as a user prompt. Neither is reported. A child's
 *   turn ending is `SubagentStop`, which may sustain a turn and never end one.
 *   Its tool events and its Notifications still pass: a subagent working is the
 *   pane working, and its permission prompt is a real question on screen.
 */
function reportedEvent(fired: string, subagent: boolean): string | null {
  const turnEnd = fired === 'StopCancelled' || fired === 'StopFailure';
  if (!subagent) return turnEnd ? 'Stop' : fired;
  if (fired === 'SessionEnd' || fired === 'UserPromptSubmit') return null;
  return turnEnd ? 'SubagentStop' : fired;
}

/** The `hook.event` params: only the fields that carry something. */
function hookParams(fields: HookPayloadFields): Record<string, string | number> {
  const { file, message, sessionId, prompt, notificationType, agentId, agentType } = fields;
  const params: Record<string, string | number> = { at: firedAt };
  const optional: Record<string, string> = {
    event, tool, file, message, notificationType, prompt, agentId, agentType, surfaceId,
    // Not under Grok (it sets GROK_HOOK_EVENT on every hook process). Grok
    // 1.0.44 sends `session_id` alongside `sessionId`, and an id recorded here
    // ends up on a `claude --resume` command line at restore — naming a session
    // Claude has never seen.
    sessionId: process.env.GROK_HOOK_EVENT ? '' : sessionId,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) params[key] = value;
  }
  return params;
}

function sendHook(): void {
  if (sent) return;
  sent = true;
  if (stdinTimer) { clearTimeout(stdinTimer); stdinTimer = null; }
  // stdin is a live handle that keeps the event loop alive on its own. If the
  // caller opened it and never closes it, exiting would otherwise wait on a
  // stream nobody is going to end.
  process.stdin.pause();

  const fields = parsePayload(stdinData);
  const reported = reportedEvent(event, fields.subagent);
  // Nothing to say, so no connection either: the pipe is never opened.
  if (reported === null) process.exit(0);
  event = reported;
  if (!tool && fields.toolName) tool = fields.toolName;
  const params = hookParams(fields);

  const client = net.connect(remote ? { host: remote.host, port: remote.port } : { path: pipePath }, () => {
    const msg = JSON.stringify({ method: 'hook.event', params, id: 1, token });
    client.write(msg + '\n');
  });
  // The reply is the signal to leave, and leaving is destroy() — not end().
  //
  // This used to `end()` right after the write and drain the reply until the
  // server closed. Two things were wrong with that. wmux's server never closed
  // its side (it does now, but the hook on disk is often older than the wmux
  // it talks to, and vice versa), so the exit waited on EOF that only ever came
  // from a timer. And the timer is libuv's: on a Windows named pipe a half-close
  // arms a 50 ms `eof_timeout` (libuv src/win/pipe.c) before EOF is reported,
  // so every hook process sat ~60 ms past its reply doing nothing — 95 ms
  // measured for a hook whose pipe round trip is 1 ms; 37 ms with this. The
  // reply's content is not read: wmux acknowledges a hook.event, and there is
  // nothing this process could do with a refusal.
  //
  // The deadline is referenced, not unref'd: it has to be able to fire while the
  // pending socket is what is holding the loop open — a wmux that accepts and
  // never answers (wedged, or shutting down) is the case it is for.
  const deadline = setTimeout(() => {
    client.destroy();
    process.exit(0);
  }, PIPE_DEADLINE_MS);
  client.on('data', () => {
    clearTimeout(deadline);
    client.destroy();
    process.exit(0);
  });
  client.on('close', () => clearTimeout(deadline));
  client.on('error', () => {
    // wmux not running — silently ignore.
    clearTimeout(deadline);
    process.exit(0);
  });
}

// Read stdin (Claude Code pipes the hook payload as JSON).
process.stdin.setEncoding('utf8');
// Stop appending at the cap rather than truncating mid-chunk: what is kept is
// then a prefix of the payload, which is what the session_id salvage below
// depends on. It is still not valid JSON, and it is not meant to be.
process.stdin.on('data', (chunk) => { if (stdinData.length < MAX_STDIN) stdinData += chunk; });
process.stdin.on('end', sendHook);
process.stdin.on('error', sendHook);

// Timeout: if no stdin arrives within 1s, send without payload info.
//
// Held in a variable so sendHook can clear it (issue #139). Left armed, this
// one timer kept EVERY hook process — including the ones whose work finished in
// ~90ms — resident for the full second: measured 1049ms before, 101ms after.
// Claude Code fires a hook per tool call in every pane, so under a few busy
// agents that is a standing population of node.exe doing nothing.
stdinTimer = setTimeout(sendHook, 1000);

// If stdin is already ended (e.g. no pipe), send immediately.
if (process.stdin.readableEnded) sendHook();
