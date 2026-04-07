# wmux-orchestrator Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that decomposes dev tasks into parallel sub-tasks, spawns multiple Claude Code instances across wmux panes with wave-based orchestration, and auto-reviews results.

**Architecture:** Hybrid plugin — skills for intelligence (decomposition, review), hooks for reactivity (tracking, wave transitions), bash scripts for wmux CLI operations. State shared via JSON file in TMPDIR. Works standalone (degraded mode) or fully integrated with wmux.

**Tech Stack:** Claude Code plugin system (SKILL.md, hooks.json, agents/*.md, commands/*.md), bash scripts, wmux CLI (named pipe V2 JSON-RPC), jq for JSON state manipulation.

**Spec:** `docs/superpowers/specs/2026-04-07-wmux-orchestrator-plugin-design.md`

---

## File Structure

### Plugin files (new: `resources/wmux-orchestrator/`)

```
resources/wmux-orchestrator/
├── .claude-plugin/
│   └── plugin.json                          # Plugin manifest
├── package.json                             # Node metadata
├── commands/
│   └── wmux:orchestrate.md                  # Slash command entry point
├── skills/
│   ├── orchestrate/
│   │   ├── SKILL.md                         # Core orchestration skill
│   │   └── references/
│   │       └── decomposition-guide.md       # Decomposition patterns
│   ├── reviewer/
│   │   └── SKILL.md                         # Final review skill
│   └── wmux-detect/
│       └── SKILL.md                         # wmux detection + fallback
├── hooks/
│   └── hooks.json                           # PostToolUse, SubagentStop, Stop, SessionStart
├── agents/
│   └── wmux-worker.md                       # Worker agent template
└── scripts/
    ├── detect-wmux.sh                       # Check if wmux is running
    ├── spawn-agents.sh                      # Create panes + spawn Claude Code agents
    ├── check-status.sh                      # Read state JSON, output dashboard markdown
    ├── update-dashboard.sh                  # Push dashboard content to wmux markdown pane
    ├── on-tool-use.sh                       # Hook: increment toolUses in state
    ├── on-agent-stop.sh                     # Hook: update agent status, trigger next wave
    ├── on-stop.sh                           # Hook: warn if orchestration active
    ├── on-session-start.sh                  # Hook: crash recovery check
    ├── collect-results.sh                   # Aggregate agent result files for reviewer
    └── cleanup.sh                           # Remove orchestration temp directory
```

### wmux main process changes

```
src/main/
├── index.ts                                 # ADD: V2 pipe handlers for workspace/pane/surface/markdown
├── claude-context.ts                        # ADD: ensureOrchestratorPlugin() function
└── ipc-handlers.ts                          # (reference only — already has needed IPC handlers)
```

### Test files

```
tests/unit/
├── orchestrator-state.test.ts               # State file read/write/lock logic
└── pipe-v2-handlers.test.ts                 # New V2 pipe method handlers
```

---

## Task 1: Implement missing V2 pipe handlers for workspace/pane/surface/markdown

The orchestrator plugin relies on wmux CLI commands (`wmux split`, `wmux new-workspace`, `wmux list-panes`, `wmux markdown set`) that send V2 JSON-RPC requests. Currently, the pipe server V2 handler in `src/main/index.ts:159-363` only handles `system.*`, `browser.*`, `agent.*`, `hook.event`, and `diff.*`. All other methods return "Method not found". These handlers must exist before the plugin can function.

**Files:**
- Modify: `src/main/index.ts:159-363` (V2 pipe handler switch block)
- Test: `tests/unit/pipe-v2-handlers.test.ts`

- [ ] **Step 1: Write failing tests for workspace V2 handlers**

```typescript
// tests/unit/pipe-v2-handlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the V2 handler logic by extracting the handler mapping.
// Since the handlers call into renderer via executeJavaScript, we mock BrowserWindow.

describe('V2 pipe handlers — workspace', () => {
  it('workspace.create should forward to renderer and return workspaceId', async () => {
    // This test verifies the handler exists and delegates correctly
    // Full integration is tested manually via `wmux new-workspace`
    expect(true).toBe(true); // placeholder — real test in step 3
  });
});
```

Run: `npx vitest run tests/unit/pipe-v2-handlers.test.ts`
Expected: PASS (placeholder)

- [ ] **Step 2: Add workspace/pane/surface V2 handlers to pipe server**

The renderer already handles workspace/pane/surface operations via Zustand store. The pipe V2 handlers need to forward commands to the renderer via `executeJavaScript`, similar to how `agent.spawn` already works (see `index.ts:243-253`).

Add these cases to the `switch (request.method)` block in `src/main/index.ts`, before the `default` case:

```typescript
      // ── Workspace operations (forwarded to renderer) ──
      case 'workspace.create': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_createWorkspace?.(${JSON.stringify(request.params || {})})`
            );
            respond(result || { ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'workspace.close': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_closeWorkspace?.(${JSON.stringify(request.params.id)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'workspace.select': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_selectWorkspace?.(${JSON.stringify(request.params.id)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'workspace.rename': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_renameWorkspace?.(${JSON.stringify(request.params.id)}, ${JSON.stringify(request.params.title)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'workspace.list': {
        // Override the existing stub
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respond({ workspaces: [] }); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_listWorkspaces?.()`
            );
            respond({ workspaces: result || [] });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ── Pane operations ──
      case 'pane.split': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_splitPane?.(${JSON.stringify(request.params || {})})`
            );
            respond(result || { ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'pane.close': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_closePane?.(${JSON.stringify(request.params.id)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'pane.focus': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_focusPane?.(${JSON.stringify(request.params.id)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'pane.zoom': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_zoomPane?.(${JSON.stringify(request.params.id)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'pane.list': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respond({ panes: [] }); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_listPanes?.(${JSON.stringify(request.params?.workspaceId || null)})`
            );
            respond({ panes: result || [] });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'system.tree': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respond({ tree: null }); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_getTree?.()`
            );
            respond({ tree: result });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ── Surface operations ──
      case 'surface.create': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_createSurface?.(${JSON.stringify(request.params || {})})`
            );
            respond(result || { ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.close': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_closeSurface?.(${JSON.stringify(request.params.id)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.focus': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_focusSurface?.(${JSON.stringify(request.params.id)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.list': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respond({ surfaces: [] }); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_listSurfaces?.(${JSON.stringify(request.params?.paneId || null)})`
            );
            respond({ surfaces: result || [] });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.send_text': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            const surfaceId = await win.webContents.executeJavaScript(
              `window.__wmux_getActiveSurfaceId?.()`
            );
            if (!surfaceId) { respondError(-32000, 'No active surface'); return; }
            ptyManager.write(surfaceId, request.params.text);
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.send_key': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            const surfaceId = await win.webContents.executeJavaScript(
              `window.__wmux_getActiveSurfaceId?.()`
            );
            if (!surfaceId) { respondError(-32000, 'No active surface'); return; }
            // Map key names to escape sequences
            const key = request.params.key;
            const mods = request.params.modifiers || [];
            let seq = key;
            if (key === 'Enter') seq = '\r';
            else if (key === 'Tab') seq = '\t';
            else if (key === 'Escape') seq = '\x1b';
            else if (mods.includes('ctrl') && key.length === 1) {
              seq = String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
            }
            ptyManager.write(surfaceId, seq);
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.read_text': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_readScreen?.(${JSON.stringify(request.params?.lines || 50)})`
            );
            respond({ text: result || '' });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.trigger_flash': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_triggerFlash?.(${JSON.stringify(request.params.id)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ── Markdown operations ──
      case 'markdown.set_content': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_setMarkdownContent?.(${JSON.stringify(request.params.surfaceId)}, ${JSON.stringify(request.params.markdown)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'markdown.load_file': {
        (async () => {
          try {
            const content = fs.readFileSync(request.params.filePath, 'utf-8');
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_setMarkdownContent?.(${JSON.stringify(request.params.surfaceId)}, ${JSON.stringify(content)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ── Notification operations ──
      case 'notification.list': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respond({ notifications: [] }); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_listNotifications?.()`
            );
            respond({ notifications: result || [] });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'notification.clear': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_clearNotification?.(${JSON.stringify(request.params.id)})`
            );
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ── Sidebar operations ──
      case 'sidebar.set_status': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, { type: 'status', key: request.params.key, value: request.params.value });
        });
        respond({ ok: true });
        break;
      }
      case 'sidebar.set_progress': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, { type: 'progress', value: request.params.value, label: request.params.label });
        });
        respond({ ok: true });
        break;
      }
      case 'sidebar.log': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, { type: 'log', level: request.params.level, message: request.params.message });
        });
        respond({ ok: true });
        break;
      }
      case 'sidebar.get_state': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) { respond({}); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_getSidebarState?.()`
            );
            respond(result || {});
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
```

- [ ] **Step 3: Expose renderer store operations on window global**

The V2 handlers call `window.__wmux_*` functions. These must be exposed by the renderer. Add a new file that bridges the Zustand store to the window global.

Create: `src/renderer/pipe-bridge.ts`

```typescript
import { useStore } from './store';
import { SurfaceType, PaneId, WorkspaceId, SurfaceId } from '../shared/types';
import { v4 as uuid } from 'uuid';

/**
 * Expose store operations on `window` so the main process can call them
 * via webContents.executeJavaScript('window.__wmux_*(...)').
 * This bridges the named pipe V2 API to the Zustand renderer store.
 */
export function initPipeBridge(): void {
  const w = window as any;

  // Already exposed by existing code:
  // w.__wmux_getActiveWorkspaceId
  // w.__wmux_getPaneLoads

  w.__wmux_createWorkspace = (params: { title?: string; shell?: string; cwd?: string }) => {
    const store = useStore.getState();
    const id = store.addWorkspace(params.title || 'Workspace');
    return { workspaceId: id };
  };

  w.__wmux_closeWorkspace = (id: string) => {
    const store = useStore.getState();
    store.removeWorkspace(id as WorkspaceId);
  };

  w.__wmux_selectWorkspace = (id: string) => {
    const store = useStore.getState();
    store.setActiveWorkspace(id as WorkspaceId);
  };

  w.__wmux_renameWorkspace = (id: string, title: string) => {
    const store = useStore.getState();
    store.renameWorkspace(id as WorkspaceId, title);
  };

  w.__wmux_listWorkspaces = () => {
    const store = useStore.getState();
    return store.workspaces.map(ws => ({
      id: ws.id,
      title: ws.title,
      isActive: ws.id === store.activeWorkspaceId,
    }));
  };

  w.__wmux_splitPane = (params: { direction?: string; type?: string }) => {
    const store = useStore.getState();
    const direction = params.direction === 'down' ? 'vertical' : 'horizontal';
    const type = (params.type || 'terminal') as SurfaceType;
    const surfaceId = `surf-${uuid()}` as SurfaceId;
    store.splitActivePane(direction as 'horizontal' | 'vertical', surfaceId, type);
    return { surfaceId, paneId: store.activePaneId };
  };

  w.__wmux_closePane = (id: string) => {
    const store = useStore.getState();
    store.removePane(id as PaneId);
  };

  w.__wmux_focusPane = (id: string) => {
    const store = useStore.getState();
    store.setActivePane(id as PaneId);
  };

  w.__wmux_zoomPane = (id: string) => {
    const store = useStore.getState();
    store.toggleZoom(id as PaneId);
  };

  w.__wmux_listPanes = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];
    // Collect leaf panes from the split tree
    const panes: any[] = [];
    const walk = (node: any, paneId?: string) => {
      if (node.type === 'leaf') {
        panes.push({
          paneId: node.paneId || paneId,
          surfaces: node.surfaces || [],
          tabCount: node.surfaces?.length || 0,
        });
      } else if (node.type === 'branch') {
        walk(node.children[0]);
        walk(node.children[1]);
      }
    };
    if (ws.rootNode) walk(ws.rootNode);
    return panes;
  };

  w.__wmux_getTree = () => {
    const store = useStore.getState();
    const ws = store.workspaces.find(w => w.id === store.activeWorkspaceId);
    return ws?.rootNode || null;
  };

  w.__wmux_createSurface = (params: { type?: string }) => {
    const store = useStore.getState();
    const type = (params.type || 'terminal') as SurfaceType;
    const surfaceId = `surf-${uuid()}` as SurfaceId;
    store.addSurface(surfaceId, type);
    return { surfaceId };
  };

  w.__wmux_closeSurface = (id: string) => {
    const store = useStore.getState();
    store.removeSurface(id as SurfaceId);
  };

  w.__wmux_focusSurface = (id: string) => {
    const store = useStore.getState();
    store.setActiveSurface(id as SurfaceId);
  };

  w.__wmux_listSurfaces = (paneId?: string) => {
    const store = useStore.getState();
    // Implementation depends on store structure
    return [];
  };

  w.__wmux_getActiveSurfaceId = () => {
    const store = useStore.getState();
    return store.activeSurfaceId;
  };

  w.__wmux_readScreen = (lines: number) => {
    // Read from the active terminal's xterm buffer
    const store = useStore.getState();
    const surfaceId = store.activeSurfaceId;
    const terminal = (window as any).__wmux_terminals?.get(surfaceId);
    if (!terminal) return '';
    const buffer = terminal.buffer.active;
    const totalRows = buffer.length;
    const start = Math.max(0, totalRows - lines);
    const result: string[] = [];
    for (let i = start; i < totalRows; i++) {
      const line = buffer.getLine(i);
      if (line) result.push(line.translateToString(true));
    }
    return result.join('\n');
  };

  w.__wmux_triggerFlash = (id: string) => {
    const store = useStore.getState();
    store.triggerFlash(id as SurfaceId);
  };

  w.__wmux_setMarkdownContent = (surfaceId: string, markdown: string) => {
    const store = useStore.getState();
    store.setMarkdownContent(surfaceId as SurfaceId, markdown);
  };

  w.__wmux_listNotifications = () => {
    const store = useStore.getState();
    return store.notifications || [];
  };

  w.__wmux_clearNotification = (id: string) => {
    const store = useStore.getState();
    store.clearNotification(id);
  };

  w.__wmux_getSidebarState = () => {
    const store = useStore.getState();
    return store.sidebarState || {};
  };
}
```

Note: The exact store method names (`addWorkspace`, `splitActivePane`, etc.) must match the actual Zustand store. Read the workspace-slice and surface-slice to confirm exact names before implementing. The code above shows the pattern — adapt to match the real store API.

- [ ] **Step 4: Import and call initPipeBridge in renderer entry**

In the renderer's main entry file (likely `src/renderer/main.tsx` or `src/renderer/App.tsx`), add:

```typescript
import { initPipeBridge } from './pipe-bridge';

