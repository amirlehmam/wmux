# Saved Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users save and restore named workspace layouts (CWDs, splits, browser URL) so they don't have to rebuild their workflow every time wmux starts.

**Architecture:** Main process handles file I/O (save/load JSON files in `%APPDATA%/wmux/sessions/saved/`). Renderer exposes save/load UI in the sidebar footer. On startup, the last-used session is auto-loaded. Loading a session replaces all workspaces via a new `replaceAllWorkspaces()` store action.

**Tech Stack:** Node.js `fs` for persistence, Zustand for store, React for UI. No new dependencies.

---

### Task 1: Types + IPC channels

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add SavedSession type and IPC channels**

At the end of `src/shared/types.ts`, before `} as const;`, add the IPC channels. Before the IPC_CHANNELS, add the type:

```typescript
// Saved session (user-named layout snapshot)
export interface SavedSession {
  name: string;
  savedAt: number;
  workspaces: Array<{
    title: string;
    customColor?: string;
    shell: string;
    cwd: string;
    splitTree: SplitNode;
  }>;
  browserUrl?: string;
  sidebarWidth: number;
}
```

Add to IPC_CHANNELS before the closing `} as const;`:

```typescript
  // Named sessions
  SESSION_SAVE_NAMED: 'session:save-named',
  SESSION_LOAD_NAMED: 'session:load-named',
  SESSION_LIST_NAMED: 'session:list-named',
  SESSION_DELETE_NAMED: 'session:delete-named',
```

- [ ] **Step 2: Build**

Run: `npx tsc -p tsconfig.node.json`

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(sessions): add SavedSession type and IPC channels"
```

---

### Task 2: Session persistence functions

**Files:**
- Modify: `src/main/session-persistence.ts`

- [ ] **Step 1: Add named session CRUD functions**

Add these at the bottom of `src/main/session-persistence.ts`:

```typescript
const SAVED_DIR = path.join(APPDATA_DIR, 'sessions', 'saved');
const LAST_SESSION_FILE = path.join(APPDATA_DIR, 'sessions', 'last-session.txt');

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, '_').substring(0, 100);
}

export function saveNamedSession(session: import('../shared/types').SavedSession): void {
  if (!fs.existsSync(SAVED_DIR)) fs.mkdirSync(SAVED_DIR, { recursive: true });
  const filePath = path.join(SAVED_DIR, sanitizeName(session.name) + '.json');
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  setLastSessionName(session.name);
}

export function loadNamedSession(name: string): import('../shared/types').SavedSession | null {
  try {
    const filePath = path.join(SAVED_DIR, sanitizeName(name) + '.json');
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

export function listNamedSessions(): Array<{ name: string; savedAt: number; workspaceCount: number }> {
  if (!fs.existsSync(SAVED_DIR)) return [];
  try {
    return fs.readdirSync(SAVED_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SAVED_DIR, f), 'utf-8'));
          return { name: data.name, savedAt: data.savedAt, workspaceCount: data.workspaces?.length || 0 };
        } catch { return null; }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch { return []; }
}

export function deleteNamedSession(name: string): boolean {
  try {
    const filePath = path.join(SAVED_DIR, sanitizeName(name) + '.json');
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
    return false;
  } catch { return false; }
}

export function getLastSessionName(): string | null {
  try {
    if (!fs.existsSync(LAST_SESSION_FILE)) return null;
    return fs.readFileSync(LAST_SESSION_FILE, 'utf-8').trim() || null;
  } catch { return null; }
}

export function setLastSessionName(name: string): void {
  if (!fs.existsSync(SAVED_DIR)) fs.mkdirSync(SAVED_DIR, { recursive: true });
  fs.writeFileSync(LAST_SESSION_FILE, name, 'utf-8');
}
```

- [ ] **Step 2: Build**

Run: `npx tsc -p tsconfig.node.json`

- [ ] **Step 3: Commit**

```bash
git add src/main/session-persistence.ts
git commit -m "feat(sessions): named session CRUD + last-session tracking"
```

---

### Task 3: IPC handlers + preload

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add IPC handlers for session CRUD**

In `src/main/ipc-handlers.ts`, add import at the top:

```typescript
import { saveNamedSession, loadNamedSession, listNamedSessions, deleteNamedSession } from './session-persistence';
```

Add at the end of `registerIpcHandlers()`, before the closing `}`:

```typescript
  ipcMain.handle(IPC_CHANNELS.SESSION_SAVE_NAMED, (_event, session: any) => {
    saveNamedSession(session);
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD_NAMED, (_event, name: string) => {
    return loadNamedSession(name);
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_NAMED, () => {
    return listNamedSessions();
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE_NAMED, (_event, name: string) => {
    return deleteNamedSession(name);
  });
```

- [ ] **Step 2: Expose in preload**

In `src/preload/index.ts`, add after the `claudeActivity` section:

```typescript
  session: {
    save: (session: any) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SAVE_NAMED, session),
    load: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LOAD_NAMED, name),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST_NAMED),
    delete: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE_NAMED, name),
  },
