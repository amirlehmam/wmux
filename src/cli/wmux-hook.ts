#!/usr/bin/env node
/**
 * wmux hook helper — sends a hook event to the wmux pipe.
 * Called by Claude Code hooks (PostToolUse, Notification, Stop, SubagentStop),
 * and by the same hooks registered in Qwen Code's settings with `--provider qwen`.
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
import fs from 'fs';
import net from 'net';
import path from 'path';
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
 * Which agent registered this hook. Only Qwen Code says (qwen-context.ts writes
 * `--provider qwen` on every command it registers); everything else is Claude
 * Code, or an agent reading Claude Code's hooks (Grok).
 */
const providerIndex = argv.indexOf('--provider');
const provider = providerIndex === -1 ? '' : (argv[providerIndex + 1] ?? '');
const isQwen = provider === 'qwen';

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

// The fallback tracks WMUX_INSTANCE the way shared/instance.ts's getPipePath()
// does — restated rather than imported, because the CLI ships file by file.
const instance = process.env.WMUX_INSTANCE?.trim() ?? '';
const pipePath = process.env.WMUX_PIPE || '\\\\.\\pipe\\wmux' + (instance ? '-' + instance : '');
const surfaceId = process.env.WMUX_SURFACE_ID || '';

/**
 * Whether this hook fired in a pane of ANOTHER terminal multiplexer (#282).
 *
 * openwong2kim/wmux — a different app with the same name — also exports
 * `WMUX_SURFACE_ID` into its panes, and Claude Code runs this hook from the
 * global ~/.claude/settings.json in every session on the machine. With both
 * installed, every tool call in one of ITS panes was reported to this wmux,
 * attributed to a surface id this wmux never issued.
 *
 * A pane this wmux spawned always carries `WMUX=1` and `WMUX_PIPE` (forwarded
 * into WSL through WSLENV), and a devcontainer or ssh session reaching it over
 * the bridge carries `WMUX_REMOTE`. The other app sets none of them — it
 * strips every inherited `WMUX_*` before spawning — so a surface id with none
 * of our markers beside it is not ours. A hook with NO surface id is left to
 * behave exactly as before.
 */
function isForeignPane(env: NodeJS.ProcessEnv): boolean {
  if (!env.WMUX_SURFACE_ID) return false;
  return env.WMUX !== '1' && !env.WMUX_PIPE && !env.WMUX_REMOTE?.trim();
}
if (isForeignPane(process.env)) process.exit(0);

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
  /**
   * A shell Claude Code moved to the background (issue #276): the Bash or
   * PowerShell tool's `tool_response.backgroundTaskId`, set both for
   * `run_in_background` and for a command the user backgrounded with Ctrl+B.
   * Only a PostToolUse carries it.
   */
  bgTask: string;
  /** What that shell is for: the tool call's `description` — never its command. */
  bgTaskDetail: string;
  /**
   * Background tasks that have ENDED, comma-joined. Claude Code has no hook of
   * its own for a background shell finishing; it delivers a `<task-notification>`
   * as the next turn's input, which fires UserPromptSubmit — mid-turn too, once
   * the running tool returns. `TaskStop` ends one as well.
   */
  bgTasksEnded: string;
  /**
   * Fresh Claude Code process (SessionStart with `source: startup`). Shells
   * recorded for the pane before it belong to a process that is gone.
   */
  freshSession: boolean;
}

/** An agent id or type: an identifier, never free text. Anything else is dropped. */
const AGENT_IDENT_RE = /^[\w.:@-]{1,128}$/;

/** A background task id (`b71nbhepv`): an identifier, never free text. */
const TASK_ID_RE = /^[\w-]{1,64}$/;
const MAX_TASK_DETAIL = 120;
/** Most notifications one prompt is searched for; Claude Code batches a few at most. */
const MAX_TASK_NOTIFICATIONS = 32;
/** Tools that stop a background task by id (`TaskStop`; older spellings kept). */
const TASK_STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);

/**
 * Is this "prompt" a task notification rather than something a human typed?
 * Anchored at the start: a user pasting the tag into a sentence is a prompt.
 */
function isTaskNotification(prompt: string): boolean {
  return /^\s*<task-notification>/.test(prompt);
}

/**
 * The ids of the tasks a notification prompt reports as finished. A block whose
 * status is `running` is progress, not an ending, and is skipped.
 */