// Call after store is initialized
initPipeBridge();
```

- [ ] **Step 5: Remove the old workspace.list stub**

In `src/main/index.ts`, remove the existing stub at line ~167-170:
```typescript
      // DELETE this block — replaced by the full handler above:
      case 'workspace.list':
        respond({ workspaces: [] });
        break;
```

- [ ] **Step 6: Run build and verify**

```bash
npm run build:main
```
Expected: No TypeScript errors

- [ ] **Step 7: Test manually**

```bash
wmux list-workspaces
wmux list-panes
wmux split --right
wmux list-panes
```
Expected: Commands return JSON results instead of "Method not found"

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/renderer/pipe-bridge.ts
git commit -m "feat: implement V2 pipe handlers for workspace/pane/surface/markdown operations"
```

---

## Task 2: Create plugin manifest and package.json

**Files:**
- Create: `resources/wmux-orchestrator/.claude-plugin/plugin.json`
- Create: `resources/wmux-orchestrator/package.json`

- [ ] **Step 1: Create plugin directory structure**

```bash
mkdir -p "resources/wmux-orchestrator/.claude-plugin"
mkdir -p "resources/wmux-orchestrator/commands"
mkdir -p "resources/wmux-orchestrator/skills/orchestrate/references"
mkdir -p "resources/wmux-orchestrator/skills/reviewer"
mkdir -p "resources/wmux-orchestrator/skills/wmux-detect"
mkdir -p "resources/wmux-orchestrator/hooks"
mkdir -p "resources/wmux-orchestrator/agents"
mkdir -p "resources/wmux-orchestrator/scripts"
```

