import React, { useState, useEffect, useRef } from 'react';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';

interface SessionEntry {
  name: string;
  savedAt: number;
  workspaceCount: number;
}

interface SessionMenuProps {
  /** 'load' picks a session to restore; 'save' picks a session to overwrite (or names a new one). */
  mode?: 'load' | 'save';
  onSelect: (name: string) => void;
  onClose: () => void;
}

function timeAgo(ts: number, t: (key: TranslationKey, fallback?: string) => string): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return t('sessionMenu.justNow', 'just now');
  if (seconds < 3600) return t('sessionMenu.minutesAgo', '{count}m ago').replace('{count}', String(Math.floor(seconds / 60)));
  if (seconds < 86400) return t('sessionMenu.hoursAgo', '{count}h ago').replace('{count}', String(Math.floor(seconds / 3600)));
  return t('sessionMenu.daysAgo', '{count}d ago').replace('{count}', String(Math.floor(seconds / 86400)));
}

export default function SessionMenu({ mode = 'load', onSelect, onClose }: SessionMenuProps) {
  const t = useT();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [saveName, setSaveName] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const isSave = mode === 'save';

  useEffect(() => {
    window.wmux?.session?.list().then(setSessions);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleDelete = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await window.wmux?.session?.delete(name);
    setSessions(prev => prev.filter(s => s.name !== name));
  };

  return (
    <div ref={menuRef} className="session-menu">
      {isSave && (
        <input
          className="sidebar__save-input session-menu__save-input"
          placeholder={t('sessionMenu.newSessionName', 'New session name...')}
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && saveName.trim()) onSelect(saveName.trim());
            if (e.key === 'Escape') onClose();
          }}
          autoFocus
        />
      )}
      {sessions.length === 0 && !isSave && (
        <div className="session-menu__empty">{t('sessionMenu.noSavedSessions', 'No saved sessions')}</div>
      )}
      {sessions.length > 0 && (
        <>
          {isSave && <div className="session-menu__label">{t('sessionMenu.overwriteExisting', 'Or overwrite an existing session:')}</div>}
          {sessions.map(s => (
            <div
              key={s.name}
              className="session-menu__item"
              onClick={() => onSelect(s.name)}
              title={isSave
                ? t('sessionMenu.overwrite', 'Overwrite "{name}"').replace('{name}', s.name)
                : t('sessionMenu.load', 'Load "{name}"').replace('{name}', s.name)}
            >
              <div className="session-menu__name">{s.name}</div>
              <div className="session-menu__meta">
                {s.workspaceCount} ws · {timeAgo(s.savedAt, t)}
              </div>
              <button
                className="session-menu__delete"
                onClick={(e) => handleDelete(s.name, e)}
                title={t('sessionMenu.deleteSession', 'Delete session')}
              >
                ✕
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
