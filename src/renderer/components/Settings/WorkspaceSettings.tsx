import { useStore } from '../../store';

export default function WorkspaceSettings() {
  const { workspacePrefs, setWorkspacePrefs } = useStore();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Workspace Behaviour</h3>

      <div className="settings-row">
        <label className="settings-label">New workspace placement</label>
        <select
          className="settings-select"
          value={workspacePrefs.newWorkspacePlacement}
          onChange={(e) =>
            setWorkspacePrefs({
              newWorkspacePlacement: e.target.value as 'afterCurrent' | 'top' | 'end',
            })
          }
        >
          <option value="afterCurrent">After Current</option>
          <option value="top">Top</option>
          <option value="end">End</option>
        </select>
      </div>

      <div className="settings-row">
        <label className="settings-label">Auto-reorder on notification</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.autoReorderOnNotification}
          onChange={(e) => setWorkspacePrefs({ autoReorderOnNotification: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Show welcome screen on startup</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.showWelcomeScreen}
          onChange={(e) => setWorkspacePrefs({ showWelcomeScreen: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Confirm before closing a session</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.confirmWorkspaceClose}
          onChange={(e) => setWorkspacePrefs({ confirmWorkspaceClose: e.target.checked })}
        />
      </div>
      <p className="settings-hint">
        Ask before the × button, the context menu or Ctrl+Shift+W closes a session — a stray click
        can&apos;t take down agents that haven&apos;t saved their state yet. Closes from the CLI and
        agents never prompt.
      </p>

      <div className="settings-row">
        <label className="settings-label">Auto-open diff tab on agent edits</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.autoOpenDiffTab}
          onChange={(e) => setWorkspacePrefs({ autoOpenDiffTab: e.target.checked })}
        />
      </div>
      <p className="settings-hint">
        When Claude edits or writes files, wmux pops a diff tab in the bottom pane. Turn this off to
        stop it appearing.
      </p>

      <div className="settings-divider" />
      <h3 className="settings-section-title">Shell</h3>

      <div className="settings-row">
        <label className="settings-label">Default shell</label>
        <select
          className="settings-select"
          value={workspacePrefs.defaultShell}
          onChange={(e) => setWorkspacePrefs({ defaultShell: e.target.value })}
        >
          <option value="">System default</option>
          <option value="powershell.exe">PowerShell</option>
          <option value="pwsh.exe">PowerShell Core</option>
          <option value="cmd.exe">Command Prompt</option>
          <option value="bash.exe">Git Bash</option>
          <option value="wsl.exe">WSL</option>
        </select>
      </div>
    </div>
  );
}