```

- [ ] **Step 3: Build**

Run: `npx tsc -p tsconfig.node.json`

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/preload/index.ts
git commit -m "feat(sessions): IPC handlers + preload for save/load/list/delete"
```

---

### Task 4: Store action — replaceAllWorkspaces

**Files:**
- Modify: `src/renderer/store/workspace-slice.ts`

- [ ] **Step 1: Add replaceAllWorkspaces action**

In the `WorkspaceSlice` interface, add:

```typescript
  replaceAllWorkspaces(workspaces: Array<Partial<WorkspaceInfo>>): void;
```

In the slice creator, add the implementation:

```typescript
  replaceAllWorkspaces(workspaceConfigs: Array<Partial<WorkspaceInfo>>): void {
    // Kill all existing PTYs
    const state = get();
    // Note: PTYs are killed by the component layer (useTerminal cleanup)
    // We just clear the store — React will unmount terminals

    const newWorkspaces: WorkspaceInfo[] = workspaceConfigs.map((config, i) => ({
      id: `ws-${uuid()}` as WorkspaceId,
      title: config.title ?? `Workspace ${i + 1}`,
      pinned: config.pinned ?? false,
      shell: config.shell ?? 'pwsh.exe',
      splitTree: config.splitTree ?? createLeaf(),
      unreadCount: 0,
      customColor: config.customColor,
      cwd: config.cwd,
    }));

    set({
      workspaces: newWorkspaces,
      activeWorkspaceId: newWorkspaces.length > 0 ? newWorkspaces[0].id : null,
    });
  },
```

- [ ] **Step 2: Build renderer**

Run: `npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/workspace-slice.ts
git commit -m "feat(sessions): replaceAllWorkspaces store action"
```

---

### Task 5: Sidebar UI — save/load buttons + session menu

**Files:**
- Create: `src/renderer/components/Sidebar/SessionMenu.tsx`
- Modify: `src/renderer/components/Sidebar/Sidebar.tsx`
- Modify: `src/renderer/styles/sidebar.css`

- [ ] **Step 1: Create SessionMenu component**

```typescript
// src/renderer/components/Sidebar/SessionMenu.tsx
import React, { useState, useEffect, useRef } from 'react';

interface SessionEntry {
  name: string;
  savedAt: number;
  workspaceCount: number;
}

interface SessionMenuProps {
  onLoad: (name: string) => void;
  onClose: () => void;
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function SessionMenu({ onLoad, onClose }: SessionMenuProps) {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.wmux?.session?.list().then(setSessions);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleDelete = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await window.wmux?.session?.delete(name);
    setSessions(prev => prev.filter(s => s.name !== name));
  };

  if (sessions.length === 0) {
    return (
      <div ref={menuRef} className="session-menu">
        <div className="session-menu__empty">No saved sessions</div>
      </div>
    );
  }

  return (
    <div ref={menuRef} className="session-menu">
      {sessions.map(s => (
        <div key={s.name} className="session-menu__item" onClick={() => onLoad(s.name)}>
          <div className="session-menu__name">{s.name}</div>
          <div className="session-menu__meta">
            {s.workspaceCount} workspace{s.workspaceCount !== 1 ? 's' : ''} · {timeAgo(s.savedAt)}
          </div>
          <button
            className="session-menu__delete"
            onClick={(e) => handleDelete(s.name, e)}
            title="Delete session"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add save/load buttons to Sidebar footer**

In `src/renderer/components/Sidebar/Sidebar.tsx`, add import:

```typescript
import SessionMenu from './SessionMenu';
```

Add props to SidebarProps:

```typescript
  onSaveSession?: (name: string) => void;
  onLoadSession?: (name: string) => void;
```

Add state inside the Sidebar component:

```typescript
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [saveInputOpen, setSaveInputOpen] = useState(false);
  const [saveInputValue, setSaveInputValue] = useState('');
```

Replace the `sidebar__footer` div:

```tsx
      <div className="sidebar__footer">
        {saveInputOpen ? (
          <input
            className="sidebar__save-input"
            placeholder="Session name..."
            value={saveInputValue}
            onChange={(e) => setSaveInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && saveInputValue.trim()) {
                onSaveSession?.(saveInputValue.trim());
                setSaveInputOpen(false);
                setSaveInputValue('');
              }
              if (e.key === 'Escape') { setSaveInputOpen(false); setSaveInputValue(''); }
            }}
            onBlur={() => { setSaveInputOpen(false); setSaveInputValue(''); }}
            autoFocus
          />
        ) : (
          <>
            <button className="sidebar__footer-btn" onClick={() => setSaveInputOpen(true)} title="Save session">
              &#128190;
            </button>
            <button className="sidebar__footer-btn" onClick={() => setSessionMenuOpen(!sessionMenuOpen)} title="Load session">
              &#128194;
            </button>
            <button className="sidebar__new-btn" onClick={onCreate} title="New workspace">
              +
            </button>
          </>
        )}
        {sessionMenuOpen && (
          <SessionMenu
            onLoad={(name) => { onLoadSession?.(name); setSessionMenuOpen(false); }}
            onClose={() => setSessionMenuOpen(false)}
          />
        )}
      </div>
