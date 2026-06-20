import { useEffect } from 'react';
import { useStore } from '../store';
import { ShortcutBinding, ShortcutAction } from '../store/settings-slice';
import { splitNode, removeLeaf, getAllPaneIds, findLeaf } from '../store/split-utils';
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
    function handleKeyDown(e: KeyboardEvent): void {
      if (!isSafeToIntercept(e)) return;

      const shortcutEntries = Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][];

      for (const [action, binding] of shortcutEntries) {
        if (!matchesBinding(e, binding)) continue;

        // find and copyMode are handled at PaneWrapper level — don't block them
        if (action === 'find' || action === 'copyMode') return;

        // Found a matching action — prevent default and handle it
        e.preventDefault();
        dispatchAction(action);
        return;
      }
    }

    function dispatchAction(action: ShortcutAction): void {
      const state = useStore.getState();

      switch (action) {
        case 'newWorkspace': {
          createWorkspace();
          break;
        }

        case 'newWindow': {
          window.wmux?.window?.create?.();
          break;
        }

        case 'closeWorkspace': {
          if (activeWorkspaceId) closeWorkspace(activeWorkspaceId);
          break;
        }

        case 'closeWindow': {
          window.close();
          break;
        }

        case 'openFolder': {
          // No-op: needs OS file dialog via IPC, not yet implemented
          break;
        }

        case 'toggleSidebar': {
          toggleSidebar();
          break;
        }

        case 'nextWorkspace': {
          if (workspaces.length === 0 || !activeWorkspaceId) break;
          const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
          const nextIdx = (idx + 1) % workspaces.length;
          selectWorkspace(workspaces[nextIdx].id);
          break;
        }

        case 'prevWorkspace': {
          if (workspaces.length === 0 || !activeWorkspaceId) break;
          const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
          const prevIdx = (idx - 1 + workspaces.length) % workspaces.length;
          selectWorkspace(workspaces[prevIdx].id);
          break;
        }

        case 'renameSurface': {
          document.dispatchEvent(new CustomEvent('wmux:rename-surface'));
          break;
        }

        case 'renameWorkspace': {
          document.dispatchEvent(new CustomEvent('wmux:rename-workspace'));
          break;
        }

        case 'splitRight': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          const ws = state.workspaces.find((w) => w.id === activeWorkspaceId);
          if (!ws) break;
          const newPaneId: PaneId = `pane-${uuid()}` as PaneId;
          const newTree = splitNode(ws.splitTree, focusedPaneId, newPaneId, 'terminal', 'horizontal');
          updateSplitTree(activeWorkspaceId, newTree);
          break;
        }

        case 'splitDown': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          const ws = state.workspaces.find((w) => w.id === activeWorkspaceId);
          if (!ws) break;
          const newPaneId: PaneId = `pane-${uuid()}` as PaneId;
          const newTree = splitNode(ws.splitTree, focusedPaneId, newPaneId, 'terminal', 'vertical');
          updateSplitTree(activeWorkspaceId, newTree);
          break;
        }

        case 'splitBrowserRight': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          const ws = state.workspaces.find((w) => w.id === activeWorkspaceId);
          if (!ws) break;
          const newPaneId: PaneId = `pane-${uuid()}` as PaneId;
          const newTree = splitNode(ws.splitTree, focusedPaneId, newPaneId, 'browser', 'horizontal');
          updateSplitTree(activeWorkspaceId, newTree);
          break;
        }

        case 'splitBrowserDown': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          const ws = state.workspaces.find((w) => w.id === activeWorkspaceId);
          if (!ws) break;
          const newPaneId: PaneId = `pane-${uuid()}` as PaneId;
          const newTree = splitNode(ws.splitTree, focusedPaneId, newPaneId, 'browser', 'vertical');
          updateSplitTree(activeWorkspaceId, newTree);
          break;
        }

        case 'toggleZoom': {
          onToggleZoom?.();
          break;
        }

        case 'focusLeft':
        case 'focusRight':
        case 'focusUp':
        case 'focusDown': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          const ws = state.workspaces.find((w) => w.id === activeWorkspaceId);
          if (!ws) break;
          const dirMap: Record<string, 'left' | 'right' | 'up' | 'down'> = {
            focusLeft: 'left',
            focusRight: 'right',
            focusUp: 'up',
            focusDown: 'down',
          };
          const targetPane = findAdjacentPane(ws.splitTree, focusedPaneId, dirMap[action]);
          if (targetPane) onFocusPane?.(targetPane);
          break;
        }

        case 'closeSurfaceOrPane': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          const ws = state.workspaces.find((w) => w.id === activeWorkspaceId);
          if (!ws) break;
          const leaf = findLeaf(ws.splitTree, focusedPaneId);
          if (leaf && leaf.surfaces.length > 0) {
            // Close the active surface; if it's the last, closeSurface removes the pane
            const activeSurface = leaf.surfaces[leaf.activeSurfaceIndex];
            if (activeSurface) {
              closeSurface(activeWorkspaceId, focusedPaneId, activeSurface.id);
              break;
            }
          }
          // Fallback: no surfaces found, remove the pane directly (guard: keep last pane)
          const paneIds = getAllPaneIds(ws.splitTree);
          if (paneIds.length <= 1) break;
          const newTree = removeLeaf(ws.splitTree, focusedPaneId);
          if (newTree) updateSplitTree(activeWorkspaceId, newTree);
          break;
        }

        case 'newSurface': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          addSurface(activeWorkspaceId, focusedPaneId, 'terminal');
          break;
        }

        case 'nextSurface': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          nextSurface(activeWorkspaceId, focusedPaneId);
          break;
        }

        case 'prevSurface': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          prevSurface(activeWorkspaceId, focusedPaneId);
          break;
        }

        case 'jumpToUnread': {
          const notifs = state.notifications;
          const unread = notifs.find((n) => !n.read);
          if (!unread) break;
          state.selectWorkspace(unread.workspaceId);
          // Find the pane containing this surface and focus it
          const ws = state.workspaces.find((w) => w.id === unread.workspaceId);
          if (ws) {
            const paneIds = getAllPaneIds(ws.splitTree);
            for (const pid of paneIds) {
              const leaf = findLeaf(ws.splitTree, pid);
              if (leaf) {
                const surfIdx = leaf.surfaces.findIndex((s) => s.id === unread.surfaceId);
                if (surfIdx !== -1) {
                  state.selectSurface(unread.workspaceId, pid, surfIdx);
                  onFocusPane?.(pid);
                  break;
                }
              }
            }
          }
          state.markRead(unread.surfaceId);
          break;
        }

        case 'showNotifications': {
          onToggleNotifications?.();
          break;
        }

        case 'flashFocused': {
          if (focusedPaneId) {
            document.dispatchEvent(
              new CustomEvent('wmux:trigger-flash', { detail: { paneId: focusedPaneId } }),
            );
          }
          break;
        }

        case 'openBrowser': {
          onToggleBrowser?.();
          break;
        }

        case 'browserDevTools': {
          window.wmux?.system?.toggleDevTools?.();
          break;
        }

        case 'browserConsole': {
          window.wmux?.system?.toggleDevTools?.();
          break;
        }

        // find and copyMode are handled at PaneWrapper level
        case 'find':
        case 'copyMode':
          break;

        case 'copy': {
          const selection = window.getSelection()?.toString();
          if (selection) {
            navigator.clipboard.writeText(selection);
          }
          break;
        }

        case 'paste': {
          if (!focusedPaneId || !activeWorkspaceId) break;
          const ws = useStore.getState().workspaces.find((w) => w.id === activeWorkspaceId);
          if (!ws) break;
          const leaf = findLeaf(ws.splitTree, focusedPaneId);
          if (!leaf) break;
          const activeSurf = leaf.surfaces[leaf.activeSurfaceIndex];
          if (activeSurf?.type === 'terminal') {
            // Delegate to the focused terminal instead of reading the clipboard
            // here: navigator.clipboard.readText() garbles non-UTF-8 Windows
            // clipboard formats (em dash → "â"), and a raw pty.write strips
            // bracketed-paste markers (breaking multi-line paste in Claude Code).
            // The terminal's handler reads via Electron's clipboard and uses
            // terminal.paste(), matching the Ctrl+V path.
            document.dispatchEvent(
              new CustomEvent('wmux:paste-terminal', { detail: { surfaceId: activeSurf.id } }),
            );
          }
          break;
        }

        case 'fontSizeIncrease': {
          const prefs = state.terminalPrefs;
          state.setTerminalPrefs({ fontSize: Math.min(32, prefs.fontSize + 1) });
          break;
        }

        case 'fontSizeDecrease': {
          const prefs = state.terminalPrefs;
          state.setTerminalPrefs({ fontSize: Math.max(8, prefs.fontSize - 1) });
          break;
        }

        case 'fontSizeReset': {
          state.setTerminalPrefs({ fontSize: 13 });
          break;
        }

        case 'openSettings': {
          onOpenSettings?.(true);
          break;
        }

        case 'openMarkdownPanel': {
          if (!activeWorkspaceId || !focusedPaneId) break;
          addSurface(activeWorkspaceId, focusedPaneId, 'markdown');
          break;
        }

        case 'commandPalette':
          // Handled separately in App.tsx
          break;

        default:
          console.log(`[wmux] Shortcut triggered: ${action}`);
          break;
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
}
