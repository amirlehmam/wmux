import React, { useRef, useEffect } from 'react';
import NotificationPanel from './NotificationPanel';
import { IconBell } from './icons';
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
        <IconBell />
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
