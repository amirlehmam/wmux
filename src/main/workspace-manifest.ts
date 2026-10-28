// Project-local workspace manifests (#284, 2.23.0): `wmux.workspace.json` (or
// `.wmux/workspace.json`) — panes, their folders, what each runs, extra env,
// ordering, browser tabs — committed next to the code it brings up. Per pane:
// `cwd`, `run`, `runOnce`, `env`, `after`, `waitFor`. User docs:
// `docs/workspace-manifest.md`.
//
// The module family: this file (pure validation and the plan), workspace-open.ts
// (end to end), workspace-scheduler.ts (ordering), workspace-trust.ts (the trust
// store), workspace-manifest-v2.ts (pipe methods and the native dialog),
// wait-probes.ts (`waitFor`) and surface-env.ts (`${env:NAME}`).
//
// Pure: reading the file, asking for trust, creating panes and typing commands
// are workspace-open.ts. Everything here is a decision that can be tested
// against plain values, and the security-relevant ones in particular, since
// for an untrusted file the design IS the guardrails:
//
//   - A manifest arrives with `git clone`, so it is UNTRUSTED input. Nothing
//     in it may name a folder outside its own repo (`cwd` is relative and
//     contained here, plus a realpath check in workspace-open.ts so a junction
//     cannot walk out), and nothing it runs may differ from what the trust
//     prompt showed — `formatPlan` is that prompt's text, built from the same
//     resolved plan the scheduler executes, so the two cannot drift.
//   - A command may not contain a line break. Multi-line text would type as
//     several commands, and a preview shows a line break poorly.
//   - `waitFor` probes only loopback: it exists to wait for the services this
//     manifest starts, and must not turn wmux into a port scanner for a file
//     somebody else wrote.
//   - `WMUX_*` env keys are refused, and a literal value under a
//     secret-looking key warns toward `${env:NAME}` (resolved at spawn by
//     surface-env.ts, so the secret never sits in the file).

import * as crypto from 'crypto';
import * as path from 'path';
import { ENV_KEY_RE, isReservedEnvKey } from './surface-env';

export const MANIFEST_FILENAMES = ['wmux.workspace.json', path.join('.wmux', 'workspace.json')] as const;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_PANES = 8;
export const MAX_BROWSER_TABS = 10;
export const MAX_COMMAND_LENGTH = 2000;
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
export const MAX_WAIT_MS = 10 * 60_000;
export const LAYOUTS = ['grid', 'columns', 'rows', 'left', 'down'] as const;
export type ManifestLayout = typeof LAYOUTS[number];

export type WaitFor =
  | { kind: 'port'; port: number; host: string; timeoutMs: number }
  | { kind: 'http'; url: string; timeoutMs: number }
  | { kind: 'delay'; ms: number };

export interface ManifestPane {
  id: string;
  title?: string;
  /** Relative to the manifest root; '.' by default. */
  cwd: string;
  run: string[];
  runOnce: string[];
  env: Record<string, string>;
  after: string[];
  waitFor?: WaitFor;
}

export interface WorkspaceManifest {
  version: 1;
  name?: string;
  layout?: ManifestLayout;
  panes: ManifestPane[];
  browser?: { tabs: string[]; active: number };
}

export interface ParseResult {
  manifest: WorkspaceManifest | null;
  errors: string[];
  warnings: string[];
}

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * JSON with `//` and `/* *\/` comments, the way the issue writes its examples
 * (and VS Code's own settings files). Comments are blanked outside strings
 * only, so a URL's `//` survives; trailing commas before `]`/`}` are dropped.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const skip = commentEnd(text, i);
    if (skip !== -1) { i = skip; continue; }
    out += text[i];
    i++;
  }
  return removeTrailingCommas(out);
}

/** Index just past the string literal that opens at `i` (escapes honoured). */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, text.length);
}

/** Index just past a comment starting at `i`, or -1 when none starts there. */
function commentEnd(text: string, i: number): number {
  if (text[i] !== '/') return -1;
  if (text[i + 1] === '/') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl;
  }
  if (text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  return -1;
}

const CLOSER_AHEAD = /\s*[\]}]/y;

function removeTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    CLOSER_AHEAD.lastIndex = i + 1;
    if (!(text[i] === ',' && CLOSER_AHEAD.test(text))) out += text[i];
    i++;
  }
  return out;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const PANE_ID_RE = /^[\w.-]{1,40}$/;
