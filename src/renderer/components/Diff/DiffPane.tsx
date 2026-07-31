import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useT } from '../../i18n';
import '../../styles/diff.css';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldNum?: number;
  newNum?: number;
}

interface DiffHunk {
  header: string;
  context: string;
  lines: DiffLine[];
}

// ─── Diff parser ────────────────────────────────────────────────────────────

function parseDiff(raw: string): DiffHunk[] {
  if (!raw) return [];
  const hunks: DiffHunk[] = [];
  const lines = raw.split('\n');
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') ||
        line.startsWith('---') || line.startsWith('+++') ||
        line.startsWith('new file') || line.startsWith('deleted file')) {
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@(.*)/);
      if (match) {
        oldLine = parseInt(match[1]);
        newLine = parseInt(match[2]);
        currentHunk = { header: line, context: match[3]?.trim() || '', lines: [] };
        hunks.push(currentHunk);
      }
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', content: line.slice(1), newNum: newLine++ });
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'remove', content: line.slice(1), oldNum: oldLine++ });
    } else if (line.startsWith(' ') || line === '') {
      const content = line.startsWith(' ') ? line.slice(1) : '';
      currentHunk.lines.push({ type: 'context', content, oldNum: oldLine++, newNum: newLine++ });
    }
  }

  return hunks;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface DiffPaneProps {
  surfaceId: string;
  cwd?: string;
}

