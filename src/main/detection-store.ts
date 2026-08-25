/**
 * Detection results, mirrored into main.
 *
 * The loop runs in the renderer (that is where the screen is), but the CLI and
 * the pipe live here, so `wmux agent-state` and `wmux detect explain` need a
 * copy. A mirror rather than a query: `executeJavaScript` per CLI call would
 * work, but the renderer is also the thread drawing every terminal, and a
 * debugging command should not have to interrupt it.
 */
import { app } from 'electron';
import * as fs from 'fs';
import { DetectionResult, Manifest } from '../shared/detection/types';
import { detectScreen } from '../shared/detection/engine';
import { BUNDLED_MANIFESTS } from '../shared/detection/manifests';
import { loadUserManifests, mergeManifests } from './user-manifests';

/** Same bound, and the same reason, as agent-state.ts's record map. */
const MAX_TRACKED_SURFACES = 256;

const results = new Map<string, DetectionResult>();

export function setDetection(surfaceId: string, result: DetectionResult | null): void {
  if (!result) {
    results.delete(surfaceId);
    return;
  }
  if (results.size >= MAX_TRACKED_SURFACES && !results.has(surfaceId)) {
    const oldest = results.keys().next();
    if (!oldest.done) results.delete(oldest.value);
  }
  results.set(surfaceId, result);
}

export function getDetection(surfaceId: string): DetectionResult | undefined {
  return results.get(surfaceId);
}

export function listDetections(): Array<DetectionResult & { surfaceId: string }> {
  return [...results.entries()].map(([surfaceId, result]) => ({ surfaceId, ...result }));
}

export function forgetDetection(surfaceId: string): void {
  results.delete(surfaceId);
}

/** Tests only. */
export function resetDetectionStore(): void {
  results.clear();
  cachedManifests = null;
}

let cachedManifests: { manifests: Manifest[]; warnings: string[] } | null = null;

/**
 * Bundled manifests with any user overrides applied.
 *
 * Cached because it is read on every renderer bootstrap and on every explain,
 * and re-reading the config directory each time would turn a debugging command
 * into a filesystem sweep. `reloadManifests` is the explicit invalidation, so
 * editing an override and re-running explain is a two-step the user controls
 * rather than a race they have to guess at.
 */
export function activeManifests(): { manifests: Manifest[]; warnings: string[] } {
  if (!cachedManifests) {
    const { manifests: overrides, warnings } = loadUserManifests();
    cachedManifests = { manifests: mergeManifests(BUNDLED_MANIFESTS, overrides), warnings };
  }
  return cachedManifests;
}

export function reloadManifests(): { manifests: Manifest[]; warnings: string[] } {
  cachedManifests = null;
  return activeManifests();
}

export interface ExplainResult {
  surfaceId?: string;
  file?: string;
  agent: string | null;
  state: string;
  ruleId: string | null;
  reason: string;
  manifestVersion: number | null;
  evidence: string[];
  /** Where the manifest that decided came from, so a stale override is visible. */
  manifestSource: 'bundled' | 'override' | null;
  /** Problems found while loading overrides — always shown, never swallowed. */
  warnings: string[];
  /** Config directory, so the answer to "where do I put my file?" is in the output. */
  manifestDir: string;
}

function sourceOf(agent: string | null, manifests: Manifest[]): ExplainResult['manifestSource'] {
  if (!agent) return null;
  const bundled = BUNDLED_MANIFESTS.some((m) => m.agent === agent);
  const active = manifests.find((m) => m.agent === agent);
  if (!active) return null;
  return bundled && BUNDLED_MANIFESTS.includes(active) ? 'bundled' : 'override';
}

/**
 * Why does this surface read the way it does?
 *
 * The live half. Reports what the renderer last decided rather than re-running
 * the engine, so it answers the question the user actually asked — "why does
 * the sidebar say that" — instead of "what would a fresh scan say now".
 */
export function explainSurface(surfaceId: string): ExplainResult {
  const { manifests, warnings } = activeManifests();
  const result = results.get(surfaceId);
  const dir = manifestDirSafe();

  if (!result) {
    return {
      surfaceId,
      agent: null,
      state: 'unknown',
      ruleId: null,
      reason: 'not-scanned',
      manifestVersion: null,
      evidence: [],
      manifestSource: null,
      warnings,
      manifestDir: dir,
    };
  }

  return {
    surfaceId,
    ...result,
    manifestSource: sourceOf(result.agent, manifests),
    warnings,
    manifestDir: dir,
  };
}

/**
 * The offline half: replay a captured screen with no running detection.
 *
 * Worth every minute it costs. It is how a rule regression gets debugged from a
 * `wmux read-screen` capture committed to a fixture, on a machine where the
 * agent in question is not installed — which is exactly the situation the
 * bundled Codex and OpenCode manifests were written in.
 */
export function explainFile(file: string, agent?: string): ExplainResult {
  const { manifests, warnings } = activeManifests();
  const dir = manifestDirSafe();

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      file,
      agent: null,
      state: 'unknown',
      ruleId: null,
      reason: `unreadable: ${(err as Error).message}`,
      manifestVersion: null,
      evidence: [],
      manifestSource: null,
      warnings,
      manifestDir: dir,
    };
  }

  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const result = detectScreen({ lines }, manifests, agent ?? null);
  return {
    file,
    ...result,
    manifestSource: sourceOf(result.agent, manifests),
    warnings,
    manifestDir: dir,
  };
}

/** `app` is unavailable in a bare unit test; the directory is informational. */
function manifestDirSafe(): string {
  try {
    return `${app.getPath('userData')}\\agent-detection`;
  } catch {
    return '';
  }
}
