// Opening a workspace manifest (#284), end to end: read → validate → plan →
// (dry run | focus the copy already open | ask for trust) → create the panes
// → type each pane's commands in order.
//
// The trust question is the security boundary, and two things keep it one:
//   1. It is asked by a NATIVE dialog in main (`deps.confirm`, implemented in
//      workspace-manifest-v2.ts). Nothing on the pipe can answer it — there is
//      deliberately no `--trust` flag, because an agent holding the pipe token
//      could pass it, and "a repo I cloned runs its commands without asking" is
//      exactly the hole this closes. The answer is recorded per manifest path,
//      with the sha256 of the bytes that were shown, in
//      `%APPDATA%\wmux\workspace-trust.json` (workspace-trust.ts), so any byte
//      changed re-prompts, with an added/removed diff.
//   2. What the dialog shows is `formatPlan` of the SAME plan the scheduler
//      runs. Re-reading the file between the two would let it change after
//      the user looked; it is read once, hashed, and that text is the plan.
//
// Manifest commands never enter the store or session.json — the workspace spec
// carries the layout, folders, titles, env and browser tabs, never a command,
// and the commands go straight to the scheduler — because a restart would
// replay them without asking again.
// Re-opening a manifest that is already open focuses it instead of opening a
// second copy; the map that knows this is live-only, so it is empty after a
// restart.
//
// "Open without running commands" is a real answer, not a cancel: the layout,
// folders and env still come up, which is what graceful degradation means for
// a file the user does not want executing anything.

import * as fs from 'fs';
import * as path from 'path';
import {
  MANIFEST_FILENAMES,
  MAX_MANIFEST_BYTES,
  buildPlan,
  diffCommandLines,
  formatPlan,
  manifestHash,
  onceKey,
  parseManifest,
  planCommandLines,
  stripJsonComments,
  type WorkspacePlan,
} from './workspace-manifest';
import { getTrustEntry, recordRanOnce, recordTrust, trustKey } from './workspace-trust';
import { runPlan, type PaneOutcome, type SchedulerIo } from './workspace-scheduler';
import type { ManifestWorkspaceSpec } from '../shared/types';

export type TrustAnswer = 'run' | 'layout-only' | 'cancel';

export interface OpenDeps {
  /** The native trust dialog. `changed` is set when an earlier version was trusted. */
  confirm(plan: WorkspacePlan, text: string, changed: { added: string[]; removed: string[] } | null): Promise<TrustAnswer>;
  createWorkspace(spec: ManifestWorkspaceSpec): Promise<{ workspaceId: string; surfaces: Record<string, string> } | null>;
  focusWorkspace(workspaceId: string): Promise<boolean>;
  io: SchedulerIo;
  log(event: string, fields: Record<string, unknown>): void;
}

export type OpenResult =
  | { ok: false; errors: string[]; warnings: string[] }
  | { ok: true; dryRun: true; plan: string; warnings: string[] }
  | { ok: true; focused: true; workspaceId: string }
  | { ok: true; cancelled: true }
  | { ok: true; workspaceId: string; ranCommands: boolean; warnings: string[] };

/** Workspaces opened from a manifest in this run of wmux, by manifest path. */
const openedWorkspaces = new Map<string, string>();

/**
 * A path the caller gave: a manifest file, or a folder holding one at a known
 * name. The CLI resolves relative paths against the CALLER's cwd before this.
 */