export default function DiffPane({ surfaceId, cwd }: DiffPaneProps) {
  const t = useT();
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [hunks, setHunks] = useState<DiffHunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const selectedFileRef = useRef(selectedFile);
  const lastFilesKeyRef = useRef('');
  const lastDiffRawRef = useRef('');
  selectedFileRef.current = selectedFile;

  const loadFiles = useCallback(async () => {
    try {
      const result = await window.wmux?.diff?.getFiles(cwd || '');
      if (result?.files) {
        const newFiles = result.files as ChangedFile[];
        const newKey = newFiles.map(f => `${f.path}|${f.status}|${f.additions}|${f.deletions}`).join('\n');
        if (newKey !== lastFilesKeyRef.current) {
          lastFilesKeyRef.current = newKey;
          setFiles(newFiles);
        }
        setError(null);
        return newFiles;
      }
    } catch (err: any) {
      setError(err.message || t('diffPane.failedToLoad', 'Failed to load changed files'));
    } finally {
      setLoading(false);
    }
    return [];
  }, [cwd, t]);

  const loadDiff = useCallback(async (file: string) => {
    try {
      const result = await window.wmux?.diff?.getFileDiff(cwd || '', file);
      if (result?.diff !== undefined) {
        if (result.diff !== lastDiffRawRef.current) {
          lastDiffRawRef.current = result.diff;
          setHunks(parseDiff(result.diff));
        }
      }
    } catch {
      lastDiffRawRef.current = '';
      setHunks([]);
    }
  }, [cwd]);

  // Poll git status every 2 seconds (~50ms per git status call)
  // This replaces the old mount-only load — ensures diffs always stay fresh
  useEffect(() => {
    lastFilesKeyRef.current = '';
    lastDiffRawRef.current = '';
    setLoading(true);

    const poll = async () => {
      const loaded = await loadFiles();
      if (loaded.length > 0 && !selectedFileRef.current) {
        setSelectedFile(loaded[0].path);
      }
      if (selectedFileRef.current) {
        loadDiff(selectedFileRef.current);
      }
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [loadFiles, loadDiff]);

  // Load diff + scroll to top when user selects a file
  useEffect(() => {
    if (!selectedFile) return;
    lastDiffRawRef.current = '';
    loadDiff(selectedFile);
    contentRef.current?.scrollTo(0, 0);
  }, [selectedFile, loadDiff]);

  // Listen for immediate updates from Claude Code hooks (faster than polling)
  useEffect(() => {
    if (!window.wmux?.diff?.onUpdate) return;
    let debounce: ReturnType<typeof setTimeout>;
    const unsub = window.wmux.diff.onUpdate((data: { file?: string }) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (data?.file) setSelectedFile(data.file);
        lastFilesKeyRef.current = '';
        lastDiffRawRef.current = '';
        loadFiles().then((loaded) => {
          if (loaded.length > 0 && !selectedFileRef.current) {
            setSelectedFile(loaded[0].path);
          }
          if (selectedFileRef.current) {
            loadDiff(selectedFileRef.current);
          }
        });
      }, 300);
    });
    return () => {
      clearTimeout(debounce);
      unsub();
    };
  }, [loadFiles, loadDiff]);

  const handleRefresh = useCallback(async () => {
    lastFilesKeyRef.current = '';
    lastDiffRawRef.current = '';
    setLoading(true);
    const loaded = await loadFiles();
    if (selectedFile) {
      loadDiff(selectedFile);
    } else if (loaded.length > 0) {
      setSelectedFile(loaded[0].path);
    }
    setLoading(false);
  }, [loadFiles, loadDiff, selectedFile]);

  // Status badge color
  const statusColor = (status: string) => {
    if (status === 'added') return '#4ec94e';
    if (status === 'deleted') return '#e05252';
    return '#e2c08d';
  };

  const statusLetter = (status: string) => {
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    if (status === 'renamed') return 'R';
    return 'M';
  };

  if (loading && files.length === 0) {
    return (
      <div className="diff-pane" data-surface-id={surfaceId}>
        <div className="diff-pane__empty">{t('diffPane.loadingChanges', 'Loading changes...')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="diff-pane" data-surface-id={surfaceId}>
        <div className="diff-pane__empty">{error}</div>
      </div>
    );
  }

  const totalAdded = files.reduce((s, f) => s + f.additions, 0);
  const totalDeleted = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div className="diff-pane" data-surface-id={surfaceId}>
      {/* File list sidebar */}
      <div className="diff-pane__sidebar">
        <div className="diff-pane__sidebar-header">
          <span className="diff-pane__sidebar-title">
            {t('diffPane.changed', 'Changed')}
            <span className="diff-pane__sidebar-count">{files.length}</span>
          </span>
          <div className="diff-pane__sidebar-actions">
            {(totalAdded > 0 || totalDeleted > 0) && (
              <span className="diff-pane__total-stats">
                {totalAdded > 0 && <span className="diff-pane__stat-add">+{totalAdded}</span>}
                {totalDeleted > 0 && <span className="diff-pane__stat-del">-{totalDeleted}</span>}
              </span>
            )}
            <button className="diff-pane__refresh-btn" onClick={handleRefresh} title={t('diffPane.refresh', 'Refresh')}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
              </svg>
            </button>
          </div>
        </div>
        <div className="diff-pane__file-list">
          {files.length === 0 && (
            <div className="diff-pane__no-files">
              {t('diffPane.noChanges', 'No changes detected')}
            </div>
          )}
          {files.map((file) => (
            <div
              key={file.path}
              className={`diff-pane__file ${selectedFile === file.path ? 'diff-pane__file--selected' : ''}`}
              onClick={() => setSelectedFile(file.path)}
              title={file.path}
            >
              <span
                className="diff-pane__file-badge"
                style={{ color: statusColor(file.status) }}
              >
                {statusLetter(file.status)}
              </span>
              <span className="diff-pane__file-name">
                {file.path.split(/[/\\]/).pop()}
              </span>
              <span className="diff-pane__file-dir">
                {file.path.split(/[/\\]/).slice(0, -1).join('/')}
              </span>
              <span className="diff-pane__file-stats">
                {file.additions > 0 && <span className="diff-pane__stat-add">+{file.additions}</span>}
                {file.deletions > 0 && <span className="diff-pane__stat-del">-{file.deletions}</span>}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Diff content */}
      <div className="diff-pane__content" ref={contentRef}>
        {!selectedFile && files.length > 0 && (
          <div className="diff-pane__empty">{t('diffPane.selectFile', 'Select a file to view changes')}</div>
        )}
        {files.length === 0 && (
          <div className="diff-pane__empty">
            <div className="diff-pane__empty-icon">
              <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" opacity="0.3">
                <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0zm7.25-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7.25 8.25v-3.5a.75.75 0 0 1 1.5 0z"/>
              </svg>
            </div>
            <div>{t('diffPane.waitingForChanges', 'Waiting for changes...')}</div>
            <div className="diff-pane__empty-hint">
              {t('diffPane.hint', 'Diffs will appear here when Claude edits files')}
            </div>
          </div>
        )}
        {selectedFile && hunks.length === 0 && files.length > 0 && (
          <div className="diff-pane__empty">{t('diffPane.noDiffAvailable', 'No diff available for {file}').replace('{file}', selectedFile.split(/[/\\]/).pop() ?? selectedFile)}</div>
        )}
        {selectedFile && hunks.length > 0 && (
          <>
            <div className="diff-pane__file-header">
              <span className="diff-pane__file-header-path">{selectedFile}</span>
            </div>
            {hunks.map((hunk, hi) => (
              <div key={hi} className="diff-hunk">
                <div className="diff-hunk__header">
                  {hunk.header}
                  {hunk.context && (
                    <span className="diff-hunk__context"> {hunk.context}</span>
                  )}
                </div>
                {hunk.lines.map((line, li) => (
                  <div key={li} className={`diff-line diff-line--${line.type}`}>
                    <span className="diff-line__gutter diff-line__gutter--old">
                      {line.type !== 'add' ? line.oldNum : ''}
                    </span>
                    <span className="diff-line__gutter diff-line__gutter--new">
                      {line.type !== 'remove' ? line.newNum : ''}
                    </span>
                    <span className="diff-line__prefix">
                      {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : '\u00A0'}
                    </span>
                    <pre className="diff-line__content">{line.content || '\u00A0'}</pre>
                  </div>
                ))}
              </div>
            ))}
            <div className="diff-pane__end-spacer" />
          </>
        )}
      </div>
    </div>
  );
}
