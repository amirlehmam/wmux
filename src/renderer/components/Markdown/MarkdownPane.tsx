import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { openInWmuxBrowser } from '../../utils/open-in-browser';
import { useT, type TranslationKey } from '../../i18n';
import {
  SOURCE_VIRTUALIZE_THRESHOLD,
  continueList,
  insertIndent,
  middleEllipsize,
  toDisplayPath,
  toRelativePath,
} from './markdown-utils';
import '../../styles/markdown.css';

export type MarkdownViewMode = 'preview' | 'source';

interface MarkdownPaneProps {
  content?: string;
  surfaceId: string;
  /** Absolute path of the backing file, when the surface came from one (#116). */
  filePath?: string;
  /** Persisted preview/source mode; defaults to preview. */
  viewMode?: MarkdownViewMode;
  /** Workspace cwd — the path chip shows paths inside it as relative, and is
   *  where Save As opens for a surface with no backing file. */
  cwd?: string;
  /** mtime at last load/save — compared before overwriting (F3). */
  fileMtime?: number;
  /** Buffer differs from disk (F3). */
  dirty?: boolean;
  onViewModeChange?: (mode: MarkdownViewMode) => void;
  /** Reload-from-disk and drag-and-drop both replace the surface's content. */
  onFileLoaded?: (file: { content: string; filePath: string; fileName: string; mtimeMs: number }) => void;
  /** An edit in the textarea — content changed, buffer now differs from disk. */
  onEdit?: (content: string) => void;
  /** A successful write — records the new mtime and clears the dirty flag. */
  onSaved?: (file: { filePath: string; fileName: string; mtimeMs: number }) => void;
}

// A dedicated Marked instance rather than the global `marked` + setOptions():
// the global is shared by every pane in the window, so configuring it during
// render meant each pane kept reconfiguring state the others were using. This
// instance is module-scoped (the config is identical everywhere) and built once.
const md = new Marked({ gfm: true, breaks: true });

// GFM task lists rendered as glyphs instead of <input type="checkbox">.
// The sanitizer forbids `input` outright — relaxing that to admit checkboxes
// would also admit every other input type from untrusted markdown, so the
// cheaper trade is to never emit the tag. Previously these rendered as bare
// bullets, and markdown.css styled a checkbox that could never exist.
md.use({
  renderer: {
    checkbox({ checked }: { checked: boolean }) {
      return checked
        ? '<span class="markdown-pane__task markdown-pane__task--done">☑</span> '
        : '<span class="markdown-pane__task">☐</span> ';
    },
  },
});

const COPIED_FEEDBACK_MS = 1200;

/** Panes narrower than this drop the toolbar button labels and go icon-only. */
const COMPACT_TOOLBAR_PX = 420;

const basenameOf = (p: string) => p.replace(/\\/g, '/').split('/').pop() || 'Markdown';

// The main process has no access to the renderer's i18n system, so its IPC
// error responses carry a stable `code` alongside the (always-English) `error`
// string — main-process callers (the CLI, agent pipe responses) still print
// `error` verbatim, while the renderer maps `code` to a translated message.
const MARKDOWN_ERROR_KEY: Record<string, TranslationKey> = {
  no_path: 'markdown.error.noPath',
  unsupported_type: 'markdown.error.unsupportedType',
  not_found: 'markdown.error.notFound',
  symlink: 'markdown.error.symlink',
  not_regular_file: 'markdown.error.notRegularFile',
  too_large: 'markdown.error.tooLarge',
  no_content: 'markdown.error.noContent',
  not_granted: 'markdown.error.notGranted',
  action_failed: 'markdown.error.action',
};

/** Translated message for a `{ error, code }` IPC result, falling back to the
 *  raw (English) error, then to `fallbackKey`, when `code` is missing/unknown. */
function markdownErrorMessage(
  res: { error?: string; code?: string } | null | undefined,
  t: (key: TranslationKey, fallback?: string) => string,
  fallbackKey: TranslationKey,
  fallbackText: string,
): string {
  const key = res?.code ? MARKDOWN_ERROR_KEY[res.code] : undefined;
  if (key) return t(key, res!.error);
  return res?.error || t(fallbackKey, fallbackText);
}

