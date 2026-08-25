import { useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { getAllPaneIds, findLeaf, patchLeafPrimarySurface } from '../../store/split-utils';
import type { PaneId } from '../../../shared/types';

/**
 * One editable startup-command line for a saved layout's pane.
 *
 * Extracted, along with PaneCommandGroup below, because the saved-layout editor
 * is three nested lists — layouts → panes → command lines — and the handlers on
 * the innermost input then sit five callbacks deep inside the component. Each
 * list level becoming its own component puts every callback back within one
 * level of something named.
 */
function PaneCommandRow({ value, removable, onChange, onBlur, onRemove }: {
  value: string;
  removable: boolean;
  onChange: (next: string) => void;
  onBlur: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="ql-profile__pane">
      <input
        className="settings-input ql-profile__commands"
        value={value}
        placeholder={t('settings.workspacePanel.paneCommandPlaceholder', 'Command to run on start (optional)')}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {removable && (
        <button
          className="ql-profile__line-remove"
          onClick={onRemove}
          title={t('settings.workspacePanel.removeCommandLine', 'Remove this line')}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** The command lines belonging to one pane of one saved layout. */
function PaneCommandGroup({
  paneNumber, commands, justSaved, onSetCommandAt, onConfirmSaved, onRemoveCommandAt, onAddLine,
}: {
  paneNumber: number;
  commands: string[];
  justSaved: boolean;
  onSetCommandAt: (index: number, value: string) => void;
  onConfirmSaved: () => void;
  onRemoveCommandAt: (index: number) => void;
  onAddLine: () => void;
}) {
  const t = useT();
  // Always at least one (empty) row so there's somewhere to type a first
  // command — but never more rows than commands that actually exist, and never
  // fewer: every row is real, editable data, not a summary of it.
  const rows = commands.length > 0 ? commands : [''];
  return (
    <div className="ql-profile__pane-group">
      <div className="ql-profile__pane-header">
        <span className="ql-profile__pane-label">
          {t('settings.workspacePanel.paneLabel', 'Pane {n}').replace('{n}', String(paneNumber))}
        </span>
        {justSaved && (
          <span className="ql-profile__saved">{t('settings.workspacePanel.overwritten', 'Saved ✓')}</span>
        )}
      </div>
      {rows.map((cmd, cmdIndex) => (
        <PaneCommandRow
          key={cmdIndex}
          value={cmd}
          removable={commands.length > 0}
          onChange={(next) => onSetCommandAt(cmdIndex, next)}
          onBlur={onConfirmSaved}
          onRemove={() => onRemoveCommandAt(cmdIndex)}
        />
      ))}
      <button className="ql-profile__add-line" onClick={onAddLine}>
        + {t('settings.workspacePanel.addCommandLine', 'Add line')}
      </button>
    </div>
  );
}

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
        <label className="settings-label">{t('settings.workspacePanel.restoreClaudeSessions', 'Resume Claude Code sessions on restore')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.restoreClaudeSessions}
          onChange={(e) => setWorkspacePrefs({ restoreClaudeSessions: e.target.checked })}
        />
      </div>
      <p className="settings-hint">
        {t(
          'settings.workspacePanel.restoreClaudeSessionsHint',
          'When wmux restores a session, re-launch each terminal that was running Claude Code with `claude --resume`, in the directory it was in. Off by default: every such pane starts an agent at once. Panes whose conversation Claude no longer has are skipped, and a Claude you exited cleanly is not resumed.',
        )}
      </p>

      <div className="settings-row">
        <label className="settings-label">{t('settings.workspacePanel.detectAgentScreens', 'Read agent screens to infer state')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.detectAgentScreens}
          onChange={(e) => setWorkspacePrefs({ detectAgentScreens: e.target.checked })}
        />
      </div>
      <p className="settings-hint">
        {t(
          'settings.workspacePanel.detectAgentScreensHint',
          'For agents that do not report state themselves (Codex, Gemini, Aider…), match their on-screen UI against bundled rules to tell blocked from working. Runs entirely on this machine and never overrides what an agent declares — panes whose agent reports are skipped without being read at all. Override the rules in %APPDATA%\\wmux\\agent-detection, and use `wmux detect explain` to see which rule fired.',
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
                {panes.map(({ paneId, index, leaf }) => (
                  <PaneCommandGroup
                    key={paneId}
                    paneNumber={index + 1}
                    commands={leaf?.surfaces[0]?.startupCommands ?? []}
                    justSaved={justSavedPaneKey === `${layout.id}:${paneId}`}
                    onSetCommandAt={(i, value) => setPaneCommandAt(layout.id, paneId, i, value)}
                    onConfirmSaved={() => confirmPaneSaved(layout.id, paneId)}
                    onRemoveCommandAt={(i) => removePaneCommandAt(layout.id, paneId, i)}
                    onAddLine={() => addPaneCommandLine(layout.id, paneId)}
                  />
                ))}
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
