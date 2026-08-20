export type PrStatus = 'open' | 'merged' | 'closed';

const PR_STATUSES: readonly PrStatus[] = ['open', 'merged', 'closed'];

/**
 * Fold a reported PR state onto the union the sidebar renders.
 *
 * `gh pr view --json state` answers `OPEN` / `MERGED` / `CLOSED`, and the V1
 * `report_pr` command carries that string through untouched — so the value that
 * reaches the store is in GitHub's casing, not the renderer's. Anything else is
 * reported as absent: a state no icon knows would render as bare text beside a
 * missing glyph, which reads as a stuck badge rather than an unknown one.
 */
export function normalizePrStatus(raw: string | undefined | null): PrStatus | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  return PR_STATUSES.find((s) => s === lower);
}