// ─── Source view ──────────────────────────────────────────────────────────────

function MarkdownSource({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n'), [content]);

  // One <div> per line is fine for normal documents but janks badly near the
  // 5 MB read cap (~100k lines), so past the threshold we drop the gutter for a
  // single <pre> rather than take on a virtualization dependency.
  if (lines.length > SOURCE_VIRTUALIZE_THRESHOLD) {
    return <pre className="markdown-pane__source markdown-pane__source--plain">{content}</pre>;
  }

  return (
    <div className="markdown-pane__source">
      {lines.map((line, index) => (
        <div className="markdown-pane__source-line" key={`line-${index}`}>
          {/* The gutter is user-select:none in CSS, so dragging across lines
              yields the text without the numbers mixed into the selection. */}
          <span className="markdown-pane__source-gutter">{index + 1}</span>
          <span className="markdown-pane__source-text">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Editor (F3) ──────────────────────────────────────────────────────────────

/**
 * A plain <textarea>, deliberately: CodeMirror/Monaco would add 1–3 MB to the
 * bundle for a surface whose job is "fix a typo, add a bullet". Tab indents
 * instead of moving focus, and Enter continues list/quote prefixes — the two
 * things whose absence makes a bare textarea feel broken for markdown.
 */
function MarkdownEditor({
  content,
  onChange,
  onSave,
}: {
  content: string;
  onChange: (next: string) => void;
  onSave: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const apply = useCallback(
    (result: { content: string; selectionStart: number; selectionEnd: number }) => {
      onChange(result.content);
      // The caret has to be restored after React re-renders with the new value,
      // or the textarea puts it at the end of the document on every keystroke.
      requestAnimationFrame(() => {
        ref.current?.setSelectionRange(result.selectionStart, result.selectionEnd);
      });
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      // Ctrl+S is handled here rather than as a global shortcut: bare-Ctrl combos
      // are deliberately not intercepted globally so the terminal keeps XOFF.
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        onSave();
        return;
      }
      if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        apply(insertIndent(target.value, target.selectionStart, target.selectionEnd));
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (target.selectionStart !== target.selectionEnd) return;
        const continued = continueList(target.value, target.selectionStart);
        if (!continued) return;
        event.preventDefault();
        apply(continued);
      }
    },
    [apply, onSave],
  );

  return (
    <textarea
      ref={ref}
      className="markdown-pane__editor"
      value={content}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={handleKeyDown}
    />
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

interface MenuItem {
  key: string;
  label: string;
  enabled: boolean;
  run: () => void | Promise<unknown>;
}

/** The overflow menu: everything that acts on the backing file, plus revert. */
function OverflowMenu({
  items,
  onActionFailed,
  label,
}: {
  items: MenuItem[];
  onActionFailed: () => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.('.markdown-pane__menu-wrap')) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const run = (action: () => void | Promise<unknown>) => () => {
    setOpen(false);
    const pending = action();
    if (pending instanceof Promise) pending.catch(onActionFailed);
  };

  return (
    <div className="markdown-pane__menu-wrap">
      <button
        type="button"
        className="markdown-pane__btn markdown-pane__btn--icon"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && (
        <div className="markdown-pane__menu" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={!item.enabled}
              onClick={run(item.run)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ToolbarProps {
  filePath?: string;
  displayPath: string;
  relativePath: string | null;
  viewMode: MarkdownViewMode;
  editing: boolean;
  dirty: boolean;
  compact: boolean;
  copied: 'doc' | 'path' | null;
  hasContent: boolean;
  onViewModeChange?: (mode: MarkdownViewMode) => void;
  onToggleEditing: () => void;
  onSave: () => void;
  onCopyDocument: () => void;
  onCopyText: (text: string) => Promise<void> | void;
  onReload: (path: string) => Promise<void> | void;
  onReveal: (path: string) => Promise<void> | void;
  onOpenInApp: (path: string) => Promise<void> | void;
  onRevert: () => void;
  onActionFailed: () => void;
}

// Typed against the English dictionary, not `string`: an `any` key here would
// silently exempt every label in this table from the compile-time check that
// PR #120 exists to provide.
type Translate = (key: TranslationKey, fallback?: string) => string;

/** Path-dependent actions stay listed without a path, just disabled — a
 *  pathless surface is a first-class state (agent-pushed content), not an
 *  error, so the menu should not change shape underneath the user. */
function menuItems(props: ToolbarProps, t: Translate): MenuItem[] {
  const { filePath, relativePath, dirty, onCopyText, onReload, onReveal, onOpenInApp, onRevert } = props;
  const hasPath = !!filePath;
  return [
    { key: 'copyPath', label: t('markdown.copyPath', 'Copy file path'), enabled: hasPath, run: () => onCopyText(filePath!) },
    { key: 'copyRel', label: t('markdown.copyRelativePath', 'Copy relative path'), enabled: !!relativePath, run: () => onCopyText(relativePath!) },
    { key: 'reload', label: t('markdown.reload', 'Reload from disk'), enabled: hasPath, run: () => onReload(filePath!) },
    { key: 'revert', label: t('markdown.revert', 'Discard changes'), enabled: hasPath && dirty, run: onRevert },
    { key: 'reveal', label: t('markdown.reveal', 'Reveal in File Explorer'), enabled: hasPath, run: () => onReveal(filePath!) },
    { key: 'openInApp', label: t('markdown.openInApp', 'Open in default app'), enabled: hasPath, run: () => onOpenInApp(filePath!) },
  ];
}

/** Shows where the content came from, `•` when unsaved, and copies the full
 *  path on click. */
function PathChip({ filePath, displayPath, dirty, compact, copied, onCopyText }: ToolbarProps) {
  const t = useT();
  const dirtyMark = dirty ? '• ' : '';

  if (!filePath) {
    return (
      <span className="markdown-pane__path markdown-pane__path--none">
        {dirtyMark}{t('markdown.noFile', 'Not backed by a file')}
      </span>
    );
  }

  let label = dirtyMark + middleEllipsize(displayPath, compact ? 28 : 60);
  if (copied === 'path') label = t('markdown.copiedPath', 'Path copied');

  return (
    <button
      type="button"
      className={`markdown-pane__path${dirty ? ' markdown-pane__path--dirty' : ''}`}
      title={`${filePath}\n${t('markdown.copyPathHint', 'Click to copy the full path')}`}
      onClick={() => { void onCopyText(filePath); }}
    >
      {label}
    </button>
  );
}

function MarkdownToolbar(props: ToolbarProps) {
  const {
    viewMode, editing, compact, copied, hasContent,
    onViewModeChange, onToggleEditing, onSave, onCopyDocument, onActionFailed,
  } = props;
  const t = useT();

  const segment = (active: boolean, onClick: () => void, glyph: string, label: string) => (
    <button
      type="button"
      className={`markdown-pane__segment${active ? ' markdown-pane__segment--active' : ''}`}
      onClick={onClick}
      title={label}
    >
      {compact ? glyph : label}
    </button>
  );

  return (
    <div className={`markdown-pane__toolbar${compact ? ' markdown-pane__toolbar--compact' : ''}`}>
      <PathChip {...props} />

      <div className="markdown-pane__actions">
        <div className="markdown-pane__segmented" role="group">
          {segment(viewMode === 'preview' && !editing, () => onViewModeChange?.('preview'), '¶', t('markdown.preview', 'Preview'))}
          {segment(viewMode === 'source' && !editing, () => onViewModeChange?.('source'), '</>', t('markdown.source', 'Source'))}
          {segment(editing, onToggleEditing, '✎', t('markdown.edit', 'Edit'))}
        </div>

        {editing && (
          <button
            type="button"
            className="markdown-pane__btn markdown-pane__btn--primary"
            onClick={onSave}
            title={t('markdown.saveHint', 'Write the buffer back to the file (Ctrl+S)')}
          >
            {t('markdown.save', 'Save')}
          </button>
        )}

        <button
          type="button"
          className="markdown-pane__btn"
          onClick={onCopyDocument}
          disabled={!hasContent}
          title={t('markdown.copyDocument', 'Copy the raw markdown')}
        >
          {copied === 'doc' ? t('markdown.copied', 'Copied') : t('markdown.copy', 'Copy')}
        </button>

        <OverflowMenu
          items={menuItems(props, t)}
          onActionFailed={onActionFailed}
          label={t('markdown.moreActions', 'More actions')}
        />
      </div>
    </div>
  );
}


// ─── Pane ─────────────────────────────────────────────────────────────────────

export default function MarkdownPane({
  content = '',
  surfaceId,
  filePath,
  viewMode = 'preview',
  cwd,
  fileMtime,
  dirty = false,
  onViewModeChange,
  onFileLoaded,
  onEdit,
  onSaved,
}: MarkdownPaneProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<'doc' | 'path' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const [editing, setEditing] = useState(false);
  // Set when the file moved under us. Blocks an in-place save until the user
  // says which side wins — see the banner below.
  const [conflict, setConflict] = useState(false);

  const html = useMemo(() => {
    if (!content) return '';

    // Markdown can arrive from untrusted sources (CLI/pipe callers, agents,
    // loaded files). marked emits raw HTML, so sanitize before injecting it
    // via dangerouslySetInnerHTML to prevent XSS in the renderer (which has
    // preload/IPC access). FORBID javascript: URIs and event handlers.
    const rawHtml = md.parse(content) as string;
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
      FORBID_ATTR: ['style'],
    });
  }, [content]);

  const displayPath = useMemo(
    () => (filePath ? toDisplayPath(filePath, { cwd, homeDir: window.wmux?.system?.homeDir }) : ''),
    [filePath, cwd],
  );

  // ─── Transient feedback ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // ─── Clipboard ──────────────────────────────────────────────────────────────

  // window.wmux.clipboard over navigator.clipboard: no user-gesture requirement
  // and correct handling of Windows clipboard payloads (see useTerminal.ts).
  const writeClipboard = useCallback(async (text: string, kind: 'doc' | 'path') => {
    if (!text) return;
    try {
      await window.wmux?.clipboard?.writeText?.(text);
      setCopied(kind);
    } catch {
      setError(t('markdown.error.copy', 'Could not write to the clipboard'));
    }
  }, [t]);

  const copyPath = useCallback((text: string) => writeClipboard(text, 'path'), [writeClipboard]);

  const copyDocument = useCallback(() => {
    // In source view a selection is line-accurate and almost certainly what the
    // user meant; in preview it would yield rendered text with the markdown
    // syntax stripped, which is the thing this button exists to avoid.
    if (viewMode === 'source' && !editing) {
      const selection = window.getSelection?.();
      const selected = selection?.toString() ?? '';
      const insidePane = !!selection?.anchorNode && !!rootRef.current?.contains(selection.anchorNode);
      if (selected && insidePane) {
        void writeClipboard(selected, 'doc');
        return;
      }
    }
    void writeClipboard(content, 'doc');
  }, [content, viewMode, editing, writeClipboard]);

  // ─── Per-code-block copy buttons ────────────────────────────────────────────

  // Depended on as plain strings below rather than calling `t` inside the
  // effect: useT returns a fresh closure every render, so a `t` dependency
  // would re-run this DOM walk on every state change instead of when the
  // rendered HTML actually changes.
  const copyLabel = t('markdown.copy', 'Copy');
  const copyBlockLabel = t('markdown.copyBlock', 'Copy this code block');

  useEffect(() => {
    if (viewMode !== 'preview' || editing) return;
    const host = contentRef.current;
    if (!host) return;

    // Injected *after* sanitization on purpose: FORBID_TAGS includes `button`,
    // so anything added before DOMPurify runs would be stripped. Clicks are
    // handled by delegation on the container (see handleContentClick) because
    // the HTML comes from dangerouslySetInnerHTML — there are no React nodes to
    // attach a handler to.
    host.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.markdown-pane__code-copy')) return;
      if (!pre.querySelector('code')) return;
      pre.classList.add('markdown-pane__code-block');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'markdown-pane__code-copy';
      btn.dataset.mdCopy = '';
      btn.textContent = copyLabel;
      btn.title = copyBlockLabel;
      pre.appendChild(btn);
    });
  }, [html, viewMode, editing, copyLabel, copyBlockLabel]);

  const handleContentClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;

    const copyBtn = target?.closest?.('[data-md-copy]') as HTMLElement | null;
    if (copyBtn) {
      event.preventDefault();
      const code = copyBtn.parentElement?.querySelector('code');
      if (code) void writeClipboard(code.textContent ?? '', 'doc');
      return;
    }

    const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
    if (!anchor?.href) return;
    event.preventDefault();
    openInWmuxBrowser(anchor.href, { forceExternal: event.ctrlKey || event.metaKey });
  }, [writeClipboard]);

  // ─── File actions ───────────────────────────────────────────────────────────

  const loadFromDisk = useCallback(async (path: string) => {
    const res = await window.wmux?.markdown?.readFile?.(path);
    if (!res || res.error || typeof res.content !== 'string') {
      setError(markdownErrorMessage(res, t, 'markdown.error.read', 'Could not read the file'));
      return;
    }
    setConflict(false);
    onFileLoaded?.({
      content: res.content,
      filePath: res.filePath,
      fileName: basenameOf(res.filePath),
      mtimeMs: res.mtimeMs,
    });
  }, [onFileLoaded, t]);

  // Both shell actions are rejected by the main process when the path falls
  // outside the extension whitelist, so surface that rather than dropping it.
  const revealFile = useCallback(async (path: string) => {
    const res = await window.wmux?.markdown?.reveal?.(path);
    if (res?.error) setError(markdownErrorMessage(res, t, 'markdown.error.action', 'The action failed'));
  }, [t]);

  const openFileInApp = useCallback(async (path: string) => {
    const res = await window.wmux?.markdown?.openInApp?.(path);
    if (res?.error) setError(markdownErrorMessage(res, t, 'markdown.error.action', 'The action failed'));
  }, [t]);

  // ─── Save (F3) ──────────────────────────────────────────────────────────────

  const saveAs = useCallback(async () => {
    const suggested = filePath ? basenameOf(filePath) : 'untitled.md';
    const res = await window.wmux?.markdown?.saveAs?.(content, suggested, cwd);
    if (!res || res.canceled) return;
    if (res.error || !res.filePath) {
      setError(markdownErrorMessage(res, t, 'markdown.error.save', 'Could not save the file'));
      return;
    }
    setConflict(false);
    onSaved?.({ filePath: res.filePath, fileName: basenameOf(res.filePath), mtimeMs: res.mtimeMs });
  }, [content, cwd, filePath, onSaved, t]);

  /**
   * Write in place. `force` skips the mtime check, and is only reachable from
   * the conflict banner's explicit "Overwrite" — a save that silently wins a
   * race it did not know it was in is exactly what the check exists to prevent.
   */
  const saveInPlace = useCallback(async (force = false) => {
    if (!filePath) { await saveAs(); return; }
    const res = await window.wmux?.markdown?.saveFile?.(
      filePath,
      content,
      force ? undefined : fileMtime,
    );
    if (res?.conflict) {
      setConflict(true);
      setError(t('markdown.error.conflict', 'The file changed on disk — nothing was written'));
      return;
    }
    if (!res || res.error) {
      setError(markdownErrorMessage(res, t, 'markdown.error.save', 'Could not save the file'));
      return;
    }
    setConflict(false);
    onSaved?.({ filePath, fileName: basenameOf(filePath), mtimeMs: res.mtimeMs });
  }, [content, filePath, fileMtime, onSaved, saveAs, t]);

  const save = useCallback(() => { void saveInPlace(false); }, [saveInPlace]);

  // Out-of-band change detection: re-stat on focus rather than running an fs
  // watcher per pane. It needs no watcher lifecycle and covers the realistic
  // case — an agent rewrote the file while the user was in another pane.
  useEffect(() => {
    if (!filePath || fileMtime === undefined) return;
    const check = async () => {
      const res = await window.wmux?.markdown?.statFile?.(filePath);
      if (res && !res.error && res.mtimeMs !== fileMtime) setConflict(true);
    };
    void check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [filePath, fileMtime]);

  const handleEdit = useCallback((next: string) => {
    setError(null);
    onEdit?.(next);
  }, [onEdit]);

  const handleToggleEditing = useCallback(() => {
    setEditing((was) => {
      // Editing IS source view plus an editable buffer, so entering it from
      // preview switches the mode too — "Preview → Source → Editing".
      if (!was) onViewModeChange?.('source');
      return !was;
    });
  }, [onViewModeChange]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    // The browser's default drop action navigates the window to file:///…,
    // which would unload the whole app — the same reason useTerminal
    // preventDefaults both dragover and drop (issue #33).
    event.preventDefault();
    event.stopPropagation();
    const path = window.wmux?.shell?.getPathForFile?.(files[0]);
    if (path) void loadFromDisk(path);
  }, [loadFromDisk]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer?.types?.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  // ─── Layout ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    const host = rootRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < COMPACT_TOOLBAR_PX);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const onActionFailed = useCallback(
    () => setError(t('markdown.error.action', 'The action failed')),
    [t],
  );

  return (
    <div
      className="markdown-pane"
      data-surface-id={surfaceId}
      ref={rootRef}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <MarkdownToolbar
        filePath={filePath}
        displayPath={displayPath}
        relativePath={filePath ? toRelativePath(filePath, cwd) : null}
        viewMode={viewMode}
        editing={editing}
        dirty={dirty}
        compact={compact}
        copied={copied}
        hasContent={!!content}
        onViewModeChange={(mode) => { setEditing(false); onViewModeChange?.(mode); }}
        onToggleEditing={handleToggleEditing}
        onSave={save}
        onCopyDocument={copyDocument}
        onCopyText={copyPath}
        onReload={loadFromDisk}
        onReveal={revealFile}
        onOpenInApp={openFileInApp}
        onRevert={() => { if (filePath) void loadFromDisk(filePath); }}
        onActionFailed={onActionFailed}
      />

      {conflict && (
        <div className="markdown-pane__conflict">
          <span>{t('markdown.conflict', 'This file changed on disk since it was loaded.')}</span>
          <button type="button" onClick={() => { if (filePath) void loadFromDisk(filePath); }}>
            {dirty
              ? t('markdown.conflict.reload', 'Reload and lose my edits')
              : t('markdown.reload', 'Reload from disk')}
          </button>
          {dirty && (
            <>
              <button type="button" onClick={() => { void saveInPlace(true); }}>
                {t('markdown.conflict.overwrite', 'Overwrite')}
              </button>
              <button type="button" onClick={() => { void saveAs(); }}>
                {t('markdown.conflict.saveAs', 'Save as copy')}
              </button>
            </>
          )}
        </div>
      )}

      {error && <div className="markdown-pane__error">{error}</div>}

      <div className="markdown-pane__body">
        {!content && !editing && (
          <p className="markdown-pane__empty">
            {t('markdown.empty', 'No content. Use wmux markdown set to add content, or drop a file here.')}
          </p>
        )}
        {editing && <MarkdownEditor content={content} onChange={handleEdit} onSave={save} />}
        {!editing && !!content && viewMode === 'source' && <MarkdownSource content={content} />}
        {!editing && !!content && viewMode === 'preview' && (
          <div
            className="markdown-pane__content"
            ref={contentRef}
            onClick={handleContentClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
}
