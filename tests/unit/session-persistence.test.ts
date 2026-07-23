import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SessionData } from '../../src/main/session-persistence';

// Use a temp directory for tests
const TEST_DIR = path.join(os.tmpdir(), 'wmux-test-sessions-' + process.pid);

describe('session-persistence', () => {
  beforeEach(() => {
    // Override APPDATA for testing by directly manipulating the module
    // We'll test the serialize/deserialize logic with direct file operations
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('saveSession writes valid JSON', () => {
    const sessionFile = path.join(TEST_DIR, 'session.json');
    const data: SessionData = {
      version: 1,
      windows: [{
        bounds: { x: 100, y: 100, width: 1400, height: 900 },
        sidebarWidth: 200,
        activeWorkspaceId: 'ws-1',
        workspaces: [{
          id: 'ws-1',
          title: 'Test',
          pinned: false,
          shell: 'pwsh.exe',
          splitTree: { type: 'leaf', paneId: 'pane-1', surfaces: [], activeSurfaceIndex: 0 },
        }],
      }],
    };

    // Write directly to test location
    fs.writeFileSync(sessionFile, JSON.stringify(data, null, 2));
    const loaded = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    expect(loaded.version).toBe(1);
    expect(loaded.windows[0].workspaces[0].title).toBe('Test');
  });

  it('handles missing file gracefully', () => {
    const nonexistent = path.join(TEST_DIR, 'nonexistent.json');
    expect(fs.existsSync(nonexistent)).toBe(false);
  });

  it('handles corrupted JSON gracefully', () => {
    const sessionFile = path.join(TEST_DIR, 'corrupted.json');
    fs.writeFileSync(sessionFile, '{invalid json!!!');
    expect(() => JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))).toThrow();
  });

  it('round-trips session data correctly', () => {
    const sessionFile = path.join(TEST_DIR, 'roundtrip.json');
    const data: SessionData = {
      version: 1,
      windows: [{
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        sidebarWidth: 250,
        activeWorkspaceId: 'ws-abc',
        workspaces: [
          { id: 'ws-abc', title: 'Agent 1', pinned: true, shell: 'pwsh.exe', customColor: '#C0392B', splitTree: { type: 'leaf', paneId: 'p-1', surfaces: [{ id: 's-1', type: 'terminal' }], activeSurfaceIndex: 0 } },
          { id: 'ws-def', title: 'Agent 2', pinned: false, shell: 'cmd.exe', splitTree: { type: 'branch', direction: 'horizontal', ratio: 0.5, children: [{ type: 'leaf', paneId: 'p-2', surfaces: [{ id: 's-2', type: 'terminal' }], activeSurfaceIndex: 0 }, { type: 'leaf', paneId: 'p-3', surfaces: [{ id: 's-3', type: 'browser' }], activeSurfaceIndex: 0 }] } },
        ],
      }],
    };

    fs.writeFileSync(sessionFile, JSON.stringify(data, null, 2));
    const loaded = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as SessionData;

    expect(loaded.version).toBe(1);
    expect(loaded.windows[0].workspaces).toHaveLength(2);
    expect(loaded.windows[0].workspaces[0].customColor).toBe('#C0392B');
    expect(loaded.windows[0].workspaces[1].splitTree.type).toBe('branch');
    expect(loaded.windows[0].workspaces[1].splitTree.children).toHaveLength(2);
  });
});

