import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { cwdReportPatch, isPosixPath, isWslShell, workspaceFallbackCwd } from '../../src/shared/paths';
import { WorkspaceId } from '../../src/shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// One workspace, two filesystems.
//
// A workspace can hold a pwsh pane and a WSL pane side by side, and both report
// their directory over the same `report_pwd`. `workspace.cwd` was a single
// last-writer-wins field, so the pwsh pane's C:\Users\<user> overwrote the
// POSIX path — and since a plain WSL pane never reports its own cwd (wmux sets
// WMUX_INTEGRATION=1 in the distro but installs no rc hook there), the next WSL
// pane fell back to that Win32 path, failed isPosixPath, and got `--cd ~`.
// Users saw every new WSL pane open in /home/<user> instead of the project.
//
// `posixCwd` is the same medicine issue #134 applied per-terminal: stop making
// one field answer for two namespaces.
// ─────────────────────────────────────────────────────────────────────────────

function makeStore() {
  return create<WorkspaceSlice>()((...args) => ({ ...createWorkspaceSlice(...args) }));
}

function wsById(store: ReturnType<typeof makeStore>, id: WorkspaceId) {
  return store.getState().workspaces.find((w) => w.id === id)!;
}

describe('isPosixPath', () => {
  it('accepts a WSL/devcontainer path', () => {
    expect(isPosixPath('/home/lsi2abt/agent/ms-container-feature-agent1')).toBe(true);
  });

  it('rejects a drive-rooted Win32 path', () => {
    expect(isPosixPath('C:\\Users\\lsi2abt')).toBe(false);
  });

  it('rejects a UNC path — a leading // is a server, not a POSIX root', () => {
    expect(isPosixPath('//server/share')).toBe(false);
  });
});

describe('isWslShell', () => {
  it('recognises the shell spec wmux spawns WSL panes with', () => {
    expect(isWslShell('wsl.exe')).toBe(true);
    expect(isWslShell('C:\\Windows\\System32\\wsl.exe -d Ubuntu')).toBe(true);
  });

  it('does not claim a Win32 shell', () => {
    expect(isWslShell('powershell.exe')).toBe(false);
    expect(isWslShell(undefined)).toBe(false);
  });

  it('does not guess POSIX for a remote command line (issue #78)', () => {
    // wmux has no idea where `ssh user@host` lands; handing it a POSIX path
    // would be a guess, and a wrong one whenever the far end is Windows.
    expect(isWslShell('ssh user@host')).toBe(false);
  });
});

describe('cwdReportPatch', () => {
  it('records a POSIX report in both fields', () => {
    expect(cwdReportPatch('/home/u/proj')).toEqual({ cwd: '/home/u/proj', posixCwd: '/home/u/proj' });
  });

  it('omits posixCwd entirely for a Win32 report', () => {
    const patch = cwdReportPatch('C:\\Users\\lsi2abt');
    expect(patch).toEqual({ cwd: 'C:\\Users\\lsi2abt' });
    // Present-but-undefined would still clear the field when the patch is
    // spread into the workspace, so absence of the key is the contract.
    expect('posixCwd' in patch).toBe(false);
  });

  it('omits posixCwd for an empty report rather than blanking it', () => {
    expect('posixCwd' in cwdReportPatch(undefined)).toBe(false);
    expect('posixCwd' in cwdReportPatch('')).toBe(false);
  });
});

describe('a powershell report_pwd does not clear a recorded posixCwd', () => {
  it('leaves posixCwd intact while cwd follows the latest prompt', () => {
    const store = makeStore();
    const id = store.getState().createWorkspace({ title: 'ms-playbook-agent2', shell: 'wsl.exe' });

    // The WSL pane reports first…
    store.getState().updateWorkspaceMetadata(id, cwdReportPatch('/home/lsi2abt/agent/ms-playbook-agent2'));
    expect(wsById(store, id).posixCwd).toBe('/home/lsi2abt/agent/ms-playbook-agent2');

    // …then the pwsh pane in the same workspace reports. This is the exact
    // sequence that produced `cwd: "C:\\Users\\lsi2abt"` in a real session.json.
    store.getState().updateWorkspaceMetadata(id, cwdReportPatch('C:\\Users\\lsi2abt'));

    expect(wsById(store, id).cwd).toBe('C:\\Users\\lsi2abt');
    expect(wsById(store, id).posixCwd).toBe('/home/lsi2abt/agent/ms-playbook-agent2');
  });
});

