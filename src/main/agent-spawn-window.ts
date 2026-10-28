import { BrowserWindow } from 'electron';
import { agentManager, setupAgentPtyForwarding } from './ipc-handlers';
import { SpawnTargetError } from './agent-spawn-target';

/**
 * Resolve the target's renderer before creating any PTYs. Both spawn routes
 * use the returned spawner so output and history authority follow the same
 * window, rather than whichever window happens to be first.
 */
export async function prepareAgentSpawn(workspaceId: string, paneIds: readonly string[]): Promise<typeof agentManager.spawn> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const loads = await win.webContents
      .executeJavaScript(`window.__wmux_getPaneLoads?.(${JSON.stringify(workspaceId)}) ?? []`)
      .catch(() => []);
    if (win.isDestroyed() || win.webContents.isDestroyed() || !Array.isArray(loads) || loads.length === 0
      || !paneIds.every((paneId) => loads.some((load) => load?.paneId === paneId))) continue;
    return (params) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) {
        throw new SpawnTargetError(-32000, 'Target window is no longer available');
      }
      const result = agentManager.spawn(params);
      setupAgentPtyForwarding(result.surfaceId, win);
      return result;
    };
  }
  throw new SpawnTargetError(-32000, 'Target panes are no longer available');
}