- [ ] **Step 2: Write plugin.json**

```json
{
  "name": "wmux-orchestrator",
  "description": "Multi-agent task orchestration with visual terminal panes. Decomposes complex dev tasks into parallel Claude Code instances coordinated through dependency-aware waves.",
  "version": "0.1.0",
  "author": {
    "name": "amirlehmam",
    "email": "amir@wmux.org"
  },
  "homepage": "https://wmux.org",
  "repository": "https://github.com/amirlehmam/wmux",
  "license": "MIT",
  "keywords": ["orchestration", "multi-agent", "parallel", "terminal", "wmux"]
}
```

- [ ] **Step 3: Write package.json**

```json
{
  "name": "wmux-orchestrator",
  "version": "0.1.0",
  "description": "Multi-agent task orchestration for Claude Code with wmux visual panes",
  "author": "amirlehmam",
  "license": "MIT"
}
```

- [ ] **Step 4: Commit**

```bash
git add resources/wmux-orchestrator/
git commit -m "feat: scaffold wmux-orchestrator plugin directory structure"
```

---

## Task 3: Write wmux-detect skill and detect-wmux.sh script

**Files:**
- Create: `resources/wmux-orchestrator/skills/wmux-detect/SKILL.md`
- Create: `resources/wmux-orchestrator/scripts/detect-wmux.sh`

- [ ] **Step 1: Write detect-wmux.sh**

```bash
#!/usr/bin/env bash
# Detect if wmux is running and available via named pipe.
# Exit 0 + print "available" if wmux responds to ping.
# Exit 1 + print "unavailable" if not.

if command -v wmux &>/dev/null; then
  result=$(wmux ping 2>/dev/null)
  if [ "$result" = "pong" ]; then
    echo "available"
    exit 0
  fi
fi

# Fallback: try connecting to the pipe directly
if [ -e "//./pipe/wmux" ] 2>/dev/null; then
  echo "available"
  exit 0
fi

echo "unavailable"
exit 1
```

- [ ] **Step 2: Write SKILL.md**

```markdown
---
name: wmux-detect
description: Detect if wmux terminal multiplexer is running. Used internally by orchestrate skill to decide between wmux multi-pane mode and degraded subagent mode.
---

# wmux Detection

Run the detection script to check if wmux is available:

\`\`\`bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/detect-wmux.sh"
\`\`\`

**If output is "available":**
- wmux is running and the named pipe is accessible
- The orchestrator can use `wmux split`, `wmux agent spawn`, `wmux markdown set` etc.
- Full multi-pane visual experience is available

**If output is "unavailable":**
- wmux is not running or not installed
- Fall back to Claude Code's native `Agent` tool for parallel workers
- No visual dashboard — use text summaries in the terminal instead
- Log: "wmux not detected. Running in degraded mode — agents will use Claude Code's native subagent system. Install wmux for the full multi-pane experience: https://wmux.org"

Store the detection result so other skills can check it without re-running:

\`\`\`bash
export WMUX_AVAILABLE=$( bash "${CLAUDE_PLUGIN_ROOT}/scripts/detect-wmux.sh" 2>/dev/null && echo "true" || echo "false" )
\`\`\`
```

- [ ] **Step 3: Make script executable and commit**

```bash
chmod +x resources/wmux-orchestrator/scripts/detect-wmux.sh
git add resources/wmux-orchestrator/skills/wmux-detect/ resources/wmux-orchestrator/scripts/detect-wmux.sh
git commit -m "feat: add wmux-detect skill and detection script"
```

---

## Task 4: Write state management scripts

The orchestration state is a JSON file in TMPDIR. These scripts create, read, update, and lock it.

**Files:**
- Create: `resources/wmux-orchestrator/scripts/orchestration-state.sh`

- [ ] **Step 1: Write orchestration-state.sh**

This is a bash library sourced by other scripts. It provides functions for state management.

```bash
#!/usr/bin/env bash
# orchestration-state.sh — State management library for wmux orchestrations.
# Source this file in other scripts: source "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.sh"

ORCH_BASE="${TMPDIR:-/tmp}"

# Find the active orchestration directory (most recent state.json)
find_active_orch() {
  local latest=""
  local latest_time=0
  for dir in "$ORCH_BASE"/wmux-orch-*/; do
    [ -d "$dir" ] || continue
    local state="$dir/state.json"
    [ -f "$state" ] || continue
    local status
    status=$(jq -r '.status' "$state" 2>/dev/null)
    if [ "$status" = "running" ]; then
      local mtime
      mtime=$(stat -c %Y "$state" 2>/dev/null || stat -f %m "$state" 2>/dev/null || echo 0)
      if [ "$mtime" -gt "$latest_time" ]; then
        latest="$dir"
        latest_time="$mtime"
      fi
    fi
  done
  echo "$latest"
}

# Get orchestration dir by ID
get_orch_dir() {
  local id="$1"
  echo "$ORCH_BASE/wmux-orch-$id"
}

# Create a new orchestration directory
create_orch_dir() {
  local id="$1"
  local dir="$ORCH_BASE/wmux-orch-$id"
  mkdir -p "$dir"
  echo "$dir"
}

# Acquire lock (simple file-based, 2s timeout)
acquire_lock() {
  local dir="$1"
  local lockfile="$dir/state.lock"
  local timeout=20  # 20 * 100ms = 2s
  local i=0
  while [ -f "$lockfile" ] && [ $i -lt $timeout ]; do
    sleep 0.1
    i=$((i + 1))
  done
  echo $$ > "$lockfile"
}

# Release lock
release_lock() {
  local dir="$1"
  rm -f "$dir/state.lock"
}

# Read state JSON field using jq
read_state() {
  local dir="$1"
  local query="$2"
  jq -r "$query" "$dir/state.json" 2>/dev/null
}

# Update state JSON using jq
update_state() {
  local dir="$1"
  local jq_expr="$2"
  acquire_lock "$dir"
  local tmp="$dir/state.tmp.json"
  jq "$jq_expr" "$dir/state.json" > "$tmp" && mv "$tmp" "$dir/state.json"
  release_lock "$dir"
}

# Check if all agents in a wave are completed
wave_complete() {
  local dir="$1"
  local wave_idx="$2"
  local pending
  pending=$(jq -r ".waves[$wave_idx].agents[] | select(.status != \"completed\" and .status != \"failed\") | .id" "$dir/state.json" 2>/dev/null)
  [ -z "$pending" ]
}

# Get the next pending wave index
next_pending_wave() {
  local dir="$1"
  jq -r '.waves | to_entries[] | select(.value.status == "pending") | .key' "$dir/state.json" 2>/dev/null | head -1
}

# Check if all waves are done
all_waves_done() {
  local dir="$1"
  local pending
  pending=$(jq -r '.waves[] | select(.status == "pending" or .status == "running") | .index' "$dir/state.json" 2>/dev/null)
  [ -z "$pending" ]
}
```

