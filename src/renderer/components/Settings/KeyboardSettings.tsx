import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { ShortcutAction, ShortcutBinding } from '../../store/settings-slice';
import ShortcutRecorder from './ShortcutRecorder';
import ShortcutFilterCapture from './ShortcutFilterCapture';
import { bindingsEqual } from '../../utils/shortcut-binding';
import {
  INDEX_MODIFIER_CHOICES,
  IndexModifiers,
  formatIndexShortcut,
} from '../../utils/index-shortcuts';

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
  jumpToBlocked: 'Jump to agent needing you',
  openAgentNavigator: 'All agents',
  openHub: 'Agent office',
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
  toggleMarkdownSource: 'Toggle markdown source view',
  openDiffPanel: 'Open diff panel',
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
  resetTerminal: 'Reset terminal state',
  togglePromptOutline: 'Prompt outline',
  togglePinnedPrompt: 'Pin / unpin prompt',
  followOutput: 'Follow output',
};

/** Translated label for an action, falling back to the English `ACTION_LABELS` map. */
export function actionLabel(action: ShortcutAction, t: (key: TranslationKey, fallback?: string) => string): string {
  return t(`shortcutAction.${action}` as TranslationKey, ACTION_LABELS[action] ?? action);
}

/** Render a binding as "Ctrl+Shift+T". Shared with the shortcut cheat-sheet
 *  (F1) so both views always show the user's live (possibly remapped) bindings. */
export function formatBinding(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join('+');
}

/** Group every action under a readable category. Actions absent here fall under
 *  "Other", so newly-added shortcuts still appear without touching this map.
 *  Shared with the cheat-sheet (F1) so the two views can never drift. */
export const CATEGORY: Partial<Record<ShortcutAction, string>> = {
  newWorkspace: 'Workspaces', closeWorkspace: 'Workspaces', nextWorkspace: 'Workspaces',
  prevWorkspace: 'Workspaces', renameWorkspace: 'Workspaces', jumpToUnread: 'Workspaces',
  togglePinWorkspace: 'Workspaces', markWorkspaceRead: 'Workspaces', openFolder: 'Workspaces',
  newWindow: 'Workspaces', closeWindow: 'Workspaces',
  jumpToBlocked: 'Agents', openAgentNavigator: 'Agents', openHub: 'Agents',
  newSurface: 'Tabs', nextSurface: 'Tabs', prevSurface: 'Tabs', reopenClosedSurface: 'Tabs',
  renameSurface: 'Tabs', openMarkdownPanel: 'Tabs', openDiffPanel: 'Tabs',
  toggleMarkdownSource: 'Tabs',
  splitRight: 'Panes', splitDown: 'Panes', splitBrowserRight: 'Panes', splitBrowserDown: 'Panes',
  focusLeft: 'Panes', focusRight: 'Panes', focusUp: 'Panes', focusDown: 'Panes',
  resizePaneLeft: 'Panes', resizePaneRight: 'Panes', resizePaneUp: 'Panes', resizePaneDown: 'Panes',
  toggleZoom: 'Panes', closeSurfaceOrPane: 'Panes', broadcastInput: 'Panes',
  find: 'Terminal', findNext: 'Terminal', findPrevious: 'Terminal', copyMode: 'Terminal',
  copy: 'Terminal', paste: 'Terminal', fontSizeIncrease: 'Terminal', fontSizeDecrease: 'Terminal',
  fontSizeReset: 'Terminal', resetTerminal: 'Terminal',
  // Issue #207. Terminal rather than View: all three act on one pane's
  // scrollback — where its prompts are, which one is pinned above it, and
  // whether the viewport chases its output — not on the window's chrome.
  togglePromptOutline: 'Terminal', togglePinnedPrompt: 'Terminal', followOutput: 'Terminal',
  toggleSidebar: 'View', showNotifications: 'View', flashFocused: 'View', openBrowser: 'View',
  browserDevTools: 'View', browserConsole: 'View', openSettings: 'View', commandPalette: 'View',
  toggleShortcutCheatSheet: 'View',
};

export const CATEGORY_ORDER = ['Workspaces', 'Tabs', 'Panes', 'Terminal', 'View', 'Other'];

/** Internal (English) category constant → its translation key. */
export const CATEGORY_LABEL_KEY: Record<string, TranslationKey> = {
  Workspaces: 'cheatSheet.category.workspaces',
  Tabs: 'cheatSheet.category.tabs',
  Panes: 'cheatSheet.category.panes',
  Terminal: 'cheatSheet.category.terminal',
  View: 'cheatSheet.category.view',
  Other: 'cheatSheet.category.other',
};

type ShortcutRow = {
  action: ShortcutAction;
  label: string;
  binding: ShortcutBinding;
  category: string;
};

/** Translation key for each modifier mode's dropdown entry. */
const INDEX_MODIFIER_LABEL_KEY: Record<IndexModifiers, TranslationKey> = {
  'ctrl': 'settings.keyboard.indexMods.ctrl',
  'alt': 'settings.keyboard.indexMods.alt',
  'ctrl-alt': 'settings.keyboard.indexMods.ctrlAlt',
  'ctrl-shift': 'settings.keyboard.indexMods.ctrlShift',
  'alt-shift': 'settings.keyboard.indexMods.altShift',
  'off': 'settings.keyboard.indexMods.off',
};

