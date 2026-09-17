/**
 * Issue #238: "make the environment more safe".
 *
 * `session.json` is rewritten in place every 30 seconds, so it only ever holds
 * the CURRENT layout — right for restore-on-launch, useless the moment something
 * goes wrong. The reporter asked an agent to kill orphan pwsh processes, lost 28
 * browser panes to it, and recovered most of them only because an OLDER file
 * happened to still be around.
 *
 * Two rules decide when a snapshot happens, and the second one is the
 * interesting one: without it, an idle machine rotates identical copies through
 * the ring every five minutes and deletes the very history the feature exists to
 * keep.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SNAPSHOT_MINUTES,
  layoutFingerprint,
  shouldSnapshot,
  SessionData,
} from '../../src/main/session-persistence';

const MIN = 60_000;

const session = (over: Partial<{ id: string; title: string; tree: unknown; cwd: string }> = {}): SessionData => ({
  version: 1,
  windows: [{
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    sidebarWidth: 260,
    activeWorkspaceId: 'ws-1',
    workspaces: [{
      id: over.id ?? 'ws-1',
      title: over.title ?? 'api',
      pinned: false,
      shell: 'pwsh',
      cwd: over.cwd ?? 'C:\\repo',
      splitTree: over.tree ?? { type: 'leaf', paneId: 'pane-1', surfaces: [{ id: 'surf-1', type: 'terminal' }] },
    }],
  }],
});

const decide = (over: Partial<Parameters<typeof shouldSnapshot>[0]>): boolean =>
  shouldSnapshot({
    now: 10 * MIN,
    lastAt: 0,
    intervalMinutes: DEFAULT_SNAPSHOT_MINUTES,
    fingerprint: 'A',
    lastFingerprint: '',
    ...over,
  });

describe('shouldSnapshot — the clock (issue #238)', () => {
  it('takes the first snapshot of a run immediately', () => {
    // That first one holds what the PREVIOUS run left behind, which is exactly
    // what a person goes looking for after losing something.
    expect(decide({ lastAt: 0 })).toBe(true);
  });

  it('waits out the interval', () => {
    expect(decide({ now: 10 * MIN, lastAt: 8 * MIN })).toBe(false);
    expect(decide({ now: 10 * MIN, lastAt: 5 * MIN })).toBe(true);
  });

  it('honours a longer interval', () => {
    expect(decide({ now: 40 * MIN, lastAt: 10 * MIN, intervalMinutes: 60 })).toBe(false);
    expect(decide({ now: 71 * MIN, lastAt: 10 * MIN, intervalMinutes: 60 })).toBe(true);
  });

  it('is off at 0 — that is the "Never" option, not "every tick"', () => {
    expect(decide({ intervalMinutes: 0 })).toBe(false);
    expect(decide({ intervalMinutes: -5 })).toBe(false);
  });

  it('is off for a value that is not a finite number', () => {
    // settings.json is hand-editable, and NaN compares false against every
    // bound — so a `<= 0` guard would read a garbled value as "on, at the floor"
    // and snapshot on every 30-second tick. Infinity is rejected by the same
    // check and means the same thing it looks like it means: never.
    expect(decide({ intervalMinutes: NaN })).toBe(false);
    expect(decide({ intervalMinutes: Infinity })).toBe(false);
  });

  it('clamps an absurdly small interval to the floor rather than free-running', () => {
    expect(decide({ now: 10 * MIN, lastAt: 10 * MIN - 30_000, intervalMinutes: 0.001 })).toBe(false);
    expect(decide({ now: 10 * MIN, lastAt: 8 * MIN, intervalMinutes: 0.001 })).toBe(true);
  });
});

describe('shouldSnapshot — the fingerprint (issue #238)', () => {
  it('refuses to spend a ring slot on a layout it already holds', () => {
    // A lunch break would otherwise rotate three identical copies in and destroy
    // every distinct state behind them.
    expect(decide({ lastAt: MIN, now: 30 * MIN, fingerprint: 'A', lastFingerprint: 'A' })).toBe(false);
  });

  it('snapshots once the layout differs again', () => {
    expect(decide({ lastAt: MIN, now: 30 * MIN, fingerprint: 'B', lastFingerprint: 'A' })).toBe(true);
  });

  it('never snapshots an empty layout', () => {
    // No workspaces at all is what a half-torn-down session looks like during
    // shutdown; writing it over a good snapshot is the failure mode itself.
    expect(decide({ fingerprint: '' })).toBe(false);
  });

  it('still waits out the clock when the layout changed', () => {
    // Both gates, not either — otherwise typing in a pane that renames a tab
    // would snapshot at PTY speed.
    expect(decide({ lastAt: 9 * MIN, now: 10 * MIN, fingerprint: 'B', lastFingerprint: 'A' })).toBe(false);
  });
});

describe('layoutFingerprint (issue #238)', () => {
  it('is stable across two reads of the same layout', () => {
    expect(layoutFingerprint(session())).toBe(layoutFingerprint(session()));
  });

  it('changes when a workspace is renamed', () => {
    expect(layoutFingerprint(session({ title: 'api' }))).not.toBe(layoutFingerprint(session({ title: 'web' })));
  });

  it('changes when the split tree changes', () => {
    const split = { type: 'branch', direction: 'row', children: [{ type: 'leaf', paneId: 'p1', surfaces: [] }, { type: 'leaf', paneId: 'p2', surfaces: [] }] };
    expect(layoutFingerprint(session())).not.toBe(layoutFingerprint(session({ tree: split })));
  });

  it('does NOT change when a shell merely cds', () => {
    // `cwd` is rewritten on every prompt. Were it in the fingerprint, the gate
    // would pass on essentially every tick — which is the same as having no gate.
    expect(layoutFingerprint(session({ cwd: 'C:\\repo' }))).toBe(layoutFingerprint(session({ cwd: 'C:\\repo\\src' })));
  });

  it('is empty for a session with nothing in it', () => {
    expect(layoutFingerprint({ version: 1, windows: [] })).toBe('');
    expect(layoutFingerprint(null)).toBe('');
    expect(layoutFingerprint(undefined)).toBe('');
  });

  it('covers every window, not just the first', () => {
    const two = session();
    two.windows.push({ ...two.windows[0], workspaces: [{ ...two.windows[0].workspaces[0], id: 'ws-2', title: 'second' }] });
    expect(layoutFingerprint(two)).not.toBe(layoutFingerprint(session()));
  });

  it('returns empty rather than throwing on an unserialisable tree', () => {
    // '' means "do not snapshot", which is the safe way round: a best-effort
    // safety net must never become a write loop.
    const cyclic: any = session();
    cyclic.windows[0].workspaces[0].splitTree.self = cyclic.windows[0].workspaces[0].splitTree;
    expect(layoutFingerprint(cyclic)).toBe('');
  });
});
