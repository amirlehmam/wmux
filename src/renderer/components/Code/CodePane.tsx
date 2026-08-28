// ─── Code viewer pane ────────────────────────────────────────────────────────
// Read-only by construction: there is no editor here and no view-mode toggle,
// so "read-only" is a property of this component's shape rather than a flag
// some future feature has to remember to honour.
//
// The line-numbered view duplicates MarkdownSource's markup rather than sharing
// it. That is deliberate — it is ~25 lines of stateless JSX, and the
// alternative was opening a working surface that contains an editor. Extract
// only if a third consumer ever appears.

import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { SOURCE_VIRTUALIZE_THRESHOLD } from '../Markdown/markdown-utils';
import { codeErrorKey } from '../Explorer/explorer-errors';
import type {
  ExplorerErrorCode, PaneId, SplitNode, SurfaceId, SurfaceRef, WorkspaceId,
} from '../../../shared/types';
import '../../styles/code.css';

export function CodePane({ surfaceId }: { surfaceId: SurfaceId }): React.JSX.Element | null {
  const t = useT();
  // Selecting the SurfaceRef itself, not a derived object: the ref is a stable
  // identity inside the immutable split tree, so this re-renders exactly when
  // the surface actually changes. Returning a fresh `{...}` here would make
  // every unrelated store write look like a change to this pane.
  const surface = useStore((s) => {
    for (const ws of s.workspaces) {
      const found = findSurface(ws.splitTree, surfaceId);
      if (found) return found;
    }
    return null;
  });
  const updateSurface = useStore((s) => s.updateSurface);

  const relPath = surface?.codeRelPath ?? null;
  // The TERMINAL whose root this file lives under — never this surface's own
  // id. Main reads only for a live, owned terminal surface, and a code surface
  // has neither a PTY nor a reported cwd, so reading with `surfaceId` here
  // answered `no_root` every time and every restored tab came back blank.
  const rootSurfaceId = surface?.codeRootSurfaceId ?? null;
  // Whether main can be expected to HAVE a root for that terminal yet.
  //
  // The explorer root map in main is fed by report_pwd, i.e. by the shell's
  // first prompt — and on a restore this pane mounts long before a freshly
  // spawned shell gets there. Reading immediately answers `no_root`, and the
  // effect below has no retry, so the tab would sit on an error forever for
  // no reason other than being early. `currentCwd` is set from that same
  // report, so it IS the readiness signal: absent, wait; present, read. The
  // effect re-runs on its own when it lands.
  const rootCwd = useStore((s) => {
    if (!rootSurfaceId) return null;
    for (const ws of s.workspaces) {
      const found = findSurface(ws.splitTree, rootSurfaceId);
      if (found) return found.currentCwd ?? null;
    }
    return null;
  });
  const filePath = surface?.codeFilePath ?? '';
  const content = surface?.codeContent;
  const [error, setError] = useState<ExplorerErrorCode | null>(null);
  const [loading, setLoading] = useState(false);

  // Re-read on mount and whenever the backing file changes. The buffer is not
  // persisted (see SurfaceRef.codeContent), so a restored surface arrives here
  // with a path and no content and this effect is what fills it — which is also
  // why a file deleted since the last session shows not_found rather than a
  // stale ghost of itself.
  useEffect(() => {
    // Content already present, so there is nothing to read — but the error from
    // a PREVIOUS file must not outlive it. open-preview.ts writes `codeContent`
    // straight into the store when it recycles this pane's preview tab, and
    // this component is not remounted for that, so this effect is the only
    // thing that ever clears `error` — and it used to return before doing so.
    // A tab that had failed (binary, too large, deleted) then went on showing
    // that failure over the next file's perfectly good content, because the
    // render checks `error` before it checks `content`.
    if (content !== undefined) { setError(null); return; }
    if (!relPath || !rootSurfaceId) { setError('invalid_path'); return; }
    if (!rootCwd) return;                   // root not reported yet — see above
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.wmux.code.readFile(rootSurfaceId, relPath).then(
      (res: any) => {
        if (cancelled) return;
        setLoading(false);
        if (!res) { setError('read_failed'); return; }
        if ('error' in res) { setError(res.code as ExplorerErrorCode); return; }
        // The relPath is resolved under the terminal's root AS IT IS NOW, and
        // that root moves: the shell may have cd'd since this tab was opened,
        // or been restored somewhere else. Then the same relPath names a
        // DIFFERENT file, and the pane would show it under the old tab label
        // and the old path in its toolbar. Compare against the absolute path
        // this surface was opened with and refuse the mismatch — a tab whose
        // file is no longer reachable is `not_found`, not silently something
        // else. Case-insensitive: Windows spells one file many ways.
        if (filePath && !samePath(res.filePath, filePath)) {
          setError('not_found');
          return;
        }
        updateSurfaceContent(res.content);
      },
      () => { if (!cancelled) { setLoading(false); setError('read_failed'); } },
    );
    return () => { cancelled = true; };

    function updateSurfaceContent(text: string) {
      // Re-resolved from the LIVE state rather than closed over: the surface
      // may have been dragged to another pane while the read was in flight,
      // and updateSurface addresses a surface by (workspace, pane, surface).
      const owner = findOwner(useStore.getState().workspaces, surfaceId);
      if (!owner) return;
      updateSurface(owner.workspaceId, owner.paneId, surfaceId, { codeContent: text });
    }
  }, [surfaceId, rootSurfaceId, rootCwd, relPath, filePath, content, updateSurface]);

  const lines = useMemo(() => (content ?? '').split('\n'), [content]);

  // Render nothing while loading rather than a spinner: the explorer panel
  // makes the same choice, and a read of a local file is fast enough that a
  // flash of "Loading…" is worse than a blank frame.
  if (loading) return null;
  if (error) {
    return (
      <div className="code-pane">
        <div className="code-pane__status code-pane__status--error">
          {t(codeErrorKey(error), 'Could not read that file')}
        </div>
      </div>
    );
  }
  if (content === undefined) return null;

  return (
    <div className="code-pane">
      <div className="code-pane__toolbar" title={filePath}>
        <span className="code-pane__path">{filePath}</span>
        <button
          className="code-pane__copy"
          onClick={() => void window.wmux?.clipboard?.writeText?.(filePath)}
        >
          {t('explorer.copyPath', 'Copy path')}
        </button>
      </div>
      {/* __body owns the scrolling, not .code-pane — otherwise the toolbar
          scrolls away with the file, which is the mistake markdown.css's header
          records having already made once. */}
      <div className="code-pane__body">
        {/* One <div> per line is fine for normal files but janks badly on a very
            large one, so past the threshold the gutter is dropped for a single
            <pre> rather than taking on a virtualization dependency — the same
            trade MarkdownSource makes, for the same reason. */}
        {lines.length > SOURCE_VIRTUALIZE_THRESHOLD ? (
          <pre className="code-pane__source code-pane__source--plain">{content}</pre>
        ) : (
          <div className="code-pane__source">
            {lines.map((line, index) => (
              <div className="code-pane__line" key={`line-${index}`}>
                {/* The gutter is user-select:none in CSS, so dragging across
                    lines yields the code without the numbers mixed in. */}
                <span className="code-pane__gutter">{index + 1}</span>
                <span className="code-pane__text">{line || ' '}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Windows spells one file many ways — casing, and separators the two sides of
 * this comparison did not necessarily build the same way. Neither side is a
 * security decision here: this is an integrity check on a path main itself
 * returned, so a normalizing compare is exactly right.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.split(/[\\/]+/).filter(Boolean).join('\\').toLowerCase();
  return norm(a) === norm(b);
}

// ─── Tree lookups ────────────────────────────────────────────────────────────
// split-utils exports findLeaf (by paneId) and getAllPaneIds, neither of which
// answers "which surface/pane/workspace is this surfaceId in?". These two do,
// and they live here rather than in split-utils because this is their only
// caller — moving them there when a second one appears is the cheaper direction.

function findSurface(tree: SplitNode, surfaceId: SurfaceId): SurfaceRef | null {
  if (tree.type === 'leaf') {
    return tree.surfaces.find((s) => s.id === surfaceId) ?? null;
  }
  return findSurface(tree.children[0], surfaceId) ?? findSurface(tree.children[1], surfaceId);
}

function findPane(tree: SplitNode, surfaceId: SurfaceId): PaneId | null {
  if (tree.type === 'leaf') {
    return tree.surfaces.some((s) => s.id === surfaceId) ? tree.paneId : null;
  }
  return findPane(tree.children[0], surfaceId) ?? findPane(tree.children[1], surfaceId);
}

function findOwner(
  workspaces: { id: WorkspaceId; splitTree: SplitNode }[],
  surfaceId: SurfaceId,
): { workspaceId: WorkspaceId; paneId: PaneId } | null {
  for (const ws of workspaces) {
    const paneId = findPane(ws.splitTree, surfaceId);
    if (paneId) return { workspaceId: ws.id, paneId };
  }
  return null;
}

export default CodePane;
