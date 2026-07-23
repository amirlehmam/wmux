import { describe, it, expect } from 'vitest';
import { DEFAULT_DEV_PORTS, mergeDevPorts, matchDevPorts, firstNewDevPort } from '../../src/renderer/dev-ports';

describe('mergeDevPorts', () => {
  it('returns the defaults unchanged when no config is given', () => {
    expect(mergeDevPorts(DEFAULT_DEV_PORTS)).toBe(DEFAULT_DEV_PORTS);
    expect(mergeDevPorts(DEFAULT_DEV_PORTS, [])).toBe(DEFAULT_DEV_PORTS);
    expect(mergeDevPorts(DEFAULT_DEV_PORTS, null)).toBe(DEFAULT_DEV_PORTS);
  });

  it('adds a configured port on top of the defaults (additive, not replacing)', () => {
    const merged = mergeDevPorts(DEFAULT_DEV_PORTS, [8501]);
    // Every default is still present...
    for (const p of DEFAULT_DEV_PORTS) expect(merged).toContain(p);
    // ...plus the new one.
    expect(merged).toContain(8501);
    expect(merged.length).toBe(DEFAULT_DEV_PORTS.length + 1);
  });

  it('de-dupes a configured port that overlaps a default', () => {
    const merged = mergeDevPorts(DEFAULT_DEV_PORTS, [3000, 8501]);
    expect(merged.filter((p) => p === 3000).length).toBe(1);
    expect(merged).toContain(8501);
    expect(merged.length).toBe(DEFAULT_DEV_PORTS.length + 1);
  });
});

describe('matchDevPorts', () => {
  it('matches a configured custom port once it is merged in (the 8501 case)', () => {
    const active = mergeDevPorts(DEFAULT_DEV_PORTS, [8501]);
    expect(matchDevPorts([8501], active)).toEqual([8501]);
  });

  it('does NOT match a custom port against the bare defaults', () => {
    expect(matchDevPorts([8501], DEFAULT_DEV_PORTS)).toEqual([]);
  });

  it('filters a mixed set down to only recognized dev ports', () => {
    const active = mergeDevPorts(DEFAULT_DEV_PORTS, [8501]);
    expect(matchDevPorts([22, 443, 5173, 8501, 61000], active)).toEqual([5173, 8501]);
  });

  it('returns empty when nothing matches', () => {
    expect(matchDevPorts([22, 443, 61000], DEFAULT_DEV_PORTS)).toEqual([]);
  });
});

describe('firstNewDevPort', () => {
  it('returns the first recognized port the workspace has not seen yet', () => {
    expect(firstNewDevPort([3000, 3001, 8501], [3000, 3001])).toBe(8501);
  });

  // Regression: on a busy machine several recognized ports are already listening,
  // so netstat lists a pre-existing one first. Blindly using index 0 meant a
  // freshly-started server (8501) never opened. It must still be picked.
  it('opens a newly-appeared port even when other dev ports already listen', () => {
    expect(firstNewDevPort([3001, 3000, 8000, 8501], [3001, 3000, 8000])).toBe(8501);
  });

  it('returns undefined when every detected port is already known (no re-navigation)', () => {
    expect(firstNewDevPort([3000, 8501], [3000, 8501])).toBeUndefined();
  });

  it('on a cold workspace (nothing known yet) returns the first detected port', () => {
    expect(firstNewDevPort([5173, 8501], [])).toBe(5173);
  });
});
