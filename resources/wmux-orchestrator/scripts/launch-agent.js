#!/usr/bin/env node
// launch-agent.js — Launch an agent with the prompt from a file.
// Set WMUX_AGENT_CMD to pick one: claude (default), opencode, or omp.
// Usage: node launch-agent.js <prompt-file>
//
// Uses execFileSync to bypass all shell quoting issues.
// The '--' separator prevents --allowedTools from eating the prompt.
// Claude starts in INTERACTIVE mode with full TUI — user can watch and intervene.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Resolve an agent executable to an absolute path before running it.
 *
 * Launching by bare name leaves resolution to the OS at exec time, against
 * whatever PATH this pane happened to inherit — so any writable directory
 * earlier in the order shadows the real binary. That matters more here than in
 * most scripts: this one exists to hand a coding agent a prompt and let it edit
 * the repo, which is the last place to accept an ambiguous binary.
 *
 * Resolving up front also turns a bare ENOENT (which reads as "the agent
 * crashed") into a message that names what is missing.
 *
 * Returns null when nothing matches, so the caller can say so plainly.
 */
function resolveExecutable(name, env = process.env) {
  // Windows resolves a bare name against PATHEXT; POSIX has no such notion and
  // an empty extension is the only candidate.
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  // `Path` as well as `PATH`: Windows env lookup is case-insensitive, but
  // process.env in Node is not on POSIX and callers may set either.
  const raw = env.PATH || env.Path || '';
  for (const dir of raw.split(path.delimiter).filter(Boolean)) {
    for (const ext of ['', ...exts]) {
      const candidate = path.resolve(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* next candidate */ }
    }
  }
  return null;
}

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

/**
 * One line explaining why this worker is going to ask for permission.
 *
 * The default changed in 1.0.0 (#161) and a silent behaviour change of this
 * shape reads as a bug: a wave of six workers that used to run unattended now
 * stops on the first Bash call each, with nothing on screen connecting that to
 * a decision anyone made. Printed into the worker's OWN pane, which is exactly
 * where the prompts are about to appear.
 *
 * Returns null when the opt-in is set, since there is nothing to explain.
 */
function permissionNotice(env = process.env) {
  if (env.WMUX_ORCHESTRATOR_SKIP_PERMISSIONS === '1') return null;
  return (
    '[wmux] This worker keeps Claude\'s normal permission prompts.\n' +
    '[wmux] Approve them here, or from another pane with: wmux answer-agent --surface <id> --choice <id>\n' +
    '[wmux] To bypass them for trusted tasks, set WMUX_ORCHESTRATOR_SKIP_PERMISSIONS=1 before starting wmux.'
  );
}

/**
 * The agents a worker pane can be launched as, keyed by WMUX_AGENT_CMD.
 *
 * A table rather than a chain of branches because #165 made it three, and the
 * shape of the difference is only ever "which binary" and "how the prompt is
 * passed" — everything else (resolution, notices, exit handling) is shared.
 */
const AGENTS = {
  claude: {
    bin: 'claude',
    // NOTE: do NOT use --bare — it skips keychain/OAuth and causes "Not logged in".
    args: prompt => buildClaudeArgs(prompt),
  },
  opencode: {
    bin: 'opencode',
    // opencode run streams formatted progress; the user can watch.
    // '--' stops flag parsing from consuming the prompt.
    args: prompt => ['run', '--', prompt],
  },
  // omp (Oh My Pi), issue #165. `omp run` is its non-interactive entry point;
  // like the others, '--' keeps the prompt out of the flag parser.
  omp: {
    bin: 'omp',
    args: prompt => ['run', '--', prompt],
  },
};

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
  const agent = AGENTS[agentCmd] || AGENTS.claude;

  const exe = resolveExecutable(agent.bin);
  if (!exe) {
    console.error(
      `[wmux] Could not find "${agent.bin}" on PATH. ` +
      'Install it, or set WMUX_AGENT_CMD to the agent you do have ' +
      `(one of: ${Object.keys(AGENTS).join(', ')}).`,
    );
    process.exit(127);
  }

  // Only Claude's permission boundary is the one wmux changed in #161.
  const notice = agent.bin === 'claude' ? permissionNotice() : null;
  if (notice) console.error(notice);

  try {
    execFileSync(exe, agent.args(prompt), { stdio: 'inherit' });
  } catch (e) {
    process.exit(e.status || 1);
  }
}

if (require.main === module) main();

module.exports = { AGENTS, buildClaudeArgs, permissionNotice, resolveExecutable };
