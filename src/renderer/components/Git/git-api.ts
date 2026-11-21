/**
 * The Git view's one door to main (#362): `window.wmux.git.view`, plus a hook
 * that runs a request and keeps its answer.
 *
 * The hook keys the request by its JSON, so a parent re-rendering with an
 * equal request object does not refire it, and it only stores an answer that
 * actually differs from the last one — a poll that finds nothing new must not
 * re-render the tree under it (#141).
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { GitViewRequest, GitViewResult } from '../../../shared/git-view';

export class GitViewError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export async function gitView<T>(request: GitViewRequest): Promise<T> {
  const res = await window.wmux?.git?.view(request) as GitViewResult<T> | undefined;
  if (!res) throw new GitViewError('Git view unavailable', 'failed');
  if (!res.ok) throw new GitViewError(res.error, res.code);
  return res.data;
}

/** What the Git pane tells every query under it. A context rather than props so the five views need no change. */
export interface GitQueryScope {
  /**
   * The surface the pane belongs to. `useGitQuery` adds it to every request that names none,
   * so main can run a workspace that lives on a remote host over ssh; with no ssh target main ignores it.
   */
  surfaceId?: string;
  /**
   * Whether the pane's last refresh was its own timer. A ref rather than state
   * because it is read inside the effect that is already running for the tick it
   * describes: the timer sets it just before it bumps the tick, and every other
   * refresh (the button, an agent's edit, a click on a file) clears it. A request
   * that carries `poll` is background work for main on an ssh workspace, queued
   * behind clicks; without a scope nothing is ever a poll.
   */
  polled?: { current: boolean };
}

export const GitQueryContext = createContext<GitQueryScope | undefined>(undefined);

export interface GitQuery<T> {
  data: T | null;
  error: GitViewError | null;
  loading: boolean;
}

/**
 * Run `request` whenever it (or `refresh`) changes. `null` runs nothing and
 * clears the answer. A stale answer — one for a request that has since been
 * replaced — is dropped rather than shown. `error` set beside a non-null
 * `data` means the latest refresh failed and `data` is the previous answer.
 */
export function useGitQuery<T>(
  request: GitViewRequest | null,
  refresh: number | string = 0,
  /** For the pane's own query, which sits above the provider and so cannot read the context. */
  own?: GitQueryScope,
): GitQuery<T> {
  const inherited = useContext(GitQueryContext);
  const { surfaceId, polled } = own ?? inherited ?? {};
  const key = request ? JSON.stringify(surfaceId && !request.surfaceId ? { ...request, surfaceId } : request) : '';
  const [state, setState] = useState<GitQuery<T>>({ data: null, error: null, loading: !!request });
  const lastJson = useRef('');
  const lastKey = useRef('');

  useEffect(() => {
    if (!key) {
      lastJson.current = '';
      setState({ data: null, error: null, loading: false });
      return;
    }
    const keyChanged = lastKey.current !== key;
    lastKey.current = key;
    if (keyChanged) {
      lastJson.current = '';
      setState({ data: null, error: null, loading: true });
    }
    let cancelled = false;
    // A request that is new (a different file, worktree or mode) is somebody's click, whatever woke the effect.
    const poll = !keyChanged && polled?.current === true;
    gitView<T>(poll ? { ...(JSON.parse(key) as GitViewRequest), poll: true } : JSON.parse(key) as GitViewRequest).then(
      (data) => {
        if (cancelled) return;
        const json = JSON.stringify(data);
        if (json === lastJson.current) {
          setState((s) => (s.loading || s.error ? { data: s.data, error: null, loading: false } : s));
          return;
        }
        lastJson.current = json;
        setState({ data, error: null, loading: false });
      },
      (err: unknown) => {
        if (cancelled) return;
        const error = err instanceof GitViewError ? err : new GitViewError(String(err));
        // A REFRESH that fails keeps the last good answer: one git call timing
        // out (an agent mid-rebase, a slow disk) must not swap the whole view
        // for an error screen and drop what the user had selected. A new
        // request has no last answer — the key change cleared it above.
        setState((s) => ({ data: s.data, error, loading: false }));
      },
    );
    return () => { cancelled = true; };
  }, [key, refresh]);

  return state;
}

/** `abc1234` — the conventional short hash. */
export function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 7) : '';
}

/** Last path segment of a worktree path, whatever its separators. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
