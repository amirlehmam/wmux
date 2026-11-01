/**
 * The project Git view (#362): every worktree of one repository, and three
 * ways to review the selected one — its working changes, what its branch has
 * committed since a base, and where that sits in the repository's graph.
 *
 * Read-only. The review context (worktree, base, mode, graph scope) lives on
 * the surface, never on focus: clicking into another agent's terminal does
 * not move it, which is the whole point of reviewing one agent's work while
 * others keep running.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SurfaceRef } from '../../../shared/types';
import type { GitGraphScope, GitRepoInfo, GitWorktreeEntry } from '../../../shared/git-view';
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { baseName, shortHash, useGitQuery } from './git-api';
import GitWorkingView from './GitWorkingView';
import GitBranchView from './GitBranchView';
import GitGraphView from './GitGraphView';
import { requestFocusSurface } from './open-git';
import { terminalsByWorktree, worktreeForCwd, type TerminalLocation } from './worktree-terminals';
import '../../styles/diff.css';
import '../../styles/git.css';

type GitMode = NonNullable<SurfaceRef['gitMode']>;
type GitPatch = Partial<Pick<SurfaceRef, 'cwd' | 'gitWorktree' | 'gitBase' | 'gitMode' | 'gitGraphScope'>>;

const POLL_MS = 4000;

/** Same visibility rule as the Diff tab: hidden tabs stay mounted and must not poll. */
function isSurfaceVisible(surfaceId: string): boolean {
  if (typeof document === 'undefined') return true;
  if (document.hidden) return false;
  const el = document.querySelector(`.git-pane[data-surface-id="${CSS.escape(surfaceId)}"]`);
  if (!el) return true;
  const check = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(el, { visibilityProperty: true, contentVisibilityAuto: true }) : true;
}

/** A tick that advances every POLL_MS while visible, and on agent edits. */
function usePollTick(surfaceId: string): [number, () => void] {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    const timer = setInterval(() => { if (isSurfaceVisible(surfaceId)) bump(); }, POLL_MS);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const unsub = window.wmux?.diff?.onUpdate?.(() => {
      clearTimeout(debounce);
      debounce = setTimeout(bump, 300);
    });
    return () => {
      clearInterval(timer);
      clearTimeout(debounce);
      unsub?.();
    };
  }, [surfaceId, bump]);
  return [tick, bump];
}

function WorktreeItem({ wt, selected, terminals, onSelect }: Readonly<{
  wt: GitWorktreeEntry; selected: boolean; terminals: number; onSelect: () => void;
}>) {
  const t = useT();
  const s = wt.summary;
  return (
    <button
      type="button"
      className={`git-wt${selected ? ' git-wt--selected' : ''}${wt.prunable ? ' git-wt--gone' : ''}`}
      onClick={onSelect}
      disabled={wt.prunable || wt.bare}
      title={wt.path}
    >
      <span className="git-wt__name">
        {baseName(wt.path)}
        {wt.primary && <span className="git-tag">{t('git.primary', 'main tree')}</span>}
        {wt.locked && <span className="git-tag">{t('git.locked', 'locked')}</span>}
        {wt.prunable && <span className="git-tag git-tag--warn">{t('git.missing', 'missing')}</span>}
        {terminals > 0 && <span className="git-wt__term" title={t('git.hasTerminal', 'Has an open terminal')}>{'>_'}</span>}
      </span>
      <span className="git-wt__branch">
        {wt.branch ?? t('git.detached', 'detached @ {hash}').replace('{hash}', shortHash(wt.head))}
      </span>
      {s && (
        <span className="git-wt__summary">
          {s.conflicted > 0 && <span className="git-chip git-chip--conflict">!{s.conflicted}</span>}
          {s.staged > 0 && <span className="git-chip git-chip--staged" title={t('git.section.staged', 'Staged')}>●{s.staged}</span>}
          {s.unstaged > 0 && <span className="git-chip git-chip--unstaged" title={t('git.section.unstaged', 'Changes')}>✎{s.unstaged}</span>}
          {s.untracked > 0 && <span className="git-chip" title={t('git.section.untracked', 'Untracked')}>?{s.untracked}</span>}
          {s.ahead > 0 && <span className="git-chip" title={s.upstream ?? ''}>↑{s.ahead}</span>}
          {s.behind > 0 && <span className="git-chip" title={s.upstream ?? ''}>↓{s.behind}</span>}
          {s.staged + s.unstaged + s.untracked + s.conflicted === 0 && <span className="git-muted">{t('git.clean', 'clean')}</span>}
        </span>
      )}
    </button>
  );
}