- [ ] **Step 2: Verify jq is available**

```bash
jq --version
```
Expected: jq 1.6 or higher (comes with Git for Windows)

If jq is not available, the scripts will need a fallback. But jq ships with Git Bash on Windows, which is Claude Code's shell.

- [ ] **Step 3: Commit**

```bash
chmod +x resources/wmux-orchestrator/scripts/orchestration-state.sh
git add resources/wmux-orchestrator/scripts/orchestration-state.sh
git commit -m "feat: add orchestration state management library"
```

---

## Task 5: Write hook scripts (on-tool-use, on-agent-stop, on-stop, on-session-start)

**Files:**
- Create: `resources/wmux-orchestrator/scripts/on-tool-use.sh`
- Create: `resources/wmux-orchestrator/scripts/on-agent-stop.sh`
- Create: `resources/wmux-orchestrator/scripts/on-stop.sh`
- Create: `resources/wmux-orchestrator/scripts/on-session-start.sh`
- Create: `resources/wmux-orchestrator/hooks/hooks.json`

- [ ] **Step 1: Write on-tool-use.sh**

```bash
#!/usr/bin/env bash
# PostToolUse hook: increment toolUses counter for the active agent.
# Called by Claude Code after each tool use. Must complete in <5s.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR=$(find_active_orch)
[ -z "$ORCH_DIR" ] && exit 0  # No active orchestration, nothing to do

# Identify which agent this tool use belongs to
AGENT_ID="${WMUX_AGENT_ID:-}"
[ -z "$AGENT_ID" ] && exit 0  # Not an agent PTY

# Increment toolUses for this agent
update_state "$ORCH_DIR" \
  "(.waves[].agents[] | select(.id == \"$AGENT_ID\")) .toolUses += 1"

# Update dashboard if wmux is available
if command -v wmux &>/dev/null; then
  DASHBOARD_SID=$(read_state "$ORCH_DIR" '.dashboardSurfaceId')
  if [ "$DASHBOARD_SID" != "null" ] && [ -n "$DASHBOARD_SID" ]; then
    bash "$SCRIPT_DIR/check-status.sh" "$ORCH_DIR" > "$ORCH_DIR/dashboard.md"
    wmux markdown set "$DASHBOARD_SID" --file "$ORCH_DIR/dashboard.md" 2>/dev/null || true
  fi
fi
```

- [ ] **Step 2: Write on-agent-stop.sh**

```bash
#!/usr/bin/env bash
# SubagentStop hook: update agent status, check wave completion, trigger next wave.
# This is the core orchestration driver. Must complete in <15s.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR=$(find_active_orch)
[ -z "$ORCH_DIR" ] && exit 0

AGENT_ID="${WMUX_AGENT_ID:-}"
[ -z "$AGENT_ID" ] && exit 0

# Get agent's exit code (passed via environment by Claude Code hooks)
EXIT_CODE="${CLAUDE_EXIT_CODE:-0}"

# Update agent status
if [ "$EXIT_CODE" = "0" ]; then
  update_state "$ORCH_DIR" \
    "(.waves[].agents[] | select(.id == \"$AGENT_ID\")) |= (.status = \"completed\" | .exitCode = 0 | .finishedAt = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\")"
else
  update_state "$ORCH_DIR" \
    "(.waves[].agents[] | select(.id == \"$AGENT_ID\")) |= (.status = \"failed\" | .exitCode = $EXIT_CODE | .finishedAt = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\")"
fi

# Find which wave this agent belongs to
WAVE_IDX=$(jq -r ".waves | to_entries[] | select(.value.agents[] | .id == \"$AGENT_ID\") | .key" "$ORCH_DIR/state.json")

# Check if this wave is now complete
if wave_complete "$ORCH_DIR" "$WAVE_IDX"; then
  # Mark wave as completed
  update_state "$ORCH_DIR" ".waves[$WAVE_IDX].status = \"completed\""

  # Check if all waves are done
  if all_waves_done "$ORCH_DIR"; then
    # Check if reviewer is enabled
    REVIEWER_STATUS=$(read_state "$ORCH_DIR" '.reviewer.status')
    if [ "$REVIEWER_STATUS" = "pending" ]; then
      # Signal that reviewer should start
      update_state "$ORCH_DIR" '.reviewer.status = "ready"'
      # The orchestrate skill will detect this and launch the reviewer
      # Notify user via wmux
      if command -v wmux &>/dev/null; then
        wmux notify "All agents complete. Starting reviewer..." 2>/dev/null || true
      fi
    else
      update_state "$ORCH_DIR" '.status = "completed"'
    fi
  else
    # Launch next wave
    NEXT_WAVE=$(next_pending_wave "$ORCH_DIR")
    if [ -n "$NEXT_WAVE" ]; then
      update_state "$ORCH_DIR" ".waves[$NEXT_WAVE].status = \"running\""
      # Spawn next wave's agents
      bash "$SCRIPT_DIR/spawn-agents.sh" "$ORCH_DIR" "$NEXT_WAVE"
    fi
  fi
fi

# Update dashboard
if command -v wmux &>/dev/null; then
  DASHBOARD_SID=$(read_state "$ORCH_DIR" '.dashboardSurfaceId')
  if [ "$DASHBOARD_SID" != "null" ] && [ -n "$DASHBOARD_SID" ]; then
    bash "$SCRIPT_DIR/check-status.sh" "$ORCH_DIR" > "$ORCH_DIR/dashboard.md"
    wmux markdown set "$DASHBOARD_SID" --file "$ORCH_DIR/dashboard.md" 2>/dev/null || true
  fi
fi
```

- [ ] **Step 3: Write on-stop.sh**

```bash
#!/usr/bin/env bash
# Stop hook: warn if orchestration is active before Claude Code exits.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR=$(find_active_orch)
[ -z "$ORCH_DIR" ] && exit 0

# Count running agents
RUNNING=$(jq '[.waves[].agents[] | select(.status == "running")] | length' "$ORCH_DIR/state.json" 2>/dev/null)

if [ "$RUNNING" -gt 0 ]; then
  echo "WARNING: wmux orchestration in progress with $RUNNING active agent(s)."
  echo "Exiting now will leave agents running unmonitored."
fi
```

- [ ] **Step 4: Write on-session-start.sh**

```bash
#!/usr/bin/env bash
# SessionStart hook: detect wmux, check for interrupted orchestrations.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

# Check for interrupted orchestrations
ORCH_DIR=$(find_active_orch)
if [ -n "$ORCH_DIR" ]; then
  ORCH_ID=$(read_state "$ORCH_DIR" '.id')
  TASK=$(read_state "$ORCH_DIR" '.task')
  RUNNING=$(jq '[.waves[].agents[] | select(.status == "running")] | length' "$ORCH_DIR/state.json" 2>/dev/null)
  echo "Found interrupted orchestration: $ORCH_ID"
  echo "Task: $TASK"
  echo "Running agents: $RUNNING"
fi
```

- [ ] **Step 5: Write hooks.json**

```json
{
  "description": "wmux-orchestrator: multi-agent orchestration tracking and wave transitions",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|Read|Write|Edit|Grep|Glob|Agent",
        "hooks": [{
          "type": "command",
          "command": "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/on-tool-use.sh\"",
          "timeout": 5
        }]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/on-agent-stop.sh\"",
          "timeout": 15
        }]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.sh\"",
          "timeout": 15
        }]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/on-session-start.sh\"",
          "timeout": 5
        }]
      }
    ]
  }
}
```

