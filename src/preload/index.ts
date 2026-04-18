import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/types';

contextBridge.exposeInMainWorld('wmux', {
  pty: {
    create: (options: { shell: string; cwd: string; env: Record<string, string>; surfaceId?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, options) as Promise<{ id: string; shell: string }>,
    write: (id: string, data: string) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_WRITE, id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, id, cols, rows),
    kill: (id: string) =>
      ipcRenderer.send(IPC_CHANNELS.PTY_KILL, id),
    has: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_HAS, id),
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
    getTheme: (name?: string) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET_THEME, name),
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
    navigate: (_surfaceId: string, url: string) => {
      // Dispatch a custom event that BrowserPane listens for
      window.dispatchEvent(new CustomEvent('wmux:browser-navigate', { detail: { url } }));
    },
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
  clipboard: {
    pasteImage: () => ipcRenderer.invoke('clipboard:paste-image'),
  },
  hook: {
    onEvent: (callback: (event: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.HOOK_EVENT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.HOOK_EVENT, handler);
    },
  },
  claudeActivity: {
    onUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_ACTIVITY, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_ACTIVITY, handler);
    },
  },
  orchestration: {
    onUpdate: (callback: (state: any) => void) => {
      const handler = (_event: any, state: any) => callback(state);
      ipcRenderer.on(IPC_CHANNELS.ORCHESTRATION_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.ORCHESTRATION_UPDATE, handler);
    },
    onClear: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.ORCHESTRATION_CLEAR, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.ORCHESTRATION_CLEAR, handler);
    },
  },
  session: {
    save: (session: any) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SAVE_NAMED, session),
    load: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LOAD_NAMED, name),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST_NAMED),
    delete: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE_NAMED, name),
    onAutoSaveRequest: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('session:request', handler);
      return () => ipcRenderer.removeListener('session:request', handler);
    },
    pushAutoSave: (data: any) => ipcRenderer.send('session:save', data),
  },
  diff: {
    getFiles: (cwd: string) => ipcRenderer.invoke(IPC_CHANNELS.DIFF_GET_FILES, cwd),
    getFileDiff: (cwd: string, file: string) => ipcRenderer.invoke(IPC_CHANNELS.DIFF_GET_DIFF, cwd, file),
    onUpdate: (callback: (data: { file?: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.DIFF_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.DIFF_UPDATE, handler);
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
