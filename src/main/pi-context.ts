/**
 * pi (@earendil-works/pi-coding-agent) integration — issue #231.
 *
 * The fifth agent wmux teaches about itself, after Claude Code, OpenCode, Kiro
 * and omp. #165 was filed as "support for omp/pi" and closed once omp worked;
 * the reporter of #231 is right that this left pi out. They are separate
 * harnesses with separate config roots, and a pi pane sat on "Running" for the
 * whole time pi was open — the shell-integration's honest report about a
 * long-lived foreground process, and useless for triage.
 *
 * ── Where the block goes, and why it is not just "AGENTS.md" ─────────────────
 *
 * pi loads ONE user-scope context file, from `getAgentDir()` — `~/.pi/agent` —
 * taking the first name that exists from:
 *
 *     AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD
 *
 * (`loadContextFileFromDir` in pi's resource-loader). First match wins and the
 * rest are never read. So the obvious implementation — always write
 * `AGENTS.md`, as the omp integration does — is silently a no-op on a machine
 * that already has `AGENTS.override.md`, which is exactly the file a pi user
 * who cares about their context is most likely to have. wmux would create a
 * second file, report success, and reach nobody.
 *
 * Hence `getPiContextFilePath()`: splice into the file pi will ACTUALLY read,
 * and only fall back to creating `AGENTS.md` when the directory has none of
 * them. The block is spliced between markers either way — these are the user's
 * own instruction files, and everything outside the markers is left alone.
 *
 * Note the `agent` segment, as in omp: `~/.pi/` is also the project-local
 * config directory name, and only the user-level files live under `agent/`.
 *
 * ── Why there IS an extension here, when omp got none ────────────────────────
 *
 * omp-context.ts declines to install hooks, and the reason is specific rather
 * than a general policy: omp discovers hooks from `.omp/hooks/` *inside a
 * project*, so wiring the sidebar that way would mean writing into every
 * repository the user opens — issue #132's complaint exactly. It then says an
 * extension "is the right shape for a follow-up, since extensions CAN be
 * configured globally".
 *
 * pi is that follow-up's other half. It auto-discovers extensions from
 * `~/.pi/agent/extensions/`, globally, for every session — one file, in the
 * user's own config root, removable, and gated behind the same consent as
 * everything else. No repository is touched. See resources/pi-extension/wmux.js
 * for what it reports and why each event maps the way it does.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { injectWmuxBlock, readRenderedInstructions } from './agent-instructions';
import { stripWmuxBlock, stripLegacyBlocks } from './claude-context';
import { isWmuxPluginFile, pluginNeedsUpdate } from './agent-plugin-file';

/**
 * The context-file names pi looks for, in pi's own priority order.
 *
 * Copied from pi rather than reduced to "AGENTS.md" because the ORDER is the
 * load-bearing part: see the header. Kept as a literal list so a future reader
 * can diff it against pi's `loadContextFileFromDir` when pi changes.
 */
export const PI_CONTEXT_FILE_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
] as const;

/** What wmux creates when the directory holds none of the above. */
const PI_DEFAULT_CONTEXT_FILE = 'AGENTS.md';

/**
 * `~/.pi/agent`, honouring the same env override pi itself honours.
 *
 * `PI_CODING_AGENT_DIR` is read here only when it is set in wmux's OWN
 * environment — a user who exports it machine-wide, which is the case worth
 * covering. A value set per-shell, after wmux launched, is unknowable from here
 * and falls back to the default; that is a miss (no block, no extension), never
 * a write to the wrong place.
 */
export function getPiAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    // pi expands a leading `~` itself; do the same so the two agree on the path.
    if (override === '~') return os.homedir();
    if (override.startsWith('~/') || override.startsWith('~\\')) {
      return path.join(os.homedir(), override.slice(2));
    }
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

/**
 * The file pi will read for user-scope context — the first candidate that
 * exists, else the one to create.
 *
 * Deliberately resolved on every call rather than cached: the user can add an
 * `AGENTS.override.md` between two launches, and a cached answer would keep
 * writing to a file that has stopped being read.
 */
export function getPiContextFilePath(agentDir = getPiAgentDir()): string {
  for (const name of PI_CONTEXT_FILE_NAMES) {
    const candidate = path.join(agentDir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* next candidate */ }
  }
  return path.join(agentDir, PI_DEFAULT_CONTEXT_FILE);
}

