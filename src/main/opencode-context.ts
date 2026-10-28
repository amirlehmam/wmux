/**
 * OpenCode integration: the wmux block in `~/.config/opencode/AGENTS.md`, and
 * `resources/opencode-plugin/wmux.js` installed into `~/.config/opencode/plugin/`.
 *
 * ── The plugin file ─────────────────────────────────────────────────────────
 *
 * Installing it is gated on the `// wmux-plugin-version:` marker
 * (`pluginNeedsUpdate` compares it verbatim), so any change to the plugin needs
 * a bump or it reaches nobody — every broken install already has the old file
 * on disk.
 *
 * That file must export `WmuxPlugin` and the default definition, nothing else
 * (#191, #271). OpenCode v1's legacy loader calls EVERY export as a plugin
 * factory and then invokes a `config` hook on the result, so an exported helper
 * returning a plain value crashes OpenCode at startup. Helpers hang off
 * `WmuxPlugin.__wmuxInternals` for the tests; a test pins the export set.
 *
 * OpenCode v2 rejects any file without `export default { id, effect | setup }`
 * (#271 — the plugin silently never loaded), so the default is ONE object both
 * generations accept: `{ id, server: WmuxPlugin, setup }`. v1 ≥ 1.3.4 sees the
 * `id`, calls only `default.server` and stops walking the exports; v2's schema
 * ignores `server` and runs `setup`, which adapts v2's `tool`/`shell` hooks and
 * event stream onto the SAME handlers through `fromV2Event` — v2 renamed the
 * events and moved the payload to `data`, and its core never publishes
 * `session.idle` (a turn ends with
 * `session.execution.succeeded|interrupted|failed`). `filesystem.changed` is
 * deliberately unmapped: it fires on the user's own saves and would clear
 * "Needs you". OpenCode ≤ 1.3.3 calls the default object as a factory and
 * cannot load a v2-compatible file at all. Verified against real
 * `@opencode/cli@2.0.24` and `opencode-ai@1.18.35` with an isolated
 * `XDG_CONFIG_HOME`.
 *
 * The v2 half also registers `ctx.session.hook("prompt")` and forwards the
 * submitted text as `wmux hook --event UserPromptSubmit --prompt` (#304) — the
 * prompt log's only OpenCode producer, capped at `wmux-hook.js`'s 4000 chars
 * and deduped by `messageID`. v1 has no prompt log.
 *
 * ── The CLI-side (TUI) half is NOT installed here (#310) ────────────────────
 *
 * It must land in the environment that hosts the TUI (WSL distro,
 * devcontainer, native Windows), so `wmux opencode-tui` copies
 * `resources/opencode-plugin/wmux-tui.js` + `wmux-tui-core.js` to
 * `<config>/plugins/wmux-cli/{tui,core}.js` from inside that environment — own
 * marker on `tui.js`, removal guarded by it. It reports the viewed session
 * (`report-session`, subagents→root, release on quit) and, since its v2, user
 * prompts from `session.inbox.enqueued` (only `item.type === "user"`; `inboxID`
 * dedupe; attributed only to a session being viewed or open in a tab, because
 * the event stream is the whole server's). Since v3 it also reports blocked
 * state from `permission.asked`/`form.created`, cleared only by explicit
 * replies/cancellations or a turn-ending `session.execution.interrupted|failed`
 * — tool/streaming events never unblock (#189). Since v4 it declares
 * working/idle from `session.execution.started|succeeded|failed|interrupted`
 * with ABSOLUTE `--run-depth` (never `--run-start`/`--run-end`, so a second
 * producer converges rather than inflating); running sessions are tracked by
 * id so an end still clears after the view moved, and a subagent's end cannot
 * idle a pane whose parent is running.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stripWmuxBlock, stripLegacyBlocks } from './claude-context';
import { injectWmuxBlock as spliceBlock, readRenderedInstructions } from './agent-instructions';
import { isWmuxPluginFile, pluginNeedsUpdate } from './agent-plugin-file';

/**
 * Re-exported rather than moved, because the tests target it here and because
 * this is still the file that documents what the marker is for. The
 * implementation went to agent-plugin-file.ts when the pi extension (#231)
 * became the second thing wmux installs into somebody else's config directory —
 * a duplicate with no enforcement is not a duplicate, it is a time bomb (#137).
 */
