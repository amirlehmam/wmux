#!/usr/bin/env node
/**
 * wmux hook helper — sends a hook event to the wmux pipe.
 * Called by Claude Code PostToolUse hooks.
 * Usage: node wmux-hook.js <tool-name>
 */
import net from 'net';

const tool = process.argv[2] || 'unknown';
const pipePath = '\\\\.\\pipe\\wmux';

const client = net.connect({ path: pipePath }, () => {
  const msg = JSON.stringify({ method: 'hook.event', params: { tool }, id: 1 });
  client.write(msg + '\n');
  setTimeout(() => client.end(), 200);
});

client.on('error', () => {
  // wmux not running — silently ignore
  process.exit(0);
});
