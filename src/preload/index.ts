import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/types';

contextBridge.exposeInMainWorld('wmux', {
  pty: {
    create: (options: { shell: string; cwd: string; env: Record<string, string> }) =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, options),
    write: (id: string, data: string) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_WRITE, id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, id, cols, rows),
    kill: (id: string) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_KILL, id),
    onData: (id: string, callback: (data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ptyId: string, data: string) => {
        if (ptyId === id) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.PTY_DATA, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA, handler);
    },
    onExit: (id: string, callback: (code: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ptyId: string, code: number) => {
        if (ptyId === id) callback(code);
      };
      ipcRenderer.on(IPC_CHANNELS.PTY_EXIT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_EXIT, handler);
    },
  },
  system: {
    platform: 'win32' as const,
    getShells: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_SHELLS),
    openExternal: (url: string) => ipcRenderer.send(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, url),
    toggleDevTools: () => ipcRenderer.send('toggle-devtools'),
  },
  config: {
    getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET_THEME),
    getThemeList: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET_THEME_LIST),
    importWindowsTerminal: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_IMPORT_WT),
    importGhostty: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_IMPORT_GHOSTTY),
  },
  metadata: {
    onUpdate: (callback: (command: any) => void) => {
      const handler = (_event: any, cmd: any) => callback(cmd);
      ipcRenderer.on(IPC_CHANNELS.METADATA_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.METADATA_UPDATE, handler);
    },
  },
  notification: {
    fire: (data: { surfaceId: string; text: string; title?: string }) =>
      ipcRenderer.send(IPC_CHANNELS.NOTIFICATION_FIRE, data),
    onFocusSurface: (callback: (surfaceId: string) => void) => {
      const handler = (_event: any, surfaceId: string) => callback(surfaceId);
      ipcRenderer.on('notification:focus-surface', handler);
      return () => ipcRenderer.removeListener('notification:focus-surface', handler);
    },
  },
  browser: {
    navigate: (surfaceId: string, url: string) => ipcRenderer.send('browser:navigate', surfaceId, url),
  },
  agent: {
    list: (workspaceId?: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST, workspaceId),
    status: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STATUS, agentId),
    onUpdate: (callback: (agent: any) => void) => {
      const handler = (_event: any, agent: any) => callback(agent);
      ipcRenderer.on(IPC_CHANNELS.AGENT_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_UPDATE, handler);
    },
  },
  cdp: {
    attach: (webContentsId: number) => ipcRenderer.send(IPC_CHANNELS.CDP_ATTACH, webContentsId),
    detach: () => ipcRenderer.send(IPC_CHANNELS.CDP_DETACH),
  },
  window: {
    create: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CREATE),
    close: (id: string) => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE, id),
    focus: (id: string) => ipcRenderer.send(IPC_CHANNELS.WINDOW_FOCUS, id),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_LIST),
    minimize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
  },
});