function endedTaskIds(prompt: string): string[] {
  const ids: string[] = [];
  const blocks = prompt.split('<task-notification>').slice(1, MAX_TASK_NOTIFICATIONS + 1);
  for (const block of blocks) {
    const id = /<task-id>([^<]{1,64})<\/task-id>/.exec(block)?.[1]?.trim();
    const status = /<status>([^<]{1,32})<\/status>/.exec(block)?.[1]?.trim();
    if (id && TASK_ID_RE.test(id) && status !== 'running') ids.push(id);
  }
  return ids;
}

/**
 * One line of what a background shell is for, for its sidebar line: the tool
 * call's own `description`, and never the command. A command line is where a
 * credential reliably shows up, which is why main refuses to put one in front
 * of a renderer (the `report_command` hard stop in index.ts).
 */
function taskDetail(toolInput: any): string {
  const raw = typeof toolInput?.description === 'string' ? toolInput.description : '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_DETAIL);
}

/**
 * How much of a subagent's transcript is read for notifications. The tail is
 * enough: this runs on every tool call the subagent makes, and a notification
 * is absorbed just before the call that follows it.
 */
const SUBAGENT_TAIL_BYTES = 256 * 1024;

/**
 * Where a subagent's own transcript is. `SubagentStop` names it
 * (`agent_transcript_path`); every other hook from inside a subagent carries
 * only the parent's `transcript_path`, and Claude Code keeps the subagent's
 * beside it as `<session>/subagents/agent-<agent_id>.jsonl`.
 */
function subagentTranscriptPath(data: Record<string, any>, agentId: string): string {
  const named = data.agent_transcript_path;
  if (typeof named === 'string' && path.basename(named) === `agent-${agentId}.jsonl`) return named;
  const parent = data.transcript_path;
  if (typeof parent !== 'string' || !parent.endsWith('.jsonl')) return '';
  return path.join(parent.slice(0, -'.jsonl'.length), 'subagents', `agent-${agentId}.jsonl`);
}

