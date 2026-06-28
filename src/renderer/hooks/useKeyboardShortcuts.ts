import { useEffect } from 'react';
import { useStore } from '../store';
import { ShortcutBinding, ShortcutAction } from '../store/settings-slice';
import { splitNode, removeLeaf, getAllPaneIds, findLeaf, adjustPaneRatio } from '../store/split-utils';
import { PaneId, SplitNode } from '../../shared/types';
import { v4 as uuid } from 'uuid';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function matchesBinding(e: KeyboardEvent, binding: ShortcutBinding): boolean {
  // Case-insensitive compare for single-letter keys: Shift uppercases e.key on Windows,
  // but bindings are stored lowercase. Without toLowerCase, Ctrl+Shift+letter combos
  // never match (e.g. Ctrl+Shift+N fires with e.key='N' vs binding.key='n').
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const bindingKey = binding.key.length === 1 ? binding.key.toLowerCase() : binding.key;
  const keyMatch = eventKey === bindingKey;
  const ctrlMatch = !!binding.ctrl === e.ctrlKey;
  const shiftMatch = !!binding.shift === e.shiftKey;
  const altMatch = !!binding.alt === e.altKey;
  return keyMatch && ctrlMatch && shiftMatch && altMatch;
}

/**
 * Keys that are safe to intercept even when a terminal has focus.
 * All others with only Ctrl held (no Shift/Alt) are forwarded to the terminal.
 */
const SAFE_CTRL_KEYS = new Set(['b', 'd', 'n', 't', 'w', 'f', ',']);

function isSafeToIntercept(e: KeyboardEvent): boolean {
  if (!e.ctrlKey) return true; // Not a Ctrl combo — always safe

  // Ctrl+Shift+* and Ctrl+Alt+* are safe (terminal uses bare Ctrl combos)
  if (e.shiftKey || e.altKey) return true;

  // Ctrl+PageDown / Ctrl+PageUp are safe
  if (e.key === 'PageDown' || e.key === 'PageUp') return true;

  // Ctrl+F2 is safe (rename)
  if (e.key === 'F2') return true;

  // Ctrl+F12 is safe (dev tools)
  if (e.key === 'F12') return true;

  // Ctrl+= / Ctrl+- / Ctrl+0 are safe (font size)
  if (e.key === '=' || e.key === '-' || e.key === '0') return true;

  // Specifically whitelisted bare Ctrl keys
  if (SAFE_CTRL_KEYS.has(e.key.toLowerCase())) return true;

  return false;
}

// ─── Spatial pane navigation ─────────────────────────────────────────────────

interface PaneRect {
  paneId: PaneId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Compute approximate fractional rectangles for all panes from the split tree */
function computePaneRects(tree: SplitNode): PaneRect[] {
  const rects: PaneRect[] = [];

  function walk(node: SplitNode, x: number, y: number, w: number, h: number) {
    if (node.type === 'leaf') {
      rects.push({ paneId: node.paneId, x, y, w, h });
      return;
    }
    const { ratio, direction, children } = node;
    if (direction === 'horizontal') {
      walk(children[0], x, y, w * ratio, h);
      walk(children[1], x + w * ratio, y, w * (1 - ratio), h);
    } else {
      walk(children[0], x, y, w, h * ratio);
      walk(children[1], x, y + h * ratio, w, h * (1 - ratio));
    }
  }

  walk(tree, 0, 0, 1, 1);
  return rects;
}

function findAdjacentPane(
  tree: SplitNode,
  currentPaneId: PaneId,
  direction: 'left' | 'right' | 'up' | 'down',
): PaneId | null {
  const rects = computePaneRects(tree);
  const current = rects.find((r) => r.paneId === currentPaneId);
  if (!current) return null;

  const cx = current.x + current.w / 2;
  const cy = current.y + current.h / 2;
  const eps = 0.001;

  let candidates: PaneRect[];
  switch (direction) {
    case 'left':
      candidates = rects.filter((r) => r.paneId !== currentPaneId && r.x + r.w <= current.x + eps);
      break;
    case 'right':
      candidates = rects.filter((r) => r.paneId !== currentPaneId && r.x >= current.x + current.w - eps);
      break;
    case 'up':
      candidates = rects.filter((r) => r.paneId !== currentPaneId && r.y + r.h <= current.y + eps);
      break;
    case 'down':
      candidates = rects.filter((r) => r.paneId !== currentPaneId && r.y >= current.y + current.h - eps);
      break;
  }

  if (candidates.length === 0) return null;

  // Pick closest by center-to-center distance
  candidates.sort((a, b) => {
    const distA = Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy);
    const distB = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
    return distA - distB;
  });