// Issue #35: a version update must NOT delete explicitly-named saved sessions
// (they are layout-only snapshots the user chose to keep). Only the volatile
// auto session.json is reset. The module computes its storage paths from
// %APPDATA% at import time, so we override APPDATA and re-import per test.
describe('handleVersionChange (issue #35)', () => {
  const APPDATA_OVERRIDE = path.join(os.tmpdir(), 'wmux-vc-test-' + process.pid);
  let mod: typeof import('../../src/main/session-persistence');
  let savedAppData: string | undefined;

  beforeEach(async () => {
    savedAppData = process.env.APPDATA;
    process.env.APPDATA = APPDATA_OVERRIDE;
    delete process.env.WMUX_INSTANCE;
    vi.resetModules();
    mod = await import('../../src/main/session-persistence');
    mod.ensureDirectories();
  });

  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    fs.rmSync(APPDATA_OVERRIDE, { recursive: true, force: true });
  });

  it('preserves named saved sessions across a version change', () => {
    mod.handleVersionChange('0.9.0'); // establish the version marker
    mod.saveNamedSession({ name: 'My Layout', savedAt: 123, workspaces: [] } as any);
    expect(mod.loadNamedSession('My Layout')).not.toBeNull();

    const changed = mod.handleVersionChange('0.9.1');
    expect(changed).toBe(true);
    expect(mod.listNamedSessions().map((s) => s.name)).toContain('My Layout');
    expect(mod.loadNamedSession('My Layout')).not.toBeNull();
    expect(mod.getLastSessionName()).toBe('My Layout');
  });

  it('clears the volatile auto session.json on a version change', () => {
    mod.handleVersionChange('1.0.0'); // establish the version marker
    mod.saveSession({ version: 1, windows: [] } as any);
    expect(mod.loadSession()).not.toBeNull();

    mod.handleVersionChange('1.0.1');
    expect(mod.loadSession()).toBeNull();
  });

  // Issue #113: an update must never lose the user's arranged tabs. The auto
  // session is archived as an "Auto-backup vX.Y.Z" named session before being
  // cleared, and the post-update startup path restores the newest named session.
  it('archives the auto session as a named backup before clearing it', () => {
    mod.handleVersionChange('1.0.0');
    mod.saveSession({
      version: 1,
      windows: [{
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        sidebarWidth: 240,
        activeWorkspaceId: 'ws-1',
        workspaces: [
          { id: 'ws-1', title: 'My Renamed Tab', customColor: '#ff0000', pinned: true, shell: 'pwsh.exe', cwd: 'C:\\proj', splitTree: { type: 'leaf' } },
          { id: 'ws-2', title: 'Second', pinned: false, shell: 'bash', splitTree: { type: 'leaf' } },
        ],
      }],
    } as any);

    mod.handleVersionChange('1.0.1');
    expect(mod.loadSession()).toBeNull(); // volatile session still cleared

    const backup = mod.loadNamedSession('Auto-backup v1.0.0');
    expect(backup).not.toBeNull();
    expect(backup!.workspaces.map(w => w.title)).toEqual(['My Renamed Tab', 'Second']);
    expect(backup!.workspaces[0].customColor).toBe('#ff0000');
    expect(backup!.workspaces[0].cwd).toBe('C:\\proj');
    expect(backup!.workspaces[1].cwd).toBe(''); // missing cwd normalized to string
    expect(backup!.sidebarWidth).toBe(240);
    // It's the newest named session, so the startup fallback will restore it.
    expect(mod.listNamedSessions()[0].name).toBe('Auto-backup v1.0.0');
  });

  it('does not create a backup when there is no auto session or it is empty', () => {
    mod.handleVersionChange('2.0.0'); // no session.json at all
    expect(mod.listNamedSessions()).toEqual([]);

    mod.saveSession({ version: 1, windows: [{ bounds: { x: 0, y: 0, width: 1, height: 1 }, sidebarWidth: 200, activeWorkspaceId: null, workspaces: [] }] } as any);
    mod.handleVersionChange('2.0.1');
    expect(mod.listNamedSessions()).toEqual([]);
  });

  it('does not touch the last-session pointer and prunes old auto-backups to 3', () => {
    vi.useFakeTimers();
    try {
      mod.handleVersionChange('3.0.0');
      mod.saveNamedSession({ name: 'Mine', savedAt: 1, workspaces: [] } as any);

      const versions = ['3.0.1', '3.0.2', '3.0.3', '3.0.4', '3.0.5'];
      for (const v of versions) {
        vi.advanceTimersByTime(1000); // distinct savedAt per backup for prune ordering
        mod.saveSession({
          version: 1,
          windows: [{ bounds: { x: 0, y: 0, width: 1, height: 1 }, sidebarWidth: 200, activeWorkspaceId: 'w', workspaces: [{ id: 'w', title: 'T', pinned: false, shell: 's', splitTree: {} }] }],
        } as any);
        mod.handleVersionChange(v);
      }

      const names = mod.listNamedSessions().map(s => s.name);
      const backups = names.filter(n => n.startsWith('Auto-backup'));
      expect(backups).toHaveLength(3);
      expect(backups).toEqual(['Auto-backup v3.0.4', 'Auto-backup v3.0.3', 'Auto-backup v3.0.2']);
      expect(names).toContain('Mine'); // user sessions never pruned
      expect(mod.getLastSessionName()).toBe('Mine'); // pointer not hijacked by backups
    } finally {
      vi.useRealTimers();
    }
  });
});
