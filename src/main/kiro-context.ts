/**
 * Kiro CLI integration (issue #148).
 *
 * Kiro is the third agent wmux teaches about itself, after Claude Code and
 * OpenCode, and it is the one that needs the least machinery — because Kiro's
 * global *steering* directory is designed for exactly this.
 *
 * ── Why a whole file, and not a block in a shared one ────────────────────────
 *
 * Claude Code and OpenCode each read a single global context file
 * (~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md). wmux does not own those
 * files, so it splices its section between markers and leaves everything else
 * alone — that is what `injectWmuxBlock` / `stripWmuxBlock` exist for.
 *
 * Kiro instead reads *every* markdown file in ~/.kiro/steering/ and concatenates
 * them, and its own guidance is "keep files focused — one domain per file". So
 * the idiomatic thing here is also the safe thing: write one file that is
 * entirely ours. There is no user prose to preserve, no splice to get wrong, and
 * uninstalling is a delete rather than a rewrite.
 *
 * We still write the marker-wrapped instructions verbatim rather than stripping
 * the markers, for two reasons: the file is then byte-identical to what the
 * other two agents receive (one source of truth, no per-agent drift), and the
 * start marker is what `removeKiroContext` checks before deleting — a wmux.md
 * the user wrote themselves has no marker and is left where it is.
 *
 * ── What is deliberately NOT installed ───────────────────────────────────────
 *
 * No hooks. Kiro's hooks live in .kiro/hooks/ *per project*, with no global
 * equivalent, so wiring the sidebar the way ensureClaudeHooks does would mean
 * writing into every repository the user opens. That is precisely the complaint
 * in #132, and it is not worth a status indicator. Kiro reports state the same
 * way any agent can without a plugin: the instructions block documents
 * `wmux report-agent`, and the declared-state protocol (#128) takes it from
 * there.
 *
 * Inclusion modes are also skipped: Kiro CLI ignores them and loads every
 * steering file unconditionally, and the default in the IDE is already
 * `always`, so front matter would add a Kiro-version dependency for no gain.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Identifies a file as wmux-managed. Shared with the other two agent paths. */
const START_MARKER = '<!-- wmux:start';

function getInstructionsPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'claude-instructions', 'claude-instructions.md');
    }
  } catch { /* not running under Electron */ }
  return path.join(__dirname, '../../resources/claude-instructions.md');
}

/**
 * ~/.kiro/steering/wmux.md — the *global* steering location, which applies to
 * every workspace. The per-project .kiro/steering/ is the user's, not ours.
 */
export function getKiroSteeringPath(): string {
  return path.join(os.homedir(), '.kiro', 'steering', 'wmux.md');
}

/** Pure: is this file ours to manage? Everything else is the user's. */
export function isWmuxManaged(content: string): boolean {
  return content.includes(START_MARKER);
}

/** Writes the wmux steering file into ~/.kiro/steering/. */
export function ensureKiroContext(): void {
  try {
    const instructionsPath = getInstructionsPath();
    if (!fs.existsSync(instructionsPath)) {
      console.warn('[wmux] instructions source not found at', instructionsPath);
      return;
    }
    const block = fs.readFileSync(instructionsPath, 'utf-8').trimEnd() + '\n';
    const steeringPath = getKiroSteeringPath();

    // A pre-existing wmux.md that is NOT ours belongs to the user. Overwriting
    // it would be the same class of mistake as clobbering their CLAUDE.md.
    if (fs.existsSync(steeringPath)) {
      const current = fs.readFileSync(steeringPath, 'utf-8');
      if (!isWmuxManaged(current)) {
        console.warn('[wmux] ~/.kiro/steering/wmux.md exists and is not wmux-managed — leaving it alone');
        return;
      }
      if (current === block) return; // already current; don't churn the mtime
    }

    fs.mkdirSync(path.dirname(steeringPath), { recursive: true });
    fs.writeFileSync(steeringPath, block, 'utf-8');
    console.log('[wmux] Updated wmux steering in ~/.kiro/steering/wmux.md');
  } catch (err) {
    console.warn('[wmux] Failed to update Kiro context:', err);
  }
}

/**
 * Delete the wmux steering file (issue #132's inverse requirement: every write
 * wmux makes outside its own directory must be undoable).
 *
 * Guarded on the marker, so a wmux.md the user happens to have written under
 * that name survives switching the integration off.
 */
export function removeKiroContext(): void {
  try {
    const steeringPath = getKiroSteeringPath();
    if (!fs.existsSync(steeringPath)) return;
    if (!isWmuxManaged(fs.readFileSync(steeringPath, 'utf-8'))) return;
    fs.unlinkSync(steeringPath);
    console.log('[wmux] Removed wmux steering from ~/.kiro/steering/wmux.md');
  } catch (err) {
    console.warn('[wmux] Failed to remove Kiro context:', err);
  }
}