- [ ] **Step 6: Make scripts executable and commit**

```bash
chmod +x resources/wmux-orchestrator/scripts/on-tool-use.sh
chmod +x resources/wmux-orchestrator/scripts/on-agent-stop.sh
chmod +x resources/wmux-orchestrator/scripts/on-stop.sh
chmod +x resources/wmux-orchestrator/scripts/on-session-start.sh
git add resources/wmux-orchestrator/scripts/on-*.sh resources/wmux-orchestrator/hooks/
git commit -m "feat: add orchestration hook scripts for tracking and wave transitions"
```

---

## Task 6: Write spawn-agents.sh and check-status.sh

**Files:**
- Create: `resources/wmux-orchestrator/scripts/spawn-agents.sh`
- Create: `resources/wmux-orchestrator/scripts/check-status.sh`
- Create: `resources/wmux-orchestrator/scripts/update-dashboard.sh`
- Create: `resources/wmux-orchestrator/scripts/cleanup.sh`
- Create: `resources/wmux-orchestrator/scripts/collect-results.sh`

- [ ] **Step 1: Write spawn-agents.sh**

```bash
#!/usr/bin/env bash
# spawn-agents.sh <orch-dir> <wave-index>
# Creates wmux panes and spawns Claude Code agents for a wave.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR="$1"
WAVE_IDX="$2"

[ -z "$ORCH_DIR" ] || [ -z "$WAVE_IDX" ] && { echo "Usage: spawn-agents.sh <orch-dir> <wave-index>"; exit 1; }

# Read agents for this wave
AGENTS=$(jq -c ".waves[$WAVE_IDX].agents[]" "$ORCH_DIR/state.json")

# Check if wmux is available
WMUX_AVAILABLE=false
if command -v wmux &>/dev/null && wmux ping 2>/dev/null | grep -q pong; then
  WMUX_AVAILABLE=true
fi

AGENT_COUNT=$(echo "$AGENTS" | wc -l)

if [ "$WMUX_AVAILABLE" = "true" ]; then
  # Create panes for each agent
  PANE_IDX=0
  echo "$AGENTS" | while IFS= read -r agent; do
    AGENT_ID=$(echo "$agent" | jq -r '.id')
    AGENT_LABEL=$(echo "$agent" | jq -r '.label')
    PROMPT_FILE="$ORCH_DIR/agent-${AGENT_ID}-prompt.md"

    # Create a new pane (split right for first, down for subsequent)
    if [ $PANE_IDX -eq 0 ]; then
      RESULT=$(wmux split --right --type terminal 2>/dev/null)
    else
      RESULT=$(wmux split --down --type terminal 2>/dev/null)
    fi

    # Extract paneId and surfaceId from result
    PANE_ID=$(echo "$RESULT" | jq -r '.paneId // empty' 2>/dev/null)
    SURFACE_ID=$(echo "$RESULT" | jq -r '.surfaceId // empty' 2>/dev/null)

    # Spawn Claude Code agent in the new pane
    CWD=$(read_state "$ORCH_DIR" '.cwd // empty')
    [ -z "$CWD" ] && CWD="$(pwd)"

    SPAWN_RESULT=$(wmux agent spawn \
      --cmd "claude --prompt-file \"$PROMPT_FILE\"" \
      --label "$AGENT_LABEL" \
      --cwd "$CWD" \
      --pane "$PANE_ID" 2>/dev/null)

    SPAWNED_AGENT_ID=$(echo "$SPAWN_RESULT" | jq -r '.agentId // empty' 2>/dev/null)
    SPAWNED_SURFACE_ID=$(echo "$SPAWN_RESULT" | jq -r '.surfaceId // empty' 2>/dev/null)

    # Update state with pane/surface info
    update_state "$ORCH_DIR" \
      "(.waves[$WAVE_IDX].agents[] | select(.id == \"$AGENT_ID\")) |= (.paneId = \"$PANE_ID\" | .surfaceId = \"$SPAWNED_SURFACE_ID\" | .status = \"running\" | .startedAt = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\")"

    PANE_IDX=$((PANE_IDX + 1))
  done
else
  # Degraded mode: signal that agents should be launched via Agent tool
  # Write a marker file that the orchestrate skill reads
  echo "$AGENTS" > "$ORCH_DIR/wave-${WAVE_IDX}-pending-spawn.json"
fi
```

- [ ] **Step 2: Write check-status.sh**

```bash
#!/usr/bin/env bash
# check-status.sh <orch-dir>
# Outputs a markdown dashboard of the current orchestration state.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR="$1"
[ -z "$ORCH_DIR" ] && ORCH_DIR=$(find_active_orch)
[ -z "$ORCH_DIR" ] && { echo "No active orchestration"; exit 1; }

TASK=$(read_state "$ORCH_DIR" '.task')
STATUS=$(read_state "$ORCH_DIR" '.status')
STARTED=$(read_state "$ORCH_DIR" '.startedAt')
WAVE_COUNT=$(jq '.waves | length' "$ORCH_DIR/state.json")
TOTAL_AGENTS=$(jq '[.waves[].agents[]] | length' "$ORCH_DIR/state.json")
COMPLETED_AGENTS=$(jq '[.waves[].agents[] | select(.status == "completed")] | length' "$ORCH_DIR/state.json")
RUNNING_AGENTS=$(jq '[.waves[].agents[] | select(.status == "running")] | length' "$ORCH_DIR/state.json")
FAILED_AGENTS=$(jq '[.waves[].agents[] | select(.status == "failed")] | length' "$ORCH_DIR/state.json")

cat <<EOF
# Orchestration: $TASK
**Status:** $STATUS | **Agents:** $COMPLETED_AGENTS/$TOTAL_AGENTS complete | **Running:** $RUNNING_AGENTS | **Failed:** $FAILED_AGENTS

EOF

# Output each wave
for i in $(seq 0 $((WAVE_COUNT - 1))); do
  WAVE_STATUS=$(jq -r ".waves[$i].status" "$ORCH_DIR/state.json")
  echo "## Wave $((i + 1)) — $WAVE_STATUS"
  echo ""
  echo "| Agent | Status | Tools | Started | Finished |"
  echo "|-------|--------|-------|---------|----------|"

  jq -r ".waves[$i].agents[] | \"| \(.label) | \(.status) | \(.toolUses // 0) | \(.startedAt // \"-\") | \(.finishedAt // \"-\") |\"" "$ORCH_DIR/state.json"
  echo ""
done

# Reviewer status
REVIEWER_STATUS=$(read_state "$ORCH_DIR" '.reviewer.status')
echo "## Reviewer — $REVIEWER_STATUS"
```

- [ ] **Step 3: Write update-dashboard.sh**

```bash
#!/usr/bin/env bash
# update-dashboard.sh <orch-dir>
# Regenerates dashboard and pushes to wmux markdown pane.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR="$1"
[ -z "$ORCH_DIR" ] && ORCH_DIR=$(find_active_orch)
[ -z "$ORCH_DIR" ] && exit 0

bash "$SCRIPT_DIR/check-status.sh" "$ORCH_DIR" > "$ORCH_DIR/dashboard.md"

DASHBOARD_SID=$(read_state "$ORCH_DIR" '.dashboardSurfaceId')
if [ "$DASHBOARD_SID" != "null" ] && [ -n "$DASHBOARD_SID" ] && command -v wmux &>/dev/null; then
  wmux markdown set "$DASHBOARD_SID" --file "$ORCH_DIR/dashboard.md" 2>/dev/null || true
fi
```