  return candidates[0].paneId;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useKeyboardShortcuts(
  focusedPaneId: PaneId | null,
  onOpenSettings?: (open: boolean) => void,
  onToggleBrowser?: () => void,
  onToggleNotifications?: () => void,
  onFocusPane?: (paneId: PaneId) => void,
  onToggleZoom?: () => void,
): void {
  const {
    shortcuts,
    workspaces,
    activeWorkspaceId,
    createWorkspace,
    closeWorkspace,
    selectWorkspace,
    updateSplitTree,
    toggleSidebar,
    addSurface,
    nextSurface,
    prevSurface,
    closeSurface,
  } = useStore();

  useEffect(() => {
    // ── Shared action helpers (kept small so each stays well under Sonar's
    //    cognitive-complexity budget; the dispatch table below maps actions to
    //    these instead of one giant switch). ──────────────────────────────────
    const activeWs = () => useStore.getState().workspaces.find((w) => w.id === activeWorkspaceId);

    const doSplit = (type: 'terminal' | 'browser', dir: 'horizontal' | 'vertical') => {
      if (!activeWorkspaceId || !focusedPaneId) return;
      const ws = activeWs();
      if (!ws) return;
      const newPaneId = `pane-${uuid()}` as PaneId;
      updateSplitTree(activeWorkspaceId, splitNode(ws.splitTree, focusedPaneId, newPaneId, type, dir));
    };

    const doFocus = (dir: 'left' | 'right' | 'up' | 'down') => {
      if (!activeWorkspaceId || !focusedPaneId) return;
      const ws = activeWs();
      if (!ws) return;
      const target = findAdjacentPane(ws.splitTree, focusedPaneId, dir);
      if (target) onFocusPane?.(target);
    };

    // Move the divider adjacent to the focused pane (issue #64 keyboard resize).
    const doResize = (orientation: 'horizontal' | 'vertical', delta: number) => {
      if (!activeWorkspaceId || !focusedPaneId) return;
      const ws = activeWs();
      if (!ws) return;
      const newTree = adjustPaneRatio(ws.splitTree, focusedPaneId, orientation, delta);
      if (newTree !== ws.splitTree) updateSplitTree(activeWorkspaceId, newTree);
    };

    const cycleWorkspace = (dir: 1 | -1) => {
      if (workspaces.length === 0 || !activeWorkspaceId) return;
      const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
      const nextIdx = (idx + dir + workspaces.length) % workspaces.length;
      selectWorkspace(workspaces[nextIdx].id);
    };

    const closeFocusedSurfaceOrPane = () => {
      if (!activeWorkspaceId || !focusedPaneId) return;
      const ws = activeWs();
      if (!ws) return;
      const leaf = findLeaf(ws.splitTree, focusedPaneId);
      const activeSurface = leaf?.surfaces[leaf.activeSurfaceIndex];
      if (activeSurface) {
        // Close the active surface; if it's the last, closeSurface removes the pane.
        closeSurface(activeWorkspaceId, focusedPaneId, activeSurface.id);
        return;
      }
      // Fallback: no surfaces — remove the pane directly (guard: keep last pane).
      if (getAllPaneIds(ws.splitTree).length <= 1) return;
      const newTree = removeLeaf(ws.splitTree, focusedPaneId);
      if (newTree) updateSplitTree(activeWorkspaceId, newTree);
    };

    const jumpToUnread = () => {
      const state = useStore.getState();
      const unread = state.notifications.find((n) => !n.read);
      if (!unread) return;
      state.selectWorkspace(unread.workspaceId);
      const ws = state.workspaces.find((w) => w.id === unread.workspaceId);
      for (const pid of ws ? getAllPaneIds(ws.splitTree) : []) {
        const leaf = findLeaf(ws!.splitTree, pid);
        const surfIdx = leaf ? leaf.surfaces.findIndex((s) => s.id === unread.surfaceId) : -1;
        if (surfIdx !== -1) {
          state.selectSurface(unread.workspaceId, pid, surfIdx);
          onFocusPane?.(pid);
          break;
        }
      }
      state.markRead(unread.surfaceId);
    };

    const copySelection = () => {
      const selection = window.getSelection()?.toString();
      if (selection) navigator.clipboard.writeText(selection);
    };

    const pasteIntoFocusedTerminal = () => {
      if (!focusedPaneId || !activeWorkspaceId) return;
      const ws = activeWs();
      const leaf = ws ? findLeaf(ws.splitTree, focusedPaneId) : undefined;
      const activeSurf = leaf?.surfaces[leaf.activeSurfaceIndex];
      // Delegate to the focused terminal (see TerminalPane) instead of reading the
      // clipboard here: navigator.clipboard.readText() garbles non-UTF-8 Windows
      // formats and a raw pty.write strips bracketed-paste markers.
      if (activeSurf?.type === 'terminal') {
        document.dispatchEvent(new CustomEvent('wmux:paste-terminal', { detail: { surfaceId: activeSurf.id } }));
      }
    };

    const adjustFontSize = (next: (size: number) => number) => {
      const prefs = useStore.getState().terminalPrefs;
      useStore.getState().setTerminalPrefs({ fontSize: next(prefs.fontSize) });
    };

    const togglePinWorkspace = () => {
      if (!activeWorkspaceId) return;
      const state = useStore.getState();
      const ws = state.workspaces.find((w) => w.id === activeWorkspaceId);
      if (ws) state.updateWorkspaceMetadata(activeWorkspaceId, { pinned: !ws.pinned });
    };

    const markWorkspaceRead = () => {
      if (!activeWorkspaceId) return;
      const state = useStore.getState();
      state.updateWorkspaceMetadata(activeWorkspaceId, { unreadCount: 0, notificationText: undefined });
      const ws = state.workspaces.find((w) => w.id === activeWorkspaceId);
      for (const pid of ws ? getAllPaneIds(ws.splitTree) : []) {
        const leaf = findLeaf(ws!.splitTree, pid);
        for (const s of leaf ? leaf.surfaces : []) state.markRead(s.id);
      }
    };

    const openFolderAsWorkspace = () => {
      void (async () => {
        const res = await window.wmux?.system?.pickFolder?.();
        if (!res || res.canceled || !res.path) return;
        const segments = String(res.path).split(/[\\/]/).filter(Boolean);
        createWorkspace({ cwd: res.path, title: segments[segments.length - 1] || res.path });
      })();
    };

    const fire = (eventName: string, detail?: unknown) =>
      document.dispatchEvent(new CustomEvent(eventName, detail ? { detail } : undefined));

    // ── Action → handler dispatch table. Replaces the previous 35-case switch;
    //    new actions just add an entry. `find`/`copyMode` are handled at the
    //    PaneWrapper level and short-circuited before this lookup. ─────────────
    const handlers: Partial<Record<ShortcutAction, () => void>> = {
      newWorkspace: () => createWorkspace(),
      newWindow: () => window.wmux?.window?.create?.(),
      closeWorkspace: () => { if (activeWorkspaceId) closeWorkspace(activeWorkspaceId); },
      closeWindow: () => window.close(),
      openFolder: openFolderAsWorkspace,
      toggleSidebar: () => toggleSidebar(),
      nextWorkspace: () => cycleWorkspace(1),
      prevWorkspace: () => cycleWorkspace(-1),
      renameSurface: () => fire('wmux:rename-surface'),
      renameWorkspace: () => fire('wmux:rename-workspace'),
      splitRight: () => doSplit('terminal', 'horizontal'),
      splitDown: () => doSplit('terminal', 'vertical'),
      splitBrowserRight: () => doSplit('browser', 'horizontal'),
      splitBrowserDown: () => doSplit('browser', 'vertical'),
      toggleZoom: () => onToggleZoom?.(),
      focusLeft: () => doFocus('left'),
      focusRight: () => doFocus('right'),
      focusUp: () => doFocus('up'),
      focusDown: () => doFocus('down'),
      closeSurfaceOrPane: closeFocusedSurfaceOrPane,
      newSurface: () => { if (activeWorkspaceId && focusedPaneId) addSurface(activeWorkspaceId, focusedPaneId, 'terminal'); },
      nextSurface: () => { if (activeWorkspaceId && focusedPaneId) nextSurface(activeWorkspaceId, focusedPaneId); },
      prevSurface: () => { if (activeWorkspaceId && focusedPaneId) prevSurface(activeWorkspaceId, focusedPaneId); },
      jumpToUnread,
      showNotifications: () => onToggleNotifications?.(),
      flashFocused: () => { if (focusedPaneId) fire('wmux:trigger-flash', { paneId: focusedPaneId }); },
      openBrowser: () => onToggleBrowser?.(),
      browserDevTools: () => window.wmux?.system?.toggleDevTools?.(),
      browserConsole: () => window.wmux?.system?.toggleDevTools?.(),
      copy: copySelection,
      paste: pasteIntoFocusedTerminal,
      fontSizeIncrease: () => adjustFontSize((s) => Math.min(32, s + 1)),
      fontSizeDecrease: () => adjustFontSize((s) => Math.max(8, s - 1)),
      fontSizeReset: () => useStore.getState().setTerminalPrefs({ fontSize: 13 }),
      openSettings: () => onOpenSettings?.(true),
      openMarkdownPanel: () => { if (activeWorkspaceId && focusedPaneId) addSurface(activeWorkspaceId, focusedPaneId, 'markdown'); },
      // commandPalette is opened by App.tsx's own listener; keep a no-op so we
      // still preventDefault on the combo. find/copyMode are short-circuited above.
      commandPalette: () => {},
      // ── issue #64 additions ──────────────────────────────────────────────
      reopenClosedSurface: () => { if (activeWorkspaceId && focusedPaneId) useStore.getState().reopenClosedSurface(activeWorkspaceId, focusedPaneId); },
      findNext: () => fire('wmux:find-next'),
      findPrevious: () => fire('wmux:find-prev'),
      resizePaneLeft: () => doResize('horizontal', -0.05),
      resizePaneRight: () => doResize('horizontal', 0.05),
      resizePaneUp: () => doResize('vertical', -0.05),
      resizePaneDown: () => doResize('vertical', 0.05),
      broadcastInput: () => useStore.getState().toggleBroadcastInput(),
      togglePinWorkspace,
      markWorkspaceRead,
      toggleShortcutCheatSheet: () => fire('wmux:toggle-cheatsheet'),
    };

    function handleKeyDown(e: KeyboardEvent): void {
      if (!isSafeToIntercept(e)) return;

      const shortcutEntries = Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][];

      for (const [action, binding] of shortcutEntries) {
        if (!matchesBinding(e, binding)) continue;

        // find and copyMode are handled at PaneWrapper level — don't block them
        if (action === 'find' || action === 'copyMode') return;

        const handler = handlers[action];
        if (!handler) return;

        // Found a matching action — prevent default and handle it
        e.preventDefault();
        handler();
        return;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    shortcuts,
    workspaces,
    activeWorkspaceId,
    focusedPaneId,
    createWorkspace,
    closeWorkspace,
    selectWorkspace,
    updateSplitTree,
    toggleSidebar,
    addSurface,
    nextSurface,
    prevSurface,
    closeSurface,
    onOpenSettings,
    onToggleBrowser,
    onToggleNotifications,
    onFocusPane,
    onToggleZoom,
  ]);

  // Ctrl+1 through Ctrl+9 — select workspace by index
  useEffect(() => {
    function handleWorkspaceIndexKey(e: KeyboardEvent): void {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      const digit = parseInt(e.key, 10);
      if (isNaN(digit) || digit < 1 || digit > 9) return;

      e.preventDefault();
      const target = workspaces[digit - 1];
      if (target) selectWorkspace(target.id);
    }

    document.addEventListener('keydown', handleWorkspaceIndexKey);
    return () => {
      document.removeEventListener('keydown', handleWorkspaceIndexKey);
    };
  }, [workspaces, selectWorkspace]);

  // Ctrl+Alt+1 through Ctrl+Alt+9 — select tab (surface) N in the focused pane
  // (issue #64). Mirrors the Ctrl+1–9 workspace selector above; kept as a fixed
  // handler rather than nine remappable entries to avoid bloating Settings.
  useEffect(() => {
    function handleSurfaceIndexKey(e: KeyboardEvent): void {
      if (!e.ctrlKey || !e.altKey || e.shiftKey) return;
      const digit = parseInt(e.key, 10);
      if (isNaN(digit) || digit < 1 || digit > 9) return;
      if (!activeWorkspaceId || !focusedPaneId) return;

      e.preventDefault();
      useStore.getState().selectSurface(activeWorkspaceId, focusedPaneId, digit - 1);
    }

    document.addEventListener('keydown', handleSurfaceIndexKey);
    return () => {
      document.removeEventListener('keydown', handleSurfaceIndexKey);
    };
  }, [activeWorkspaceId, focusedPaneId]);
}