const KNOWN_TOP = new Set(['version', 'name', 'root', 'layout', 'panes', 'browser', '$schema']);
const KNOWN_PANE = new Set(['id', 'title', 'name', 'type', 'cwd', 'run', 'runOnce', 'env', 'after', 'waitFor', 'when']);
const SECRET_KEY_RE = /(token|secret|passw(or)?d|api_?key|private_?key|credential)/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `"a"` or `["a", "b"]` → string[]; anything else is an error. */
function stringList(value: unknown, where: string, errors: string[]): string[] {
  if (value === undefined) return [];
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list)) {
    errors.push(`${where}: expected a string or a list of strings`);
    return [];
  }
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') { errors.push(`${where}: every entry must be a string`); continue; }
    out.push(item);
  }
  return out;
}

function checkCommands(cmds: string[], where: string, errors: string[]): string[] {
  const out: string[] = [];
  for (const cmd of cmds) {
    if (/[\r\n]/.test(cmd)) { errors.push(`${where}: a command may not contain a line break — use one entry per command`); continue; }
    if (cmd.length > MAX_COMMAND_LENGTH) { errors.push(`${where}: a command is longer than ${MAX_COMMAND_LENGTH} characters`); continue; }
    if (cmd.trim()) out.push(cmd.trim());
  }
  return out;
}

/** A manifest's `cwd` must stay inside its repo: relative, no `..` escape. */
export function containedCwd(cwd: string): string | null {
  const trimmed = cwd.trim() || '.';
  if (path.win32.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '' ? '.' : normalized;
}

function parseEnv(value: unknown, where: string, errors: string[], warnings: string[]): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) { errors.push(`${where}: expected an object of NAME: "value"`); return {}; }
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!ENV_KEY_RE.test(key)) { errors.push(`${where}.${key}: not a valid variable name`); continue; }
    if (isReservedEnvKey(key)) { errors.push(`${where}.${key}: WMUX_* variables belong to wmux`); continue; }
    if (typeof val !== 'string') { errors.push(`${where}.${key}: value must be a string`); continue; }
    if (SECRET_KEY_RE.test(key) && val !== '' && !val.includes('${env:')) {
      warnings.push(`${where}.${key} looks like a credential written into a file that gets committed — use "\${env:${key}}" to read it from your environment instead`);
    }
    env[key] = val;
  }
  return env;
}

function parseTimeout(value: unknown, where: string, errors: string[]): number {
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_WAIT_MS) {
    errors.push(`${where}.timeoutMs: expected 1-${MAX_WAIT_MS}`);
    return DEFAULT_WAIT_TIMEOUT_MS;
  }
  return Math.round(value);
}

function parseWaitFor(value: unknown, where: string, errors: string[]): WaitFor | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) { errors.push(`${where}: expected { port } , { http } or { delay }`); return undefined; }
  const kinds = ['port', 'http', 'delay'].filter((k) => value[k] !== undefined);
  if (kinds.length !== 1) { errors.push(`${where}: give exactly one of port, http, delay`); return undefined; }
  if (kinds[0] === 'port') return parsePortWait(value, where, errors);
  if (kinds[0] === 'http') return parseHttpWait(value, where, errors);
  const ms = value.delay;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_WAIT_MS) { errors.push(`${where}.delay: expected 0-${MAX_WAIT_MS} ms`); return undefined; }
  return { kind: 'delay', ms: Math.round(ms) };
}

function parsePortWait(value: Record<string, unknown>, where: string, errors: string[]): WaitFor | undefined {
  const timeoutMs = parseTimeout(value.timeoutMs, where, errors);
  const port = value.port;
  const host = typeof value.host === 'string' ? value.host : '127.0.0.1';
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) { errors.push(`${where}.port: expected 1-65535`); return undefined; }
  if (!LOOPBACK_HOSTS.has(host)) { errors.push(`${where}.host: only this machine (localhost) can be waited on`); return undefined; }
  return { kind: 'port', port, host: host === 'localhost' ? '127.0.0.1' : host.replace(/^\[|\]$/g, ''), timeoutMs };
}

