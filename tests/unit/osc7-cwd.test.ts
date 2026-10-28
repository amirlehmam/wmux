import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneId, SurfaceId, SurfaceRef, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';
import { applyOsc7Cwd } from '../../src/renderer/utils/osc7-cwd';

const { getState } = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock('../../src/renderer/store', () => ({ useStore: { getState } }));

const workspaceId = 'ws-osc7' as WorkspaceId;
const paneId = 'pane-osc7' as PaneId;
const surfaceId = 'surf-osc7' as SurfaceId;
const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\user\\project';
const reportOsc7 = vi.fn();
const updateSurface = vi.fn();
const updateWorkspaceMetadata = vi.fn();
let workspace: WorkspaceInfo;
let surface: SurfaceRef;
let defaultShell: string;

beforeEach(() => {
  vi.clearAllMocks();
  defaultShell = 'pwsh.exe';
  surface = { id: surfaceId, type: 'terminal', shell: 'wsl.exe -d Ubuntu' };
  workspace = {
    id: workspaceId, title: 'WSL', pinned: false, unreadCount: 0, shell: '', cwd: 'C:\\Users\\user',
    splitTree: {
      type: 'leaf', paneId, activeSurfaceIndex: 0,
      surfaces: [surface],
    },
  };
  getState.mockImplementation(() => ({
    workspaces: [workspace], workspacePrefs: { defaultShell }, updateSurface, updateWorkspaceMetadata,
  }));
  reportOsc7.mockResolvedValue(cwd);
  vi.stubGlobal('window', { wmux: { explorer: { reportOsc7 } } });
});

afterEach(() => vi.unstubAllGlobals());

describe('OSC 7 cwd propagation', () => {
  it('updates sidebar metadata, the WSL fallback and the terminal cwd', async () => {
    await applyOsc7Cwd(surfaceId, 'raw OSC 7');
    expect(reportOsc7).toHaveBeenCalledWith(surfaceId, 'raw OSC 7');
    expect(updateWorkspaceMetadata).toHaveBeenCalledWith(workspaceId, { cwd, posixCwd: cwd });
    expect(updateSurface).toHaveBeenCalledWith(workspaceId, paneId, surfaceId, { currentCwd: cwd });

  });

  it('uses the configured default shell when the surface has no explicit shell', async () => {
    surface.shell = undefined;
    defaultShell = 'wsl.exe -d Ubuntu';
    await applyOsc7Cwd(surfaceId, 'raw');
    expect(updateWorkspaceMetadata).toHaveBeenCalledWith(workspaceId, { cwd, posixCwd: cwd });
  });

  it('does not replace the WSL fallback for a Windows pane', async () => {
    surface.shell = 'pwsh.exe';
    defaultShell = 'wsl.exe';
    workspace.posixCwd = '/home/user/other-project';
    reportOsc7.mockResolvedValue('C:\\other');
    await applyOsc7Cwd(surfaceId, 'raw');
    expect(updateWorkspaceMetadata).toHaveBeenCalledWith(workspaceId, { cwd: 'C:\\other' });
  });

  it('refreshes workspace metadata even when the surface cwd has not changed', async () => {
    surface.currentCwd = cwd;
    await applyOsc7Cwd(surfaceId, 'raw');
    expect(updateWorkspaceMetadata).toHaveBeenCalledWith(workspaceId, { cwd, posixCwd: cwd });
    expect(updateSurface).not.toHaveBeenCalled();
  });

  it('does not write to the store for an unchanged report', async () => {
    surface.currentCwd = cwd;
    workspace.cwd = cwd;
    workspace.posixCwd = cwd;
    await applyOsc7Cwd(surfaceId, 'raw');
    expect(updateWorkspaceMetadata).not.toHaveBeenCalled();
    expect(updateSurface).not.toHaveBeenCalled();
  });

  it('ignores rejected reports, IPC failure and missing surfaces', async () => {
    reportOsc7.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('unavailable'));
    await applyOsc7Cwd(surfaceId, 'rejected');
    await applyOsc7Cwd(surfaceId, 'failed');
    getState.mockReturnValue({ workspaces: [] });
    await applyOsc7Cwd(surfaceId, 'closed');
    expect(updateWorkspaceMetadata).not.toHaveBeenCalled();
    expect(updateSurface).not.toHaveBeenCalled();
  });
});
