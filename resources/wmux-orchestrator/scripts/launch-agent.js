#!/usr/bin/env node
// launch-agent.js — Launch an agent (claude by default, opencode if
// WMUX_AGENT_CMD=opencode) with the prompt from a file.
// Usage: node launch-agent.js <prompt-file>
//
// Uses execFileSync to bypass all shell quoting issues.
// The '--' separator prevents --allowedTools from eating the prompt.
// Claude starts in INTERACTIVE mode with full TUI — user can watch and intervene.

const { execFileSync } = require('child_process');
const fs = require('fs');

/** Build Claude's argv without bypassing its permission boundary by default. */
function buildClaudeArgs(prompt, env = process.env) {
  const args = [];
  if (env.WMUX_ORCHESTRATOR_SKIP_PERMISSIONS === '1') {
    args.push('--dangerously-skip-permissions');
  }
  // '--' stops Commander.js variadic flags from consuming the prompt.
  args.push('--', prompt);
  return args;
}

function main() {
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
  const agentCmd = (process.env.WMUX_AGENT_CMD || 'claude').toLowerCase();

  try {
    if (agentCmd === 'opencode') {
      // opencode run streams formatted progress; the user can watch.
      // '--' stops flag parsing from consuming the prompt.
      execFileSync('opencode', ['run', '--', prompt], { stdio: 'inherit' });
    } else {
      // NOTE: do NOT use --bare — it skips keychain/OAuth and causes "Not logged in".
      execFileSync('claude', buildClaudeArgs(prompt), { stdio: 'inherit' });
    }
  } catch (e) {
    process.exit(e.status || 1);
  }
}

if (require.main === module) main();

module.exports = { buildClaudeArgs };