function parseHttpWait(value: Record<string, unknown>, where: string, errors: string[]): WaitFor | undefined {
  const timeoutMs = parseTimeout(value.timeoutMs, where, errors);
  let url: URL;
  try { url = new URL(String(value.http)); } catch { errors.push(`${where}.http: not a URL`); return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { errors.push(`${where}.http: http(s) only`); return undefined; }
  if (!LOOPBACK_HOSTS.has(url.hostname)) { errors.push(`${where}.http: only this machine (localhost) can be waited on`); return undefined; }
  return { kind: 'http', url: url.href, timeoutMs };
}

function parsePane(raw: unknown, index: number, errors: string[], warnings: string[]): ManifestPane | null {
  const where = `panes[${index}]`;
  if (!isObject(raw)) { errors.push(`${where}: expected an object`); return null; }
  for (const key of Object.keys(raw)) if (!KNOWN_PANE.has(key)) warnings.push(`${where}.${key}: unknown field, ignored`);
  const id = raw.id === undefined ? `pane-${index + 1}` : raw.id;
  if (typeof id !== 'string' || !PANE_ID_RE.test(id)) { errors.push(`${where}.id: letters, digits, '.', '_' or '-' (max 40)`); return null; }
  if (raw.type !== undefined && raw.type !== 'terminal' && raw.type !== 'agent') errors.push(`${where}.type: "terminal" or "agent" (browser pages go in "browser.tabs")`);
  if (raw.when !== undefined && raw.when !== 'always') warnings.push(`${where}.when: only "always" is supported; use runOnce for first-open steps`);
  const cwdRaw = raw.cwd === undefined ? '.' : raw.cwd;
  const cwd = typeof cwdRaw === 'string' ? containedCwd(cwdRaw) : null;
  if (cwd === null) errors.push(`${where}.cwd: must be a folder inside this repo, relative to the manifest (no absolute path, no ..)`);
  const titleRaw = raw.title ?? raw.name;
  return {
    id,
    title: typeof titleRaw === 'string' && titleRaw.trim() ? titleRaw.trim().slice(0, 60) : undefined,
    cwd: cwd ?? '.',
    run: checkCommands(stringList(raw.run, `${where}.run`, errors), `${where}.run`, errors),
    runOnce: checkCommands(stringList(raw.runOnce, `${where}.runOnce`, errors), `${where}.runOnce`, errors),
    env: parseEnv(raw.env, `${where}.env`, errors, warnings),
    after: stringList(raw.after, `${where}.after`, errors),
    waitFor: parseWaitFor(raw.waitFor, `${where}.waitFor`, errors),
  };
}

function parseBrowser(raw: unknown, errors: string[]): WorkspaceManifest['browser'] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) { errors.push('browser: expected { "tabs": [...] }'); return undefined; }
  const tabs: string[] = [];
  for (const tab of stringList(raw.tabs, 'browser.tabs', errors)) {
    let url: URL;
    try { url = new URL(tab); } catch { errors.push(`browser.tabs: "${tab}" is not a URL`); continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { errors.push(`browser.tabs: "${tab}" — http(s) only`); continue; }
    tabs.push(url.href);
  }
  if (tabs.length > MAX_BROWSER_TABS) errors.push(`browser.tabs: at most ${MAX_BROWSER_TABS}`);
  const active = typeof raw.active === 'number' && Number.isInteger(raw.active) && raw.active >= 0 && raw.active < tabs.length ? raw.active : 0;
  return tabs.length ? { tabs: tabs.slice(0, MAX_BROWSER_TABS), active } : undefined;
}

/** Order panes so every `after` runs first; null on a cycle. Stable otherwise. */
export function topoOrder(panes: Pick<ManifestPane, 'id' | 'after'>[]): string[] | null {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(panes.map((p) => [p.id, p]));
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 'done') return true;
    if (s === 'visiting') return false;
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.after ?? []) if (byId.has(dep) && !visit(dep)) return false;
    state.set(id, 'done');
    order.push(id);
    return true;
  };
  for (const p of panes) if (!visit(p.id)) return null;
  return order;
}

function checkGraph(panes: ManifestPane[], errors: string[]): void {
  const ids = new Set<string>();
  for (const p of panes) {
    if (ids.has(p.id)) errors.push(`panes: duplicate id "${p.id}"`);
    ids.add(p.id);
  }
  for (const p of panes) {
    for (const dep of p.after) {
      if (dep === p.id) errors.push(`panes.${p.id}.after: a pane cannot wait for itself`);
      else if (!ids.has(dep)) errors.push(`panes.${p.id}.after: no pane with id "${dep}"`);
    }
  }
  if (topoOrder(panes) === null) errors.push('panes: "after" forms a cycle');
}