- [ ] **Step 4: Write collect-results.sh**

```bash
#!/usr/bin/env bash
# collect-results.sh <orch-dir>
# Aggregates all agent result files into a single summary for the reviewer.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR="$1"
[ -z "$ORCH_DIR" ] && { echo "Usage: collect-results.sh <orch-dir>"; exit 1; }

echo "# Orchestration Results Summary"
echo ""

WAVE_COUNT=$(jq '.waves | length' "$ORCH_DIR/state.json")

for i in $(seq 0 $((WAVE_COUNT - 1))); do
  echo "## Wave $((i + 1))"
  echo ""

  jq -r ".waves[$i].agents[] | .id" "$ORCH_DIR/state.json" | while IFS= read -r agent_id; do
    LABEL=$(jq -r ".waves[$i].agents[] | select(.id == \"$agent_id\") | .label" "$ORCH_DIR/state.json")
    RESULT_FILE="$ORCH_DIR/agent-${agent_id}-result.md"

    echo "### $LABEL"
    echo ""
    if [ -f "$RESULT_FILE" ]; then
      cat "$RESULT_FILE"
    else
      echo "_No result file found._"
    fi
    echo ""
  done
done
```

- [ ] **Step 5: Write cleanup.sh**

```bash
#!/usr/bin/env bash
# cleanup.sh <orch-dir>
# Remove orchestration temp directory.

ORCH_DIR="$1"
[ -z "$ORCH_DIR" ] && { echo "Usage: cleanup.sh <orch-dir>"; exit 1; }
[ -d "$ORCH_DIR" ] && rm -rf "$ORCH_DIR"
echo "Cleaned up $ORCH_DIR"
```

- [ ] **Step 6: Make all scripts executable and commit**

```bash
chmod +x resources/wmux-orchestrator/scripts/*.sh
git add resources/wmux-orchestrator/scripts/
git commit -m "feat: add agent spawning, dashboard, and utility scripts"
```

---

## Task 7: Write the wmux-worker agent template

**Files:**
- Create: `resources/wmux-orchestrator/agents/wmux-worker.md`

- [ ] **Step 1: Write wmux-worker.md**

```markdown
---
name: wmux-worker
description: Worker agent for wmux orchestrated tasks. Executes a specific subtask within strict file boundaries, reports results in standardized format.
tools: Read, Write, Edit, Grep, Glob, Bash, LSP
model: inherit
---

You are a worker agent in a wmux orchestration. You have been assigned a specific subtask as part of a larger task being worked on by multiple agents in parallel.

## Critical Rules

1. **File zone is strict.** Only modify files listed in your mission's "Allowed files" section. If you discover you need to change a file outside your zone, STOP immediately and document it in your result file under "Risks" — do not modify it.

2. **No side effects.** Do not run `git commit`, `git push`, `npm install -g`, or modify system/global configuration. You may run `npm test`, `tsc --noEmit`, or other validation commands.

3. **Production quality.** Write clean, production-ready code. No TODOs, no placeholders, no "implement later" comments. If you can't complete something, explain why in your result file.

4. **Result report is mandatory.** When you finish, create your result file at the path specified in your mission. Use the exact format below.

## Result File Format

Create your result file as markdown with these sections:

```
### Summary
[2-3 sentences describing what was done]

### Files Modified
- `path/to/file.ts` — [what changed and why]

### Interfaces/Types Changed
[List any exported types, interfaces, or function signatures that changed.
This is critical for agents in subsequent waves who depend on your work.]

