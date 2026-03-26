import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const START_MARKER = '<!-- wmux:start';
const END_MARKER = '<!-- wmux:end -->';

function getInstructionsPath(): string {
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

function getClaudeMdPath(): string {
  return path.join(os.homedir(), '.claude', 'CLAUDE.md');
}

/**
 * Ensures the user's global ~/.claude/CLAUDE.md contains the wmux section.
 * - Creates ~/.claude/ and CLAUDE.md if they don't exist
 * - Inserts the wmux block if not present
 * - Updates the wmux block if it's outdated
 * - Never touches content outside the <!-- wmux:start --> / <!-- wmux:end --> markers
 */
export function ensureClaudeContext(): void {
  try {
    const instructionsPath = getInstructionsPath();
    if (!fs.existsSync(instructionsPath)) {
      console.warn('[wmux] claude-instructions.md not found at', instructionsPath);
      return;
    }

    const wmuxBlock = fs.readFileSync(instructionsPath, 'utf-8');
    const claudeMdPath = getClaudeMdPath();
    const claudeDir = path.dirname(claudeMdPath);

    // Ensure ~/.claude/ exists
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    if (!fs.existsSync(claudeMdPath)) {
      // No CLAUDE.md yet — create with just the wmux block
      fs.writeFileSync(claudeMdPath, wmuxBlock, 'utf-8');
      console.log('[wmux] Created ~/.claude/CLAUDE.md with wmux context');
      return;
    }

    // CLAUDE.md exists — check for existing wmux block
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');
    const startIdx = existing.indexOf(START_MARKER);
    const endIdx = existing.indexOf(END_MARKER);

    if (startIdx === -1) {
      // No wmux block — append it
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      fs.writeFileSync(claudeMdPath, existing + separator + wmuxBlock, 'utf-8');
      console.log('[wmux] Appended wmux context to ~/.claude/CLAUDE.md');
      return;
    }

    if (endIdx === -1) {
      // Broken markers — replace from start marker to end of file
      const before = existing.substring(0, startIdx);
      fs.writeFileSync(claudeMdPath, before + wmuxBlock, 'utf-8');
      console.log('[wmux] Fixed and updated wmux context in ~/.claude/CLAUDE.md');
      return;
    }

    // Both markers found — replace the block
    const currentBlock = existing.substring(startIdx, endIdx + END_MARKER.length);
    if (currentBlock.trim() === wmuxBlock.trim()) {
      // Already up to date
      return;
    }

    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + END_MARKER.length);
    fs.writeFileSync(claudeMdPath, before + wmuxBlock + after, 'utf-8');
    console.log('[wmux] Updated wmux context in ~/.claude/CLAUDE.md');
  } catch (err) {
    console.warn('[wmux] Failed to update Claude context:', err);
  }
}

const HOOK_MARKER = 'WMUX_CLI';

function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Ensures Claude Code's ~/.claude/settings.json has a PostToolUse hook
 * that notifies wmux. Identified by WMUX_CLI in the command string.
 * Never touches other hook entries.
 */
export function ensureClaudeHooks(): void {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return;

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    let settings: any;
    try { settings = JSON.parse(raw); } catch { return; }

    const wmuxHookCommand = 'node "$WMUX_CLI" hook --event post_tool --tool $CLAUDE_TOOL_USE_NAME 2>/dev/null || true';

    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

    const entries: any[] = settings.hooks.PostToolUse;

    // Find existing wmux hook entry by checking nested hooks[].command
    const existingIdx = entries.findIndex((e: any) =>
      Array.isArray(e.hooks) && e.hooks.some((h: any) => h.command?.includes(HOOK_MARKER))
    );

    const wmuxEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: wmuxHookCommand }],
    };

    if (existingIdx === -1) {
      entries.push(wmuxEntry);
      console.log('[wmux] Added PostToolUse hook to ~/.claude/settings.json');
    } else {
      const currentCmd = entries[existingIdx]?.hooks?.[0]?.command;
      if (currentCmd === wmuxHookCommand) return; // Already up to date
      entries[existingIdx] = wmuxEntry;
      console.log('[wmux] Updated PostToolUse hook in ~/.claude/settings.json');
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[wmux] Failed to update Claude hooks:', err);
  }
}
