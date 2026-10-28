// A pane's OSC 7 cwd report (#378), renderer half. The payload goes to main
// RAW — main owns the allow-list (see src/shared/osc7.ts) and the explorer
// root map — and only the path main accepted lands in the store, as the same
// `currentCwd` a pipe `report_pwd` writes. Main updates its root BEFORE it
// answers, so by the time the explorer sees the new `currentCwd` and refetches,
// the jail it lists against has already moved.

import { useStore } from '../store';
import { findLeaf, findSurfaceOwner } from '../store/split-utils';
import type { SurfaceId } from '../../shared/types';
import { isWslShell } from '../../shared/paths';

export async function applyOsc7Cwd(surfaceId: SurfaceId, data: string): Promise<void> {
  let cwd: string | null;
  try {
    cwd = await window.wmux.explorer.reportOsc7(surfaceId, data);
  } catch {
    return;
  }
  if (!cwd) return;
  const { workspaces, workspacePrefs, updateSurface, updateWorkspaceMetadata } = useStore.getState();
  const owner = findSurfaceOwner(workspaces, surfaceId);
  if (!owner) return;
  const ws = workspaces.find((w) => w.id === owner.workspaceId);
  const surface = ws && findLeaf(ws.splitTree, owner.paneId)?.surfaces.find((s) => s.id === surfaceId);
  if (!ws || !surface) return;
  const isWsl = isWslShell(surface.shell || ws.shell || workspacePrefs.defaultShell);
  if (ws.cwd !== cwd || (isWsl && ws.posixCwd !== cwd)) {
    updateWorkspaceMetadata(ws.id, { cwd, ...(isWsl ? { posixCwd: cwd } : {}) });
  }
  // Repeated prompts must not re-render the tree, but may need to restore the
  // workspace metadata after a neighbouring pane reported a different cwd.
  if (surface.currentCwd !== cwd) {
    updateSurface(owner.workspaceId, owner.paneId, surfaceId, { currentCwd: cwd });
  }
}
