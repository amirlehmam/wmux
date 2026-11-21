// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OPENED_MTIMES_MAX,
  openedMtimeCount,
  recordOpenedMtime,
  takeOpenedMtime,
} from '../../src/renderer/components/Explorer/opened-mtimes';
import { killSurfacePty } from '../../src/renderer/store/pty-teardown';
import type { SurfaceId } from '../../src/shared/types';

/**
 * The mtime an opened code tab was read at is handed to its pane once. A tab closed before its
 * pane ever took it must not leave the entry behind, and the map is bounded either way.
 */
beforeEach(() => {
  for (let i = 0; i < OPENED_MTIMES_MAX + 1; i++) takeOpenedMtime(`s${i}`, `/f${i}`);
});

describe('opened mtimes', () => {
  it('hands the mtime over once, and only for the file it was recorded for', () => {
    recordOpenedMtime('s1', '/f1', 1234);
    expect(takeOpenedMtime('s1', '/other')).toBeUndefined();
    expect(takeOpenedMtime('s1', '/f1')).toBe(1234);
    expect(takeOpenedMtime('s1', '/f1')).toBeUndefined();
  });

  it('drops the entry of a surface that is closed before its pane took it', () => {
    recordOpenedMtime('s2', '/f2', 5);
    const before = openedMtimeCount();
    killSurfacePty({ id: 's2' as SurfaceId, type: 'code' as never });
    expect(openedMtimeCount()).toBe(before - 1);
    expect(takeOpenedMtime('s2', '/f2')).toBeUndefined();
  });

  it('leaves other surfaces\' entries alone when one closes', () => {
    recordOpenedMtime('s3', '/f3', 7);
    killSurfacePty({ id: 's-other' as SurfaceId, type: 'code' as never });
    expect(takeOpenedMtime('s3', '/f3')).toBe(7);
  });

  it('is bounded: surfaces that were never shown do not accumulate', () => {
    for (let i = 0; i < OPENED_MTIMES_MAX * 3; i++) recordOpenedMtime(`never-${i}`, `/f${i}`, i);
    expect(openedMtimeCount()).toBeLessThanOrEqual(OPENED_MTIMES_MAX);
    expect(takeOpenedMtime('never-0', '/f0')).toBeUndefined();
    expect(takeOpenedMtime(`never-${OPENED_MTIMES_MAX * 3 - 1}`, `/f${OPENED_MTIMES_MAX * 3 - 1}`)).toBe(OPENED_MTIMES_MAX * 3 - 1);
  });
});