function parseLayout(value: unknown, warnings: string[]): ManifestLayout | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (LAYOUTS as readonly string[]).includes(value)) return value as ManifestLayout;
  warnings.push(`layout: one of ${LAYOUTS.join(', ')}; ignored`);
  return undefined;
}

function parsePanes(value: unknown, errors: string[], warnings: string[]): ManifestPane[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('panes: at least one pane');
    return [];
  }
  if (value.length > MAX_PANES) errors.push(`panes: at most ${MAX_PANES}`);
  return value.slice(0, MAX_PANES)
    .map((p, i) => parsePane(p, i, errors, warnings))
    .filter((p): p is ManifestPane => p !== null);
}

export function parseManifest(raw: unknown): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(raw)) return { manifest: null, errors: ['expected a JSON object'], warnings };
  for (const key of Object.keys(raw)) if (!KNOWN_TOP.has(key)) warnings.push(`${key}: unknown field, ignored`);
  if (raw.version !== 1) errors.push('version: must be 1');
  if (raw.root !== undefined && raw.root !== '.') errors.push('root: only "." (the manifest\'s own folder) is supported');
  const layout = parseLayout(raw.layout, warnings);
  const panes = parsePanes(raw.panes, errors, warnings);
  checkGraph(panes, errors);
  const browser = parseBrowser(raw.browser, errors);
  if (panes.length + (browser ? 1 : 0) > MAX_PANES) errors.push(`panes + browser: at most ${MAX_PANES} panes in a workspace`);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : undefined;
  if (errors.length) return { manifest: null, errors, warnings };
  return { manifest: { version: 1, name, layout, panes, browser }, errors, warnings };
}

// ─── The resolved plan ──────────────────────────────────────────────────────

export interface PlannedPane {
  id: string;
  title: string;
  /** Absolute folder the pane opens in. */
  cwd: string;
  /** Exactly what will be typed, in order. */
  commands: string[];
  /** The runOnce entries among `commands` (first open on this machine). */
  onceCommands: string[];
  env: Record<string, string>;
  after: string[];
  waitFor?: WaitFor;
}

export interface WorkspacePlan {
  name: string;
  manifestPath: string;
  root: string;
  layout?: ManifestLayout;
  panes: PlannedPane[];
  browserTabs: string[];
  browserActive: number;
}

/** The repo root a manifest describes: its folder, or the parent of `.wmux`. */
export function manifestRoot(manifestPath: string): string {
  const dir = path.dirname(manifestPath);
  return path.basename(dir).toLowerCase() === '.wmux' ? path.dirname(dir) : dir;
}

/**
 * Resolve against a root, choosing which runOnce steps are still due. A
 * runOnce entry that is also listed in `run` runs once, in its runOnce place,
 * so both of the issue's spellings (`run: [install, dev], runOnce: [install]`
 * and `runOnce: [install], run: [dev]`) mean the same thing.
 */
export function buildPlan(manifest: WorkspaceManifest, manifestPath: string, alreadyRanOnce: ReadonlySet<string>): WorkspacePlan {
  const root = manifestRoot(manifestPath);
  return {
    name: manifest.name ?? path.basename(root),
    manifestPath,
    root,
    layout: manifest.layout,
    panes: manifest.panes.map((p) => {
      const due = p.runOnce.filter((cmd) => !alreadyRanOnce.has(onceKey(p.id, cmd)));
      const once = new Set(p.runOnce);
      return {
        id: p.id,
        title: p.title ?? p.id,
        cwd: path.resolve(root, p.cwd),
        commands: [...due, ...p.run.filter((cmd) => !once.has(cmd))],
        onceCommands: due,
        env: p.env,
        after: p.after,
        waitFor: p.waitFor,
      };
    }),
    browserTabs: manifest.browser?.tabs ?? [],
    browserActive: manifest.browser?.active ?? 0,
  };
}

/** How a runOnce step is remembered: per pane, per command text. */
export function onceKey(paneId: string, command: string): string {
  return `${paneId}\u0000${command}`;
}

