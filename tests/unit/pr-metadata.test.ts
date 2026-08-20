import { describe, it, expect } from 'vitest';

import { applyPrCommand } from '../../src/renderer/pr-metadata';
import { SurfaceId } from '../../src/shared/types';

const SURF_A = 'surf-aaaa' as SurfaceId;
const SURF_B = 'surf-bbbb' as SurfaceId;

/**
 * Ownership gate for `clear_pr` (issue #4, Codex review follow-up).
 *
 * Every PowerShell pane in a workspace runs its own PR poller, so two panes
 * on two different repos/branches both write the SAME workspace-scoped PR
 * fields. Before this fix, `clear_pr` from either pane wiped the row
 * unconditionally: pane A reports #1, pane B (different repo) reports #2 —
 * the row now shows #2 — then pane A's branch loses its PR and pane A sends
 * `clear_pr`, wiping pane B's #2 even though B's PR is still open. The
 * PowerShell side can't fix this alone: it only knows whether IT reported,
 * not whether something else has since overwritten the row.
 */
describe('applyPrCommand — report_pr', () => {
  it('records the reporting surface as the owner alongside the PR fields', () => {
    const patch = applyPrCommand(
      { command: 'report_pr', surfaceId: SURF_A, args: ['42', 'OPEN', 'Fix', 'thing'] },
      {},
    );
    expect(patch).toEqual({
      prNumber: 42,
      prStatus: 'open',
      prLabel: 'Fix thing',
      prSurfaceId: SURF_A,
    });
  });
});

describe('applyPrCommand — clear_pr ownership gate', () => {
  it('clears the PR when it comes from the surface that reported it', () => {
    const patch = applyPrCommand(
      { command: 'clear_pr', surfaceId: SURF_A },
      { prSurfaceId: SURF_A },
    );
    expect(patch).toEqual({
      prNumber: undefined,
      prStatus: undefined,
      prLabel: undefined,
      prSurfaceId: undefined,
    });
  });

  it('is dropped as a no-op when it comes from a different surface than the owner', () => {
    // Pane B owns the row (reported #2); pane A's clear must not touch it.
    const patch = applyPrCommand(
      { command: 'clear_pr', surfaceId: SURF_A },
      { prSurfaceId: SURF_B },
    );
    expect(patch).toBeNull();
  });

  it('is dropped as a no-op when no owner is recorded yet', () => {
    const patch = applyPrCommand(
      { command: 'clear_pr', surfaceId: SURF_A },
      {},
    );
    expect(patch).toBeNull();
  });
});
