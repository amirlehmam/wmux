import React, { useState, useEffect, useRef } from 'react';

interface SessionEntry {
  name: string;
  savedAt: number;
  workspaceCount: number;
}

interface SessionMenuProps {
  onLoad: (name: string) => void;
  onClose: () => void;
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function SessionMenu({ onLoad, onClose }: SessionMenuProps) {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

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

  if (sessions.length === 0) {
    return (
      <div ref={menuRef} className="session-menu">
        <div className="session-menu__empty">No saved sessions</div>
      </div>
    );
  }

  return (
    <div ref={menuRef} className="session-menu">
      {sessions.map(s => (
        <div key={s.name} className="session-menu__item" onClick={() => onLoad(s.name)}>
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
    </div>
  );
}
