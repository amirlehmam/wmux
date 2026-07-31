import { useState, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { ShortcutAction, ShortcutBinding } from '../../store/settings-slice';
import { actionLabel, formatBinding, CATEGORY, CATEGORY_ORDER, CATEGORY_LABEL_KEY } from '../Settings/KeyboardSettings';
import '../../styles/cheat-sheet.css';

interface ShortcutCheatSheetProps {
  onClose: () => void;
}

// Fixed (non-remappable) bindings handled by dedicated key listeners, surfaced
// here so they're discoverable alongside the remappable ones.
function getFixedBindings(t: (key: TranslationKey, fallback?: string) => string): Array<{ label: string; binding: string; category: string }> {
  return [
    { label: t('cheatSheet.selectWorkspace', 'Select workspace 1–9'), binding: 'Ctrl+1…9', category: 'Workspaces' },
    { label: t('cheatSheet.selectTab', 'Select tab 1–9'), binding: 'Ctrl+Alt+1…9', category: 'Tabs' },
  ];
}

export default function ShortcutCheatSheet({ onClose }: ShortcutCheatSheetProps) {
  const t = useT();
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
        label: actionLabel(action, t),
        binding: formatBinding(binding),
        category: CATEGORY[action] ?? 'Other',
      })),
      ...getFixedBindings(t),
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
  }, [shortcuts, query, t]);

  return (
    <div className="cheat-sheet-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cheat-sheet">
        <div className="cheat-sheet__header">
          <h2 className="cheat-sheet__title">{t('settings.keyboard.title', 'Keyboard Shortcuts')}</h2>
          <input
            ref={inputRef}
            className="cheat-sheet__search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('cheatSheet.filterPlaceholder', 'Filter shortcuts…')}
          />
          <button className="cheat-sheet__close" onClick={onClose} title={t('cheatSheet.closeTitle', 'Close (Esc)')}>×</button>
        </div>
        <div className="cheat-sheet__body">
          {grouped.length === 0 ? (
            <div className="cheat-sheet__empty">{t('cheatSheet.noMatch', 'No shortcuts match "{query}".').replace('{query}', query)}</div>
          ) : (
            grouped.map((group) => (
              <div key={group.category} className="cheat-sheet__group">
                <h3 className="cheat-sheet__group-title">{t(CATEGORY_LABEL_KEY[group.category] ?? 'cheatSheet.category.other', group.category)}</h3>
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