/**
 * One index-shortcut family (issue #202).
 *
 * These are not `ShortcutAction`s and have no `ShortcutRecorder`: recording a
 * combo makes no sense for a binding that spans nine keys. A modifier dropdown
 * is the whole choice — everything else about the family is fixed.
 */
function IndexShortcutRow({ labelKey, labelFallback, value, onChange }: {
  labelKey: TranslationKey;
  labelFallback: string;
  value: IndexModifiers;
  onChange: (next: IndexModifiers) => void;
}) {
  const t = useT();
  return (
    <div className="settings-row">
      <label className="settings-label">{t(labelKey, labelFallback)}</label>
      <select
        className="settings-select"
        value={value}
        onChange={(e) => onChange(e.target.value as IndexModifiers)}
      >
        {INDEX_MODIFIER_CHOICES.map((mode) => (
          <option key={mode} value={mode}>
            {t(INDEX_MODIFIER_LABEL_KEY[mode], formatIndexShortcut(mode) ?? 'Disabled')}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function KeyboardSettings() {
  const t = useT();
  const shortcuts = useStore((s) => s.shortcuts);
  const resetShortcuts = useStore((s) => s.resetShortcuts);
  const keyboardPrefs = useStore((s) => s.keyboardPrefs);
  const setKeyboardPrefs = useStore((s) => s.setKeyboardPrefs);
  const [query, setQuery] = useState('');
  const [bindingFilter, setBindingFilter] = useState<ShortcutBinding | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Group + filter, bucketed by category and sorted alphabetically within
  // each bucket, same as the shortcut cheat-sheet's (F1) behaviour. Unlike
  // the cheat sheet, name and shortcut are two independent filters (AND):
  // the text field matches only the translated label, the capture control
  // matches the binding exactly. The number-row families (issue #202) are not
  // ShortcutActions and have no ShortcutRecorder, so neither filter reaches
  // them — they get their own section below the list.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows: ShortcutRow[] = (Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][])
      .map(([action, binding]) => ({
        action,
        label: actionLabel(action, t),
        binding,
        category: CATEGORY[action] ?? 'Other',
      }))
      .filter((r) => {
        if (q && !r.label.toLowerCase().includes(q)) return false;
        if (bindingFilter && !bindingsEqual(r.binding, bindingFilter)) return false;
        return true;
      });

    const byCategory = new Map<string, ShortcutRow[]>();
    for (const row of rows) {
      const list = byCategory.get(row.category) ?? [];
      list.push(row);
      byCategory.set(row.category, list);
    }

    return CATEGORY_ORDER
      .filter((c) => byCategory.has(c))
      .map((c) => ({ category: c, rows: byCategory.get(c)!.sort((a, b) => a.label.localeCompare(b.label)) }));
  }, [shortcuts, query, bindingFilter, t]);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.keyboard.title', 'Keyboard Shortcuts')}</h3>

      <div className="shortcut-search-row">
        <input
          ref={inputRef}
          className="settings-input shortcut-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('settings.keyboard.searchByName', 'Search by name…')}
          aria-label={t('settings.keyboard.searchByName', 'Search by name…')}
        />
        <ShortcutFilterCapture value={bindingFilter} onChange={setBindingFilter} />
      </div>

      {groups.length === 0 ? (
        <div className="shortcut-empty">
          {t('settings.keyboard.noMatch', 'No shortcuts match your search.')}
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.category} className="shortcut-group">
            <h4 className="shortcut-group-title">
              {t(CATEGORY_LABEL_KEY[group.category] ?? 'cheatSheet.category.other', group.category)}
            </h4>
            <div className="shortcut-list">
              {group.rows.map((row) => (
                <div key={row.action} className="shortcut-row">
                  <span className="shortcut-action-label">
                    {row.label}
                  </span>
                  <ShortcutRecorder action={row.action} binding={row.binding} />
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <div className="settings-divider" />
      <h3 className="settings-section-title">
        {t('settings.keyboard.indexSection', 'Number-row shortcuts')}
      </h3>

      <IndexShortcutRow
        labelKey="settings.keyboard.workspaceIndex"
        labelFallback="Select workspace by number"
        value={keyboardPrefs.workspaceIndexModifiers}
        onChange={(workspaceIndexModifiers) => setKeyboardPrefs({ workspaceIndexModifiers })}
      />
      <IndexShortcutRow
        labelKey="settings.keyboard.surfaceIndex"
        labelFallback="Select tab by number"
        value={keyboardPrefs.surfaceIndexModifiers}
        onChange={(surfaceIndexModifiers) => setKeyboardPrefs({ surfaceIndexModifiers })}
      />

      <p className="settings-hint">
        {t(
          'settings.keyboard.indexHint',
          'The two families can never share the same modifiers — assigning one a combo the other holds swaps them. Number 9 always selects the last workspace or tab, however many there are.',
        )}
      </p>

      <div className="shortcut-footer">
        <button className="settings-btn settings-btn--danger" onClick={resetShortcuts}>
          {t('settings.keyboard.resetAll', 'Reset All')}
        </button>
      </div>
    </div>
  );
}
