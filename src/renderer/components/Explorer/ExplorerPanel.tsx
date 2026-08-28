import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { findLeaf } from '../../store/split-utils';
import { useT } from '../../i18n';
import {
  EXPLORER_MAX_ENTRIES,
  type ExplorerErrorCode, type ExplorerListResult,
} from '../../../shared/types';
import {
  flattenVisible, forgetTree, nextRefillPaths, pathRoot, pickRootSurface, pruneExpanded, recallTree,
  rememberTree, responseKey, toAbsolutePath, toggleExpanded, treeCacheKey, usableSticky,
  type CachedTree, type ExplorerRow, type ExplorerTreeCache, type ExplorerTreeState, type StickyRoot,
} from './explorer-state';
import { explorerErrorKey } from './explorer-errors';
import { ExplorerTree } from './ExplorerTree';
import { openInPreviewTab } from './open-preview';
import '../../styles/explorer.css';
import type { PaneId, SurfaceId } from '../../../shared/types';

const MAX_ROOTS = 8;

interface ExplorerPanelProps {
  onClose: () => void;
  /** Focused pane id, lifted from App.tsx local state — not store state. */
  focusedPaneId: PaneId | null;
}

export function ExplorerPanel({ onClose, focusedPaneId }: ExplorerPanelProps): React.JSX.Element {
  const t = useT();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const updateWorkspaceMetadata = useStore((s) => s.updateWorkspaceMetadata);

  // The root follows the FOCUSED PANE's TERMINAL, not the workspace and not
  // whatever tab happens to be active: the workspace cwd is last-reporter-wins
  // across every pane and would thrash, and the active tab is a markdown
  // preview the moment the user clicks a file in this very tree — see
  // pickRootSurface.
  //
  // Which terminal was last active per pane is remembered across renders, so a
  // pane with two shells in different directories goes back to the one the user
  // was actually in rather than to tab 0.
  const lastTerminalByPane = useRef<Map<PaneId, string>>(new Map());

  const focusedSurface = useMemo(() => {
    if (!workspace || !focusedPaneId) return null;
    const leaf = findLeaf(workspace.splitTree, focusedPaneId);
    if (!leaf) return null;
    return pickRootSurface(
      leaf.surfaces, leaf.activeSurfaceIndex, lastTerminalByPane.current.get(focusedPaneId) ?? null,
    );
  }, [workspace, focusedPaneId]);

  // A pane with no terminal at all (a markdown- or browser-only pane) has no
  // root to offer. Holding the last good one beats blanking the panel: the
  // user's browsing context survives a detour into such a pane.
  //
  // Both of these are refs read during THIS render and written after it: the
  // sticky value has to be usable on the same render that loses the terminal,
  // so the read cannot wait for an effect — but the write must, or the render
  // is impure and StrictMode's double-invoke records a pane visit twice.
  //
  // Scoped to ONE workspace, which is the whole reason it records a workspace
  // id it could otherwise infer. A detour into a terminal-less pane is a
  // detour within the user's current context; switching workspaces is not. A
  // globally sticky root let a markdown-only workspace B keep listing, and
  // revealing, workspace A's folder — and worse, a file clicked there was
  // opened in B while `codeRootSurfaceId` recorded A's terminal, persisting a
  // cross-workspace pointer into B's saved layout.
  const stickyRef = useRef<StickyRoot | null>(null);
  const liveRoot = focusedSurface?.currentCwd ?? focusedSurface?.cwd ?? '';
  const sticky = usableSticky(stickyRef.current, activeWorkspaceId);

  useEffect(() => {
    if (focusedPaneId && focusedSurface) {
      lastTerminalByPane.current.set(focusedPaneId, focusedSurface.id);
    }
    if (activeWorkspaceId && focusedSurface && liveRoot) {
      stickyRef.current = { workspaceId: activeWorkspaceId, surfaceId: focusedSurface.id, root: liveRoot };
    }
  }, [activeWorkspaceId, focusedPaneId, focusedSurface, liveRoot]);

  const surfaceId = (focusedSurface && liveRoot ? focusedSurface.id : sticky?.surfaceId) ?? null;
  // The cwd as REPORTED by the shell. Good enough to identify a fetch, and it
  // is what main resolves a root from — but never good enough to build a path
  // out of, which is what `absRoot` below is for.
  const root = (focusedSurface && liveRoot ? liveRoot : sticky?.root) ?? '';

  const [tree, setTree] = useState<ExplorerTreeState>({});
  const [error, setError] = useState<ExplorerErrorCode | null>(null);
  const [openError, setOpenError] = useState<ExplorerErrorCode | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // The absolute, realpath'd root main actually listed, taken from the root
  // reply. Main already knows it; before this landed the renderer threw it away
  // and concatenated paths onto the reported cwd instead, which under Git Bash
  // produced `/c/Users/x/repo\README.md` — a string no Windows API accepts, so
  // opening, revealing and copying a path all failed silently.
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null);

  const absRoot = pathRoot(resolvedRoot, root);

  // ─── The loaded tree, cached per root ──────────────────────────────────────
  // `tree` used to be torn down and refetched on every pane switch while
  // `expanded` persisted, and the refetch is where the expansion was lost: a
  // child listing dropped as stale left its path marked in `requestedRef` and
  // was never asked for again, so the folder kept an open chevron with nothing
  // under it until the user collapsed and reopened it by hand.
  //
  // `liveRef` is the source of truth the cache is written from; `tree` and
  // `resolvedRoot` are its rendering mirrors, written at the same three places.
  // A ref rather than an effect over `tree`, because the commit right after a
  // pane switch still holds the OLD tree under the NEW cache key — an effect
  // there would file one pane's children under another pane's root.
  const liveRef = useRef<CachedTree>({ tree: {}, resolvedRoot: null });
  const cacheRef = useRef<ExplorerTreeCache>({});
  const cacheKey = treeCacheKey(root, showHidden);

  // Expansion is keyed off the RESOLVED root, so the two spellings of one
  // directory (a junction and its target, `/c/...` and `C:\...`) share a single
  // entry instead of fragmenting into two.
  const expandedByRoot = workspace?.explorerExpanded ?? {};
  const expanded = expandedByRoot[absRoot] ?? [];

  // Everything derived from a SUCCESSFUL root listing, cleared together. The
  // banner and the resolved root are both statements about one specific folder
  // — leaving either behind puts a stale "Showing the first 2000 entries" under
  // a different folder, or lets a click build a path from a root that is no
  // longer the one on screen.
  const resetRootState = useCallback(() => {
    setResolvedRoot(null);
    setTruncated(false);
    setOpenError(null);
  }, []);

  // The current identity of this tree. A reply that no longer matches when it
  // lands is dropped — rapid pane switching would otherwise paint one pane's
  // children under another pane's tree.
  const currentKeyRef = useRef('');
  currentKeyRef.current = responseKey(surfaceId ?? '', root, String(showHidden));

  const fetchDir = useCallback(async (relPath: string) => {
    if (!surfaceId || !root) return;
    const key = currentKeyRef.current;
    const callCacheKey = treeCacheKey(root, showHidden);
    setLoading(true);
    try {
      const result: ExplorerListResult =
        await window.wmux.explorer.listDir(surfaceId, relPath, { showHidden });
      // Clear loading for THIS call unconditionally, even if stale. A stale
      // reply that skipped this would strand the spinner/empty-state forever
      // if the newer fetch then bailed at the guard above (no surfaceId/root)
      // and never started its own — nothing else would ever clear it.
      setLoading(false);
      if (currentKeyRef.current !== key) {
        // Superseded, NOT failed. The attempt record exists to stop a folder
        // that genuinely fails to list being re-queued every time `tree`
        // changes identity — it was never meant to make a dropped request
        // unrecoverable, which is exactly what left an expanded folder showing
        // an open chevron over nothing after a pane switch. Unmark, so the
        // refill can ask again; the key guard keeps this from unmarking a
        // request some LATER pass has already re-issued.
        if (relPath !== '' && requestedRef.current.key === key) {
          requestedRef.current.paths.delete(relPath);
        }
        return;
      }
      if ('error' in result) {
        // Only a ROOT failure blanks the panel; a failure expanding one child
        // leaves the rest of the tree on screen.
        if (relPath === '') {
          setError(result.code);
          liveRef.current = { tree: {}, resolvedRoot: null };
          setTree({});
          resetRootState();
        }
        return;
      }
      setError(null);
      liveRef.current = {
        tree: { ...liveRef.current.tree, [result.relPath]: result.entries },
        resolvedRoot: relPath === '' ? result.root : liveRef.current.resolvedRoot,
      };
      // Written under the key THIS call was made for — `treeCacheKey(root,
      // showHidden)` off the callback's own closure, never off a later render.
      cacheRef.current = rememberTree(cacheRef.current, callCacheKey, liveRef.current, MAX_ROOTS);
      if (relPath === '') {
        setTruncated(result.truncated);
        setResolvedRoot(result.root);
      }
      setTree(liveRef.current.tree);
    } catch {
      // ipcRenderer.invoke rejected — main threw rather than returning a
      // structured ExplorerListError, so there is no `code` to branch on.
      // Fall back to the generic read_failed message rather than leaving an
      // unhandled rejection and a stuck spinner.
      setLoading(false);
      // A rejection that arrives stale unmarks for the same reason the success
      // path above does: the refill only re-asks for a path it does not think
      // it has already asked for, so leaving the mark on strands the folder
      // open over nothing until the user collapses it by hand.
      if (currentKeyRef.current !== key) {
        if (relPath !== '' && requestedRef.current.key === key) {
          requestedRef.current.paths.delete(relPath);
        }
        return;
      }
      if (relPath === '') { setError('read_failed'); setTree({}); resetRootState(); }
    }
  }, [surfaceId, root, showHidden, resetRootState]);

  // Which expanded folders have already been asked for under the CURRENT tree
  // identity. Not a cache — `tree` is that — but a record of attempts, so a
  // folder that fails to list (deleted since it was expanded, or permission
  // denied) is asked for once per reload instead of being re-queued every time
  // some other fetch lands and gives `tree` a new identity.
  const requestedRef = useRef<{ key: string; paths: Set<string> }>({ key: '', paths: new Set() });

  // Drop everything derived from the old tree and ask for the root again.
  // Clearing the attempt record is part of it: a Refresh under an unchanged
  // key must be allowed to retry the very folders that just failed, which is
  // most of what the user is pressing the button for.
  // Refresh means "go and look again", so it drops this root's cache entry
  // first — otherwise the button could serve the user the very tree they are
  // asking to have re-read.
  const reloadTree = useCallback(() => {
    cacheRef.current = forgetTree(cacheRef.current, cacheKey);
    requestedRef.current = { key: '', paths: new Set() };
    liveRef.current = { tree: {}, resolvedRoot: null };
    setTree({});
    setError(null);
    resetRootState();
    if (surfaceId && root) void fetchDir('');
  }, [cacheKey, surfaceId, root, fetchDir, resetRootState]);

  // Re-root whenever the focused pane, its cwd, or the hidden filter changes.
  //
  // NOT a reload: seed from the per-root cache, then revalidate the root in the
  // background. A hit restores the loaded children AND the resolved root in one
  // commit, so the expansions persisted under that root are on screen
  // immediately with no child fetching at all — and a fetch that is never
  // issued cannot be dropped. Two panes sitting in the same directory share one
  // entry (the key is the cwd, not the surface), so switching between them is
  // now free rather than a full re-listing.
  useEffect(() => {
    setSelected(null);
    liveRef.current = recallTree(cacheRef.current, cacheKey) ?? { tree: {}, resolvedRoot: null };
    requestedRef.current = { key: '', paths: new Set() };
    setTree(liveRef.current.tree);
    setResolvedRoot(liveRef.current.resolvedRoot);
    setError(null);
    setOpenError(null);
    setTruncated(false);
    if (surfaceId && root) void fetchDir('');
  }, [surfaceId, root, cacheKey, fetchDir]);

  // `expanded` is PERSISTED per root and `tree` is not, so the two start out
  // disagreeing after every reload — and an expanded folder with no entry in
  // `tree` renders as an open chevron with nothing beneath it. Refresh made
  // that permanent: it cleared `tree`, re-fetched only the root, and left every
  // folder the user had opened looking empty until they collapsed and reopened
  // it by hand.
  //
  // So the fetching lives HERE, driven by the gap between the two, rather than
  // in the toggle handler. Expanding a folder writes `expanded` and this effect
  // notices; a reload clears `tree` and it notices that too. One rule, and the
  // two states cannot drift apart again.
  useEffect(() => {
    if (!surfaceId || !root) return;
    // Not until the ROOT has listed. Run in parallel with it, a child that
    // succeeds while the root fails takes fetchDir's success path, clears
    // `error`, and writes its entries under a tree that has no root — so a real
    // root failure (denied, deleted, a transient IPC error) is replaced on
    // screen by an empty tree that explains nothing. Children exist only
    // beneath a root that listed.
    if (!tree['']) return;
    const key = responseKey(surfaceId, root, String(showHidden));
    if (requestedRef.current.key !== key) requestedRef.current = { key, paths: new Set() };
    for (const relPath of nextRefillPaths(tree, expanded, requestedRef.current.paths)) {
      requestedRef.current.paths.add(relPath);
      void fetchDir(relPath);
    }
  }, [expanded, tree, surfaceId, root, showHidden, fetchDir]);

  const handleToggleDir = useCallback((relPath: string) => {
    if (!activeWorkspaceId) return;
    const next = toggleExpanded(expanded, relPath);
    // Re-opening a folder is a RETRY. The attempt record exists to stop the
    // effect re-queueing a failed listing every time `tree` changes identity,
    // not to make a failure permanent — and when the fetch lived in this
    // handler, clicking the folder again always tried again. Without this,
    // a folder that failed once (a network share that blinked, a transient
    // denial) stays empty until the whole tree is refreshed.
    if (next.includes(relPath)) requestedRef.current.paths.delete(relPath);
    const map = pruneExpanded({ ...expandedByRoot, [absRoot]: next }, absRoot, MAX_ROOTS);
    updateWorkspaceMetadata(activeWorkspaceId, { explorerExpanded: map });
  }, [activeWorkspaceId, expanded, expandedByRoot, absRoot, updateWorkspaceMetadata]);

  const rows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  // The tree's relPath is POSIX; the backing path the markdown surface saves
  // and reveals with must be a real Windows path — built from `absRoot`, never
  // from the reported cwd.
  const absolutePathOf = useCallback(
    (relPath: string) => toAbsolutePath(absRoot, relPath),
    [absRoot],
  );

  const handleActivate = useCallback((row: ExplorerRow, opts: { keep: boolean }) => {
    // No `focusedPaneId` bail: openInPreviewTab falls back to the workspace's
    // first pane when the id does not resolve, and dropping the click here
    // meant that recovery path could never run.
    if (!activeWorkspaceId || !absRoot) return;
    const absolute = absolutePathOf(row.relPath);
    setOpenError(null);
    void openInPreviewTab(
      activeWorkspaceId, focusedPaneId ?? ('' as PaneId), absolute, row.entry.name,
      // surfaceId + relPath are what a code read is addressed by — the panel is
      // the only place that holds both, and main will not accept an absolute
      // path from here.
      { ...opts, surfaceId: (surfaceId ?? undefined) as SurfaceId | undefined, relPath: row.relPath },
    ).then(setOpenError, () => setOpenError('read_failed'));
  }, [activeWorkspaceId, focusedPaneId, surfaceId, absRoot, absolutePathOf]);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: ExplorerRow } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((row: ExplorerRow, event: React.MouseEvent) => {
    setContextMenu({ x: event.clientX, y: event.clientY, row });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu(); };
    const handleMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) closeContextMenu();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [contextMenu, closeContextMenu]);

  const copyPath = useCallback((relPath: string) => {
    void window.wmux?.clipboard?.writeText?.(absolutePathOf(relPath));
  }, [absolutePathOf]);

  // Reveal / open-in-app go through the EXPLORER's own jailed channels, not
  // `markdown.*`: those are gated main-side on the markdown extension
  // whitelist, so every ordinary source file the tree offers came back
  // `unsupported_type` and the click did nothing at all. Main answers in
  // ExplorerErrorCode, and a refusal is shown under the tree rather than
  // discarded — a silently dropped shell action is indistinguishable from a
  // dead menu item.
  const runShellAction = useCallback((
    action: 'reveal' | 'openInApp',
    relPath: string,
  ) => {
    if (!surfaceId) { setOpenError('no_root'); return; }
    setOpenError(null);
    void window.wmux.explorer[action](surfaceId, relPath).then(
      (res: { code?: ExplorerErrorCode } | null) => {
        if (res && 'error' in res) setOpenError(res.code ?? 'read_failed');
      },
      () => setOpenError('read_failed'),
    );
  }, [surfaceId]);

  const rootLabel = absRoot ? (absRoot.split(/[\\/]/).filter(Boolean).pop() ?? absRoot) : '';

  return (
    <div className="explorer-panel">
      <div className="explorer-panel__header">
        <span className="explorer-panel__root" title={absRoot}>
          {rootLabel || t('explorer.title', 'Explorer')}
        </span>
        <button
          className="explorer-panel__action"
          title={t('explorer.refresh', 'Refresh')}
          onClick={reloadTree}
        >{'↻'}</button>
        <button
          className="explorer-panel__action"
          title={showHidden
            ? t('explorer.hideHidden', 'Hide hidden files')
            : t('explorer.showHidden', 'Show hidden files')}
          onClick={() => setShowHidden((v) => !v)}
        >{showHidden ? '◉' : '○'}</button>
        <button
          className="explorer-panel__action"
          title={t('explorer.close', 'Close explorer')}
          onClick={onClose}
        >{'×'}</button>
      </div>
      <div className="explorer-panel__body">
        {error && (
          <div className="explorer-panel__message">{t(explorerErrorKey(error), error)}</div>
        )}
        {!error && rows.length === 0 && !loading && (
          <div className="explorer-panel__message">{t('explorer.empty', 'This folder is empty')}</div>
        )}
        {!error && (
          <ExplorerTree
            rows={rows}
            selectedRelPath={selected}
            onToggleDir={handleToggleDir}
            onSelect={(row) => setSelected(row.relPath)}
            onActivate={handleActivate}
            onContextMenu={handleContextMenu}
          />
        )}
        {truncated && (
          <div className="explorer-panel__message">
            {t('explorer.truncated', 'Showing the first {count} entries')
              .replace('{count}', String(EXPLORER_MAX_ENTRIES))}
          </div>
        )}
        {/* A FAILED OPEN, not a failed listing: it sits under the tree and
            leaves the rows on screen, because the folder is still readable —
            it is one file that could not be shown. Blanking the panel the way
            `error` does would throw away the tree the user is browsing. */}
        {openError && (
          <div className="explorer-panel__message">
            {t(explorerErrorKey(openError), openError)}
          </div>
        )}
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="ctx-menu"
          role="menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
        >
          <div
            className="ctx-menu__item"
            role="menuitem"
            onClick={() => { copyPath(contextMenu.row.relPath); closeContextMenu(); }}
          >
            {t('explorer.copyPath', 'Copy path')}
          </div>
          {/* Enabled for EVERY entry — folders and binaries included. Reveal
              only selects the item in Explorer, and "open in the default app"
              is the one action that is MORE useful on a file wmux cannot
              render itself. `viewable` means "wmux can show this as text",
              which was never the right question for either. */}
          <div
            className="ctx-menu__item"
            role="menuitem"
            onClick={() => { runShellAction('reveal', contextMenu.row.relPath); closeContextMenu(); }}
          >
            {t('explorer.reveal', 'Reveal in File Explorer')}
          </div>
          <div
            className="ctx-menu__item"
            role="menuitem"
            onClick={() => { runShellAction('openInApp', contextMenu.row.relPath); closeContextMenu(); }}
          >
            {t('explorer.openInApp', 'Open in default app')}
          </div>
          {!contextMenu.row.entry.viewable && contextMenu.row.entry.kind === 'file' && (
            <div className="explorer-panel__ctx-hint">
              {t('explorer.notViewable', 'wmux can only open text files')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