/** The last `max` bytes of a file, from the first whole line; '' on any error. */
function readTail(file: string, max: number): string {
  if (!file) return '';
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * Background tasks a SUBAGENT was told have ended. A shell the subagent started
 * reports back to the subagent, not to the parent: the `<task-notification>` is
 * written into the subagent's transcript, and a subagent fires no
 * UserPromptSubmit, so the path above never sees it and the shell's line
 * stayed "running" until the 12 h ghost guard. It arrives in one of two
 * records: a `queued_command` attachment (absorbed mid-turn), or a meta user
 * message whose text leads with a "[SYSTEM NOTIFICATION …]" preamble. Only
 * those are read, so a notification quoted in tool output is not taken for one.
 */
function subagentEndedTaskIds(file: string): string[] {
  const ids: string[] = [];
  for (const line of readTail(file, SUBAGENT_TAIL_BYTES).split('\n')) {
    if (!line.includes('<task-notification>')) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    const attachment = record?.attachment;
    if (attachment?.type === 'queued_command' && typeof attachment.prompt === 'string') {
      if (isTaskNotification(attachment.prompt)) ids.push(...endedTaskIds(attachment.prompt));
    } else if (record?.type === 'user' && record.isMeta === true && typeof record.message?.content === 'string') {
      ids.push(...endedTaskIds(record.message.content));
    }
  }
  // Oldest first, and a repeated id moves to its latest position, so the end of
  // the list is always the most recent endings.
  const recent = new Set<string>();
  for (const id of ids) {
    recent.delete(id);
    recent.add(id);
  }
  return [...recent];
}

function readBackgroundTasks(data: Record<string, any>, toolInput: any, toolName: unknown, out: HookPayloadFields): void {
  const response = data.tool_response ?? data.toolResponse;
  const bgId = response && typeof response === 'object' ? response.backgroundTaskId : undefined;
  if (!event && typeof bgId === 'string' && TASK_ID_RE.test(bgId)) {
    out.bgTask = bgId;
    out.bgTaskDetail = taskDetail(toolInput);
  }
  if (event === 'PreToolUse' && typeof toolName === 'string' && TASK_STOP_TOOLS.has(toolName)) {
    const stopped = toolInput?.task_id ?? toolInput?.shell_id;
    if (typeof stopped === 'string' && TASK_ID_RE.test(stopped)) out.bgTasksEnded = stopped;
  }
  if (event === 'UserPromptSubmit' && typeof data.prompt === 'string' && isTaskNotification(data.prompt)) {
    out.bgTasksEnded = endedTaskIds(data.prompt).join(',');
  }
  if (out.agentId && (event === 'PreToolUse' || event === 'SubagentStop')) {
    const ended = subagentEndedTaskIds(subagentTranscriptPath(data, out.agentId));
    if (ended.length) {
      // Keep a TaskStop from this call, then the NEWEST endings. Every hook
      // rereads the same tail, so keeping the oldest would drop a fresh ending
      // on every call until older records scrolled out of the tail.
      const stopped = out.bgTasksEnded.split(',').filter(Boolean);
      const room = MAX_TASK_NOTIFICATIONS - stopped.length;
      const newest = ended.filter((id) => !stopped.includes(id)).slice(-room);
      out.bgTasksEnded = [...stopped, ...newest].join(',');
    }
  }
  if (event === 'SessionStart' && data.source === 'startup') out.freshSession = true;
}

/**
 * Qwen Code's runtime tool ids, in the Claude spelling every consumer in wmux
 * already reads (the sidebar label, the diff refresh on Edit/Write). An id not
 * listed passes through unchanged — an unknown tool is still a tool running.
 */
const QWEN_TOOL_NAMES: Record<string, string> = {
  run_shell_command: 'Bash',
  read_file: 'Read',
  read_many_files: 'Read',
  write_file: 'Write',
  edit: 'Edit',
  replace: 'Edit',
  grep_search: 'Grep',
  search_file_content: 'Grep',
  glob: 'Glob',
  list_directory: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  task: 'Agent',
  agent: 'Agent',
  skill: 'Skill',
  todo_write: 'TodoWrite',
};

/** A Qwen session id: the strict UUID Qwen itself accepts (qwen-resume.ts). */
const QWEN_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Where Qwen Code's payload means something different from Claude Code's.
 *
 * - `tool_name` is Qwen's runtime id (`run_shell_command`), not Claude's name.
 * - `UserPromptSubmit` also fires for tool-result and hook continuations, whose
 *   `prompt` is not something a human typed. Only `submitted_prompt` is — so
 *   the prompt log reads that, and a continuation logs nothing.
 * - A subagent's events may carry `<uuid>-agent-<name>`, which is not a session
 *   `qwen --resume` can open. Only a bare UUID is forwarded, so such an event
 *   cannot overwrite the pane's real handle.
 */
function adaptQwenFields(data: Record<string, any>, out: HookPayloadFields): void {
  if (out.toolName) out.toolName = QWEN_TOOL_NAMES[out.toolName] ?? out.toolName;
  if (event === 'UserPromptSubmit') {
    out.prompt = typeof data.submitted_prompt === 'string' ? data.submitted_prompt.slice(0, MAX_PROMPT) : '';
  }
  if (!QWEN_SESSION_ID_RE.test(out.sessionId)) out.sessionId = '';
}

function parsePayload(raw: string): HookPayloadFields {
  const out: HookPayloadFields = {
    file: '', message: '', sessionId: '', toolName: '', prompt: '', notificationType: '', subagent: false,
    agentId: '', agentType: '', bgTask: '', bgTaskDetail: '', bgTasksEnded: '', freshSession: false,
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
    if (isQwen) adaptQwenFields({}, out);
    return out;
  }
  readPayloadFields(data, out);
  if (isQwen) adaptQwenFields(data, out);
  return out;
}

/** Every field wmux forwards, read off a parsed payload into `out`. */
function readPayloadFields(data: Record<string, any>, out: HookPayloadFields): void {
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
  // A task notification is Claude Code talking to itself, not the user: it is
  // read for the tasks it ends and kept out of the prompt log (#276).
  if (event === 'UserPromptSubmit' && typeof data.prompt === 'string' && !isTaskNotification(data.prompt)) {
    out.prompt = data.prompt.slice(0, MAX_PROMPT);
  }
  readBackgroundTasks(data, toolInput, toolName, out);
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
  const { file, message, sessionId, prompt, notificationType, agentId, agentType, bgTask, bgTaskDetail, bgTasksEnded } = fields;
  const params: Record<string, string | number> = { at: firedAt };
  const optional: Record<string, string> = {
    event, tool, file, message, notificationType, prompt, agentId, agentType, surfaceId,
    bgTask, bgTaskDetail, bgTasksEnded, freshSession: fields.freshSession ? '1' : '',
    // Not under Grok (it sets GROK_HOOK_EVENT on every hook process). Grok
    // 1.0.44 sends `session_id` alongside `sessionId`, and an id recorded here
    // ends up on a `claude --resume` command line at restore — naming a session
    // Claude has never seen.
    sessionId: process.env.GROK_HOOK_EVENT ? '' : sessionId,
    // Whose session id that is: main files it under this provider and restores
    // it with that agent's resume command. Absent means Claude.
    provider: isQwen ? 'qwen' : '',
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
