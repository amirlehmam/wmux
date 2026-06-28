import { useState, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../store';
import { ShortcutAction, ShortcutBinding } from '../../store/settings-slice';
import { ACTION_LABELS } from '../Settings/KeyboardSettings';
import '../../styles/cheat-sheet.css';

interface ShortcutCheatSheetProps {
  onClose: () => void;
}

// Render a binding as "Ctrl+Shift+T". Matches CommandPalette.formatBinding so the
// cheat-sheet always shows the user's live (possibly remapped) bindings.
function formatBinding(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join('+');
}

// Group every action under a readable category. Actions absent here fall under
// "Other", so newly-added shortcuts still appear without touching this map.
const CATEGORY: Partial<Record<ShortcutAction, string>> = {
  newWorkspace: 'Workspaces', closeWorkspace: 'Workspaces', nextWorkspace: 'Workspaces',
  prevWorkspace: 'Workspaces', renameWorkspace: 'Workspaces', jumpToUnread: 'Workspaces',
  togglePinWorkspace: 'Workspaces', markWorkspaceRead: 'Workspaces', openFolder: 'Workspaces',
  newWindow: 'Workspaces', closeWindow: 'Workspaces',
  newSurface: 'Tabs', nextSurface: 'Tabs', prevSurface: 'Tabs', reopenClosedSurface: 'Tabs',
  renameSurface: 'Tabs', openMarkdownPanel: 'Tabs',
  splitRight: 'Panes', splitDown: 'Panes', splitBrowserRight: 'Panes', splitBrowserDown: 'Panes',
  focusLeft: 'Panes', focusRight: 'Panes', focusUp: 'Panes', focusDown: 'Panes',
  resizePaneLeft: 'Panes', resizePaneRight: 'Panes', resizePaneUp: 'Panes', resizePaneDown: 'Panes',
  toggleZoom: 'Panes', closeSurfaceOrPane: 'Panes', broadcastInput: 'Panes',
  find: 'Terminal', findNext: 'Terminal', findPrevious: 'Terminal', copyMode: 'Terminal',
  copy: 'Terminal', paste: 'Terminal', fontSizeIncrease: 'Terminal', fontSizeDecrease: 'Terminal',
  fontSizeReset: 'Terminal',
  toggleSidebar: 'View', showNotifications: 'View', flashFocused: 'View', openBrowser: 'View',
  browserDevTools: 'View', browserConsole: 'View', openSettings: 'View', commandPalette: 'View',
  toggleShortcutCheatSheet: 'View',
};

const CATEGORY_ORDER = ['Workspaces', 'Tabs', 'Panes', 'Terminal', 'View', 'Other'];

// Fixed (non-remappable) bindings handled by dedicated key listeners, surfaced
// here so they're discoverable alongside the remappable ones.
const FIXED_BINDINGS: Array<{ label: string; binding: string; category: string }> = [
  { label: 'Select workspace 1–9', binding: 'Ctrl+1…9', category: 'Workspaces' },
  { label: 'Select tab 1–9', binding: 'Ctrl+Alt+1…9', category: 'Tabs' },
];

export default function ShortcutCheatSheet({ onClose }: ShortcutCheatSheetProps) {
  const shortcuts = useStore((s) => s.shortcuts);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const grouped = useMemo(() => {
    const rows: Array<{ label: string; binding: string; category: string }> = [
      ...(Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][]).map(([action, binding]) => ({
        label: ACTION_LABELS[action] ?? action,
        binding: formatBinding(binding),
        category: CATEGORY[action] ?? 'Other',
      })),
      ...FIXED_BINDINGS,
    ];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.label.toLowerCase().includes(q) || r.binding.toLowerCase().includes(q))
      : rows;
    const byCategory = new Map<string, typeof rows>();
    for (const row of filtered) {
      const list = byCategory.get(row.category) ?? [];
      list.push(row);
      byCategory.set(row.category, list);
    }
    return CATEGORY_ORDER
      .filter((c) => byCategory.has(c))
      .map((c) => ({ category: c, rows: byCategory.get(c)!.sort((a, b) => a.label.localeCompare(b.label)) }));
  }, [shortcuts, query]);

  return (
    <div className="cheat-sheet-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cheat-sheet">
        <div className="cheat-sheet__header">
          <h2 className="cheat-sheet__title">Keyboard Shortcuts</h2>
          <input
            ref={inputRef}
            className="cheat-sheet__search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter shortcuts…"
          />
          <button className="cheat-sheet__close" onClick={onClose} title="Close (Esc)">×</button>
        </div>
        <div className="cheat-sheet__body">
          {grouped.length === 0 ? (
            <div className="cheat-sheet__empty">No shortcuts match “{query}”.</div>
          ) : (
            grouped.map((group) => (
              <div key={group.category} className="cheat-sheet__group">
                <h3 className="cheat-sheet__group-title">{group.category}</h3>
                {group.rows.map((row) => (
                  <div key={`${row.category}:${row.label}`} className="cheat-sheet__row">
                    <span className="cheat-sheet__label">{row.label}</span>
                    <span className="cheat-sheet__binding">{row.binding}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
