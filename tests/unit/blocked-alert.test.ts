import { describe, it, expect } from 'vitest';
import { blockedAlertTransition } from '../../src/renderer/store/blocked-alert';

const set = (...ids: string[]) => new Set(ids);

describe('blockedAlertTransition', () => {
  it('flashes when the first agent blocks', () => {
    expect(blockedAlertTransition(set(), set('a'))).toBe('flash');
  });

  it('flashes when another agent blocks alongside one already waiting', () => {
    expect(blockedAlertTransition(set('a'), set('a', 'b'))).toBe('flash');
  });

  /**
   * The reason this compares sets rather than counts. One agent unblocks in the
   * same tick another blocks: the count is identical, and a NEW pane is waiting.
   * A count-based trigger stays silent here — and this only ever happens with
   * several agents at once, which is the situation the feature exists for.
   */
  it('flashes on a swap, where the count never changes', () => {
    expect(blockedAlertTransition(set('a'), set('b'))).toBe('flash');
    expect(blockedAlertTransition(set('a', 'b'), set('b', 'c'))).toBe('flash');
  });

  /** A pane the user has deliberately left waiting must not re-flash forever. */
  it('stays quiet while the same agents remain blocked', () => {
    expect(blockedAlertTransition(set('a', 'b'), set('a', 'b'))).toBe('none');
  });

  it('stays quiet when a block resolves but others remain', () => {
    expect(blockedAlertTransition(set('a', 'b'), set('a'))).toBe('none');
  });

  it('clears only on the edge to nothing blocked', () => {
    expect(blockedAlertTransition(set('a'), set())).toBe('clear');
  });

  /**
   * Clearing whenever nothing is new would cancel a flash one tick after it
   * started — before the user, who is by definition looking elsewhere, has seen
   * it.
   */
  it('does not clear merely because nothing is new', () => {
    expect(blockedAlertTransition(set('a'), set('a'))).toBe('none');
  });

  it('is quiet when nothing was or is blocked', () => {
    expect(blockedAlertTransition(set(), set())).toBe('none');
  });
});