describe('workspaceFallbackCwd', () => {
  const polluted = { cwd: 'C:\\Users\\lsi2abt', posixCwd: '/home/lsi2abt/agent/ms-playbook-agent2' };

  it('gives a WSL surface the POSIX path even when cwd holds a Win32 one', () => {
    expect(workspaceFallbackCwd('wsl.exe', polluted)).toBe('/home/lsi2abt/agent/ms-playbook-agent2');
  });

  it('still gives a Win32 surface the Win32 path', () => {
    expect(workspaceFallbackCwd('powershell.exe', polluted)).toBe('C:\\Users\\lsi2abt');
  });

  it('falls back to a POSIX cwd for a WSL surface when posixCwd was never set', () => {
    // Sessions written before posixCwd existed, and workspaces whose panes are
    // all POSIX, have the right answer sitting in `cwd`.
    expect(workspaceFallbackCwd('wsl.exe', { cwd: '/home/u/proj' })).toBe('/home/u/proj');
  });

  it('returns undefined rather than handing wsl.exe a path it cannot open', () => {
    // `--cd C:\Users\lsi2abt` is not something wsl.exe can honour, so there is
    // nothing to gain by passing it; undefined keeps "we do not know" legible.
    expect(workspaceFallbackCwd('wsl.exe', { cwd: 'C:\\Users\\lsi2abt' })).toBeUndefined();
  });

  it('returns undefined for a surface with no workspace', () => {
    expect(workspaceFallbackCwd('wsl.exe', null)).toBeUndefined();
    expect(workspaceFallbackCwd('wsl.exe', undefined)).toBeUndefined();
  });
});

describe('createWorkspace seeds posixCwd', () => {
  it('derives it from a POSIX cwd, so a folder-opened workspace is correct from birth', () => {
    const store = makeStore();
    const id = store.getState().createWorkspace({ title: 'p', shell: 'wsl.exe', cwd: '/home/u/proj' });
    expect(wsById(store, id).posixCwd).toBe('/home/u/proj');
  });

  it('leaves it unset for a Win32 cwd', () => {
    const store = makeStore();
    const id = store.getState().createWorkspace({ title: 'p', shell: 'powershell.exe', cwd: 'C:\\dev\\proj' });
    expect(wsById(store, id).posixCwd).toBeUndefined();
  });

  it('prefers an explicit posixCwd over the derived one', () => {
    const store = makeStore();
    const id = store.getState().createWorkspace({
      title: 'p',
      shell: 'wsl.exe',
      cwd: 'C:\\dev\\proj',
      posixCwd: '/home/u/proj',
    });
    expect(wsById(store, id).posixCwd).toBe('/home/u/proj');
  });
});

describe('posixCwd round-trips through save → replaceAllWorkspaces', () => {
  it('restores a saved posixCwd verbatim', () => {
    const store = makeStore();
    store.getState().replaceAllWorkspaces([
      {
        title: 'ms-playbook-agent2',
        shell: 'wsl.exe',
        cwd: 'C:\\Users\\lsi2abt',
        posixCwd: '/home/lsi2abt/agent/ms-playbook-agent2',
      },
    ]);
    const ws = store.getState().workspaces[0];
    expect(ws.posixCwd).toBe('/home/lsi2abt/agent/ms-playbook-agent2');
    expect(workspaceFallbackCwd('wsl.exe', ws)).toBe('/home/lsi2abt/agent/ms-playbook-agent2');
  });

  it('repairs a session written before posixCwd existed, when cwd is POSIX', () => {
    // This is what rescues the user's already-saved workspaces without asking
    // them to recreate a tab: the seed runs on every restore, not just on create.
    const store = makeStore();
    store.getState().replaceAllWorkspaces([
      { title: 'p', shell: 'wsl.exe', cwd: '/home/u/proj' },
    ]);
    expect(store.getState().workspaces[0].posixCwd).toBe('/home/u/proj');
  });

  it('cannot invent a POSIX path when the saved cwd is Win32', () => {
    // A workspace whose cwd was already clobbered before the fix shipped has no
    // POSIX path recorded anywhere; it recovers on the next WSL report, not here.
    const store = makeStore();
    store.getState().replaceAllWorkspaces([
      { title: 'p', shell: 'wsl.exe', cwd: 'C:\\Users\\lsi2abt' },
    ]);
    expect(store.getState().workspaces[0].posixCwd).toBeUndefined();
  });
});
