import React, { useRef, useEffect } from 'react';
import NotificationPanel from './NotificationPanel';
import { NotificationInfo, WorkspaceId, PaneId, SurfaceId } from '../../../shared/types';
import { useT } from '../../i18n';

interface NotificationBellProps {
  notifications: NotificationInfo[];
  workspaceNames: Map<string, string>;
  onJump: (workspaceId: WorkspaceId, surfaceId: SurfaceId, paneId?: PaneId) => void;
  onMarkAllRead: () => void;
  isOpen: boolean;
  onToggle: () => void;
}

export default function NotificationBell({
  notifications,
  workspaceNames,
  onJump,
  onMarkAllRead,
  isOpen,
  onToggle,
}: NotificationBellProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onToggle();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, onToggle]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onToggle();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onToggle]);

  return (
    <div ref={containerRef} className="notif-bell" style={{ position: 'relative' }}>
      <button
        className="titlebar__btn notif-bell__btn"
        onClick={onToggle}
        title={t('notifPanel.title', 'Notifications')}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1.5A3.5 3.5 0 0 0 4.5 5v2.947c0 .346-.102.683-.294.97l-1.703 2.556a.25.25 0 0 0 .208.389L13.29 11.86a.25.25 0 0 0 .208-.389l-1.703-2.556a1.75 1.75 0 0 1-.294-.97V5A3.5 3.5 0 0 0 8 1.5ZM6.5 13a1.5 1.5 0 0 0 3 0h-3Z" />
        </svg>
        {unreadCount > 0 && (
          <span className="notif-bell__badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>
      {isOpen && (
        <NotificationPanel
          notifications={notifications}
          workspaceNames={workspaceNames}
          onJump={onJump}
          onMarkAllRead={onMarkAllRead}
          onClose={onToggle}
        />
      )}
    </div>
  );
}
