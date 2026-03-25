import { app, BrowserWindow, ipcMain } from 'electron';
import { registerIpcHandlers } from './ipc-handlers';
import { PipeServer } from './pipe-server';
import { PortScanner } from './port-scanner';
import { GitPoller } from './git-poller';
import { PrPoller } from './pr-poller';
import { IPC_CHANNELS } from '../shared/types';
import { loadSession, saveSession, SessionData } from './session-persistence';
import { WindowManager } from './window-manager';
import { initAutoUpdater } from './updater';

const windowManager = new WindowManager();
const pipeServer = new PipeServer();
const portScanner = new PortScanner();
const gitPoller = new GitPoller();
const prPoller = new PrPoller();

// Auto-save debounce handle
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_SAVE_INTERVAL_MS = 30_000;

function scheduleAutoSave(): void {
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
  }
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('session:request');
      }
    });
  }, AUTO_SAVE_INTERVAL_MS);
}

app.whenReady().then(() => {
  // IPC: renderer pushes session state (auto-save response or explicit save)
  ipcMain.on('session:save', (_event, data: SessionData) => {
    saveSession(data);
    scheduleAutoSave();
  });

  registerIpcHandlers(windowManager);

  // Attempt to restore last saved window bounds
  const savedSession = loadSession();
  const savedBounds = savedSession?.windows?.[0]?.bounds;
  windowManager.createWindow(savedBounds);

  // Initialize auto-updater only when packaged (avoids errors in dev)
  if (app.isPackaged) {
    initAutoUpdater();
  }

  // Kick off the first auto-save cycle after the window is ready
  scheduleAutoSave();

  // Start named pipe server
  pipeServer.start();

  portScanner.onResults((portsByPid) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
          command: 'ports_update',
          surfaceId: '',
          args: [JSON.stringify(Object.fromEntries(portsByPid))],
        });
      }
    });
  });

  gitPoller.onUpdate((cwd, state) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
          command: state.branch ? 'report_git_branch' : 'clear_git_branch',
          surfaceId: '', // will be mapped via cwd → workspace
          args: state.branch ? [state.branch, state.dirty ? 'dirty' : ''] : [],
        });
      }
    });
  });

  prPoller.onUpdate((cwd, pr) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        if (pr) {
          win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
            command: 'report_pr',
            surfaceId: '',
            args: [String(pr.number), pr.state, pr.title],
          });
        }
      }
    });
  });

  pipeServer.on('v1', (cmd) => {
    // Trigger port scan when requested from shell integration
    if (cmd.command === 'ports_kick') {
      portScanner.kick();
    }
    // Forward metadata updates to all windows
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, cmd);
      }
    });
  });

  pipeServer.on('v2', (request, respond, respondError) => {
    switch (request.method) {
      case 'system.identify':
        respond({ name: 'wmux', version: '0.1.0', platform: 'win32' });
        break;
      case 'system.capabilities':
        respond({ protocols: ['v1', 'v2'], features: ['workspaces', 'splits', 'notifications'] });
        break;
      case 'workspace.list':
        // Will be filled in when workspace IPC is complete
        respond({ workspaces: [] });
        break;
      default:
        respondError(-32601, `Method not found: ${request.method}`);
    }
  });
});

app.on('before-quit', () => {
  // Cancel pending auto-save timer
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  // Ask all renderers to push their current state synchronously before quit
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('session:request');
    }
  });
});

app.on('will-quit', () => {
  pipeServer.stop();
  portScanner.stop();
  gitPoller.unwatchAll();
  prPoller.stopAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
