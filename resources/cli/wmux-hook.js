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
 * WMUX_SURFACE_ID (set by wmux in each pane's shell) ties the event to its pane.
 */
const net_1 = __importDefault(require("net"));
const argv = process.argv.slice(2);
let tool = '';
let event = '';
if (argv[0] === '--event') {
    event = argv[1] || 'Notification';
}
else {
    tool = argv[0] || 'unknown';
}
const pipePath = process.env.WMUX_PIPE || '\\\\.\\pipe\\wmux';
const token = process.env.WMUX_PIPE_TOKEN || '';
const surfaceId = process.env.WMUX_SURFACE_ID || '';
let stdinData = '';
let sent = false;
const MAX_STDIN = 64 * 1024; // 64KB cap
function sendHook() {
    if (sent)
        return;
    sent = true;
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
        }
    }
    catch {
        // stdin wasn't valid JSON — that's fine.
    }
    const params = {};
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
    const client = net_1.default.connect({ path: pipePath }, () => {
        const msg = JSON.stringify({ method: 'hook.event', params, id: 1, token });
        client.write(msg + '\n', () => client.end());
    });
    client.on('error', () => {
        // wmux not running — silently ignore.
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
setTimeout(sendHook, 1000);
// If stdin is already ended (e.g. no pipe), send immediately.
if (process.stdin.readableEnded)
    sendHook();
