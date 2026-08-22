import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { findNodeRuntime, getNodeRuntime, resetNodeRuntimeCache } from '../../src/main/node-runtime';

/**
 * Issue #187: wmux hands agents a `.js` path (`WMUX_CLI`) and assumed everyone
 * downstream had something to run it with. Nobody does, reliably.
 */
const only = (...present: string[]) => (p: string) => present.includes(p);

describe('findNodeRuntime', () => {
  it('uses the host process when the host IS a JS runtime', () => {
    const found = findNodeRuntime({}, 'C:\\Program Files\\nodejs\\node.exe', 'win32', () => false);
    expect(found).toEqual({ path: 'C:\\Program Files\\nodejs\\node.exe', electron: false });
  });

  it('does NOT accept OpenCode as a JS runtime — the whole of #187', () => {
    // `opencode.exe wmux.js agent-activity --active` prints OpenCode's help.
    const exec = 'C:\\Users\\stefan\\.opencode\\bin\\opencode.exe';
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const found = findNodeRuntime(
      { ProgramFiles: 'C:\\Program Files' },
      exec,
      'win32',
      only(nodePath),
    );
    expect(found).toEqual({ path: nodePath, electron: false });
  });

  it('does not accept Electron either (it needs ELECTRON_RUN_AS_NODE)', () => {
    const found = findNodeRuntime({}, 'C:\\wmux\\wmux.exe', 'win32', () => false);
    expect(found).toBeNull();
  });

  it('prefers PATH over the well-known install dirs', () => {
    const onPath = 'C:\\nvm\\v22\\node.exe';
    const found = findNodeRuntime(
      { Path: 'C:\\nvm\\v22', ProgramFiles: 'C:\\Program Files' },
      'C:\\x\\opencode.exe',
      'win32',
      only(onPath, 'C:\\Program Files\\nodejs\\node.exe'),
    );
    expect(found?.path).toBe(onPath);
  });

  it('finds node installed but absent from PATH — the reported machine', () => {
    const installed = path.join('C:\\Users\\stefan\\AppData\\Local', 'Programs', 'nodejs', 'node.exe');
    const found = findNodeRuntime(
      { Path: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\stefan\\AppData\\Local' },
      'C:\\x\\opencode.exe',
      'win32',
      only(installed),
    );
    expect(found?.path).toBe(installed);
  });

  it('accepts bun, which is a JS runtime even though it is not node', () => {
    const bun = path.join('/home/x/.bun/bin', 'bun');
    const found = findNodeRuntime({ HOME: '/home/x' }, '/opt/opencode', 'linux', only(bun));
    expect(found?.path).toBe(bun);
  });

  it('reads PATH under any casing — Windows spells it `Path`', () => {
    // path.join, not a literal: the separator is the HOST's, and wmux runs on
    // Windows even when the case under test describes a posix layout.
    const nodePath = path.join('/usr/bin', 'node');
    const found = findNodeRuntime({ Path: '/usr/bin' }, '/opt/opencode', 'linux', only(nodePath));
    expect(found?.path).toBe(nodePath);
  });

  it('returns null when the machine really has no JS runtime', () => {
    expect(findNodeRuntime({ Path: '/usr/bin' }, '/opt/opencode', 'linux', () => false)).toBeNull();
  });
});

describe('getNodeRuntime', () => {
  it('never dead-ends: falls back to wmux itself, flagged as Electron', () => {
    resetNodeRuntimeCache();
    const runtime = getNodeRuntime();
    expect(runtime.path).toBeTruthy();
    // Under vitest the host IS node, so this resolves to the host — the point
    // of the assertion is that `electron` is only ever true for process.execPath.
    if (runtime.electron) expect(runtime.path).toBe(process.execPath);
  });

  it('memoises — it is read on the synchronous pane-create path (#176)', () => {
    resetNodeRuntimeCache();
    expect(getNodeRuntime()).toBe(getNodeRuntime());
  });
});
