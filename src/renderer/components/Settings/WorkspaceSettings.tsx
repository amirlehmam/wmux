import { useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { getAllPaneIds, findLeaf, patchLeafPrimarySurface } from '../../store/split-utils';
import type { PaneId } from '../../../shared/types';

export default function WorkspaceSettings() {
  const t = useT();
  const {
    workspacePrefs, setWorkspacePrefs,
    savedLayouts, setSavedLayouts, saveCurrentLayoutAsPreset, updateLayoutFromCurrent,
  } = useStore();
  // Which layout id was just overwritten, for a transient "Saved" confirmation
  // next to its button — unlike "+ Save as new preset", overwriting an
  // existing row changes data invisibly (the row itself doesn't change shape).
  const [justSavedId, setJustSavedId] = useState<string | null>(null);
  // Keyed by `${layoutId}:${paneId}`, not paneId alone — saving the same
  // workspace as a preset twice keeps the live pane ids on both copies
  // (freezeSurfaceCwds doesn't remint them), so a bare paneId key would flash
  // "Saved" on the matching row in every such preset at once.
  const [justSavedPaneKey, setJustSavedPaneKey] = useState<string | null>(null);
  const confirmPaneSaved = (layoutId: string, paneId: PaneId) => {
    const key = `${layoutId}:${paneId}`;
    setJustSavedPaneKey(key);
    setTimeout(() => setJustSavedPaneKey((cur) => (cur === key ? null : cur)), 1400);
  };
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const renameLayout = (id: string, name: string) => {
    setSavedLayouts(savedLayouts.map((l) => (l.id === id ? { ...l, name } : l)));
  };
  const removeLayout = (id: string) => {
    setSavedLayouts(savedLayouts.filter((l) => l.id !== id));
    if (workspacePrefs.defaultLayoutId === id) setWorkspacePrefs({ defaultLayoutId: null });
  };
  const saveCurrent = () => {
    saveCurrentLayoutAsPreset(
      t('settings.workspacePanel.newLayoutName', 'Layout {n}').replace('{n}', String(savedLayouts.length + 1)),
    );
  };
  const overwriteLayout = (id: string) => {
    if (!updateLayoutFromCurrent(id)) return;
    setJustSavedId(id);
    setTimeout(() => setJustSavedId((cur) => (cur === id ? null : cur)), 1800);
  };
  // Every command a pane carries is its own editable row — no row is ever
  // hidden behind a count badge. A pane captured from a live workspace can
  // have more than one startupCommand (Quick Launch profiles support a
  // multi-line list); showing only the first and silently preserving the
  // rest was implicit state a user editing "the command" had no way to see
  // or change. transform() reads the CURRENT array fresh each call so
  // add/remove/edit never race a stale closure.
  const transformPaneCommands = (layoutId: string, paneId: PaneId, transform: (commands: string[]) => string[]) => {
    setSavedLayouts(savedLayouts.map((l) => {
      if (l.id !== layoutId) return l;
      const current = findLeaf(l.splitTree, paneId)?.surfaces[0]?.startupCommands ?? [];
      return { ...l, splitTree: patchLeafPrimarySurface(l.splitTree, paneId, { startupCommands: transform(current) }) };
    }));
  };
  const setPaneCommandAt = (layoutId: string, paneId: PaneId, index: number, text: string) => {
    // text stored AS TYPED (not trimmed) — same reason as before: this fires
    // on every keystroke, and trimming here strips a just-typed trailing
    // space before the next render snaps the controlled input back.
    transformPaneCommands(layoutId, paneId, (cmds) => cmds.map((c, i) => (i === index ? text : c)));
  };
  const removePaneCommandAt = (layoutId: string, paneId: PaneId, index: number) => {
    transformPaneCommands(layoutId, paneId, (cmds) => cmds.filter((_, i) => i !== index));
  };
  const addPaneCommandLine = (layoutId: string, paneId: PaneId) => {
    transformPaneCommands(layoutId, paneId, (cmds) => [...cmds, '']);
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.workspacePanel.behaviourSection', 'Workspace Behaviour')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.workspacePanel.newPlacement', 'New workspace placement')}</label>
        <select
          className="settings-select"
          value={workspacePrefs.newWorkspacePlacement}
          onChange={(e) =>
            setWorkspacePrefs({
              newWorkspacePlacement: e.target.value as 'afterCurrent' | 'top' | 'end',
            })
          }
        >
          <option value="afterCurrent">{t('settings.workspacePanel.placement.afterCurrent', 'After Current')}</option>
          <option value="top">{t('settings.workspacePanel.placement.top', 'Top')}</option>
          <option value="end">{t('settings.workspacePanel.placement.end', 'End')}</option>
        </select>
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.workspacePanel.autoReorder', 'Auto-reorder on notification')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.autoReorderOnNotification}
          onChange={(e) => setWorkspacePrefs({ autoReorderOnNotification: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.workspacePanel.showWelcomeScreen', 'Show welcome screen on startup')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.showWelcomeScreen}
          onChange={(e) => setWorkspacePrefs({ showWelcomeScreen: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.workspacePanel.confirmClose', 'Confirm before closing a session')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.confirmWorkspaceClose}
          onChange={(e) => setWorkspacePrefs({ confirmWorkspaceClose: e.target.checked })}
        />
      </div>
      <p className="settings-hint">
        {t(
          'settings.workspacePanel.confirmCloseHint',
          "Ask before the × button, the context menu or Ctrl+Shift+W closes a session — a stray click can't take down agents that haven't saved their state yet. Closes from the CLI and agents never prompt.",
        )}
      </p>

      <div className="settings-row">
        <label className="settings-label">{t('settings.workspacePanel.autoOpenDiff', 'Auto-open diff tab on agent edits')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.autoOpenDiffTab}
          onChange={(e) => setWorkspacePrefs({ autoOpenDiffTab: e.target.checked })}
        />
      </div>
      <p className="settings-hint">
        {t(
          'settings.workspacePanel.autoOpenDiffHint',
          'When Claude edits or writes files, wmux pops a diff tab in the bottom pane. Turn this off to stop it appearing.',
        )}
      </p>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.workspacePanel.shellSection', 'Shell')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.workspacePanel.defaultShell', 'Default shell')}</label>
        <select
          className="settings-select"
          value={workspacePrefs.defaultShell}
          onChange={(e) => setWorkspacePrefs({ defaultShell: e.target.value })}
        >
          <option value="">{t('settings.workspacePanel.shell.systemDefault', 'System default')}</option>
          <option value="powershell.exe">PowerShell</option>
          <option value="pwsh.exe">PowerShell Core</option>
          <option value="cmd.exe">Command Prompt</option>
          <option value="bash.exe">Git Bash</option>
          <option value="wsl.exe">WSL</option>
        </select>
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.workspacePanel.layoutsSection', 'Saved Layouts')}</h3>
      <p className="settings-hint settings-hint--lead">
        {t(
          'settings.workspacePanel.layoutsHint',
          'Arrange panes the way you like in a workspace — geometry, plus whatever shell or command each pane is already running — then save that arrangement here.',
        )}
      </p>

      {savedLayouts.length === 0 && (
        <p className="settings-hint">
          {t(
            'settings.workspacePanel.noLayoutsYet',
            'No saved layouts yet — Ctrl+N and the CLI open a single pane; the sidebar "+" button and first launch use wmux\'s built-in layout.',
          )}
        </p>
      )}

      {savedLayouts.map((layout) => {
        const panes = getAllPaneIds(layout.splitTree).map((paneId, i) => ({
          paneId,
          index: i,
          leaf: findLeaf(layout.splitTree, paneId),
        }));
        return (
          <div key={layout.id} className="ql-profile">
            <div className="ql-profile__head">
              <input
                className="settings-input ql-profile__name"
                value={layout.name}
                placeholder={t('settings.quickLaunch.namePlaceholder', 'Name')}
                onChange={(e) => renameLayout(layout.id, e.target.value)}
              />
              <label className="ql-profile__checkbox-label">
                <input
                  type="checkbox"
                  checked={workspacePrefs.defaultLayoutId === layout.id}
                  onChange={(e) => setWorkspacePrefs({ defaultLayoutId: e.target.checked ? layout.id : null })}
                />
                {t('settings.workspacePanel.setDefault', 'Default')}
              </label>
              <button className="settings-button" onClick={() => overwriteLayout(layout.id)}>
                {t('settings.workspacePanel.overwriteLayout', 'Set to Current Layout')}
              </button>
              {justSavedId === layout.id && (
                <span className="ql-profile__saved">{t('settings.workspacePanel.overwritten', 'Saved ✓')}</span>
              )}
              <button className="settings-button settings-button--danger" onClick={() => removeLayout(layout.id)}>
                {t('settings.quickLaunch.remove', 'Remove')}
              </button>
            </div>

            {panes.length > 0 && (
              <button className="ql-profile__toggle" onClick={() => toggleExpanded(layout.id)}>
                {expandedIds.has(layout.id) ? '▾' : '▸'} {t('settings.workspacePanel.startupCommandsToggle', 'Startup commands')}
              </button>
            )}

            {expandedIds.has(layout.id) && panes.length > 0 && (
              <div className="ql-profile__fields">
                {panes.map(({ paneId, index, leaf }) => {
                  const commands = leaf?.surfaces[0]?.startupCommands ?? [];
                  // Always at least one (empty) row so there's somewhere to type
                  // a first command — but never more rows than commands that
                  // actually exist, and never fewer: every row is real, editable
                  // data, not a summary of it.
                  const rows = commands.length > 0 ? commands : [''];
                  return (
                    <div key={paneId} className="ql-profile__pane-group">
                      <div className="ql-profile__pane-header">
                        <span className="ql-profile__pane-label">
                          {t('settings.workspacePanel.paneLabel', 'Pane {n}').replace('{n}', String(index + 1))}
                        </span>
                        {justSavedPaneKey === `${layout.id}:${paneId}` && (
                          <span className="ql-profile__saved">{t('settings.workspacePanel.overwritten', 'Saved ✓')}</span>
                        )}
                      </div>
                      {rows.map((cmd, cmdIndex) => (
                        <div key={cmdIndex} className="ql-profile__pane">
                          <input
                            className="settings-input ql-profile__commands"
                            value={cmd}
                            placeholder={t('settings.workspacePanel.paneCommandPlaceholder', 'Command to run on start (optional)')}
                            onChange={(e) => setPaneCommandAt(layout.id, paneId, cmdIndex, e.target.value)}
                            onBlur={() => confirmPaneSaved(layout.id, paneId)}
                          />
                          {commands.length > 0 && (
                            <button
                              className="ql-profile__line-remove"
                              onClick={() => removePaneCommandAt(layout.id, paneId, cmdIndex)}
                              title={t('settings.workspacePanel.removeCommandLine', 'Remove this line')}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                      <button className="ql-profile__add-line" onClick={() => addPaneCommandLine(layout.id, paneId)}>
                        + {t('settings.workspacePanel.addCommandLine', 'Add line')}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="settings-row">
        <button className="settings-button" onClick={saveCurrent}>
          {t('settings.workspacePanel.saveCurrentLayout', '+ Save current layout as preset')}
        </button>
        {workspacePrefs.defaultLayoutId !== null && (
          <button className="settings-button" onClick={() => setWorkspacePrefs({ defaultLayoutId: null })}>
            {t('settings.workspacePanel.restoreAppDefault', 'Restore app default')}
          </button>
        )}
      </div>
    </div>
  );
}
