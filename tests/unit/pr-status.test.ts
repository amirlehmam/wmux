import { describe, it, expect } from 'vitest';
import React from 'react';

import { normalizePrStatus } from '../../src/renderer/components/Sidebar/pr-status';
import PrStatusIcon from '../../src/renderer/components/Sidebar/PrStatusIcon';

/**
 * The sidebar's PR badge renders its number and state but never its icon
 * (issue #4).
 *
 * `gh pr view --json state` answers in GitHub's own casing — `OPEN`, `MERGED`,
 * `CLOSED` — and that string travels the V1 pipe verbatim into
 * `updateWorkspaceMetadata`. `WorkspaceMetadata.prStatus` is typed `string`
 * (types.ts:217) while `Workspace.prStatus` is the narrow lowercase union
 * (types.ts:102), so the `as any` at the `report_pr` handler is accepted and
 * the uppercase value lands in the store unchallenged.
 *
 * `PrStatusIcon` then switches on the lowercase union with no default arm, so
 * every real report falls off the end and the component returns `undefined`.
 * React 19 renders that as nothing rather than throwing, which is why the badge
 * degrades quietly to a bare `#450 MERGED` instead of failing loudly.
 *
 * Two guards: normalize on the way in at the `report_pr` handler, and let the
 * icon accept whatever casing reaches it anyway. PR fields aren't persisted
 * across a save/restore, so the second guard isn't recovering from a stale
 * session — it's a cheap defense at the render boundary against anything
 * else that might set `prStatus` without going through the handler.
 */
describe('normalizePrStatus', () => {
  it("accepts gh's own casing", () => {
    // Exactly what `gh pr view --json state` emits.
    expect(normalizePrStatus('OPEN')).toBe('open');
    expect(normalizePrStatus('MERGED')).toBe('merged');
    expect(normalizePrStatus('CLOSED')).toBe('closed');
  });

  it('passes an already-lowercase state through unchanged', () => {
    expect(normalizePrStatus('open')).toBe('open');
    expect(normalizePrStatus('merged')).toBe('merged');
    expect(normalizePrStatus('closed')).toBe('closed');
  });

  it('reports an unrecognized state as absent rather than storing it', () => {
    // A state nothing downstream can render is worse than no state at all: the
    // row would print the raw word next to a missing glyph.
    expect(normalizePrStatus('DRAFT')).toBeUndefined();
    expect(normalizePrStatus('')).toBeUndefined();
    expect(normalizePrStatus(undefined)).toBeUndefined();
  });
});

describe('PrStatusIcon', () => {
  // Called as a plain function — these tests need the return value, not a DOM.
  const render = (status: string) => PrStatusIcon({ status: status as never, size: 12 });

  it('renders an icon for each state gh can report, in gh casing', () => {
    for (const status of ['OPEN', 'MERGED', 'CLOSED']) {
      expect(render(status), `no icon for ${status}`).not.toBeNull();
      expect(React.isValidElement(render(status))).toBe(true);
    }
  });

  it('still renders an icon for the lowercase union it was written against', () => {
    for (const status of ['open', 'merged', 'closed']) {
      expect(React.isValidElement(render(status))).toBe(true);
    }
  });

  it('returns null — never undefined — for a state it does not know', () => {
    // `undefined` from a component is legal in React 19 but is exactly how the
    // missing glyph hid: the switch simply ran off the end. An explicit null
    // says "nothing to draw here" on purpose.
    expect(render('DRAFT')).toBeNull();
  });
});