export function resolveManifestPath(input: string): string | null {
  const abs = path.resolve(input);
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch { return null; }
  if (stat.isFile()) return abs.toLowerCase().endsWith('.json') ? abs : null;
  if (!stat.isDirectory()) return null;
  for (const name of MANIFEST_FILENAMES) {
    const candidate = path.join(abs, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

/** Read once: the bytes that are hashed are the bytes that are planned. */
function readManifest(manifestPath: string): { text: string } | { error: string } {
  let stat: fs.Stats;
  try { stat = fs.statSync(manifestPath); } catch { return { error: `cannot read ${manifestPath}` }; }
  if (stat.size > MAX_MANIFEST_BYTES) return { error: `${manifestPath} is larger than ${MAX_MANIFEST_BYTES / 1024} KB` };
  try { return { text: fs.readFileSync(manifestPath, 'utf-8') }; } catch { return { error: `cannot read ${manifestPath}` }; }
}

/**
 * realpath every pane folder that exists: a symlink or junction must not walk
 * out of the repo. The lexical half (relative, no `..`) is `containedCwd` in
 * workspace-manifest.ts.
 */
function checkFolders(plan: WorkspacePlan): string[] {
  const errors: string[] = [];
  let realRoot: string;
  try { realRoot = fs.realpathSync(plan.root); } catch { return [`${plan.root} does not exist`]; }
  for (const pane of plan.panes) {
    let real: string;
    try { real = fs.realpathSync(pane.cwd); } catch { continue; } // missing: the pane opens in the root, see below
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) errors.push(`panes.${pane.id}.cwd: ${pane.cwd} resolves outside the repo (${real})`);
  }
  return errors;
}

/** A pane whose folder does not exist opens at the root and says so, rather than failing the open. */
function missingFolderNotices(plan: WorkspacePlan): Map<string, string> {
  const notices = new Map<string, string>();
  for (const pane of plan.panes) {
    if (!fs.existsSync(pane.cwd)) {
      notices.set(pane.id, `folder ${pane.cwd} does not exist — opened in the repo root instead, nothing was run`);
      pane.cwd = plan.root;
      pane.commands = [];
      pane.onceCommands = [];
    }
  }
  return notices;
}

export function analyzeManifest(manifestPath: string):
  { plan: WorkspacePlan; hash: string; trustLines: string[]; warnings: string[] } | { errors: string[]; warnings: string[] } {
  const read = readManifest(manifestPath);
  if ('error' in read) return { errors: [read.error], warnings: [] };
  let raw: unknown;
  try { raw = JSON.parse(stripJsonComments(read.text)); } catch (err) {
    return { errors: [`not valid JSON: ${(err as Error).message}`], warnings: [] };
  }
  const parsed = parseManifest(raw);
  if (!parsed.manifest) return { errors: parsed.errors, warnings: parsed.warnings };
  const ranOnce = new Set(getTrustEntry(manifestPath)?.ranOnce ?? []);
  const plan = buildPlan(parsed.manifest, manifestPath, ranOnce);
  const folderErrors = checkFolders(plan);
  if (folderErrors.length) return { errors: folderErrors, warnings: parsed.warnings };
  // What trust is granted OVER: everything the file can run, runOnce steps
  // included whether or not they already ran here. Taken from the plan with
  // that history applied, the next prompt's diff reported a runOnce step that
  // had simply been done as "removed" (the first version did that; a test
  // caught it).
  const trustLines = planCommandLines(buildPlan(parsed.manifest, manifestPath, new Set()));
  return { plan, hash: manifestHash(read.text), trustLines, warnings: parsed.warnings };
}

async function askTrust(manifestPath: string, plan: WorkspacePlan, hash: string, lines: string[], deps: OpenDeps): Promise<TrustAnswer> {
  if (!lines.length) return 'run'; // nothing would execute: there is nothing to consent to
  const entry = getTrustEntry(manifestPath);
  if (entry?.hash === hash) return 'run';
  const changed = entry ? diffCommandLines(entry.lines, lines) : null;
  const answer = await deps.confirm(plan, formatPlan(plan), changed);
  if (answer === 'run') recordTrust(manifestPath, hash, lines);
  return answer;
}

export async function openManifest(input: { path: string; dryRun?: boolean; newCopy?: boolean }, deps: OpenDeps): Promise<OpenResult> {
  const manifestPath = resolveManifestPath(input.path);
  if (!manifestPath) {
    return { ok: false, errors: [`no workspace manifest at ${input.path} (looked for ${MANIFEST_FILENAMES.join(' or ')})`], warnings: [] };
  }
  const analyzed = analyzeManifest(manifestPath);
  if ('errors' in analyzed) return { ok: false, errors: analyzed.errors, warnings: analyzed.warnings };
  const { plan, hash, trustLines, warnings } = analyzed;
  if (input.dryRun) return { ok: true, dryRun: true, plan: formatPlan(plan), warnings };

  const key = trustKey(manifestPath);
  const existing = openedWorkspaces.get(key);
  if (existing && !input.newCopy && await deps.focusWorkspace(existing)) return { ok: true, focused: true, workspaceId: existing };

  const answer = await askTrust(manifestPath, plan, hash, trustLines, deps);
  if (answer === 'cancel') return { ok: true, cancelled: true };
  const workspaceId = await launch(manifestPath, plan, answer === 'run', deps);
  if (!workspaceId) return { ok: false, errors: ['no wmux window could create the workspace'], warnings };
  openedWorkspaces.set(key, workspaceId);
  return { ok: true, workspaceId, ranCommands: answer === 'run', warnings };
}

/** Create the panes, then (when trusted) start the ordered run in the background. */
async function launch(manifestPath: string, plan: WorkspacePlan, run: boolean, deps: OpenDeps): Promise<string | null> {
  const notices = missingFolderNotices(plan);
  const created = await deps.createWorkspace({
    title: plan.name,
    cwd: plan.root,
    layout: plan.layout,
    panes: plan.panes.map((p) => ({ key: p.id, title: p.title, cwd: p.cwd, env: p.env })),
    browser: plan.browserTabs.length ? { tabs: plan.browserTabs, active: plan.browserActive } : undefined,
  });
  if (!created) return null;
  for (const [id, text] of notices) if (created.surfaces[id]) deps.io.notice(created.surfaces[id], text);
  deps.log('workspace-manifest-open', { panes: plan.panes.length, run, tabs: plan.browserTabs.length });
  if (!run) {
    showSkippedCommands(plan, created.surfaces, deps);
    return created.workspaceId;
  }
  runPlan(plan.panes, created.surfaces, deps.io)
    .then((outcomes) => afterRun(manifestPath, plan, outcomes, deps))
    .catch((err: unknown) => deps.log('workspace-manifest-run-failed', { message: err instanceof Error ? err.message : String(err) }));
  return created.workspaceId;
}

function showSkippedCommands(plan: WorkspacePlan, surfaces: Record<string, string>, deps: OpenDeps): void {
  for (const pane of plan.panes) {
    const surface = surfaces[pane.id];
    if (surface && pane.commands.length) deps.io.notice(surface, `opened without running commands — this pane would run: ${pane.commands.join(' ; ')}`);
  }
}

function afterRun(manifestPath: string, plan: WorkspacePlan, outcomes: Record<string, PaneOutcome>, deps: OpenDeps): void {
  // A runOnce step counts as done once it was typed — whether it then
  // succeeded is the shell's business, as it is for anything typed by hand.
  const done = plan.panes
    .filter((p) => outcomes[p.id] === 'started')
    .flatMap((p) => p.onceCommands.map((cmd) => onceKey(p.id, cmd)));
  try { recordRanOnce(manifestPath, done); } catch { /* the next open runs them again: safe */ }
  deps.log('workspace-manifest-ran', { outcomes: Object.entries(outcomes).map(([id, o]) => `${id}:${o}`).join('|') });
}

/** Test seam: forget which manifests are open. */
export function _resetOpenedWorkspaces(): void {
  openedWorkspaces.clear();
}