/** Ensures pi's user-scope context file contains the wmux block. */
export function ensurePiContext(): void {
  try {
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const wmuxBlock = readRenderedInstructions();
    if (wmuxBlock === null) return;

    const contextPath = getPiContextFilePath();
    fs.mkdirSync(path.dirname(contextPath), { recursive: true });
    const existing = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, 'utf-8') : '';
    const next = injectWmuxBlock(existing, wmuxBlock, stripLegacyBlocks);
    // Don't churn the mtime when nothing changed — pi reloads these on /reload.
    if (next === existing) return;
    fs.writeFileSync(contextPath, next, 'utf-8');
    console.log('[wmux] Updated wmux context in', contextPath);
  } catch (err) {
    console.warn('[wmux] Failed to update pi context:', err);
  }
}

/**
 * Remove the wmux block (#132's inverse requirement).
 *
 * Sweeps EVERY candidate name rather than only the one currently being written.
 * A user who adds an `AGENTS.override.md` after wmux has already written
 * `AGENTS.md` would otherwise be left with an orphaned block in a file nothing
 * reads and nothing can ever clean up — an uninstall that does not uninstall is
 * the shape of the original complaint.
 */
export function removePiContext(): void {
  const agentDir = getPiAgentDir();
  for (const name of PI_CONTEXT_FILE_NAMES) {
    const contextPath = path.join(agentDir, name);
    try {
      if (!fs.existsSync(contextPath)) continue;
      const existing = fs.readFileSync(contextPath, 'utf-8');
      // null means there is no wmux block in there at all — a file the user
      // wrote themselves, which is not ours to touch.
      const next = stripWmuxBlock(existing);
      if (next === null || next === existing) continue;
      if (next.trim() === '') fs.unlinkSync(contextPath);
      else fs.writeFileSync(contextPath, next, 'utf-8');
      console.log('[wmux] Removed wmux context from', contextPath);
    } catch (err) {
      console.warn('[wmux] Failed to remove pi context:', err);
    }
  }
}

/** Where the extension lands: `<agentDir>/extensions/wmux.js`. */
export function getPiExtensionPath(agentDir = getPiAgentDir()): string {
  return path.join(agentDir, 'extensions', 'wmux.js');
}

/**
 * The shipped source, in the packaged app and in `npm run dev` alike.
 *
 * `pi-extension` must stay a literal argument to `path.join(process.resourcesPath, …)`:
 * tests/unit/packaging.test.ts scans for exactly that shape to prove the
 * directory is in extraResources, and a computed name escapes the scan. That
 * check exists because this failure has shipped twice already (#81, #149) — the
 * dev fallback below works perfectly while the installed build has no file.
 */
function getPiExtensionSrcPath(): string {
  try {
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'pi-extension', 'wmux.js');
    }
  } catch { /* not running under Electron */ }
  return path.join(__dirname, '../../resources/pi-extension/wmux.js');
}

/** Installs/updates the wmux pi extension into `<agentDir>/extensions/`. */
export function ensurePiExtension(): void {
  try {
    const srcPath = getPiExtensionSrcPath();
    if (!fs.existsSync(srcPath)) {
      console.warn('[wmux] pi extension source not found at', srcPath);
      return;
    }
    const src = fs.readFileSync(srcPath, 'utf-8');
    const dest = getPiExtensionPath();
    const target = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;
    if (!pluginNeedsUpdate(src, target)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src, 'utf-8');
    console.log('[wmux] Installed the wmux pi extension to', dest);
  } catch (err) {
    console.warn('[wmux] Failed to install the pi extension:', err);
  }
}

/**
 * Remove the wmux pi extension (#132).
 *
 * Guarded on the version marker, exactly as the OpenCode plugin is: a
 * `wmux.js` the user wrote or vendored themselves has no marker and stays where
 * it is. Uninstalling wmux's integration must never delete somebody else's file
 * that happens to share a name.
 */
export function removePiExtension(): void {
  try {
    const dest = getPiExtensionPath();
    if (!fs.existsSync(dest)) return;
    if (!isWmuxPluginFile(fs.readFileSync(dest, 'utf-8'))) return;
    fs.unlinkSync(dest);
    console.log('[wmux] Removed the wmux pi extension from', dest);
  } catch (err) {
    console.warn('[wmux] Failed to remove the pi extension:', err);
  }
}
