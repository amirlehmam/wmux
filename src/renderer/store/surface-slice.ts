import { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import { WorkspaceId, PaneId, SurfaceId, SurfaceRef, SurfaceType } from '../../shared/types';
import { findLeaf, removeLeaf, splitNode, getAllPaneIds } from './split-utils';
import { killSurfacePty } from './pty-teardown';
import { WorkspaceSlice } from './workspace-slice';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SurfaceSlice {
  /**
   * Add a new surface (tab) to a pane; returns the new SurfaceId, or null if the
   * target workspace/pane no longer exists (so callers don't get an id for a
   * surface that was never created).
   */
  addSurface: (
    workspaceId: WorkspaceId,
    paneId: PaneId,
    type: SurfaceType,
    options?: {
      colorScheme?: string;
      customTitle?: string;
      shell?: string;
      cwd?: string;
      startupCommands?: string[];
      url?: string;
      /**
       * This open was triggered by an event, not by the user (the Edit/Write
       * hook auto-opening a diff tab). Such an open must respect an earlier
       * dismissal rather than retract it — see `isDiffTabDismissed`.
       */
      auto?: boolean;
    },
  ) => SurfaceId | null;

  /** Close a surface; if it's the last one in the pane, the pane is removed */
  closeSurface: (workspaceId: WorkspaceId, paneId: PaneId, surfaceId: SurfaceId) => void;

  /**
   * The path behind every USER close gesture for a tab (the tab ×, Ctrl+W).
   * Closes immediately unless the surface holds unsaved markdown edits (issue
   * #116, F3), in which case it parks the request in `pendingCloseSurface` for
   * the confirmation dialog. Programmatic closes (`wmux close-surface`) call
   * closeSurface directly and never see the dialog — a CLI call must not block
   * on a modal nobody is looking at.
   *
   * reopenClosedSurface (Ctrl+Shift+T) does make an accidental close
   * recoverable, but "recoverable via a shortcut you may not know" is not good
   * enough for text the user typed.
   */
  requestCloseSurface: (workspaceId: WorkspaceId, paneId: PaneId, surfaceId: SurfaceId) => void;
  pendingCloseSurface: { workspaceId: WorkspaceId; paneId: PaneId; surfaceId: SurfaceId; label: string } | null;
  confirmPendingCloseSurface: () => void;
  cancelPendingCloseSurface: () => void;

  /**
   * Close a whole pane, reaping every shell it holds.
   *
   * Lives in the store rather than in PaneWrapper so the UI button, `wmux
   * close-pane` and closeSurface's last-tab path share ONE implementation —
   * the same reasoning pty-teardown.ts records for PTY reaping. The three
   * copies this replaces had each independently gotten the last-pane case
   * wrong, in the same way.
   *
   * Closing the workspace's only pane closes the workspace: a workspace with
   * zero panes cannot be rendered, and `removeLeaf` correctly reports that
   * nothing is left.
   */
  closePane: (workspaceId: WorkspaceId, paneId: PaneId) => void;

  /**
   * Open a copy of a surface in the same pane: same type, shell, color and
   * (current) directory, but a fresh instance. Returns the new SurfaceId, or
   * null if the source no longer exists.
   */
  duplicateSurface: (workspaceId: WorkspaceId, paneId: PaneId, surfaceId: SurfaceId) => SurfaceId | null;

  /** Close every other surface in the pane, keeping only `keepSurfaceId` */
  closeOtherSurfaces: (workspaceId: WorkspaceId, paneId: PaneId, keepSurfaceId: SurfaceId) => void;

  /** Close every surface positioned after `fromSurfaceId` in the pane */
  closeSurfacesToRight: (workspaceId: WorkspaceId, paneId: PaneId, fromSurfaceId: SurfaceId) => void;

  /** Advance to the next surface in the pane (wraps around) */
  nextSurface: (workspaceId: WorkspaceId, paneId: PaneId) => void;

  /** Go back to the previous surface in the pane (wraps around) */
  prevSurface: (workspaceId: WorkspaceId, paneId: PaneId) => void;

  /** Select a surface by 0-based index */
  selectSurface: (workspaceId: WorkspaceId, paneId: PaneId, index: number) => void;

  /**
   * Re-create the most-recently-closed surface (issue #64, Ctrl+Shift+T) into the
   * given pane. Restores tab metadata (type/title/shell/cwd/url/startup commands);
   * a terminal restarts fresh since its PTY is gone. Returns null if the
   * reopen-stack is empty.
   */
  reopenClosedSurface: (workspaceId: WorkspaceId, paneId: PaneId) => SurfaceId | null;

  /** Move a surface from one pane to another (drag-and-drop) */
  moveSurface: (workspaceId: WorkspaceId, sourcePaneId: PaneId, surfaceId: SurfaceId, targetPaneId: PaneId) => void;

  /** Reorder a surface within the same pane (drag to new tab position) */
  reorderSurface: (workspaceId: WorkspaceId, paneId: PaneId, surfaceId: SurfaceId, newIndex: number) => void;

  /** Rename a surface (set custom tab title) */
  renameSurface: (workspaceId: WorkspaceId, paneId: PaneId, surfaceId: SurfaceId, customTitle: string) => void;

  /** Update a surface without moving it */
  updateSurface: (workspaceId: WorkspaceId, paneId: PaneId, surfaceId: SurfaceId, patch: Partial<SurfaceRef>) => void;

  /**
   * Set rendered markdown content on a surface, found by id across all
   * workspaces/panes (issue #54). Callers from the pipe bridge only know the
   * surfaceId, so this locates the owning pane itself.
   *
   * Takes an options object rather than positional args (issue #116) so the
   * next field doesn't become a fourth parameter. A bare string is still
   * accepted as `fileName` for compatibility with the `executeJavaScript`
   * call the main process emits, which may be from an older build during a
   * hot-swap.
   */
  setMarkdownContent: (
    surfaceId: SurfaceId,
    content: string,
    options?: string | { fileName?: string; filePath?: string; mtimeMs?: number; dirty?: boolean },
  ) => void;

  /** Split a pane and move a surface into the new pane (drag to edge) */
  splitAndMoveSurface: (
    workspaceId: WorkspaceId,
    targetPaneId: PaneId,
    sourcePaneId: PaneId,
    surfaceId: SurfaceId,
    direction: 'left' | 'right' | 'up' | 'down',
  ) => void;
}

/**
 * Build the surface patch for a markdown content update.
 *
 * The subtle rule is which fields a content-only push is allowed to touch. Only
 * a load *from a file* may set the tab label and backing path — otherwise
 * `wmux markdown set --content` against a file-backed surface would silently
 * re-point or clear the path it saves and reloads from.
 *
 * Dirty state follows the same reasoning (F3, issue #116): a load from disk
 * carries an mtime and leaves the buffer clean, while pushing text into a
 * file-backed surface makes the buffer differ from disk — which is a user edit
 * in every way that matters, so it is marked dirty rather than auto-written.
 */
export function markdownContentPatch(
  existing: SurfaceRef,
  content: string,
  opts: { fileName?: string; filePath?: string; mtimeMs?: number; dirty?: boolean } = {},
): Partial<SurfaceRef> {
  const patch: Partial<SurfaceRef> = { markdownContent: content };
  if (opts.fileName) patch.markdownFileName = opts.fileName;
  if (opts.filePath) patch.markdownFilePath = opts.filePath;
  if (opts.mtimeMs !== undefined) patch.markdownFileMtime = opts.mtimeMs;
  if (opts.dirty !== undefined) {
    patch.markdownDirty = opts.dirty;
  } else {
    patch.markdownDirty = !opts.filePath && !!existing.markdownFilePath;
  }
  return patch;
}

// ─── Helper: update a leaf's surfaces in the split tree ──────────────────────

type SliceState = SurfaceSlice & WorkspaceSlice;

// Reopen stack (issue #64): the metadata of recently-closed surfaces, most
// recent last. Module-level (not store state) — it's a transient undo buffer
// nothing renders. Bounded so a long session can't grow it unboundedly.
interface ClosedSurface {
  type: SurfaceType;
  colorScheme?: string;
  customTitle?: string;
  shell?: string;
  cwd?: string;
  startupCommands?: string[];
  url?: string;
}
const closedSurfaceStack: ClosedSurface[] = [];
const MAX_CLOSED_SURFACES = 25;

// Workspaces where the user closed the auto-opened diff tab (issue #141).
// Session-scoped, like the reopen stack: closing it used to last only until the
// next Edit/Write hook fired, so the tab resurrected itself minutes later with
// no user action — and on a large repo its polling was what made typing lag.
// A tab the user dismissed stays dismissed until they ask for a diff again.
const diffTabDismissed = new Set<WorkspaceId>();

/** True if the user closed this workspace's diff tab and hasn't reopened one. */
export function isDiffTabDismissed(workspaceId: WorkspaceId): boolean {
  return diffTabDismissed.has(workspaceId);
}

/**
 * Bookkeeping every close path owes a surface it is about to drop.
 *
 * Diff surfaces are auto-generated from hook events (issue #63), so reopening a
 * stale one via Ctrl+Shift+T is noise — but the close still has to be recorded,
 * or the next Edit/Write hook puts the tab straight back (issue #141).
 */
function pushClosedSurface(workspaceId: WorkspaceId, surface: SurfaceRef): void {
  if (surface.type === 'diff') {
    diffTabDismissed.add(workspaceId);
    return;
  }
  closedSurfaceStack.push({
    type: surface.type,
    colorScheme: surface.colorScheme,
    customTitle: surface.customTitle,
    shell: surface.shell,
    cwd: surface.cwd,
    startupCommands: surface.startupCommands,
    url: surface.url,
  });
  if (closedSurfaceStack.length > MAX_CLOSED_SURFACES) closedSurfaceStack.shift();
}

// ─── Slice creator ───────────────────────────────────────────────────────────

export const createSurfaceSlice: StateCreator<SliceState, [], [], SurfaceSlice> = (set, get) => ({
  addSurface(workspaceId, paneId, type, options) {
    const surfaceId: SurfaceId = `surf-${uuid()}` as SurfaceId;

    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return null;

    // Asking for a diff tab retracts an earlier dismissal, so the auto-open
    // behaviour resumes for this workspace (issue #141). `options.auto` marks
    // the hook-driven open, which must not clear it — that is the loop the
    // dismissal exists to break.
    if (type === 'diff' && !options?.auto) diffTabDismissed.delete(workspaceId);

    const newSurface: SurfaceRef = {
      id: surfaceId,
      type,
      ...(options?.colorScheme ? { colorScheme: options.colorScheme } : {}),
      ...(options?.customTitle ? { customTitle: options.customTitle } : {}),
      ...(options?.shell ? { shell: options.shell } : {}),
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(options?.startupCommands?.length ? { startupCommands: options.startupCommands } : {}),
      ...(options?.url ? { url: options.url } : {}),
    };
    const newSurfaces = [...leaf.surfaces, newSurface];
    const newActiveSurfaceIndex = newSurfaces.length - 1;

    // Rebuild tree with updated leaf (immutable)
    const updatedTree = patchLeaf(ws.splitTree, paneId, {
      surfaces: newSurfaces,
      activeSurfaceIndex: newActiveSurfaceIndex,
    });

    updateSplitTree(workspaceId, updatedTree);
    return surfaceId;
  },

  duplicateSurface(workspaceId, paneId, surfaceId) {
    const { workspaces } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return null;

    const src = leaf.surfaces.find((s) => s.id === surfaceId);
    if (!src) return null;

    // Copy the tab's config, preferring its live directory so the new terminal
    // opens where the source currently is. Startup commands are intentionally
    // NOT replayed — duplicating an agent tab shouldn't relaunch the agent.
    return get().addSurface(workspaceId, paneId, src.type, {
      shell: src.shell,
      cwd: src.currentCwd || src.cwd,
      colorScheme: src.colorScheme,
      url: src.url,
    });
  },

  pendingCloseSurface: null,

  requestCloseSurface(workspaceId, paneId, surfaceId) {
    const { workspaces, closeSurface } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    const surface = ws && findLeaf(ws.splitTree, paneId)?.surfaces.find((s) => s.id === surfaceId);
    if (!surface?.markdownDirty) {
      closeSurface(workspaceId, paneId, surfaceId);
      return;
    }
    set({
      pendingCloseSurface: {
        workspaceId,
        paneId,
        surfaceId,
        label: surface.markdownFileName || 'this note',
      },
    });
  },

  confirmPendingCloseSurface() {
    const pending = get().pendingCloseSurface;
    set({ pendingCloseSurface: null });
    if (pending) get().closeSurface(pending.workspaceId, pending.paneId, pending.surfaceId);
  },

  cancelPendingCloseSurface() {
    set({ pendingCloseSurface: null });
  },

  closeSurface(workspaceId, paneId, surfaceId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    // Remember the closed surface so Ctrl+Shift+T can bring it back (issue #64),
    // then reap its shell. Killing here — at the state transition — is what fixes
    // the leak (issue #65): Ctrl+W and `wmux close-surface` both funnel through
    // this action, and neither used to kill the PTY (only the tab-× button did).
    const closing = leaf.surfaces.find((s) => s.id === surfaceId);
    if (closing) {
      pushClosedSurface(workspaceId, closing);
      killSurfacePty(closing);
    }

    const newSurfaces = leaf.surfaces.filter((s) => s.id !== surfaceId);

    if (newSurfaces.length === 0) {
      // Last tab in the pane — this is a pane close, so use the pane close.
      // It was previously inlined here and got the single-pane case wrong:
      // removeLeaf returns null for a one-leaf tree, `if (newTree)` skipped the
      // update, and the function returned having ALREADY reaped the shell above
      // — leaving a dead tab that could never be closed.
      get().closePane(workspaceId, paneId);
      return;
    }

    // Clamp activeSurfaceIndex so it stays in bounds
    const newActiveIndex = Math.min(leaf.activeSurfaceIndex, newSurfaces.length - 1);
    const updatedTree = patchLeaf(ws.splitTree, paneId, {
      surfaces: newSurfaces,
      activeSurfaceIndex: newActiveIndex,
    });

    updateSplitTree(workspaceId, updatedTree);
  },

  closePane(workspaceId, paneId) {
    const { workspaces, updateSplitTree, closeWorkspace } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    // ORDER IS THE WHOLE FIX: decide BEFORE destroying anything.
    //
    // All three previous copies killed the pane's PTYs first and only then asked
    // removeLeaf what the tree should become. When the answer was null — the
    // pane was the workspace's only one, which is what `wmux new-workspace`
    // creates — they read it as "nothing to do" and returned, having already
    // killed a dev server, an agent and every shell in the pane. The UI was
    // unchanged, so nothing told the user it had happened.
    const newTree = removeLeaf(ws.splitTree, paneId);

    if (!newTree) {
      // Nothing would be left. A workspace with zero panes cannot be rendered,
      // so this closes the workspace — which reaps the whole subtree itself.
      closeWorkspace(workspaceId);
      return;
    }

    for (const surface of leaf.surfaces) {
      if (surface.type === 'diff') diffTabDismissed.add(workspaceId);
      killSurfacePty(surface);
    }
    updateSplitTree(workspaceId, newTree);
  },

  closeOtherSurfaces(workspaceId, paneId, keepSurfaceId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    const keep = leaf.surfaces.find((s) => s.id === keepSurfaceId);
    if (!keep) return;
    if (leaf.surfaces.length === 1) return;

    // Reap the shells we're dropping and remember them for Ctrl+Shift+T,
    // mirroring the bookkeeping in closeSurface (issues #64, #65).
    for (const s of leaf.surfaces) {
      if (s.id === keepSurfaceId) continue;
      pushClosedSurface(workspaceId, s);
      killSurfacePty(s);
    }

    const updatedTree = patchLeaf(ws.splitTree, paneId, {
      surfaces: [keep],
      activeSurfaceIndex: 0,
    });
    updateSplitTree(workspaceId, updatedTree);
  },

  closeSurfacesToRight(workspaceId, paneId, fromSurfaceId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    const idx = leaf.surfaces.findIndex((s) => s.id === fromSurfaceId);
    if (idx === -1 || idx === leaf.surfaces.length - 1) return;

    // Reap the shells to the right and remember them for Ctrl+Shift+T,
    // mirroring the bookkeeping in closeSurface (issues #64, #65).
    for (const s of leaf.surfaces.slice(idx + 1)) {
      pushClosedSurface(workspaceId, s);
      killSurfacePty(s);
    }

    const newSurfaces = leaf.surfaces.slice(0, idx + 1);
    const newActiveIndex = Math.min(leaf.activeSurfaceIndex, newSurfaces.length - 1);
    const updatedTree = patchLeaf(ws.splitTree, paneId, {
      surfaces: newSurfaces,
      activeSurfaceIndex: newActiveIndex,
    });
    updateSplitTree(workspaceId, updatedTree);
  },

  nextSurface(workspaceId, paneId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf || leaf.surfaces.length <= 1) return;

    const newIndex = (leaf.activeSurfaceIndex + 1) % leaf.surfaces.length;
    const updatedTree = patchLeaf(ws.splitTree, paneId, { activeSurfaceIndex: newIndex });
    updateSplitTree(workspaceId, updatedTree);
  },

  prevSurface(workspaceId, paneId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf || leaf.surfaces.length <= 1) return;

    const newIndex = (leaf.activeSurfaceIndex - 1 + leaf.surfaces.length) % leaf.surfaces.length;
    const updatedTree = patchLeaf(ws.splitTree, paneId, { activeSurfaceIndex: newIndex });
    updateSplitTree(workspaceId, updatedTree);
  },

  moveSurface(workspaceId, sourcePaneId, surfaceId, targetPaneId) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const sourceLeaf = findLeaf(ws.splitTree, sourcePaneId);
    const targetLeaf = findLeaf(ws.splitTree, targetPaneId);
    if (!sourceLeaf || !targetLeaf) return;

    // Find the surface in the source
    const surfaceIndex = sourceLeaf.surfaces.findIndex((s) => s.id === surfaceId);
    if (surfaceIndex === -1) return;
    const surface = sourceLeaf.surfaces[surfaceIndex];

    // Remove from source
    const newSourceSurfaces = sourceLeaf.surfaces.filter((s) => s.id !== surfaceId);
    let tree = ws.splitTree;

    if (newSourceSurfaces.length === 0) {
      // Source pane is now empty — remove it
      tree = removeLeaf(tree, sourcePaneId) ?? tree;
    } else {
      tree = patchLeaf(tree, sourcePaneId, {
        surfaces: newSourceSurfaces,
        activeSurfaceIndex: Math.min(sourceLeaf.activeSurfaceIndex, newSourceSurfaces.length - 1),
      });
    }

    // Add to target
    const updatedTargetLeaf = findLeaf(tree, targetPaneId);
    if (updatedTargetLeaf) {
      const newTargetSurfaces = [...updatedTargetLeaf.surfaces, surface];
      tree = patchLeaf(tree, targetPaneId, {
        surfaces: newTargetSurfaces,
        activeSurfaceIndex: newTargetSurfaces.length - 1,
      });
    }

    updateSplitTree(workspaceId, tree);
  },

  selectSurface(workspaceId, paneId, index) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    const clampedIndex = Math.max(0, Math.min(index, leaf.surfaces.length - 1));
    if (clampedIndex === leaf.activeSurfaceIndex) return;

    const updatedTree = patchLeaf(ws.splitTree, paneId, { activeSurfaceIndex: clampedIndex });
    updateSplitTree(workspaceId, updatedTree);
  },

  reopenClosedSurface(workspaceId, paneId) {
    const restored = closedSurfaceStack.pop();
    if (!restored) return null;
    const { addSurface } = get();
    return addSurface(workspaceId, paneId, restored.type, {
      ...(restored.colorScheme ? { colorScheme: restored.colorScheme } : {}),
      ...(restored.customTitle ? { customTitle: restored.customTitle } : {}),
      ...(restored.shell ? { shell: restored.shell } : {}),
      ...(restored.cwd ? { cwd: restored.cwd } : {}),
      ...(restored.startupCommands ? { startupCommands: restored.startupCommands } : {}),
      ...(restored.url ? { url: restored.url } : {}),
    });
  },

  reorderSurface(workspaceId, paneId, surfaceId, newIndex) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    const currentIndex = leaf.surfaces.findIndex((s) => s.id === surfaceId);
    if (currentIndex === -1 || currentIndex === newIndex) return;

    const newSurfaces = [...leaf.surfaces];
    const [moved] = newSurfaces.splice(currentIndex, 1);
    newSurfaces.splice(newIndex, 0, moved);

    const updatedTree = patchLeaf(ws.splitTree, paneId, {
      surfaces: newSurfaces,
      activeSurfaceIndex: newIndex,
    });

    updateSplitTree(workspaceId, updatedTree);
  },

  renameSurface(workspaceId, paneId, surfaceId, customTitle) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    const newSurfaces = leaf.surfaces.map((s) =>
      s.id === surfaceId ? { ...s, customTitle: customTitle || undefined } : s,
    );
    const updatedTree = patchLeaf(ws.splitTree, paneId, { surfaces: newSurfaces });
    updateSplitTree(workspaceId, updatedTree);
  },

  updateSurface(workspaceId, paneId, surfaceId, patch) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    const newSurfaces = leaf.surfaces.map((s) => (s.id === surfaceId ? { ...s, ...patch } : s));
    const updatedTree = patchLeaf(ws.splitTree, paneId, { surfaces: newSurfaces });
    updateSplitTree(workspaceId, updatedTree);
  },

  setMarkdownContent(surfaceId, content, options) {
    const { workspaces, updateSurface } = get();
    const opts = typeof options === 'string' ? { fileName: options } : (options ?? {});
    for (const ws of workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, paneId);
        const existing = leaf?.surfaces.find((s) => s.id === surfaceId);
        if (!existing) continue;
        updateSurface(ws.id, paneId, surfaceId, markdownContentPatch(existing, content, opts));
        return;
      }
    }
  },

  splitAndMoveSurface(workspaceId, targetPaneId, sourcePaneId, surfaceId, direction) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const splitDirection = (direction === 'left' || direction === 'right') ? 'horizontal' : 'vertical';

    const newPaneId = `pane-${uuid()}` as PaneId;
    let tree = splitNode(ws.splitTree, targetPaneId, newPaneId, 'terminal', splitDirection);

    // splitNode puts new leaf as SECOND child. For left/up, swap children.
    if (direction === 'left' || direction === 'up') {
      tree = swapSplitChildren(tree, targetPaneId, newPaneId);
    }

    // Remove surface from source pane
    const sourceLeaf = findLeaf(tree, sourcePaneId);
    if (!sourceLeaf) return;

    const surfaceIndex = sourceLeaf.surfaces.findIndex((s) => s.id === surfaceId);
    if (surfaceIndex === -1) return;
    const surface = sourceLeaf.surfaces[surfaceIndex];

    const newSourceSurfaces = sourceLeaf.surfaces.filter((s) => s.id !== surfaceId);

    if (newSourceSurfaces.length === 0) {
      tree = removeLeaf(tree, sourcePaneId) ?? tree;
    } else {
      tree = patchLeaf(tree, sourcePaneId, {
        surfaces: newSourceSurfaces,
        activeSurfaceIndex: Math.min(sourceLeaf.activeSurfaceIndex, newSourceSurfaces.length - 1),
      });
    }

    // Replace the new pane's auto-created surface with the dragged one
    tree = patchLeaf(tree, newPaneId, {
      surfaces: [surface],
      activeSurfaceIndex: 0,
    });

    updateSplitTree(workspaceId, tree);
  },
});

