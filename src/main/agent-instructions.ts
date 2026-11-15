/**
 * Shared wmux instruction source for context files, skills, and extension references.
 * Centralised path rendering keeps install-specific CLI locations consistent
 * across delivery mechanisms.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCliBinPath } from './cli-paths';

/**
 * Placeholder replaced with this install's absolute cli-bin directory.
 *
 * ## Why the block needs it (issue #158)
 *
 * The block loads GLOBALLY, so it reaches sessions wmux did not spawn — the
 * Claude Code desktop app, a plain terminal, an SSH session, a scheduled run,
 * anything that was already open before wmux started. wmux only ever puts
 * `wmux` on PATH for PTYs it spawns itself (pty-manager prepends the shim dirs
 * to that process's environment; nothing is persisted to the user's PATH). So
 * for most of the population the block is written for, `wmux` is NOT on PATH.
 *
 * That made the probe ambiguous in the one direction that matters. The block
 * told the reader that "command not found, no reply, or an error" all mean wmux
 * is absent — but "command not found" says nothing about whether wmux is
 * running, only that this session cannot reach the CLI. Every agent on a
 * machine with a perfectly healthy wmux concluded it was gone.
 *
 * ## Why interpolating a path here is sound, when #152 wasn't
 *
 * #152 removed an assertion because it was a write-time fact read at an
 * arbitrarily later time, and nothing at generation time could make it true.
 * This is the opposite shape: the writer is the installed build, it is writing
 * its OWN location, and it rewrites the block on every startup. It therefore
 * self-heals across exactly the failure that produced the report — an update
 * that relocated the install from %LOCALAPPDATA% to Program Files and left a
 * hand-added PATH entry dangling.
 */
export const CLI_BIN_PLACEHOLDER = '{{WMUX_CLI_BIN}}';

/** Absolute path to the `wmux` entry point a session off PATH should call. */
export function getCliBinDirForInstructions(): string {
  return getCliBinPath();
}

const START_MARKER = '<!-- wmux:start';
const END_MARKER = '<!-- wmux:end -->';

/**
 * Splice the wmux block into a context file the user also writes in.
 *
 * Used for shared context files such as Claude Code's CLAUDE.md and OpenCode's
 * or omp's AGENTS.md. Integrations with a dedicated file have nothing to splice.
 *
 * `trimEnd()` on the block is load-bearing and not cosmetic. The block ends
 * with a newline and so does the text following the old END_MARKER, so keeping
 * both appends one blank line to the file on EVERY launch — unbounded growth in
 * a file the agent loads into context each session. Trimming the block lets the
 * tail supply the newline exactly once, which is what makes re-splicing a
 * fixed point.
 *
 * Lives here rather than being duplicated per agent because it was duplicated
 * per agent, and the copies had already diverged on precisely that line.
 */
export function injectWmuxBlock(rawExisting: string, wmuxBlock: string, stripLegacy: (s: string) => string): string {
  const block = wmuxBlock.trimEnd();
  // Marker-less copies from older versions are ours and stale; splicing keys off
  // the markers, so without this they would sit beside the managed block forever.
  const existing = stripLegacy(rawExisting);
  if (existing.trim() === '') return block;
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (startIdx === -1) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    return existing + separator + block;
  }
  if (endIdx === -1) {
    return existing.substring(0, startIdx) + block;
  }
  const before = existing.substring(0, startIdx);
  const after = existing.substring(endIdx + END_MARKER.length);
  return before + block + after;
}

export function getInstructionsPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'claude-instructions', 'claude-instructions.md');
    }
  } catch {
    // Not in Electron
  }
  return path.join(__dirname, '../../resources/claude-instructions.md');
}

/**
 * Substitute the install-specific facts into the block.
 *
 * Exported separately from the file read so it can be tested without a
 * filesystem, and so a caller that already has the text can reuse it.
 */
export function renderInstructions(raw: string, cliBinDir = getCliBinDirForInstructions()): string {
  return raw.split(CLI_BIN_PLACEHOLDER).join(cliBinDir);
}

/**
 * Line that marks a SKILL.md as wmux's own (issue #386). `~/.claude/skills/wmux`
 * is a name a user may well have picked for a skill of their own, so ownership
 * is this line, never the directory name: a file without it is neither
 * overwritten nor removed.
 */
export const SKILL_OWNER_MARKER = '<!-- wmux-skill — AUTO-MANAGED BY wmux. Do not edit this file manually. -->';

/**
 * What makes Claude Code load the skill. It is the ONLY part of the skill that
 * is always in context, so it names every situation the block covers — a
 * trigger missing here is guidance the agent never reads.
 */
const SKILL_DESCRIPTION =
  'Use when wmux is running (`wmux ping` answers pong) and you are about to browse the web, '
  + 'show the user a markdown document (a plan, a spec, a README), stop to ask the user a question or '
  + 'confirmation, or run background work or subagents of your own. Covers `wmux browser`, '
  + '`wmux markdown`, `wmux report-agent` and `wmux report-subagent`.';

/**
 * The rendered block as a Claude Code skill (issue #386): the same text, minus
 * the splice markers, behind frontmatter. One source for both shapes, so the
 * skill and the inline block other agents still get cannot drift.
 */
export function buildSkillFile(renderedBlock: string): string {
  const body = renderedBlock
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(START_MARKER) && line.trim() !== END_MARKER)
    .join('\n')
    .trim();
  return [
    '---',
    'name: wmux',
    `description: ${JSON.stringify(SKILL_DESCRIPTION)}`,
    '---',
    '',
    SKILL_OWNER_MARKER,
    '',
    body,
    '',
  ].join('\n');
}

/**
 * The few lines that stay in the always-loaded CLAUDE.md once the skill holds
 * the rest (issue #386). It keeps the two things a skill cannot do for itself:
 * the #152/#158 presence check, so a session outside wmux stands down without
 * loading anything, and the moments to look — a skill is only loaded when the
 * agent thinks of it. The absolute SKILL.md path is for any reader that loads
 * CLAUDE.md but not Claude Code's skills (Grok's Claude compatibility).
 */
export function buildContextStub(cliBinDir: string, skillPath: string): string {
  return [
    `${START_MARKER} — AUTO-MANAGED BY wmux. Do not edit this section manually. -->`,
    '',
    '# wmux',
    '',
    'wmux is a terminal multiplexer with a browser panel the user watches. This file is',
    'global, so this session may not be running inside it. Before you browse the web,',
    'show the user a markdown document, stop to ask them something, or run work in the',
    'background, check once per session:',
    '',
    '```bash',
    'wmux ping                     # "pong" → wmux is here',
    `"${cliBinDir}/wmux" ping`,
    '```',
    '',
    'Run the second line when the first answers anything but `pong` (wmux is on PATH only',
    'in terminals it started). If either answers `pong`, load the `wmux` skill, or read',
    `\`${skillPath}\`, and follow it. If neither does, ignore this section.`,
    '',
    END_MARKER,
    '',
  ].join('\n');
}

/**
 * Read and render the block, or null when the resource is missing.
 *
 * Returning null rather than throwing keeps callers' existing
 * behaviour: a missing resource warns and skips, it does not stop startup.
 */
export function readRenderedInstructions(): string | null {
  const instructionsPath = getInstructionsPath();
  if (!fs.existsSync(instructionsPath)) {
    console.warn('[wmux] claude-instructions.md not found at', instructionsPath);
    return null;
  }
  return renderInstructions(fs.readFileSync(instructionsPath, 'utf-8'));
}
