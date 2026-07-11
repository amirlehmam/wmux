import React, { useState, useEffect, useRef } from 'react';

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

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function SessionMenu({ mode = 'load', onSelect, onClose }: SessionMenuProps) {
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
          placeholder="New session name..."
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
        <div className="session-menu__empty">No saved sessions</div>
      )}
      {sessions.length > 0 && (
        <>
          {isSave && <div className="session-menu__label">Or overwrite an existing session:</div>}
          {sessions.map(s => (
            <div
              key={s.name}
              className="session-menu__item"
              onClick={() => onSelect(s.name)}
              title={isSave ? `Overwrite "${s.name}"` : `Load "${s.name}"`}
            >
              <div className="session-menu__name">{s.name}</div>
              <div className="session-menu__meta">
                {s.workspaceCount} ws · {timeAgo(s.savedAt)}
              </div>
              <button
                className="session-menu__delete"
                onClick={(e) => handleDelete(s.name, e)}
                title="Delete session"
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
