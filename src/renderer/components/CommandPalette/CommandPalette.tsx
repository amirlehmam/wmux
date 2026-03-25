import { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../../store';
import { ShortcutAction, ShortcutBinding, DEFAULT_SHORTCUTS } from '../../store/settings-slice';
import '../../styles/command-palette.css';

interface CommandPaletteProps {
  onClose: () => void;
  onAction: (action: string) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  action: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBinding(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join('+');
}

function actionToLabel(action: ShortcutAction): string {
  // Convert camelCase action names to readable labels
  return action
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function fuzzyMatch(needle: string, haystack: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let ni = 0;
  for (let hi = 0; hi < h.length && ni < n.length; hi++) {
    if (h[hi] === n[ni]) ni++;
  }
  return ni === n.length;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CommandPalette({ onClose, onAction }: CommandPaletteProps) {
  const { shortcuts, workspaces, activeWorkspaceId, selectWorkspace } = useStore();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Build palette items from all categories
  const allItems = useMemo((): PaletteItem[] => {
    const items: PaletteItem[] = [];

    // Category: Actions — all shortcut actions
    const actionEntries = Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][];
    for (const [action, binding] of actionEntries) {
      items.push({
        id: `action:${action}`,
        label: actionToLabel(action),
        shortcut: formatBinding(binding),
        category: 'Actions',
        action: () => onAction(action),
      });
    }

    // Category: Workspaces — switch to each workspace by name
    for (const ws of workspaces) {
      const isCurrent = ws.id === activeWorkspaceId;
      items.push({
        id: `workspace:${ws.id}`,
        label: `${ws.title}${isCurrent ? ' (current)' : ''}`,
        category: 'Workspaces',
        action: () => {
          selectWorkspace(ws.id);
          onClose();
        },
      });
    }

    // Category: Themes — placeholder entries for future theme switching
    const themes = ['Dark (Default)', 'Light', 'Monokai', 'Solarized Dark', 'Nord'];
    for (const theme of themes) {
      items.push({
        id: `theme:${theme}`,
        label: theme,
        category: 'Themes',
        action: () => {
          console.log(`[wmux] Switch theme: ${theme}`);
          onClose();
        },
      });
    }

    return items;
  }, [shortcuts, workspaces, activeWorkspaceId, selectWorkspace, onAction, onClose]);

  // Filter based on query
  const filteredItems = useMemo(() => {
    return allItems.filter((item) => fuzzyMatch(query, item.label) || fuzzyMatch(query, item.category));
  }, [allItems, query]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('.command-palette__item--selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filteredItems.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = filteredItems[selectedIndex];
      if (item) item.action();
      return;
    }
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const visibleItems = filteredItems.slice(0, 10);

  return (
    <div className="command-palette-overlay" onMouseDown={handleOverlayClick}>
      <div className="command-palette">
        <input
          ref={inputRef}
          className="command-palette__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command or search..."
        />
        <div className="command-palette__results" ref={listRef}>
          {visibleItems.length === 0 ? (
            <div className="command-palette__empty">No results found</div>
          ) : (
            visibleItems.map((item, index) => (
              <div
                key={item.id}
                className={`command-palette__item${index === selectedIndex ? ' command-palette__item--selected' : ''}`}
                onMouseDown={() => item.action()}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="command-palette__item-label">{item.label}</span>
                <span className="command-palette__item-category">{item.category}</span>
                {item.shortcut && (
                  <span className="command-palette__item-shortcut">{item.shortcut}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
