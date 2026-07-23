import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS } from '../shared/types';

contextBridge.exposeInMainWorld('wmux', {
  pty: {
    create: (options: { shell: string; cwd: string; env: Record<string, string>; surfaceId?: string; startupCommands?: string[]; cols?: number; rows?: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, options) as Promise<{ id: string; shell: string; startupCommandsConsumed?: boolean }>,
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
    getFonts: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_FONTS) as Promise<string[]>,
    openExternal: (url: string) => ipcRenderer.send(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, url),
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_VERSION),
    toggleDevTools: () => ipcRenderer.send('toggle-devtools'),
    pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_PICK_FOLDER),
    getShouldUseDarkColors: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_SHOULD_USE_DARK_COLORS) as Promise<boolean>,
    onNativeThemeUpdated: (callback: (shouldUseDarkColors: boolean) => void) => {
      const handler = (_event: any, shouldUseDarkColors: boolean) => callback(shouldUseDarkColors);
      ipcRenderer.on(IPC_CHANNELS.SYSTEM_NATIVE_THEME_UPDATED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SYSTEM_NATIVE_THEME_UPDATED, handler);
    },
  },
  config: {
    getTheme: (name?: string) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET_THEME, name),
    getThemeList: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET_THEME_LIST),
    importWindowsTerminal: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_IMPORT_WT),
    importGhostty: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_IMPORT_GHOSTTY),
    getProjectProfiles: (cwd: string) => ipcRenderer.invoke('config:getProjectProfiles', cwd),
    importWindowsTerminalProfiles: () => ipcRenderer.invoke('config:importWindowsTerminalProfiles'),
    getUserConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET_USER_CONFIG),
    reloadUserConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_RELOAD_USER_CONFIG),
    getUserConfigPath: () => ipcRenderer.invoke('config:getUserConfigPath'),
    onUserConfigUpdated: (callback: (cfg: any) => void) => {
      const handler = (_event: any, cfg: any) => callback(cfg);
      ipcRenderer.on(IPC_CHANNELS.CONFIG_USER_CONFIG_UPDATED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CONFIG_USER_CONFIG_UPDATED, handler);
    },
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
    onPlaySound: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('notification:play-sound', handler);
      return () => ipcRenderer.removeListener('notification:play-sound', handler);
    },
  },
  browser: {
    navigate: (surfaceId: string, url: string) => {
      // Dispatch a custom event that BrowserPane listens for
      window.dispatchEvent(new CustomEvent('wmux:browser-navigate', { detail: { url, surfaceId: surfaceId || undefined } }));
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
    writeText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
    readText: () => ipcRenderer.invoke('clipboard:read-text') as Promise<string>,
  },
  shell: {
    // Resolve a dropped File to its real filesystem path. Electron 33 removed
    // File.path, so the renderer can no longer read it directly — webUtils
    // (preload-only) is the supported replacement. Used by terminal drag-and-drop
    // (issue #33).
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
  },
  settings: {
    // Synchronous read so the renderer store can hydrate at module-load time.
    getAllSync: (): Record<string, unknown> => {
      try {
        return ipcRenderer.sendSync('settings:get-all-sync') ?? {};
      } catch {
        return {};
      }
    },
    set: (key: string, value: unknown) => ipcRenderer.send('settings:set', key, value),
    // OS display-language list (issue #114) — synchronous for the same reason as
    // getAllSync: first-launch language detection runs at store-creation time.
    getPreferredLanguagesSync: (): string[] => {
      try {
        const langs = ipcRenderer.sendSync('system:get-preferred-languages-sync');
        return Array.isArray(langs) ? langs : [];
      } catch {
        return [];
      }
    },
  },
  update: {
    getLatest: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_GET_LATEST),
    openRelease: (url: string) => ipcRenderer.send(IPC_CHANNELS.UPDATE_OPEN_RELEASE, url),
    onAvailable: (callback: (info: { version: string; url: string; body?: string; publishedAt?: string }) => void) => {
      const handler = (_event: any, info: any) => callback(info);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_AVAILABLE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_AVAILABLE, handler);
    },
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
    loadAuto: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LOAD_AUTO),
    onAutoSaveRequest: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('session:request', handler);
      return () => ipcRenderer.removeListener('session:request', handler);
    },
    pushAutoSave: (data: any) => ipcRenderer.send('session:save', data),
  },
  markdown: {
    // Manual "open markdown file" entry point (issue #54): native file picker +
    // guarded read in the main process. Returns { filePath, content } | { canceled } | { error }.
    openFile: () => ipcRenderer.invoke(IPC_CHANNELS.MARKDOWN_OPEN_FILE),
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
    attach: (webContentsId: number, surfaceId?: string | null, workspaceId?: string | null) =>
      ipcRenderer.send(IPC_CHANNELS.CDP_ATTACH, webContentsId, surfaceId, workspaceId),
    detach: (webContentsId?: number) => ipcRenderer.send(IPC_CHANNELS.CDP_DETACH, webContentsId),
  },
  window: {
    create: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CREATE),
    close: (id: string) => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE, id),
    focus: (id: string) => ipcRenderer.send(IPC_CHANNELS.WINDOW_FOCUS, id),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_LIST),
    minimize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    // Windows taskbar progress (OSC 9;4 aggregate). value 0-1, or -1 to remove.
    setProgress: (value: number, mode?: string) =>
      ipcRenderer.send(IPC_CHANNELS.WINDOW_SET_PROGRESS, value, mode),
  },
});
