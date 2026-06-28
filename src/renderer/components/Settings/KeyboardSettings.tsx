import { useStore } from '../../store';
import { ShortcutAction, ShortcutBinding } from '../../store/settings-slice';
import ShortcutRecorder from './ShortcutRecorder';

// Human-readable labels for each action
export const ACTION_LABELS: Record<ShortcutAction, string> = {
  newWorkspace: 'New workspace',
  newWindow: 'New window',
  closeWorkspace: 'Close workspace',
  closeWindow: 'Close window',
  openFolder: 'Open folder',
  toggleSidebar: 'Toggle sidebar',
  nextWorkspace: 'Next workspace',
  prevWorkspace: 'Previous workspace',
  renameSurface: 'Rename surface',
  renameWorkspace: 'Rename workspace',
  splitRight: 'Split right',
  splitDown: 'Split down',
  splitBrowserRight: 'Split browser right',
  splitBrowserDown: 'Split browser down',
  toggleZoom: 'Toggle zoom',
  focusLeft: 'Focus left',
  focusRight: 'Focus right',
  focusUp: 'Focus up',
  focusDown: 'Focus down',
  closeSurfaceOrPane: 'Close surface or pane',
  newSurface: 'New surface (tab)',
  nextSurface: 'Next surface',
  prevSurface: 'Previous surface',
  jumpToUnread: 'Jump to unread',
  showNotifications: 'Show notifications',
  flashFocused: 'Flash focused pane',
  openBrowser: 'Open browser',
  browserDevTools: 'Browser DevTools',
  browserConsole: 'Browser console',
  find: 'Find',
  copyMode: 'Copy mode',
  copy: 'Copy',
  paste: 'Paste',
  fontSizeIncrease: 'Increase font size',
  fontSizeDecrease: 'Decrease font size',
  fontSizeReset: 'Reset font size',
  openSettings: 'Open settings',
  commandPalette: 'Command palette',
  openMarkdownPanel: 'Open markdown panel',
  reopenClosedSurface: 'Reopen closed tab',
  findNext: 'Find next',
  findPrevious: 'Find previous',
  resizePaneLeft: 'Resize pane left',
  resizePaneRight: 'Resize pane right',
  resizePaneUp: 'Resize pane up',
  resizePaneDown: 'Resize pane down',
  broadcastInput: 'Broadcast input to all panes',
  togglePinWorkspace: 'Pin / unpin workspace',
  markWorkspaceRead: 'Mark workspace read',
  toggleShortcutCheatSheet: 'Shortcut cheat-sheet',
};

export default function KeyboardSettings() {
  const { shortcuts, resetShortcuts } = useStore();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Keyboard Shortcuts</h3>

      <div className="shortcut-list">
        {(Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][]).map(
          ([action, binding]) => (
            <div key={action} className="shortcut-row">
              <span className="shortcut-action-label">
                {ACTION_LABELS[action] ?? action}
              </span>
              <ShortcutRecorder action={action} binding={binding} />
            </div>
          ),
        )}
      </div>

      <div className="shortcut-footer">
        <button className="settings-btn settings-btn--danger" onClick={resetShortcuts}>
          Reset All
        </button>
      </div>
    </div>
  );
}
