/**
 * omp (Oh My Pi) integration (issue #165).
 *
 * The fourth agent wmux teaches about itself, after Claude Code, OpenCode and
 * Kiro. It is a Windows-native terminal coding agent, which makes it a closer
 * fit for wmux than most — the request in #165 was from a team that is "100%
 * omp on Windows 11" and read wmux as Claude-only.
 *
 * ── Where the block goes ─────────────────────────────────────────────────────
 *
 * omp's `native` discovery provider reads `~/.omp/agent/AGENTS.md` at USER
 * scope, for every session, and native files have the highest discovery
 * priority of any provider. That is the one global, per-user location, so it is
 * where the block belongs.
 *
 * Worth being explicit about a tempting shortcut that was rejected: omp also
 * ships `claude` and `agents-md` discovery providers, so on many machines it
 * would already pick up the block wmux writes to ~/.claude/CLAUDE.md and appear
 * to work with no code at all. That is not something to rely on — it is true
 * only while the user has Claude Code installed AND has not put `claude` in
 * `disabledProviders`, and it makes wmux's behaviour on an omp-only machine
 * depend on a competing tool being present. Writing the native file means omp
 * support does not quietly evaporate when someone uninstalls Claude Code.
 *
 * ── Why a whole file rather than a splice ────────────────────────────────────
 *
 * Same reasoning as kiro-context.ts, for a different reason. Kiro reads every
 * file in a steering directory, so wmux can own one. Here the file is a single
 * shared AGENTS.md that the user may well have written in — so the block is
 * spliced between markers exactly as it is for Claude Code and OpenCode, and
 * everything outside the markers is left alone.
 *
 * ── What is deliberately NOT installed ───────────────────────────────────────
 *
 * No hooks. omp has a genuinely good hook surface — `session_start`,
 * `turn_start`/`turn_end`, `agent_start`/`agent_end` and pre/post tool events
 * map onto wmux's declared-state protocol almost one for one — but it discovers
 * them from `.omp/hooks/` *inside a project*, walking up from cwd. There is no
 * global hook directory, so wiring the sidebar that way would mean writing into
 * every repository the user opens. That is precisely the complaint in #132, and
 * the Kiro decision applies unchanged: a status indicator is not worth it.
 *
 * omp reports state the same way any agent can without a plugin — the
 * instructions block documents `wmux report-agent`, and the declared-state
 * protocol (#128) takes it from there. An omp extension that does this
 * automatically is the right shape for a follow-up, since extensions CAN be
 * configured globally; it is a separate piece of work from teaching omp that
 * wmux exists.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { injectWmuxBlock, readRenderedInstructions } from './agent-instructions';
import { stripWmuxBlock, stripLegacyBlocks } from './claude-context';

/**
 * ~/.omp/agent/AGENTS.md — omp's user-scope native context file.
 *
 * Note the `agent` segment: `~/.omp/` is also the project-local directory name,
 * and only the user-level one is nested under `agent/`.
 */
export function getOmpAgentsMdPath(): string {
  return path.join(os.homedir(), '.omp', 'agent', 'AGENTS.md');
}

/** Ensures ~/.omp/agent/AGENTS.md contains the wmux block. */
export function ensureOmpContext(): void {
  try {
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const wmuxBlock = readRenderedInstructions();
    if (wmuxBlock === null) return;

    const agentsPath = getOmpAgentsMdPath();
    fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
    const next = injectWmuxBlock(existing, wmuxBlock, stripLegacyBlocks);
    // Don't churn the mtime when nothing changed — omp watches these files.
    if (next === existing) return;
    fs.writeFileSync(agentsPath, next, 'utf-8');
    console.log('[wmux] Updated wmux context in ~/.omp/agent/AGENTS.md');
  } catch (err) {
    console.warn('[wmux] Failed to update omp context:', err);
  }
}

/**
 * Remove the wmux block (issue #132's inverse requirement: every write wmux
 * makes outside its own directory must be undoable).
 *
 * Only the block between the markers goes. A file the user has written their
 * own instructions into keeps all of them, and a file that becomes empty as a
 * result is deleted rather than left as a stray artefact of an integration the
 * user just switched off.
 */
export function removeOmpContext(): void {
  try {
    const agentsPath = getOmpAgentsMdPath();
    if (!fs.existsSync(agentsPath)) return;
    const existing = fs.readFileSync(agentsPath, 'utf-8');
    // null means there is no wmux block in there at all — a file the user
    // created themselves under this name, which is not ours to touch.
    const next = stripWmuxBlock(existing);
    if (next === null || next === existing) return;
    if (next.trim() === '') fs.unlinkSync(agentsPath);
    else fs.writeFileSync(agentsPath, next, 'utf-8');
    console.log('[wmux] Removed wmux context from ~/.omp/agent/AGENTS.md');
  } catch (err) {
    console.warn('[wmux] Failed to remove omp context:', err);
  }
}
