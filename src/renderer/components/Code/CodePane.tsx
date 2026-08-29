// ─── Code pane: a file view that can also edit ───────────────────────────────
// This file's header used to say read-only was a property of the component's
// SHAPE rather than a flag, because there was no editor here at all. That is no
// longer true, and it is rewritten rather than left to mislead.
//
// What replaced it is not a flag either, though. The pane has two modes and the
// mode is LOCAL state: entering edit is a user gesture, and nothing outside
// this component can put a pane into edit mode. So "am I editable" is still not
// a property some other feature can set by accident — it is a question only the
// user's click answers.
//
// Three things about the editing path are load-bearing:
//
//   • The editor is a plain <textarea>, not CodeMirror or Monaco. The renderer
//     bundle is already ~1.8 MB and an editor dependency roughly doubles it, to
//     serve "edit a thing or two in a file". If syntax-highlighted editing is
//     ever wanted, that is the moment to pay for it — not before.
//
//   • A textarea normalizes its value to LF. The CRLF a file arrived with is
//     restored main-side in code-file.ts, NOT here: the renderer would have to
//     guess, and main is already holding the file it is about to overwrite.
//
//   • Saving carries the mtime the buffer was READ at. The premise of the whole
//     feature is a user editing a file in a folder an agent is working in, so
//     "changed underneath me" is routine rather than exotic. A conflict is
//     surfaced and never resolved by picking a winner.
//
// The line-numbered view duplicates MarkdownSource's markup rather than sharing
// it. That is deliberate — it is ~25 lines of stateless JSX, and the
// alternative was opening a working surface that contains an editor. Extract
// only if a third consumer ever appears.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

  // ─── Editing state ─────────────────────────────────────────────────────────
  // `draft === null` IS the read-only mode. Not a boolean beside the text: two
  // fields that can disagree about whether there is an edit in progress is how
  // a pane ends up showing a Save button over a buffer it does not have.
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<ExplorerErrorCode | null>(null);
  const [saving, setSaving] = useState(false);
  // The mtime the CURRENT buffer was read at, and the whole basis of the
  // conflict check. A ref, not state: it is never rendered, and it must be
  // readable by the save handler without that handler being re-created (and
  // re-bound) on every keystroke.
  const mtimeRef = useRef<number | undefined>(undefined);

  const dirty = draft !== null && draft !== content;

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
    // No `void`: the two-argument `.then` below is the rejection handler.
    window.wmux.code.readFile(rootSurfaceId, relPath).then(
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
        // The basis of every subsequent conflict check. Recorded on the read
        // that produced the buffer, so a save compares against the state of the
        // file the user was actually looking at.
        mtimeRef.current = res.mtimeMs;
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

  // Write the buffer and the dirty flag into the store together.
  //
  // `markdownDirty` is the surface-wide "has unsaved edits" flag despite its
  // name — see SurfaceRef. Three things already read it: the tab's `•`, the
  // close confirmation, and open-preview's recycler, which refuses to reuse a
  // dirty preview tab for the next file. That last one is why setting it
  // matters more than it looks: without it, clicking another file in the tree
  // would silently reuse THIS pane and discard the edit in progress.
  const commit = useCallback((patch: { codeContent?: string; markdownDirty?: boolean }) => {
    const owner = findOwner(useStore.getState().workspaces, surfaceId);
    if (!owner) return;
    updateSurface(owner.workspaceId, owner.paneId, surfaceId, patch);
  }, [surfaceId, updateSurface]);

  useEffect(() => { commit({ markdownDirty: dirty }); }, [dirty, commit]);

  // A file swapped in underneath this pane (the preview recycler writes
  // `codeContent` straight into the store without remounting) must drop any
  // edit mode along with it — otherwise the textarea would go on showing the
  // previous file's draft over the new file's path, and Ctrl+S would write one
  // into the other. Keyed on the PATH, not the content: an identical save
  // should not kick the user out of edit mode.
  useEffect(() => {
    setDraft(null);
    setSaveError(null);
  }, [filePath]);

  const save = useCallback(async () => {
    if (draft === null || !relPath || !rootSurfaceId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res: any = await window.wmux.code.writeFile(
        rootSurfaceId, relPath, draft, mtimeRef.current,
      );
      setSaving(false);
      if (!res) { setSaveError('write_failed'); return; }
      if ('error' in res) { setSaveError(res.code as ExplorerErrorCode); return; }
      // The write succeeded, so the buffer IS the file now: adopt the new mtime
      // (or the next save conflicts with this one), and make the saved text the
      // baseline `dirty` compares against.
      mtimeRef.current = res.mtimeMs;
      commit({ codeContent: draft, markdownDirty: false });
      setDraft(null);
    } catch {
      setSaving(false);
      setSaveError('write_failed');
    }
  }, [draft, relPath, rootSurfaceId, commit]);

  /** Re-read from disk, discarding the draft. The only exit from a conflict. */
  const reload = useCallback(() => {
    setDraft(null);
    setSaveError(null);
    // Clearing the content is what re-arms the read effect above — it returns
    // early whenever content is already present.
    commit({ codeContent: undefined, markdownDirty: false });
  }, [commit]);

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
        {dirty && <span className="code-pane__dirty">{t('code.unsaved', 'Unsaved changes')}</span>}
        {draft === null ? (
          <button
            className="code-pane__action"
            title={t('code.readOnlyHint', 'Read-only — click Edit to make changes')}
            onClick={() => { setDraft(content); setSaveError(null); }}
          >
            {t('code.edit', 'Edit this file')}
          </button>
        ) : (
          <>
            <button
              className="code-pane__action code-pane__action--primary"
              disabled={!dirty || saving}
              title={t('code.save', 'Save (Ctrl+S)')}
              onClick={() => { save().catch(() => setSaveError('write_failed')); }}
            >
              {saving ? '…' : t('code.save', 'Save (Ctrl+S)')}
            </button>
            <button
              className="code-pane__action"
              title={t('code.revert', 'Discard changes')}
              onClick={() => { setDraft(null); setSaveError(null); }}
            >
              {t('code.revert', 'Discard changes')}
            </button>
          </>
        )}
        <button
          className="code-pane__copy"
          onClick={() => {
            // Optional all the way down, so this can be `undefined` rather than
            // a promise — hence `?.catch`.
            window.wmux?.clipboard?.writeText?.(filePath)?.catch(() => { /* ignore */ });
          }}
        >
          {t('explorer.copyPath', 'Copy path')}
        </button>
      </div>
      {saveError && (
        // A conflict is the one save failure with an action attached, and the
        // action is destructive in one direction only: reloading discards the
        // user's draft, so it is offered as a button and never taken
        // automatically. wmux does not get to decide whose edit survives.
        <div className="code-pane__status code-pane__status--error">
          <span>{t(codeErrorKey(saveError), 'Could not save that file')}</span>
          {saveError === 'conflict' && (
            <>
              <span className="code-pane__status-detail">
                {t('code.conflictBody',
                  'Someone else changed this file while you were editing it. Reloading discards your edits.')}
              </span>
              <button className="code-pane__action" onClick={reload}>
                {t('code.reload', 'Reload from disk')}
              </button>
            </>
          )}
        </div>
      )}
      {/* __body owns the scrolling, not .code-pane — otherwise the toolbar
          scrolls away with the file, which is the mistake markdown.css's header
          records having already made once. */}
      <div className="code-pane__body">
        {draft !== null ? (
          <textarea
            className="code-pane__editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            // No line-number gutter in edit mode, deliberately. Keeping the
            // numbers aligned against a textarea means matching its font
            // metrics, padding, scroll position and soft-wrapping exactly, and
            // any drift shows up as numbers that point at the wrong lines —
            // worse than no numbers at all. `wrap="off"` at least keeps one
            // logical line on one visual row.
            wrap="off"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                // Ctrl+S is a browser "save page" shortcut in Electron too.
                e.preventDefault();
                e.stopPropagation();
                save().catch(() => setSaveError('write_failed'));
                return;
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                setDraft(null);
                setSaveError(null);
                return;
              }
              // Tab indents instead of leaving the field. In a pane whose whole
              // purpose is editing source, tabbing out is never what was meant
              // — and the pane is reachable by click and by the tree's own
              // keyboard navigation, so this does not strand keyboard users.
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: from, selectionEnd: to, value } = el;
                const next = value.slice(0, from) + '\t' + value.slice(to);
                setDraft(next);
                // React re-renders from state, which resets the caret to the
                // end; put it back after the commit or every Tab jumps the
                // cursor to the bottom of the file.
                requestAnimationFrame(() => {
                  el.selectionStart = el.selectionEnd = from + 1;
                });
              }
            }}
          />
        ) : (
        <>
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
        </>
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
