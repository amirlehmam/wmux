// ─── The explorer's +N/-N column: fetching, polling and attribution ──────────
// The impure half of explorer-diff.ts. Kept out of ExplorerPanel.tsx because
// that component is already the largest file in the folder, and kept out of
// explorer-diff.ts because everything in there is a pure function a test can
// call with no React, no IPC and no timers.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExplorerDiffEntry } from '../../../shared/types';
import {
  buildDiffStats, totalStat, isEditingTool, relativizeTouched, noteTouched,
  type DiffStat, type DiffStatMap,
} from './explorer-diff';

const EMPTY_STATS: DiffStatMap = new Map();
const NO_TOTAL: DiffStat = { additions: 0, deletions: 0, files: 0 };

/**
 * How often the column refreshes on its own.
 *
 * Deliberately slow. `getChangedFiles` is a `git status` plus a `git diff
 * --numstat` on a working tree that can take ~1s, and issue #141 was exactly
 * this: a poll that looked harmless stacking one `git.exe` per tick on the main
 * process that also relays every keystroke. diff-provider coalesces per-cwd
 * now, so a burst collapses into one pass — but coalescing bounds the damage,
 * it does not make a fast poll correct.
 *
 * The interval is also NOT the primary freshness mechanism. Hook events are:
 * an agent's edit refreshes the column within `HOOK_DEBOUNCE_MS`, and the timer
 * only covers changes nothing announced (the user's own editor, a build, a
 * `git checkout` in another pane).
 */
const POLL_MS = 4000;

/**
 * Hook events arrive one per tool call, and an agent mid-edit fires them in
 * bursts. Coalesce a burst into one fetch that runs after it settles, rather
 * than one fetch per Edit.
 */
const HOOK_DEBOUNCE_MS = 400;

export interface ExplorerDiffState {
  stats: DiffStatMap;
  touched: ReadonlySet<string>;
  total: DiffStat;
  /** Which question the numbers answer. Null until the first reply lands. */
  baseline: 'git' | 'snapshot' | null;
  refresh: () => void;
}

/**
 * Live change counts for one explorer root.
 *
 * `enabled` is the panel's own visibility. A closed panel costs nothing: no
 * timer, no IPC, no listener — the same rule the agent office follows, where
 * `{hubOpen && <HubView/>}` is what lets a feature ship default-on without
 * everyone paying for it.
 */
export function useExplorerDiff(
  // `string`, not `SurfaceId`: the panel's own surfaceId falls back to a
  // persisted sticky value that is a plain string, and this hook only forwards
  // it to main. Narrowing here would push a cast into the call site, which
  // moves the looseness without removing it.
  surfaceId: string | null,
  absRoot: string,
  enabled: boolean,
): ExplorerDiffState {
  const [files, setFiles] = useState<readonly ExplorerDiffEntry[]>([]);
  const [baseline, setBaseline] = useState<'git' | 'snapshot' | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [stats, setStats] = useState<DiffStatMap>(EMPTY_STATS);

  // The identity of the tree being asked about. A reply that no longer matches
  // when it lands is dropped — the same guard the panel's own `currentKeyRef`
  // applies to directory listings, and for the same reason: switching panes
  // fast enough would otherwise paint one root's numbers onto another's rows.
  const keyRef = useRef('');
  keyRef.current = `${surfaceId ?? ''}|${absRoot}`;

  const fetchStats = useCallback(async () => {
    if (!surfaceId || !enabled) return;
    const key = keyRef.current;
    let res: any;
    try {
      res = await window.wmux.explorer.diffStats(surfaceId);
    } catch {
      return;   // main is gone or the window is closing; leave the last numbers
    }
    if (keyRef.current !== key) return;
    if (!res || 'error' in res) {
      // A root with no git and no snapshot yet, an ssh pane, a surface main
      // does not own — all of them mean "no numbers", which the tree renders as
      // no column at all. Deliberately NOT an error banner: the file list above
      // it is working fine, and a banner over a working tree reads as a
      // breakage rather than an absence.
      setFiles([]);
      setBaseline(null);
      return;
    }
    setFiles(res.files ?? []);
    setBaseline(res.baseline ?? null);
  }, [surfaceId, enabled]);

  // Rebuild the rollup only when the file list actually changes, not on every
  // render of the panel. buildDiffStats walks every ancestor of every changed
  // file, which is cheap but not free, and the panel re-renders on selection,
  // expansion and hover.
  useEffect(() => {
    setStats(files.length > 0 ? buildDiffStats(files) : EMPTY_STATS);
  }, [files]);

  // Drop everything when the root changes. Numbers and dots from the previous
  // folder are not merely stale, they are about a different tree — showing them
  // for even one frame puts `+55/-22` against an identically-named file
  // somewhere else.
  useEffect(() => {
    setFiles([]);
    setBaseline(null);
    setTouched(new Set());
    setStats(EMPTY_STATS);
  }, [absRoot]);

  // Fetch on open and whenever the root changes.
  useEffect(() => { void fetchStats(); }, [fetchStats, absRoot]);

  // The poll. Gated on the panel being open AND the window being focused: a
  // background window is not being read, so spending a `git status` a second on
  // it buys nothing. `focus`/`blur` rather than a `document.hasFocus()` check
  // inside the tick, so an unfocused window holds no timer at all.
  useEffect(() => {
    if (!enabled || !surfaceId) return;
    let timer: number | null = null;
    const start = (): void => {
      if (timer !== null) return;
      timer = window.setInterval(() => { void fetchStats(); }, POLL_MS);
    };
    const stop = (): void => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    // A window that is already focused on mount must not wait for a `focus`
    // event that has already happened and will not fire again.
    if (document.hasFocus()) start();
    const onFocus = (): void => { void fetchStats(); start(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', stop);
    return () => {
      stop();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', stop);
    };
  }, [enabled, surfaceId, fetchStats]);

  // Attribution, plus the freshness signal that actually matters. Both come off
  // the hook stream wmux already receives — nothing extra is installed or sent,
  // and with no hooks there are simply no dots and the poll still works.
  useEffect(() => {
    if (!enabled || !absRoot) return;
    let debounce: number | null = null;
    const off = window.wmux.hook.onEvent((params: any) => {
      if (!isEditingTool(params?.tool)) return;
      const rel = relativizeTouched(absRoot, String(params?.file ?? ''));
      // Outside this root — which is the COMMON case, since hooks fire for
      // every pane and most panes are rooted elsewhere. Not a refresh trigger
      // either: another project's edit says nothing about this tree.
      if (!rel) return;
      setTouched((prev) => noteTouched(new Set(prev), rel));
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { void fetchStats(); }, HOOK_DEBOUNCE_MS);
    });
    return () => {
      if (debounce !== null) window.clearTimeout(debounce);
      off?.();
    };
  }, [enabled, absRoot, fetchStats]);

  const refresh = useCallback(() => { void fetchStats(); }, [fetchStats]);

  return {
    stats,
    touched,
    total: files.length > 0 ? totalStat(files) : NO_TOTAL,
    baseline,
    refresh,
  };
}
