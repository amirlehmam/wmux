import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { openInWmuxBrowser } from '../../utils/open-in-browser';
import { useT } from '../../i18n';
import {
  SOURCE_VIRTUALIZE_THRESHOLD,
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
  /** Workspace cwd — the path chip shows paths inside it as relative. */
  cwd?: string;
  onViewModeChange?: (mode: MarkdownViewMode) => void;
  /** Reload-from-disk and drag-and-drop both replace the surface's content. */
  onFileLoaded?: (file: { content: string; filePath: string; fileName: string }) => void;
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

// ─── Toolbar ──────────────────────────────────────────────────────────────────

interface ToolbarProps {
  filePath?: string;
  displayPath: string;
  relativePath: string | null;
  viewMode: MarkdownViewMode;
  compact: boolean;
  copied: 'doc' | 'path' | null;
  hasContent: boolean;
  onViewModeChange?: (mode: MarkdownViewMode) => void;
  onCopyDocument: () => void;
  onCopyText: (text: string) => Promise<void> | void;
  onReload: (path: string) => Promise<void> | void;
  onReveal: (path: string) => Promise<void> | void;
  onOpenInApp: (path: string) => Promise<void> | void;
  onActionFailed: () => void;
}

function MarkdownToolbar(props: ToolbarProps) {
  const {
    filePath, displayPath, relativePath, viewMode, compact, copied, hasContent,
    onViewModeChange, onCopyDocument, onCopyText, onReload, onReveal, onOpenInApp,
    onActionFailed,
  } = props;
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const hasPath = !!filePath;

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.('.markdown-pane__menu-wrap')) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const runMenuAction = (action: () => void | Promise<unknown>) => () => {
    setMenuOpen(false);
    const pending = action();
    if (pending instanceof Promise) pending.catch(onActionFailed);
  };

  const pathChipWidth = compact ? 28 : 60;
  const pathChipLabel = copied === 'path'
    ? t('markdown.copiedPath', 'Path copied')
    : middleEllipsize(displayPath, pathChipWidth);

  const menuItems: Array<{ key: string; label: string; enabled: boolean; run: () => void | Promise<unknown> }> = [
    { key: 'copyPath', label: t('markdown.copyPath', 'Copy file path'), enabled: hasPath, run: () => onCopyText(filePath!) },
    { key: 'copyRel', label: t('markdown.copyRelativePath', 'Copy relative path'), enabled: !!relativePath, run: () => onCopyText(relativePath!) },
    { key: 'reload', label: t('markdown.reload', 'Reload from disk'), enabled: hasPath, run: () => onReload(filePath!) },
    { key: 'reveal', label: t('markdown.reveal', 'Reveal in File Explorer'), enabled: hasPath, run: () => onReveal(filePath!) },
    { key: 'openInApp', label: t('markdown.openInApp', 'Open in default app'), enabled: hasPath, run: () => onOpenInApp(filePath!) },
  ];

  return (
    <div className={`markdown-pane__toolbar${compact ? ' markdown-pane__toolbar--compact' : ''}`}>
      {hasPath ? (
        <button
          type="button"
          className="markdown-pane__path"
          title={`${filePath}\n${t('markdown.copyPathHint', 'Click to copy the full path')}`}
          onClick={() => { void onCopyText(filePath!); }}
        >
          {pathChipLabel}
        </button>
      ) : (
        <span className="markdown-pane__path markdown-pane__path--none">
          {t('markdown.noFile', 'Not backed by a file')}
        </span>
      )}

      <div className="markdown-pane__actions">
        <div className="markdown-pane__segmented" role="group">
          <button
            type="button"
            className={`markdown-pane__segment${viewMode === 'preview' ? ' markdown-pane__segment--active' : ''}`}
            onClick={() => onViewModeChange?.('preview')}
            title={t('markdown.preview', 'Preview')}
          >
            {compact ? '¶' : t('markdown.preview', 'Preview')}
          </button>
          <button
            type="button"
            className={`markdown-pane__segment${viewMode === 'source' ? ' markdown-pane__segment--active' : ''}`}
            onClick={() => onViewModeChange?.('source')}
            title={t('markdown.source', 'Source')}
          >
            {compact ? '</>' : t('markdown.source', 'Source')}
          </button>
        </div>

        <button
          type="button"
          className="markdown-pane__btn"
          onClick={onCopyDocument}
          disabled={!hasContent}
          title={t('markdown.copyDocument', 'Copy the raw markdown')}
        >
          {copied === 'doc' ? t('markdown.copied', 'Copied') : t('markdown.copy', 'Copy')}
        </button>

        <div className="markdown-pane__menu-wrap">
          <button
            type="button"
            className="markdown-pane__btn markdown-pane__btn--icon"
            onClick={() => setMenuOpen((open) => !open)}
            title={t('markdown.moreActions', 'More actions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="markdown-pane__menu" role="menu">
              {menuItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={!item.enabled}
                  onClick={runMenuAction(item.run)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
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
  onViewModeChange,
  onFileLoaded,
}: MarkdownPaneProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<'doc' | 'path' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);

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
    if (viewMode === 'source') {
      const selection = window.getSelection?.();
      const selected = selection?.toString() ?? '';
      const insidePane = !!selection?.anchorNode && !!rootRef.current?.contains(selection.anchorNode);
      if (selected && insidePane) {
        void writeClipboard(selected, 'doc');
        return;
      }
    }
    void writeClipboard(content, 'doc');
  }, [content, viewMode, writeClipboard]);

  // ─── Per-code-block copy buttons ────────────────────────────────────────────

  // Depended on as plain strings below rather than calling `t` inside the
  // effect: useT returns a fresh closure every render, so a `t` dependency
  // would re-run this DOM walk on every state change instead of when the
  // rendered HTML actually changes.
  const copyLabel = t('markdown.copy', 'Copy');
  const copyBlockLabel = t('markdown.copyBlock', 'Copy this code block');

  useEffect(() => {
    if (viewMode !== 'preview') return;
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
  }, [html, viewMode, copyLabel, copyBlockLabel]);

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
      setError(res?.error || t('markdown.error.read', 'Could not read the file'));
      return;
    }
    const fileName = res.filePath.replace(/\\/g, '/').split('/').pop() || 'Markdown';
    onFileLoaded?.({ content: res.content, filePath: res.filePath, fileName });
  }, [onFileLoaded, t]);

  // Both shell actions are rejected by the main process when the path falls
  // outside the extension whitelist, so surface that rather than dropping it.
  const revealFile = useCallback(async (path: string) => {
    const res = await window.wmux?.markdown?.reveal?.(path);
    if (res?.error) setError(res.error);
  }, []);

  const openFileInApp = useCallback(async (path: string) => {
    const res = await window.wmux?.markdown?.openInApp?.(path);
    if (res?.error) setError(res.error);
  }, []);

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
        compact={compact}
        copied={copied}
        hasContent={!!content}
        onViewModeChange={onViewModeChange}
        onCopyDocument={copyDocument}
        onCopyText={copyPath}
        onReload={loadFromDisk}
        onReveal={revealFile}
        onOpenInApp={openFileInApp}
        onActionFailed={onActionFailed}
      />

      {error && <div className="markdown-pane__error">{error}</div>}

      <div className="markdown-pane__body">
        {!content && (
          <p className="markdown-pane__empty">
            {t('markdown.empty', 'No content. Use wmux markdown set to add content, or drop a file here.')}
          </p>
        )}
        {!!content && viewMode === 'source' && <MarkdownSource content={content} />}
        {!!content && viewMode === 'preview' && (
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