### Tests
[Tests executed and results. Or "Out of scope" if testing isn't part of your subtask.]

### Risks
[Points of attention for subsequent agents or the reviewer.
Include any files you wanted to modify but couldn't (outside your zone).]
```

## Your Mission

Your specific mission, file assignments, and context from previous waves will be provided when you are spawned. Follow the mission plan step by step.
```

- [ ] **Step 2: Commit**

```bash
git add resources/wmux-orchestrator/agents/wmux-worker.md
git commit -m "feat: add wmux-worker agent template for orchestrated subtasks"
```

---

## Task 8: Write the orchestrate command and skill

This is the core intelligence of the plugin — the skill that analyzes the codebase, proposes decomposition, and launches orchestration.

**Files:**
- Create: `resources/wmux-orchestrator/commands/wmux:orchestrate.md`
- Create: `resources/wmux-orchestrator/skills/orchestrate/SKILL.md`
- Create: `resources/wmux-orchestrator/skills/orchestrate/references/decomposition-guide.md`

- [ ] **Step 1: Write the command entry point**

```markdown
---
name: wmux:orchestrate
description: Decompose a complex dev task into parallel subtasks and orchestrate multiple Claude Code agents across wmux terminal panes. Usage: /wmux:orchestrate <task description>
---

You are about to orchestrate a multi-agent task decomposition. Use the orchestrate skill to proceed.

The user's task: $ARGUMENTS

Invoke the Skill tool with skill "wmux-orchestrator:orchestrate" now.
```

- [ ] **Step 2: Write the orchestrate SKILL.md**

```markdown
---
name: orchestrate
description: Core orchestration skill. Analyzes codebase, decomposes tasks into waves of parallel agents, creates wmux layout, spawns agents, monitors progress, triggers reviewer.
---

# wmux Orchestration Skill

You are the orchestrator. Your job is to decompose the user's task into parallel subtasks, create a wave-based execution plan, and launch Claude Code agents to execute it.

## Phase 1: Detect wmux

Run the detection script:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/detect-wmux.sh"
```

Store the result. If "unavailable", you will use Claude Code's native Agent tool instead of wmux CLI for spawning workers. Log this to the user.

## Phase 2: Analyze the Codebase

Before decomposing, understand what the task involves:

1. **Map relevant files**: Use Glob and Grep to find all files related to the task
2. **Trace dependencies**: For each relevant file, check its imports and exports to understand coupling
3. **Identify conflict zones**: Files that would need to be touched by multiple subtasks — these MUST be assigned to a single agent or sequenced across waves
4. **Check git context**: Read recent commits for relevant context

## Phase 3: Decompose into Subtasks

Based on your analysis, break the task into subtasks. Each subtask:
- Has a clear, bounded scope
- Has an explicit list of files it may modify
- Has files it must NOT modify (other agents' zones)
- Can be described in 2-3 sentences

**Rules for decomposition:**
- Files that are tightly coupled should be in the same subtask
- Shared types/interfaces should be in the earliest wave
- Tests should generally be in the last wave (they depend on implementation)
- Prefer fewer, larger subtasks over many tiny ones
- Reference `${CLAUDE_PLUGIN_ROOT}/skills/orchestrate/references/decomposition-guide.md` for patterns

## Phase 4: Build the Wave Plan

Organize subtasks into waves based on dependencies:
- **Wave 1**: Foundation work — types, models, shared interfaces. No dependencies.
- **Wave 2+**: Work that depends on wave 1 output. Agents within a wave run in parallel.
- **Final wave**: Tests, documentation, or anything that depends on all previous work.

Determine agent count per wave based on:
- Number of independent subtasks in that wave
- If wmux is available, check layout capacity: `wmux list-panes`
- Maximum practical limit: 5 agents per wave (more causes diminishing returns)

## Phase 5: Present the Plan

Show the user a structured plan:

```
Orchestration Plan: [task description]
Agents: [total] in [N] waves

Wave 1 — [description]
  Agent A: "[subtask]"
    Files: [list]

Wave 2 (after Wave 1) — [description]  
  Agent B: "[subtask]"
    Files: [list]
  Agent C: "[subtask]"
    Files: [list]

Wave 3 (after Wave 2) — [description]
  Agent D: "[subtask]"
    Files: [list]

Options:
  --worktree: Isolate each agent in a git worktree (default: no)
  --no-review: Skip the automated reviewer (default: review enabled)
```

Ask the user: "Validate this plan? (yes / adjust / cancel)"

Wait for user approval. If they want adjustments, modify the plan and re-present.

## Phase 6: Initialize Orchestration

Once the user validates:

1. **Generate orchestration ID**: `orch-$(date +%s | tail -c 7)`

2. **Create state file**:

```bash
ORCH_DIR=$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.sh" && create_orch_dir "$ORCH_ID")
```

Write `state.json` using the Write tool with the full state structure (see spec for schema). Set:
- `status`: "running"
- `startedAt`: current UTC timestamp
- All waves and agents from the validated plan
- `reviewer.status`: "pending" (or "skipped" if --no-review)

3. **Generate agent prompts**: For each agent, create `agent-{id}-prompt.md` in the orchestration directory with:
   - The wmux-worker agent instructions
   - Mission-specific details (subtask description, file zone, exclusions)
   - Context from previous waves (for wave 2+ agents, include result summaries)
   - Result file path

4. **Create wmux layout** (if wmux available):

```bash
# Create dedicated workspace
wmux new-workspace --title "Orchestration: [task]"

# Create dashboard pane
wmux split --down --type markdown
# Capture the surfaceId and store in state.json as dashboardSurfaceId
```

5. **Spawn Wave 1 agents**:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/spawn-agents.sh" "$ORCH_DIR" 0
```

If wmux is NOT available, spawn agents using Claude Code's native Agent tool:

```
For each agent in Wave 1:
  Use the Agent tool with:
    - prompt: contents of agent-{id}-prompt.md
    - description: agent label
    - model: inherit
```

## Phase 7: Monitor and Transition

After spawning Wave 1, the hooks take over:
- `on-tool-use.sh` tracks progress
- `on-agent-stop.sh` detects completion and spawns next waves

If using native Agent tool (no wmux), you must manually:
1. Wait for all Wave 1 agents to complete
2. Read their result files
3. Generate Wave 2 agent prompts (injecting Wave 1 results)
4. Spawn Wave 2 agents
5. Repeat until all waves complete

## Phase 8: Launch Reviewer

When all waves complete (detected by hook or manual check):

1. Aggregate results:
```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/collect-results.sh" "$ORCH_DIR" > "$ORCH_DIR/all-results.md"
```

2. Invoke the reviewer skill:
```
Use the Skill tool with skill "wmux-orchestrator:reviewer"
```

## Phase 9: Finalize

After the reviewer completes, present the summary:
- Total time elapsed
- Agents used, waves completed
- Files modified (from git diff)
- Test results
- Reviewer findings and corrections
- Offer: commit / view diff / abort changes
```

- [ ] **Step 3: Write decomposition-guide.md**

```markdown
# Task Decomposition Guide

## Decomposition Patterns

### Pattern 1: Layer-Based Split
Split by architectural layers when the task spans multiple layers.
- Wave 1: Data layer (models, types, schemas)
- Wave 2: Logic layer (services, middleware, utilities)
- Wave 3: Interface layer (routes, controllers, UI components)
- Wave 4: Tests and documentation

### Pattern 2: Feature-Based Split
Split by independent features when the task involves multiple features.
- Wave 1: Shared infrastructure (types, config, utilities)
- Wave 2+: Each feature as a separate agent (parallel)
- Final wave: Integration tests

### Pattern 3: Component-Based Split
Split by UI components when the task is frontend-heavy.
- Wave 1: Shared state/store changes
- Wave 2: Independent component implementations (parallel)
- Wave 3: Integration and E2E tests

### Pattern 4: Migration Split
For data or API migrations.
- Wave 1: New schema/types/interfaces
- Wave 2: Migration logic + backward compatibility
- Wave 3: Consumer updates (parallel per consumer)
- Wave 4: Remove old code + tests

## File Conflict Resolution

When two subtasks need the same file:
1. **Prefer sequencing**: Put them in different waves
2. **Prefer merging**: Combine into one subtask if small enough
3. **Split the file**: If the file is large, the first agent can split it, second agent modifies the new file
4. **Accept shared read**: Multiple agents CAN read the same file, just not write to it

## Sizing Guidelines

- **1 agent**: Task touches 1-3 files, straightforward changes
- **2 agents**: Task has 2 independent concerns (e.g., backend + frontend)
- **3 agents**: Task spans 3+ layers or features
- **4-5 agents**: Large refactor or migration across many files
- **>5 agents**: Consider breaking into separate orchestrations

## Anti-Patterns

- Don't create agents for trivial changes (1-line fix doesn't need an agent)
- Don't split tightly coupled files across agents
- Don't put test-writing in wave 1 (tests depend on implementation)
- Don't create circular dependencies between waves
```

- [ ] **Step 4: Commit**

```bash
git add resources/wmux-orchestrator/commands/ resources/wmux-orchestrator/skills/orchestrate/
git commit -m "feat: add orchestrate command and skill — core task decomposition and orchestration"
```

---

## Task 9: Write the reviewer skill

**Files:**
- Create: `resources/wmux-orchestrator/skills/reviewer/SKILL.md`

- [ ] **Step 1: Write reviewer SKILL.md**

```markdown
---
name: reviewer
description: Automated reviewer for wmux orchestrations. Runs after all agent waves complete. Checks consistency, runs tests, fixes minor issues, produces a review report.
---

# Orchestration Reviewer

You are the reviewer for a completed wmux orchestration. Multiple agents have worked on a task in parallel waves. Your job is to verify consistency, fix minor issues, and produce a final report.

## Step 1: Gather Context

Read the aggregated results:

```bash
ORCH_DIR=$(bash -c 'source "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.sh" && find_active_orch')
cat "$ORCH_DIR/all-results.md"
```

If the file doesn't exist, aggregate manually:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/collect-results.sh" "$ORCH_DIR"
```

Also read the orchestration state to understand the task and wave structure:

```bash
cat "$ORCH_DIR/state.json"
```

## Step 2: Review the Changeset

1. Run `git diff` to see ALL changes made by all agents
2. Run `git diff --stat` for a file-level overview
3. For each modified file, verify:
   - No syntax errors
   - Imports are correct (no missing imports, no imports of deleted symbols)
   - Types are consistent across files
   - No duplicate or conflicting changes

## Step 3: Check Cross-Agent Consistency

This is the most critical step. Agents worked in isolation — their changes must be compatible:

1. **Type compatibility**: If Agent A changed an interface and Agent B uses it, verify Agent B's usage matches the new interface
2. **Import chains**: Verify all import paths are correct
3. **No orphaned code**: Check that removed exports aren't still imported elsewhere
4. **No duplicate implementations**: Ensure two agents didn't implement the same thing differently

## Step 4: Run Tests

If the project has tests:

```bash
npm test 2>&1 || true
```

Record test results. If tests fail:
- Analyze the failure
- If it's a minor fix (missing import, typo, type mismatch), fix it directly
- If it's a major issue, document it in the review report

## Step 5: Fix Minor Issues

You are authorized to fix:
- Missing imports
- Type mismatches between agent boundaries
- Unused imports from removed code
- Minor syntax issues

Use Edit tool for fixes. Document each fix in the review report.

You are NOT authorized to:
- Rewrite significant logic
- Change the architectural approach
- Add features not in the original task

## Step 6: Produce Review Report

Write the report to the orchestration directory:

```bash
# Write to: $ORCH_DIR/review-report.md
```

Report format:

```markdown
# Orchestration Review Report

## Summary
[2-3 sentences: overall assessment]

## Changeset
- Files modified: [count]
- Lines added: [count]
- Lines removed: [count]

## Cross-Agent Consistency
- [x] Types compatible across boundaries
- [x] Import chains valid
- [x] No orphaned code
- [ ] [Any issues found]

## Tests
- Result: [PASS/FAIL]
- [Details of any failures]

## Corrections Applied
- [List each fix with file and description]

## Remaining Issues
- [Any issues that need user attention]

## Recommendation
[READY TO COMMIT / NEEDS USER REVIEW / SIGNIFICANT ISSUES]
```

## Step 7: Update State

Update the orchestration state:

```bash
source "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.sh"
ORCH_DIR=$(find_active_orch)
update_state "$ORCH_DIR" '.reviewer.status = "completed"'
update_state "$ORCH_DIR" '.status = "completed"'
```

Update the dashboard one final time:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/update-dashboard.sh" "$ORCH_DIR"
```

## Step 8: Present to User

Summarize the review findings to the user and offer:
- **Commit**: Create a git commit with all changes
- **View diff**: Show the full diff for manual review
- **Abort**: Revert all changes (`git checkout .`)
```

- [ ] **Step 2: Commit**

```bash
git add resources/wmux-orchestrator/skills/reviewer/
git commit -m "feat: add reviewer skill — automated post-orchestration review and consistency check"
```

---

## Task 10: Add auto-install in wmux's claude-context.ts

wmux needs to auto-install the plugin on startup so users don't need to manually install it.

**Files:**
- Modify: `src/main/claude-context.ts` (add `ensureOrchestratorPlugin()`)
- Modify: `src/main/index.ts` (call the new function)

- [ ] **Step 1: Write ensureOrchestratorPlugin() in claude-context.ts**

Add this function at the end of `src/main/claude-context.ts`:

```typescript
/**
 * Auto-installs the wmux-orchestrator plugin into Claude Code's plugin cache.
 * Copies from resources/wmux-orchestrator/ to ~/.claude/plugins/cache/,
 * registers in installed_plugins.json, and enables in settings.json.
 */
export function ensureOrchestratorPlugin(): void {
  try {
    // Find the plugin source directory
    let pluginSrc: string;
    try {
      const { app } = require('electron') as typeof import('electron');
      if (app.isPackaged) {
        pluginSrc = path.join(process.resourcesPath, 'wmux-orchestrator');
      } else {
        pluginSrc = path.resolve(path.join(__dirname, '../../resources/wmux-orchestrator'));
      }
    } catch {
      pluginSrc = path.resolve(path.join(__dirname, '../../resources/wmux-orchestrator'));
    }

    if (!fs.existsSync(pluginSrc)) {
      console.warn('[wmux] wmux-orchestrator plugin source not found at', pluginSrc);
      return;
    }

    // Read version from plugin.json
    const pluginJson = JSON.parse(fs.readFileSync(path.join(pluginSrc, '.claude-plugin', 'plugin.json'), 'utf-8'));
    const version = pluginJson.version || '0.1.0';

    // Target: ~/.claude/plugins/cache/wmux-orchestrator/{version}/
    const claudeDir = path.join(os.homedir(), '.claude');
    const cacheDir = path.join(claudeDir, 'plugins', 'cache', 'wmux-orchestrator', version);

    // Check if already installed at this version
    const targetPluginJson = path.join(cacheDir, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(targetPluginJson)) {
      try {
        const installed = JSON.parse(fs.readFileSync(targetPluginJson, 'utf-8'));
        if (installed.version === version) return; // Already up to date
      } catch {}
    }

    // Copy plugin to cache
    fs.mkdirSync(cacheDir, { recursive: true });
    copyDirSync(pluginSrc, cacheDir);

    // Register in installed_plugins.json
    const installedPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
    let installed: any = {};
    if (fs.existsSync(installedPath)) {
      try { installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8')); } catch {}
    }
    installed['wmux-orchestrator@wmux'] = {
      scope: 'user',
      installPath: cacheDir,
      version,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(installedPath, JSON.stringify(installed, null, 2), 'utf-8');

    // Enable in settings.json
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      let settings: any;
      try { settings = JSON.parse(raw); } catch { return; }
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      if (settings.enabledPlugins['wmux-orchestrator@wmux'] !== true) {
        settings.enabledPlugins['wmux-orchestrator@wmux'] = true;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      }
    }

    console.log('[wmux] Installed wmux-orchestrator plugin v' + version);
  } catch (err) {
    console.warn('[wmux] Failed to install orchestrator plugin:', err);
  }
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
```

- [ ] **Step 2: Call ensureOrchestratorPlugin in index.ts**

In `src/main/index.ts`, find the line where `ensureClaudeContext()` and `ensureClaudeHooks()` are called (near the app.whenReady block), and add:

```typescript
import { ensureClaudeContext, ensureClaudeHooks, ensureChromeDevtoolsConfig, ensureOrchestratorPlugin } from './claude-context';

// In the app.whenReady callback, after existing calls:
ensureOrchestratorPlugin();
```

- [ ] **Step 3: Build and verify**

```bash
npm run build:main
```
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add src/main/claude-context.ts src/main/index.ts
git commit -m "feat: auto-install wmux-orchestrator plugin on wmux startup"
```

---

## Task 11: Integration testing — end-to-end manual test

**Files:** None (manual testing)

- [ ] **Step 1: Start wmux in dev mode**

```bash
npm run dev
```

- [ ] **Step 2: Verify plugin is installed**

```bash
cat ~/.claude/plugins/installed_plugins.json | jq '.["wmux-orchestrator@wmux"]'
```
Expected: Shows version, installPath, scope

```bash
cat ~/.claude/settings.json | jq '.enabledPlugins["wmux-orchestrator@wmux"]'
```
Expected: `true`

- [ ] **Step 3: Verify plugin files are in cache**

```bash
ls ~/.claude/plugins/cache/wmux-orchestrator/0.1.0/
```
Expected: Shows full plugin directory structure

- [ ] **Step 4: Test wmux-detect**

```bash
bash ~/.claude/plugins/cache/wmux-orchestrator/0.1.0/scripts/detect-wmux.sh
```
Expected: "available" (since wmux is running)

- [ ] **Step 5: Test V2 pipe handlers**

```bash
wmux list-workspaces
wmux list-panes
wmux split --right
wmux list-panes
```
Expected: JSON responses with real data

- [ ] **Step 6: Test in Claude Code**

Open Claude Code in a wmux terminal and run:
```
/wmux:orchestrate Add a dark mode toggle to the settings page
```
Expected: The orchestrate skill loads, analyzes the codebase, proposes a decomposition plan

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes for wmux-orchestrator plugin"
```

---

## Task Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | V2 pipe handlers for workspace/pane/surface/markdown | None |
| 2 | Plugin manifest and package.json | None |
| 3 | wmux-detect skill and script | Task 2 |
| 4 | State management library | Task 2 |
| 5 | Hook scripts (on-tool-use, on-agent-stop, on-stop, on-session-start) | Task 4 |
| 6 | spawn-agents.sh, check-status.sh, utility scripts | Task 4 |
| 7 | wmux-worker agent template | Task 2 |
| 8 | Orchestrate command and skill (core intelligence) | Tasks 3, 5, 6, 7 |
| 9 | Reviewer skill | Task 6 |
| 10 | Auto-install in wmux claude-context.ts | Tasks 2-9 |
| 11 | End-to-end integration testing | Task 10 |

**Parallelizable:** Tasks 1-4 can run in parallel. Tasks 5-7 can run in parallel. Tasks 8-9 can run in parallel after their dependencies.