// ─── patchLeaf — immutable leaf update inside an arbitrary tree ───────────────

import { SplitNode } from '../../shared/types';

function patchLeaf(
  tree: SplitNode,
  paneId: PaneId,
  patch: Partial<Pick<SplitNode & { type: 'leaf' }, 'surfaces' | 'activeSurfaceIndex'>>,
): SplitNode {
  if (tree.type === 'leaf') {
    if (tree.paneId !== paneId) return tree;
    return { ...tree, ...patch };
  }

  const [left, right] = tree.children;
  const newLeft = patchLeaf(left, paneId, patch);
  const newRight = patchLeaf(right, paneId, patch);

  if (newLeft === left && newRight === right) return tree;
  return { ...tree, children: [newLeft, newRight] };
}

function swapSplitChildren(tree: SplitNode, paneIdA: PaneId, paneIdB: PaneId): SplitNode {
  if (tree.type === 'leaf') return tree;

  const [left, right] = tree.children;
  const leftHasA = containsPane(left, paneIdA);
  const rightHasB = containsPane(right, paneIdB);

  if (leftHasA && rightHasB) {
    return { ...tree, children: [right, left] };
  }

  const newLeft = swapSplitChildren(left, paneIdA, paneIdB);
  const newRight = swapSplitChildren(right, paneIdA, paneIdB);
  if (newLeft === left && newRight === right) return tree;
  return { ...tree, children: [newLeft, newRight] };
}

function containsPane(node: SplitNode, paneId: PaneId): boolean {
  if (node.type === 'leaf') return node.paneId === paneId;
  return containsPane(node.children[0], paneId) || containsPane(node.children[1], paneId);
}
