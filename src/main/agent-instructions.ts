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