/** Content hash the trust store keys on: any byte changed re-prompts. */
export function manifestHash(bytes: string | Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function describeWait(w: WaitFor): string {
  if (w.kind === 'port') return `waits for port ${w.port} (up to ${Math.round(w.timeoutMs / 1000)}s)`;
  if (w.kind === 'http') return `waits for ${w.url} (up to ${Math.round(w.timeoutMs / 1000)}s)`;
  return `waits ${w.ms} ms`;
}

/** Every line that will be typed, as `[pane] command` — what trust is granted over. */
export function planCommandLines(plan: WorkspacePlan): string[] {
  return plan.panes.flatMap((p) => p.commands.map((cmd) => `[${p.id}] ${cmd}`));
}

/**
 * The plan as text: `--dry-run`'s output AND the trust dialog's body. Shows
 * every folder, every command exactly as it will be typed, every env value as
 * written (a `${env:…}` reference is shown as the reference, never resolved —
 * this text may be pasted into an issue).
 */
export function formatPlan(plan: WorkspacePlan): string {
  const lines: string[] = [`${plan.name} — ${plan.manifestPath}`, ''];
  const order = topoOrder(plan.panes) ?? plan.panes.map((p) => p.id);
  for (const id of order) {
    const pane = plan.panes.find((x) => x.id === id);
    if (pane) lines.push(...formatPane(pane, plan.root));
  }
  if (plan.browserTabs.length) {
    lines.push('', 'Browser:');
    for (const tab of plan.browserTabs) lines.push(`    ${tab}`);
  }
  return lines.join('\n');
}

function formatPane(p: PlannedPane, root: string): string[] {
  const rel = path.relative(root, p.cwd) || '.';
  const label = p.title === p.id ? p.title : p.title + ' (' + p.id + ')';
  const lines = [`▸ ${label} — ${rel}`];
  if (p.after.length) lines.push(`    after: ${p.after.join(', ')}`);
  if (p.waitFor) lines.push(`    ${describeWait(p.waitFor)}`);
  for (const [k, v] of Object.entries(p.env)) lines.push(`    env ${k}=${v}`);
  for (const cmd of p.commands) {
    const once = p.onceCommands.includes(cmd) ? '    (first open only)' : '';
    lines.push(`    $ ${cmd}${once}`);
  }
  if (!p.commands.length) lines.push('    (no command)');
  return lines;
}

/** Lines added and removed since the version that was trusted. */
export function diffCommandLines(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return { added: after.filter((l) => !was.has(l)), removed: before.filter((l) => !now.has(l)) };
}

// ─── Writing one from a live workspace (`wmux workspace save`) ─────────────

export interface LiveWorkspaceDescription {
  title?: string;
  panes: { title?: string; cwd?: string; startupCommands?: string[]; env?: Record<string, string> }[];
  browserTabs: string[];
}

/**
 * The manifest a live workspace would be written as, relative to `root` (the
 * folder the file will live in). A pane whose folder is outside `root` cannot
 * be expressed — a manifest may not point outside its repo — so it is written
 * at the root with a warning rather than silently moved.
 *
 * A pane's `run` comes from its live startup commands, which are editable on a
 * live tab (right-click → Startup command…, `StartupCommandDialog.tsx`).
 */
export function manifestFromWorkspace(desc: LiveWorkspaceDescription, root: string, name?: string): { manifest: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const panes = desc.panes.slice(0, MAX_PANES).map((p, i) => {
    const id = `pane-${i + 1}`;
    let cwd = '.';
    if (p.cwd) {
      const rel = path.relative(root, p.cwd);
      if (rel.startsWith('..') || path.isAbsolute(rel)) warnings.push(`${id}: ${p.cwd} is outside ${root}; written as "." — edit it by hand`);
      else cwd = rel.split(path.sep).join('/') || '.';
    }
    const out: Record<string, unknown> = { id, cwd };
    if (p.title) out.title = p.title;
    if (p.startupCommands?.length) out.run = p.startupCommands;
    if (p.env && Object.keys(p.env).length) out.env = p.env;
    return out;
  });
  if (desc.panes.length > MAX_PANES) warnings.push(`only the first ${MAX_PANES} panes were written`);
  const manifest: Record<string, unknown> = { version: 1, name: name ?? desc.title ?? path.basename(root), panes };
  const tabs = desc.browserTabs.slice(0, MAX_BROWSER_TABS);
  if (tabs.length) manifest.browser = { tabs };
  if (!panes.some((p) => p.run)) warnings.push('no pane has a startup command yet — add "run" entries, or set one with a tab\'s right-click → Startup command…');
  return { manifest, warnings };
}
