// The pipe methods and Electron wiring for workspace manifests (#284).
//
//   workspace.open      {path, dryRun?, newCopy?}  → workspace-open.ts
//   workspace.validate  {path}                     → errors / warnings / plan text
//   workspace.export    {to, name?}                → the manifest to write
//   workspace.list                                 → manifests trusted on this machine
//
// None of these writes a file. `export` (behind `wmux workspace save`) RETURNS
// the manifest and the CLI — running as the user, in the user's folder —
// writes it: main never writes a path a pipe caller named. And none of them
// can grant trust: `open` asks a native dialog (workspace-open.ts explains why
// that is the boundary).

import * as path from 'path';
import { BrowserWindow, dialog } from 'electron';
import { openManifest, resolveManifestPath, analyzeManifest, type OpenDeps, type TrustAnswer } from './workspace-open';
import { formatPlan, manifestFromWorkspace, MANIFEST_FILENAMES, type WorkspacePlan, type LiveWorkspaceDescription } from './workspace-manifest';
import { loadTrust } from './workspace-trust';
import { waitFor, sleep } from './wait-probes';
import type { ManifestWorkspaceSpec } from '../shared/types';

export const WORKSPACE_MANIFEST_METHODS = new Set(['workspace.open', 'workspace.validate', 'workspace.export', 'workspace.list']);

export interface ManifestHostDeps {
  deliver(surfaceId: string, commands: string[]): boolean;
  log(event: string, fields: Record<string, unknown>): void;
}

const liveWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());

async function evalIn<T>(win: BrowserWindow, script: string): Promise<T | null> {
  try { return (await win.webContents.executeJavaScript(script)) as T; } catch { return null; }
}

/** The caller's window when it has one, else the focused one, else the first. */
async function targetWindow(caller: unknown): Promise<BrowserWindow | null> {
  const windows = liveWindows();
  if (typeof caller === 'string' && caller) {
    for (const win of windows) {
      if (await evalIn(win, `window.__wmux_locateSurface?.(${JSON.stringify(caller)}) ?? null`)) return win;
    }
  }
  return BrowserWindow.getFocusedWindow() ?? windows[0] ?? null;
}

function trustDialogText(text: string, changed: { added: string[]; removed: string[] } | null): string {
  if (!changed) return text;
  const diff = [
    'This file changed since you last allowed it.',
    ...changed.added.map((l) => `  + ${l}`),
    ...changed.removed.map((l) => `  - ${l}`),
    '',
  ];
  return [...diff, text].join('\n');
}

async function confirmTrust(plan: WorkspacePlan, text: string, changed: { added: string[]; removed: string[] } | null, parent: BrowserWindow | null): Promise<TrustAnswer> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'wmux',
    message: changed
      ? `"${plan.name}" changed. Run its commands?`
      : `Run the commands in "${plan.name}"?`,
    detail: `${trustDialogText(text, changed)}\n\nOnly continue if you trust where this file came from. wmux will ask again if it changes.`,
    buttons: ['Run commands', 'Open without running', 'Cancel'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  };
  try {
    if (parent && !parent.isDestroyed()) parent.focus();
    const { response } = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (response === 0) return 'run';
    if (response === 1) return 'layout-only';
    return 'cancel';
  } catch {
    return 'cancel';
  }
}

function openDeps(host: ManifestHostDeps, caller: unknown): OpenDeps {
  let target: BrowserWindow | null = null;
  return {
    confirm: async (plan, text, changed) => {
      target = target ?? await targetWindow(caller);
      return confirmTrust(plan, text, changed, target);
    },
    createWorkspace: async (spec: ManifestWorkspaceSpec) => {
      target = target ?? await targetWindow(caller);
      if (!target) return null;
      return evalIn(target, `window.__wmux_openManifestWorkspace?.(${JSON.stringify(spec)}) ?? null`);
    },
    focusWorkspace: async (workspaceId) => {
      for (const win of liveWindows()) {
        if (await evalIn(win, `window.__wmux_focusWorkspaceIfOpen?.(${JSON.stringify(workspaceId)}) === true`)) {
          win.focus();
          return true;
        }
      }
      return false;
    },
    io: {
      deliver: (surfaceId, commands) => host.deliver(surfaceId, commands),
      wait: waitFor,
      sleep,
      notice: (surfaceId, text) => {
        const script = `window.__wmux_paneNotice?.(${JSON.stringify(surfaceId)}, ${JSON.stringify(text)}) === true`;
        void (async () => {
          for (const win of liveWindows()) if (await evalIn(win, script)) return;
        })();
      },
    },
    log: host.log,
  };
}

