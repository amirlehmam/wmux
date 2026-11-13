/**
 * Building blocks every Git view mode shares (#362): a changed-file list and
 * the diff of one file. The diff itself renders through the Diff tab's own
 * parser and hunk markup (`../Diff/diff-render`), so the two views can never
 * disagree about what a diff looks like.
 */
import React, { useEffect, useRef } from 'react';
import type { GitFileChange, GitViewRequest } from '../../../shared/git-view';
import { useT } from '../../i18n';
import { DiffHunks, DiffWrapToggle, parseDiff } from '../Diff/diff-render';
import { useGitQuery } from './git-api';

const STATUS_LETTER: Record<GitFileChange['status'], string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', conflicted: 'U',
};

export function fileKey(file: Pick<GitFileChange, 'path'>, group = ''): string {
  return `${group}\u0000${file.path}`;
}

interface FileRowProps {
  file: GitFileChange;
  selected: boolean;
  onSelect: () => void;
}

export function GitFileRow({ file, selected, onSelect }: Readonly<FileRowProps>) {
  const parts = file.path.split('/');
  const name = parts.pop() ?? file.path;
  return (
    <button
      type="button"
      className={`git-file${selected ? ' git-file--selected' : ''}`}
      onClick={onSelect}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    >
      <span className={`git-file__badge git-file__badge--${file.status}`}>{STATUS_LETTER[file.status]}</span>
      <span className="git-file__name">{name}</span>
      <span className="git-file__dir">{parts.join('/')}</span>
      <span className="git-file__stats">
        {file.binary && <span className="git-file__bin">bin</span>}
        {file.additions > 0 && <span className="git-stat-add">+{file.additions}</span>}
        {file.deletions > 0 && <span className="git-stat-del">-{file.deletions}</span>}
      </span>
    </button>
  );
}

interface FileListProps {
  files: GitFileChange[];
  selectedKey: string | null;
  onSelect: (file: GitFileChange, key: string) => void;
  group?: string;
}

export function GitFileList({ files, selectedKey, onSelect, group = '' }: Readonly<FileListProps>) {
  return (
    <>
      {files.map((file) => {
        const key = fileKey(file, group);
        return (
          <GitFileRow key={key} file={file} selected={key === selectedKey} onSelect={() => onSelect(file, key)} />
        );
      })}
    </>
  );
}

export function totals(files: readonly GitFileChange[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );
}

export function StatPair({ additions, deletions }: Readonly<{ additions: number; deletions: number }>) {
  return (
    <span className="git-stats">
      {additions > 0 && <span className="git-stat-add">+{additions}</span>}
      {deletions > 0 && <span className="git-stat-del">-{deletions}</span>}
    </span>
  );
}

interface DiffViewProps {
  /** What to diff; null shows the empty hint. */
  request: GitViewRequest | null;
  /** Shown above the hunks: the file and what it is compared against. */
  title?: string;
  subtitle?: string;
  refresh?: number | string;
}

/** The diff of one file, fetched with `request` and rendered as hunks. */
export function GitDiffView({ request, title, subtitle, refresh = 0 }: Readonly<DiffViewProps>) {
  const t = useT();
  const { data, error, loading } = useGitQuery<string>(request, refresh);
  const scroller = useRef<HTMLDivElement>(null);
  const key = request ? JSON.stringify(request) : '';
  useEffect(() => { scroller.current?.scrollTo(0, 0); }, [key]);

  let body: React.ReactNode;
  if (!request) body = <div className="git-empty">{t('git.selectFile', 'Select a file to see its diff')}</div>;
  else if (error && data === null) body = <div className="git-empty git-empty--error">{error.message}</div>;
  else if (loading && data === null) body = <div className="git-empty">{t('git.loading', 'Loading…')}</div>;
  else {
    const hunks = parseDiff(data ?? '');
    body = hunks.length > 0
      ? <DiffHunks hunks={hunks} />
      : <div className="git-empty">{t('git.noTextDiff', 'No text changes (binary, mode-only or empty)')}</div>;
  }

  return (
    <div className="git-diff" ref={scroller}>
      {request && title && (
        <div className="diff-pane__file-header git-diff__header">
          <span className="diff-pane__file-header-path">{title}</span>
          {subtitle && <span className="git-diff__subtitle">{subtitle}</span>}
          <DiffWrapToggle />
        </div>
      )}
      {body}
    </div>
  );
}
