#!/usr/bin/env node
// launch-agent.js — Launch claude interactively with prompt from file
// Usage: node launch-agent.js <prompt-file>
//
// Uses execFileSync to bypass all shell quoting issues.
// The '--' separator prevents --allowedTools from eating the prompt.
// Claude starts in INTERACTIVE mode with full TUI — user can watch and intervene.

const { execFileSync } = require('child_process');
const fs = require('fs');

const promptFile = process.argv[2];
if (!promptFile) {
  console.error('Usage: node launch-agent.js <prompt-file>');
  process.exit(1);
}

if (!fs.existsSync(promptFile)) {
  console.error(`Prompt file not found: ${promptFile}`);
  process.exit(1);
}

const prompt = fs.readFileSync(promptFile, 'utf8');

try {
  // --dangerously-skip-permissions: auto-approve all tools (interactive mode)
  // '--' stops Commander.js variadic flags from consuming the prompt
  // NOTE: do NOT use --bare — it skips keychain/OAuth and causes "Not logged in"
  execFileSync('claude', [
    '--dangerously-skip-permissions',
    '--',
    prompt
  ], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