export { pluginNeedsUpdate };

/**
 * Pure: insert/replace the wmux block within existing content, preserving the rest.
 *
 * Thin wrapper over the shared splice in agent-instructions.ts, kept as a named
 * export because the existing tests target it here. The implementation moved
 * when omp became the third agent needing it (#165) — and the copy written for
 * omp had already lost the `trimEnd()` this one depends on, appending one blank
 * line per launch to a file the agent reads every session.
 */
export function injectWmuxBlock(rawExisting: string, wmuxBlock: string): string {
  return spliceBlock(rawExisting, wmuxBlock, stripLegacyBlocks);
}

function getAgentsMdPath(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
}

/** Ensures ~/.config/opencode/AGENTS.md contains the wmux block. */
export function ensureOpencodeContext(): void {
  try {
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const wmuxBlock = readRenderedInstructions();
    if (wmuxBlock === null) return;
    const agentsPath = getAgentsMdPath();
    const dir = path.dirname(agentsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
    const next = injectWmuxBlock(existing, wmuxBlock);
    if (next !== existing) {
      fs.writeFileSync(agentsPath, next, 'utf-8');
      console.log('[wmux] Updated wmux context in ~/.config/opencode/AGENTS.md');
    }
  } catch (err) {
    console.warn('[wmux] Failed to update OpenCode context:', err);
  }
}

function getPluginSrcPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'opencode-plugin', 'wmux.js');
    }
  } catch { /* not running under Electron */ }
  return path.join(__dirname, '../../resources/opencode-plugin/wmux.js');
}

/** Installs/updates the wmux OpenCode plugin into ~/.config/opencode/plugin/. */
export function ensureOpencodePlugin(): void {
  try {
    const srcPath = getPluginSrcPath();
    if (!fs.existsSync(srcPath)) {
      console.warn('[wmux] opencode plugin source not found at', srcPath);
      return;
    }
    const src = fs.readFileSync(srcPath, 'utf-8');
    const destDir = path.join(os.homedir(), '.config', 'opencode', 'plugin');
    const dest = path.join(destDir, 'wmux.js');
    const target = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;
    if (!pluginNeedsUpdate(src, target)) return;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, src, 'utf-8');
    console.log('[wmux] Installed wmux OpenCode plugin to', dest);
  } catch (err) {
    console.warn('[wmux] Failed to install OpenCode plugin:', err);
  }
}

/**
 * Delete wmux's block from ~/.config/opencode/AGENTS.md (issue #132).
 *
 * Mirrors removeClaudeContext: the file goes only when it held nothing but our
 * block, so an AGENTS.md the user wrote survives with just the block excised.
 * The stripping itself is shared — the two files use identical markers, and
 * having one implementation is what stops the two paths from drifting.
 */
export function removeOpencodeContext(): void {
  try {
    const agentsPath = getAgentsMdPath();
    if (!fs.existsSync(agentsPath)) return;
    const stripped = stripWmuxBlock(fs.readFileSync(agentsPath, 'utf-8'));
    if (stripped === null) return;
    if (stripped === '') fs.unlinkSync(agentsPath);
    else fs.writeFileSync(agentsPath, stripped, 'utf-8');
    console.log('[wmux] Removed wmux context from ~/.config/opencode/AGENTS.md');
  } catch (err) {
    console.warn('[wmux] Failed to remove OpenCode context:', err);
  }
}

/**
 * Remove the wmux OpenCode plugin (issue #132).
 *
 * Guarded on the version marker wmux stamps into its own plugin source: a
 * wmux.js the user wrote or vendored themselves has no marker and is left where
 * it is, because uninstalling our integration must not delete their file.
 */
export function removeOpencodePlugin(): void {
  try {
    const dest = path.join(os.homedir(), '.config', 'opencode', 'plugin', 'wmux.js');
    if (!fs.existsSync(dest)) return;
    if (!isWmuxPluginFile(fs.readFileSync(dest, 'utf-8'))) return;
    fs.unlinkSync(dest);
    console.log('[wmux] Removed the wmux OpenCode plugin from', dest);
  } catch (err) {
    console.warn('[wmux] Failed to remove OpenCode plugin:', err);
  }
}