```

- [ ] **Step 3: Add CSS**

In `src/renderer/styles/sidebar.css`, add:

```css
.sidebar__footer {
  position: relative;
}

.sidebar__footer-btn {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
}
.sidebar__footer-btn:hover {
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.06);
}

.sidebar__save-input {
  flex: 1;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  padding: 4px 8px;
  outline: none;
}
.sidebar__save-input:focus {
  border-color: rgba(0, 145, 255, 0.5);
}

.session-menu {
  position: absolute;
  bottom: 100%;
  left: 6px;
  right: 6px;
  background: #1a1a1a;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
  max-height: 240px;
  overflow-y: auto;
  z-index: 1000;
  padding: 4px;
}

.session-menu__empty {
  padding: 12px;
  text-align: center;
  color: rgba(255, 255, 255, 0.3);
  font-size: 12px;
}

.session-menu__item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-radius: 4px;
  cursor: pointer;
  position: relative;
}
.session-menu__item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.session-menu__name {
  flex: 1;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-menu__meta {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
  margin-left: 8px;
  white-space: nowrap;
}

.session-menu__delete {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.2);
  cursor: pointer;
  font-size: 10px;
  padding: 2px 4px;
  margin-left: 4px;
  border-radius: 2px;
  opacity: 0;
}
.session-menu__item:hover .session-menu__delete {
  opacity: 1;
}
.session-menu__delete:hover {
  color: #e53935;
  background: rgba(229, 57, 53, 0.1);
}
```

- [ ] **Step 4: Build**

Run: `npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Sidebar/SessionMenu.tsx src/renderer/components/Sidebar/Sidebar.tsx src/renderer/styles/sidebar.css
git commit -m "feat(sessions): save/load buttons + session menu in sidebar"
```

---

### Task 6: Wire App.tsx — save, load, auto-load on startup

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add save/load handlers and auto-load**

In `App.tsx`, add save handler and pass to Sidebar:

```typescript
  const handleSaveSession = useCallback(async (name: string) => {
    const state = useStore.getState();
    const session = {
      name,
      savedAt: Date.now(),
      workspaces: state.workspaces.map(ws => ({
        title: ws.title,
        customColor: ws.customColor,
        shell: ws.shell,
        cwd: ws.cwd || '',
        splitTree: ws.splitTree,
      })),
      browserUrl: '', // Will be set if browser panel has a URL
      sidebarWidth,
    };
    await window.wmux?.session?.save(session);
    // Toast notification
    window.wmux?.notification?.fire({ surfaceId: '', text: `Session "${name}" saved`, title: 'wmux' });
  }, [sidebarWidth]);

  const handleLoadSession = useCallback(async (name: string) => {
    const session = await window.wmux?.session?.load(name);
    if (!session) return;
    const { replaceAllWorkspaces } = useStore.getState();
    replaceAllWorkspaces(session.workspaces);
    if (session.sidebarWidth) setSidebarWidth(session.sidebarWidth);
    if (session.browserUrl) {
      window.wmux?.browser?.navigate?.('', session.browserUrl);
    }
  }, []);
```

Add auto-load on mount (inside an existing useEffect or new one):

```typescript
  // Auto-load last session on startup
  useEffect(() => {
    (async () => {
      const sessions = await window.wmux?.session?.list();
      if (sessions && sessions.length > 0) {
        // Load the most recent session
        const latest = sessions[0]; // Already sorted by savedAt desc
        handleLoadSession(latest.name);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
```

Pass to Sidebar:

```tsx
  <Sidebar
    ...existing props...
    onSaveSession={handleSaveSession}
    onLoadSession={handleLoadSession}
  />
```

- [ ] **Step 2: Build**

Run: `npx tsc --noEmit -p tsconfig.json && npx vite build`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(sessions): save/load handlers + auto-load on startup"
```

---

### Task 7: Build, package, release

- [ ] **Step 1: Full build**

Run: `npx tsc -p tsconfig.node.json && npx vite build`

- [ ] **Step 2: Repack asar + zip + upload**

Follow established release process:
1. Repack asar from dist + node_modules
2. Update resources
3. Zip as `wmux-0.4.0-win-x64.zip`
4. `gh release upload v0.4.0 ... --clobber`
5. `git push origin master`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: v0.4.0 — saved sessions feature"
git push origin master
```
