/**
 * The wmux block that gets spliced into every agent's global context file.
 *
 * One source (`resources/claude-instructions.md`), read by three writers —
 * claude-context.ts, opencode-context.ts and kiro-context.ts — each of which
 * used to carry its own copy of the path lookup. It is centralised here because
 * the block is no longer a static file: it carries one interpolated fact, and a
 * fact interpolated in two of three places is worse than one interpolated
 * nowhere.
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
 * Shared by every agent whose context file is a single shared document
 * (Claude Code's CLAUDE.md, OpenCode's AGENTS.md, omp's AGENTS.md). Kiro is the
 * exception — it gets a file of wmux's own, so it has nothing to splice.
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
 * Read and render the block, or null when the resource is missing.
 *
 * Returning null rather than throwing keeps the three callers' existing
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
