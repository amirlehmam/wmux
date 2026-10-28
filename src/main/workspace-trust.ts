// Which workspace manifests the user has said may run on this machine (#284).
//
// Kept in wmux's own data dir (`%APPDATA%\wmux\workspace-trust.json`) and NEVER
// beside the manifest: a repo must not be able to ship its own "trusted" flag.
// Keyed on the manifest's absolute path, holding the content hash (sha256,
// `manifestHash` in workspace-manifest.ts) that was trusted — any byte changed
// is a new question — and the exact command lines that were shown, so the next
// prompt can say what changed instead of making the user re-read everything.

import * as fs from 'fs';
import * as path from 'path';
import { getAppDataDir } from '../shared/instance';

export interface TrustEntry {
  hash: string;
  /** `[pane] command` lines the user saw when they trusted `hash`. */
  lines: string[];
  trustedAt: string;
  /** onceKey()s of runOnce steps already run from this manifest. */
  ranOnce: string[];
}

export interface TrustFile {
  version: 1;
  manifests: Record<string, TrustEntry>;
}

export function trustFilePath(): string {
  return path.join(getAppDataDir(), 'workspace-trust.json');
}

/** One key per manifest file, however its path was spelled. */
export function trustKey(manifestPath: string): string {
  const resolved = path.resolve(manifestPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isEntry(v: unknown): v is TrustEntry {
  const e = v as TrustEntry;
  return !!e && typeof e.hash === 'string' && Array.isArray(e.lines) && Array.isArray(e.ranOnce);
}

/** A missing or damaged file trusts nothing — never the other way round. */
export function loadTrust(file = trustFilePath()): TrustFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const manifests: Record<string, TrustEntry> = {};
    for (const [key, entry] of Object.entries(raw?.manifests ?? {})) if (isEntry(entry)) manifests[key] = entry;
    return { version: 1, manifests };
  } catch {
    return { version: 1, manifests: {} };
  }
}

/** Atomic like session.json: temp file, then rename over the target. */
export function saveTrust(data: TrustFile, file = trustFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(file); } catch { /* not there */ }
    fs.renameSync(tmp, file);
  }
}

export function getTrustEntry(manifestPath: string, file = trustFilePath()): TrustEntry | undefined {
  return loadTrust(file).manifests[trustKey(manifestPath)];
}

/** Record that `hash` (showing `lines`) is trusted; keeps what already ran once. */
export function recordTrust(manifestPath: string, hash: string, lines: string[], file = trustFilePath()): void {
  const data = loadTrust(file);
  const key = trustKey(manifestPath);
  data.manifests[key] = { hash, lines, trustedAt: new Date().toISOString(), ranOnce: data.manifests[key]?.ranOnce ?? [] };
  saveTrust(data, file);
}

export function recordRanOnce(manifestPath: string, keys: string[], file = trustFilePath()): void {
  if (!keys.length) return;
  const data = loadTrust(file);
  const entry = data.manifests[trustKey(manifestPath)];
  if (!entry) return;
  entry.ranOnce = [...new Set([...entry.ranOnce, ...keys])];
  saveTrust(data, file);
}