function needPath(params: any, respondError: (code: number, message: string) => void): string | null {
  const p = params?.path;
  if (typeof p !== 'string' || !p.trim() || !path.isAbsolute(p)) {
    respondError(-32602, 'path: an absolute path to a workspace manifest or its folder');
    return null;
  }
  return p;
}

export function handleWorkspaceManifestV2(
  method: string,
  params: any,
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
  host: ManifestHostDeps,
): void {
  if (method === 'workspace.list') {
    const trust = loadTrust();
    respond({ manifests: Object.entries(trust.manifests).map(([p, e]) => ({ path: p, trustedAt: e.trustedAt })) });
    return;
  }
  if (method === 'workspace.export') {
    handleExport(params, respond, respondError);
    return;
  }
  const manifestInput = needPath(params, respondError);
  if (!manifestInput) return;
  if (method === 'workspace.validate') {
    const manifestPath = resolveManifestPath(manifestInput);
    if (!manifestPath) { respond({ ok: false, errors: [`no workspace manifest at ${manifestInput} (looked for ${MANIFEST_FILENAMES.join(' or ')})`], warnings: [] }); return; }
    const analyzed = analyzeManifest(manifestPath);
    if ('errors' in analyzed) respond({ ok: false, path: manifestPath, ...analyzed });
    else respond({ ok: true, path: manifestPath, warnings: analyzed.warnings, plan: formatPlan(analyzed.plan) });
    return;
  }
  openManifest({ path: manifestInput, dryRun: params?.dryRun === true, newCopy: params?.newCopy === true }, openDeps(host, params?.caller))
    .then(respond, (err: unknown) => respondError(-32603, err instanceof Error ? err.message : String(err)));
}

function handleExport(params: any, respond: (result: any) => void, respondError: (code: number, message: string) => void): void {
  const to = params?.to;
  if (typeof to !== 'string' || !path.isAbsolute(to)) { respondError(-32602, 'to: the absolute folder the manifest will live in'); return; }
  (async () => {
    for (const win of liveWindows()) {
      const desc = await evalIn<LiveWorkspaceDescription>(win, `window.__wmux_describeWorkspace?.(${JSON.stringify({ caller: params?.caller, workspaceId: params?.workspaceId })}) ?? null`);
      if (desc) return desc;
    }
    return null;
  })().then((desc) => {
    if (!desc) { respondError(-32602, 'no workspace to save: run this from a wmux pane, or pass --workspace'); return; }
    respond(manifestFromWorkspace(desc, to, typeof params?.name === 'string' ? params.name : undefined));
  }, (err: unknown) => respondError(-32603, err instanceof Error ? err.message : String(err)));
}

/** Electron's file picker → open, for the command palette entry. */
export async function pickAndOpenManifest(parent: BrowserWindow | null, host: ManifestHostDeps): Promise<void> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open workspace file',
    properties: ['openFile'],
    filters: [{ name: 'wmux workspace', extensions: ['json'] }],
  };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return;
  const result = await openManifest({ path: picked.filePaths[0] }, openDeps(host, null));
  if (!result.ok) {
    const box: Electron.MessageBoxOptions = { type: 'error', title: 'wmux', message: 'This workspace file cannot be opened.', detail: result.errors.join('\n'), noLink: true };
    if (parent) await dialog.showMessageBox(parent, box);
    else await dialog.showMessageBox(box);
  }
}