interface Props {
  surfaceId: string;
  /** The folder the tab is pinned to; any folder inside the repository. */
  cwd: string | undefined;
  surface: SurfaceRef;
  onPatch: (patch: GitPatch) => void;
}

export default function GitPane({ surfaceId, cwd, surface, onPatch }: Readonly<Props>) {
  const t = useT();
  const [tick, bump] = usePollTick(surfaceId);
  // Branch and graph refetch on a new HEAD (from the poll) or on this button;
  // a plain poll tick must not re-run `git log` over the whole history.
  const [manual, setManual] = useState(0);
  const refresh = useCallback(() => { bump(); setManual((n) => n + 1); }, [bump]);
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const id = (event as CustomEvent<{ surfaceId?: string }>).detail?.surfaceId;
      if (id === surfaceId) refresh();
    };
    document.addEventListener('wmux:refresh-surface', onRefresh);
    return () => document.removeEventListener('wmux:refresh-surface', onRefresh);
  }, [refresh, surfaceId]);
  const repoQuery = useGitQuery<GitRepoInfo>(cwd ? { op: 'repo', cwd } : null, tick);
  const repo = repoQuery.data;
  const mode: GitMode = surface.gitMode ?? 'working';

  // Pin the repository on first success when the tab was opened without one
  // (`wmux new-surface --type git`): the workspace cwd it fell back to is
  // last-reporter-wins and would otherwise move the view on its own.
  useEffect(() => {
    if (repo && !surface.cwd) onPatch({ cwd: repo.root });
  }, [repo, surface.cwd, onPatch]);

  const usable = useMemo(() => (repo?.worktrees ?? []).filter((w) => !w.bare && !w.prunable), [repo]);
  const selected = useMemo(() => {
    const want = surface.gitWorktree?.replace(/\\/g, '/').toLowerCase();
    const byPick = want ? usable.find((w) => w.path.replace(/\\/g, '/').toLowerCase() === want) : undefined;
    if (byPick) return byPick;
    const containing = worktreeForCwd(usable.map((w) => w.path), cwd);
    return usable.find((w) => w.path === containing) ?? usable[0] ?? null;
  }, [usable, surface.gitWorktree, cwd]);

  // The selector returns a STRING, so this pane re-renders only when the set
  // of terminals in these worktrees actually changes — not on every store
  // write (a cwd report, a split elsewhere), which would redraw the graph.
  const worktreePaths = useMemo(() => usable.map((w) => w.path), [usable]);
  const terminalsJson = useStore((s) => JSON.stringify([...terminalsByWorktree(s.workspaces, worktreePaths)]));
  const terminals = useMemo(() => new Map<string, TerminalLocation[]>(JSON.parse(terminalsJson)), [terminalsJson]);
  const selectedTerminals = selected ? terminals.get(selected.path) ?? [] : [];
  const base = surface.gitBase ?? repo?.defaultBase ?? null;

  const goToTerminal = () => {
    const target = selectedTerminals[0];
    if (target) requestFocusSurface(target.workspaceId, target.surfaceId);
  };

  if (!cwd) return <div className="git-pane git-empty" data-surface-id={surfaceId}>{t('git.noFolder', 'No folder to inspect yet — open this tab from a terminal inside a repository')}</div>;
  if (repoQuery.error && !repo) {
    const msg = repoQuery.error.code === 'not_repo' ? t('git.notRepo', 'This folder is not inside a Git repository') : repoQuery.error.message;
    return <div className="git-pane" data-surface-id={surfaceId}><div className="git-empty git-empty--error">{msg}<div className="git-muted">{cwd}</div></div></div>;
  }
  if (!repo) return <div className="git-pane" data-surface-id={surfaceId}><div className="git-empty">{t('git.loading', 'Loading…')}</div></div>;

  const repoPath = repo.worktrees.find((w) => w.primary)?.path ?? repo.root;
  const modes: Array<{ id: GitMode; label: string }> = [
    { id: 'working', label: t('git.mode.working', 'Working') },
    { id: 'branch', label: t('git.mode.branch', 'Branch') },
    { id: 'graph', label: t('git.mode.graph', 'Graph') },
  ];

  return (
    <div className="git-pane" data-surface-id={surfaceId}>
      <div className="git-pane__body">
      <aside className="git-sidebar">
        {/* Named after the MAIN tree: `root` is the toplevel of whichever
            worktree the tab was opened from, which is not the project. */}
        <div className="git-sidebar__header" title={repoPath}>
          <span className="git-sidebar__repo">{baseName(repoPath)}</span>
          <span className="git-group__count">{usable.length}</span>
        </div>
        <div className="git-sidebar__list">
          {repo.worktrees.map((wt) => (
            <WorktreeItem
              key={wt.path}
              wt={wt}
              selected={wt.path === selected?.path}
              terminals={terminals.get(wt.path)?.length ?? 0}
              onSelect={() => onPatch({ gitWorktree: wt.path })}
            />
          ))}
        </div>
      </aside>
      <section className="git-main">
        <div className="git-toolbar">
          <div className="git-seg">
            {modes.map((m) => (
              <button key={m.id} type="button" className={mode === m.id ? 'git-seg--on' : ''} onClick={() => onPatch({ gitMode: m.id })}>
                {m.label}
              </button>
            ))}
          </div>
          {selected && (
            <span className="git-toolbar__context" title={selected.path}>
              <strong>{baseName(selected.path)}</strong>
              <span className="git-muted">{selected.branch ?? shortHash(selected.head)}</span>
            </span>
          )}
          <span className="git-subbar__spacer" />
          <button
            type="button"
            className="git-btn"
            disabled={selectedTerminals.length === 0}
            onClick={goToTerminal}
            title={selectedTerminals.length > 0
              ? t('git.goToTerminalTitle', 'Focus the terminal open in this worktree')
              : t('git.noTerminal', 'No open terminal in this worktree')}
          >
            {t('git.goToTerminal', 'Go to terminal')}
          </button>
          <button type="button" className="git-btn git-btn--icon" onClick={refresh} title={t('diffPane.refresh', 'Refresh')}>↻</button>
        </div>
        {!selected && <div className="git-empty">{t('git.noWorktree', 'No worktree to review')}</div>}
        {selected && mode === 'working' && (
          <GitWorkingView cwd={repo.root} worktree={selected.path} refresh={tick} />
        )}
        {selected && mode === 'branch' && (
          <GitBranchView
            cwd={repo.root}
            worktree={selected.path}
            base={base}
            refs={repo.refs}
            head={selected.head}
            summary={selected.summary}
            refresh={manual}
            onBaseChange={(b) => onPatch({ gitBase: b })}
            onShowWorking={() => onPatch({ gitMode: 'working' })}
          />
        )}
        {selected && mode === 'graph' && (
          <GitGraphView
            cwd={repo.root}
            worktree={selected.path}
            worktrees={repo.worktrees}
            refs={repo.refs}
            scope={(surface.gitGraphScope ?? 'all') as GitGraphScope}
            head={selected.head}
            refresh={manual}
            onScopeChange={(scope) => onPatch({ gitGraphScope: scope })}
          />
        )}
      </section>
      </div>
    </div>
  );
}
