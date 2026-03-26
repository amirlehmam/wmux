import { app, BrowserWindow, ipcMain } from 'electron';
import { registerIpcHandlers, cdpBridge, agentManager, setupAgentPtyForwarding } from './ipc-handlers';
import { distributeAgents } from './agent-manager';
import { PipeServer } from './pipe-server';
import { PortScanner } from './port-scanner';
import { GitPoller } from './git-poller';
import { PrPoller } from './pr-poller';
import { CDPProxy } from './cdp-proxy';
import { IPC_CHANNELS } from '../shared/types';
import { loadSession, saveSession, SessionData } from './session-persistence';
import { WindowManager } from './window-manager';
import { initAutoUpdater } from './updater';
import { ensureClaudeContext, ensureClaudeHooks } from './claude-context';

const windowManager = new WindowManager();
const pipeServer = new PipeServer();
const portScanner = new PortScanner();
const gitPoller = new GitPoller();
const prPoller = new PrPoller();
const cdpProxy = new CDPProxy();

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
  // Inject wmux instructions into ~/.claude/CLAUDE.md for Claude Code awareness
  ensureClaudeContext();
  ensureClaudeHooks();

  // IPC: renderer pushes session state (auto-save response or explicit save)
  ipcMain.on('session:save', (_event, data: SessionData) => {
    saveSession(data);
    scheduleAutoSave();
  });

  registerIpcHandlers(windowManager, cdpProxy);

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
  cdpProxy.start();

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
        respond({ name: 'wmux', version: '0.4.0', platform: 'win32' });
        break;
      case 'system.capabilities':
        respond({ protocols: ['v1', 'v2'], features: ['workspaces', 'splits', 'notifications'] });
        break;
      case 'workspace.list':
        // Will be filled in when workspace IPC is complete
        respond({ workspaces: [] });
        break;
      case 'browser.navigate':
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        cdpBridge.navigate(request.params.url, request.params.timeout)
          .then(() => respond({ ok: true }))
          .catch((err) => respondError(-32000, err.message));
        break;
      case 'browser.snapshot':
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        cdpBridge.snapshot().then((snap) => respond(snap)).catch((err) => respondError(-32000, err.message));
        break;
      case 'browser.click':
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        cdpBridge.click(request.params.ref).then(() => respond({ ok: true })).catch((err) => respondError(-32000, err.message));
        break;
      case 'browser.type':
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        cdpBridge.type(request.params.ref, request.params.text).then(() => respond({ ok: true })).catch((err) => respondError(-32000, err.message));
        break;
      case 'browser.fill':
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        cdpBridge.fill(request.params.ref, request.params.value).then(() => respond({ ok: true })).catch((err) => respondError(-32000, err.message));
        break;
      case 'browser.screenshot':
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        cdpBridge.screenshot(request.params.fullPage).then((data) => respond({ data })).catch((err) => respondError(-32000, err.message));
        break;
      case 'browser.get_text':
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        cdpBridge.getText(request.params.ref).then((text) => respond({ text })).catch((err) => respondError(-32000, err.message));
        break;
      case 'browser.eval':
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        cdpBridge.evaluate(request.params.js).then((result) => respond({ result })).catch((err) => respondError(-32000, err.message));
        break;
      case 'browser.wait':
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        cdpBridge.wait(request.params.ref, request.params.timeout).then(() => respond({ ok: true })).catch((err) => respondError(-32000, err.message));
        break;
      case 'browser.batch': {
        if (!cdpBridge.isAttached) { respondError(-32000, 'Browser panel is not open'); break; }
        const results: any[] = [];
        (async () => {
          for (const cmd of request.params.commands || []) {
            try {
              const handlers: Record<string, () => Promise<any>> = {
                'browser.navigate': () => cdpBridge.navigate(cmd.params?.url, cmd.params?.timeout).then(() => ({ ok: true })),
                'browser.snapshot': () => cdpBridge.snapshot(),
                'browser.click': () => cdpBridge.click(cmd.params?.ref).then(() => ({ ok: true })),
                'browser.type': () => cdpBridge.type(cmd.params?.ref, cmd.params?.text).then(() => ({ ok: true })),
                'browser.fill': () => cdpBridge.fill(cmd.params?.ref, cmd.params?.value).then(() => ({ ok: true })),
                'browser.screenshot': () => cdpBridge.screenshot(cmd.params?.fullPage).then((d: string) => ({ data: d })),
                'browser.get_text': () => cdpBridge.getText(cmd.params?.ref).then((t: string) => ({ text: t })),
                'browser.eval': () => cdpBridge.evaluate(cmd.params?.js).then((r: any) => ({ result: r })),
                'browser.wait': () => cdpBridge.wait(cmd.params?.ref, cmd.params?.timeout).then(() => ({ ok: true })),
              };
              const handler = handlers[cmd.method];
              if (!handler) { results.push({ error: { code: -32601, message: `Unknown: ${cmd.method}` } }); break; }
              results.push({ result: await handler() });
            } catch (err: any) {
              results.push({ error: { code: -32000, message: err.message } });
              break;
            }
          }
          respond({ results });
        })();
        break;
      }
      case 'agent.spawn': {
        (async () => {
          try {
            const params = request.params;
            let workspaceId = params.workspaceId;
            if (!workspaceId) {
              const wins = BrowserWindow.getAllWindows();
              if (wins.length > 0) {
                workspaceId = await wins[0].webContents.executeJavaScript('window.__wmux_getActiveWorkspaceId?.()');
              }
            }
            if (!workspaceId) { respondError(-32000, 'No active workspace'); return; }

            let paneId = params.paneId;
            if (!paneId) {
              const paneLoads = await BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript('window.__wmux_getPaneLoads?.()');
              if (paneLoads && paneLoads.length > 0) paneId = distributeAgents(1, paneLoads)[0];
            }
            if (!paneId) { respondError(-32000, 'No panes available'); return; }

            const result = agentManager.spawn({ cmd: params.cmd, label: params.label, cwd: params.cwd, env: params.env, paneId, workspaceId });

            const win = BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) setupAgentPtyForwarding(result.surfaceId, win);

            BrowserWindow.getAllWindows().forEach(w => {
              if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.AGENT_UPDATE, { type: 'spawned', ...result, paneId, workspaceId, label: params.label });
            });
            respond(result);
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      case 'agent.spawn_batch': {
        (async () => {
          try {
            const { agents: agentParams, strategy = 'distribute', workspaceId: wsId } = request.params;
            let workspaceId = wsId;
            if (!workspaceId) {
              const wins = BrowserWindow.getAllWindows();
              if (wins.length > 0) workspaceId = await wins[0].webContents.executeJavaScript('window.__wmux_getActiveWorkspaceId?.()');
            }
            if (!workspaceId) { respondError(-32000, 'No active workspace'); return; }

            const paneLoads = await BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript('window.__wmux_getPaneLoads?.()') || [];
            if (paneLoads.length === 0) { respondError(-32000, 'No panes available'); return; }

            let assignments: string[];
            if (strategy === 'distribute') {
              assignments = distributeAgents(agentParams.length, paneLoads);
            } else if (strategy === 'stack') {
              const sorted = [...paneLoads].sort((a: any, b: any) => a.tabCount - b.tabCount);
              assignments = agentParams.map(() => sorted[0].paneId);
            } else {
              console.warn('[wmux] split strategy not yet implemented, falling back to distribute');
              assignments = distributeAgents(agentParams.length, paneLoads);
            }

            const win = BrowserWindow.getAllWindows()[0];
            const results: any[] = [];
            for (let i = 0; i < agentParams.length; i++) {
              try {
                const result = agentManager.spawn({ ...agentParams[i], paneId: assignments[i] as any, workspaceId });
                if (win && !win.isDestroyed()) setupAgentPtyForwarding(result.surfaceId, win);
                BrowserWindow.getAllWindows().forEach(w => {
                  if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.AGENT_UPDATE, { type: 'spawned', ...result, paneId: assignments[i], workspaceId, label: agentParams[i].label });
                });
                results.push(result);
              } catch (err: any) { results.push({ error: err.message }); }
            }
            respond({ agents: results });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      case 'agent.status': {
        const info = agentManager.getStatus(request.params.agentId);
        if (!info) { respondError(-32000, 'Agent not found'); break; }
        respond(info);
        break;
      }
      case 'agent.list':
        respond({ agents: agentManager.list(request.params.workspaceId) });
        break;
      case 'agent.kill': {
        const killed = agentManager.kill(request.params.agentId);
        if (!killed) { respondError(-32000, 'Agent not found'); break; }
        respond({ ok: true });
        break;
      }

      case 'hook.event': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.HOOK_EVENT, request.params);
        });
        respond({ ok: true });
        break;
      }

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
  cdpProxy.stop();
  portScanner.stop();
  gitPoller.unwatchAll();
  prPoller.stopAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
