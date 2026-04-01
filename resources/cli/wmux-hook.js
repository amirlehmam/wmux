#!/usr/bin/env node
"use strict";
/**
 * wmux hook helper — sends a hook event to the wmux pipe.
 * Called by Claude Code PostToolUse hooks.
 * Usage: node wmux-hook.js <tool-name>
 *
 * Reads stdin for tool details (Claude Code pipes JSON with tool_input).
 * For Edit/Write tools, extracts file_path and sends it along.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const net_1 = __importDefault(require("net"));
const tool = process.argv[2] || 'unknown';
const pipePath = '\\\\.\\pipe\\wmux';

let stdinData = '';
let sent = false;
const MAX_STDIN = 64 * 1024; // 64KB cap

function sendHook() {
    if (sent) return;
    sent = true;

    let file = '';
    try {
        if (stdinData.trim()) {
            const data = JSON.parse(stdinData);
            // Claude Code provides tool_input with file_path for Edit/Write
            file = data.tool_input?.file_path
                || data.tool_input?.path
                || data.input?.file_path
                || '';
        }
    } catch {
        // stdin wasn't valid JSON — that's fine
    }

    const params = { tool };
    if (file) params.file = file;

    const client = net_1.default.connect({ path: pipePath }, () => {
        const msg = JSON.stringify({ method: 'hook.event', params, id: 1 });
        client.write(msg + '\n', () => client.end());
    });
    client.on('error', () => {
        // wmux not running — silently ignore
        process.exit(0);
    });
}

// Read stdin (Claude Code pipes tool input/output as JSON)
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (stdinData.length < MAX_STDIN) stdinData += chunk; });
process.stdin.on('end', sendHook);
process.stdin.on('error', sendHook);

// Timeout: if no stdin arrives within 1s, send without file info
setTimeout(sendHook, 1000);

// If stdin is already ended (e.g., no pipe)
if (process.stdin.readableEnded) sendHook();
