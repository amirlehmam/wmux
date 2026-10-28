/**
 * Pi's extension scopes instructions to wmux sessions without installing them in
 * personal context files. Compact rules load automatically; the detailed reference is
 * read on demand. Instructions and status reporting have independent consent.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readRenderedInstructions } from './agent-instructions';
import { stripWmuxBlock } from './claude-context';
import { isWmuxPluginFile } from './agent-plugin-file';

/** Sweep every legacy context filename, including ones Pi no longer selects. */
export const PI_CONTEXT_FILE_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
] as const;

export interface PiExtensionFeatures {
  instructions: boolean;
  hooks: boolean;
}

const REFERENCE_MARKER = '<!-- wmux-pi-reference — AUTO-MANAGED BY wmux. -->';

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
 * Remove the wmux block (#132's inverse requirement).
 *
 * Sweeps every candidate name, not just the filename selected by older releases.
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

/** Pi discovers the directory through its index.js entry point. */
export function getPiExtensionPath(agentDir = getPiAgentDir()): string {
  return path.join(agentDir, 'extensions', 'wmux', 'index.js');
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

/** A Markdown sibling is not auto-loaded as an extension, skill, or context file. */
function getPiReferencePath(): string {
  return path.join(path.dirname(getPiExtensionPath()), 'reference.md');
}

/** Reuse the shared command guide without its global-session presence checks. */
function ensurePiReference(): string | null {
  try {
    const block = readRenderedInstructions();
    if (block === null) return null;
    const start = block.indexOf('## Browser');
    if (start === -1) throw new Error('wmux command reference is missing');
    const reference = `${REFERENCE_MARKER}\n\n# wmux command reference\n\n${block.slice(start)
      .replace('`wmux ping` says wmux is absent', 'wmux is unavailable')
      .replace(/\s*<!-- wmux:end -->\s*$/, '\n')}`;
    const dest = getPiReferencePath();
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;
    if (existing !== null && !existing.startsWith(REFERENCE_MARKER)) {
      throw new Error(`Leaving an unmanaged pi reference untouched: ${dest}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (existing !== reference) fs.writeFileSync(dest, reference, 'utf-8');
    return dest;
  } catch (err) {
    console.warn('[wmux] Failed to install the pi reference:', err);
    return null;
  }
}

/** Never remove a reference just because its filename matches. */
function removePiReference(): void {
  try {
    const dest = getPiReferencePath();
    if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf-8').startsWith(REFERENCE_MARKER)) fs.unlinkSync(dest);
  } catch (err) {
    console.warn('[wmux] Failed to remove the pi reference:', err);
  }
}

/** Embed a consent snapshot so changes apply on Pi's next reload, without polling. */
export function ensurePiExtension(features: PiExtensionFeatures): void {
  try {
    const srcPath = getPiExtensionSrcPath();
    if (!fs.existsSync(srcPath)) {
      console.warn('[wmux] pi extension source not found at', srcPath);
      return;
    }
    const src = fs.readFileSync(srcPath, 'utf-8');
    const dest = getPiExtensionPath();
    // Pi prefers these entry points over index.js; do not migrate into a user's extension.
    if (['index.ts', 'package.json'].some(name => fs.existsSync(path.join(path.dirname(dest), name)))) {
      console.warn('[wmux] Leaving an existing pi extension directory untouched');
      return;
    }
    const legacy = path.join(getPiAgentDir(), 'extensions', 'wmux.js');
    const target = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;
    const previous = fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf-8') : null;
    if ((target !== null && !isWmuxPluginFile(target)) || (previous !== null && !isWmuxPluginFile(previous))) {
      console.warn('[wmux] Leaving an unmanaged pi extension untouched');
      return;
    }
    const reference = ensurePiReference();
    const instructions = features.instructions && reference ? [
      '# wmux',
      'This session is running inside wmux; no presence check is needed.',
      '- Prefer `wmux browser` for browsing so the user can watch; an explicit user tool choice takes precedence.',
      '- Open documents for user review with `wmux markdown` instead of dumping them into the terminal.',
      '- When asking the user a question, declare `wmux report-agent --blocked` with the actual answer keys/text; report `--unblocked` after acting on the answer.',
      '- Declare background workers with `wmux report-subagent` and mark them `--done` when finished.',
      `Before using these commands, read \`${reference}\` for syntax, examples, and limitations.`,
      'If wmux is unavailable, report the failure and use your normal tools.',
    ].join('\n') : '';
    const rendered = `${src.trimEnd()}\n\nwmuxExtension.config = ${JSON.stringify({ instructions, hooks: features.hooks })};\n`;
    if (target !== rendered) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, rendered, 'utf-8');
      console.log('[wmux] Installed the wmux pi extension to', dest);
    }
    // Remove the old entry point only after its replacement is on disk.
    if (previous !== null) fs.unlinkSync(legacy);
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
  removePiReference();
  try {
    const dest = getPiExtensionPath();
    const legacy = path.join(getPiAgentDir(), 'extensions', 'wmux.js');
    let removedEntry = false;
    for (const file of [dest, legacy]) {
      if (!fs.existsSync(file) || !isWmuxPluginFile(fs.readFileSync(file, 'utf-8'))) continue;
      fs.unlinkSync(file);
      if (file === dest) removedEntry = true;
      console.log('[wmux] Removed the wmux pi extension from', file);
    }
    const dir = path.dirname(dest);
    if (removedEntry && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (err) {
    console.warn('[wmux] Failed to remove the pi extension:', err);
  }
}
