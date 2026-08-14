#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
 * WMUX_SURFACE_ID (set by wmux in each pane's shell) ties the event to its pane.
 */
const net_1 = __importDefault(require("net"));
const transport_deadline_1 = require("./transport-deadline");
const argv = process.argv.slice(2);
let tool = '';
let event = '';
if (argv[0] === '--event') {
    event = argv[1] || 'Notification';
}
else {
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
    if (!spec)
        return null;
    const idx = spec.lastIndexOf(':');
    const port = idx === -1 ? NaN : parseInt(spec.slice(idx + 1), 10);
    return Number.isFinite(port) && port > 0 && port <= 65535
        ? { host: spec.slice(0, idx) || '127.0.0.1', port }
        : { host: spec, port: 9787 };
})();
const token = (remote ? process.env.WMUX_REMOTE_TOKEN : process.env.WMUX_PIPE_TOKEN) || '';
let stdinData = '';
let sent = false;
const MAX_STDIN = 64 * 1024; // 64KB cap
/**
 * Backstop ceiling on this process's lifetime once it starts talking to the
 * pipe. Every other way out of here is event-driven; this is the one that does
 * not depend on an event arriving.
 *
 * Deliberately a backstop and not a fix for an observed hang: measured against
 * an absent, a responsive and a wedged (accepts, never answers) server, the
 * hook exits on its own in every case, because on Windows named pipes `end()`
 * tears the connection down rather than half-closing it. The wmux CLI has
 * always armed this same timer before connecting (see sendV1/sendV2); the hook
 * helper was the one client without it, and matching costs nothing.
 *
 * Derived rather than written down. This used to be `remote ? 30000 : 5000` —
 * the same intent as the CLI's `deadline()` in a second spelling that did not
 * know about npiperelay, so the two could drift and only one would be found by
 * anyone changing a number. Both now ask transport-deadline.ts, describing the
 * same connection the same way.
 */
const PIPE_DEADLINE_MS = (0, transport_deadline_1.transportDeadline)(transport_deadline_1.DEFAULT_V2_TIMEOUT_MS, {
    remote: !!remote,
    pipePath,
    env: process.env,
});
/** Cleared once we stop reading, so the happy path is not held open by it. */
let stdinTimer = null;
function sendHook() {
    if (sent)
        return;
    sent = true;
    if (stdinTimer) {
        clearTimeout(stdinTimer);
        stdinTimer = null;
    }
    // stdin is a live handle that keeps the event loop alive on its own. If the
    // caller opened it and never closes it, exiting would otherwise wait on a
    // stream nobody is going to end.
    process.stdin.pause();
    let file = '';
    let message = '';
    try {
        if (stdinData.trim()) {
            const data = JSON.parse(stdinData);
            // Claude Code provides tool_input with file_path for Edit/Write.
            file = data.tool_input?.file_path
                || data.tool_input?.path
                || data.input?.file_path
                || '';
            // The Notification hook payload carries the prompt text in `message`.
            message = data.message || '';
            // PreToolUse is registered matcher-less (one entry for every tool rather
            // than one entry per tracked tool), so the tool name arrives on stdin
            // instead of on argv.
            if (!tool && typeof data.tool_name === 'string')
                tool = data.tool_name;
        }
    }
    catch {
        // stdin wasn't valid JSON — that's fine.
    }
    const params = { at: firedAt };
    if (event)
        params.event = event;
    if (tool)
        params.tool = tool;
    if (file)
        params.file = file;
    if (message)
        params.message = message;
    if (surfaceId)
        params.surfaceId = surfaceId;
    const client = net_1.default.connect(remote ? { host: remote.host, port: remote.port } : { path: pipePath }, () => {
        const msg = JSON.stringify({ method: 'hook.event', params, id: 1, token });
        client.write(msg + '\n', () => client.end());
        // Drain the reply we do not care about. This is not cosmetic: wmux answers
        // but never closes the connection (pipe-server.ts), and a socket left in
        // paused mode never reads far enough to see EOF — so it never emits 'end',
        // never auto-destroys, and never emits 'close'. Without this the deadline
        // below becomes the ONLY way out and every hook takes the full 5s.
        client.resume();
    });
    // Referenced, not unref'd: it has to be able to fire while the pending socket
    // is what is holding the loop open. 'close' covers both a clean end and a
    // destroy, so the happy path clears it immediately rather than lingering.
    const deadline = setTimeout(() => {
        client.destroy();
        process.exit(0);
    }, PIPE_DEADLINE_MS);
    client.on('close', () => clearTimeout(deadline));
    client.on('error', () => {
        // wmux not running — silently ignore.
        clearTimeout(deadline);
        process.exit(0);
    });
}
// Read stdin (Claude Code pipes the hook payload as JSON).
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (stdinData.length < MAX_STDIN)
    stdinData += chunk; });
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
if (process.stdin.readableEnded)
    sendHook();
