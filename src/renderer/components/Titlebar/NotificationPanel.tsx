import React from 'react';
import { NotificationInfo, WorkspaceId, PaneId, SurfaceId } from '../../../shared/types';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import '../../styles/notification-panel.css';

interface NotificationPanelProps {
  notifications: NotificationInfo[];
  workspaceNames: Map<string, string>;
  onJump: (workspaceId: WorkspaceId, surfaceId: SurfaceId, paneId?: PaneId) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}

function timeAgo(timestamp: number, t: (key: TranslationKey, fallback?: string) => string): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return t('sessionMenu.justNow', 'just now');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('sessionMenu.minutesAgo', '{count}m ago').replace('{count}', String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('sessionMenu.hoursAgo', '{count}h ago').replace('{count}', String(hours));
  const days = Math.floor(hours / 24);
  if (days === 1) return t('notifPanel.yesterday', 'yesterday');
  return t('sessionMenu.daysAgo', '{count}d ago').replace('{count}', String(days));
}

export default function NotificationPanel({
  notifications,
  workspaceNames,
  onJump,
  onMarkAllRead,
  onClose,
}: NotificationPanelProps) {
  const t = useT();
  const sorted = [...notifications].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="notif-panel" onClick={(e) => e.stopPropagation()}>
      <div className="notif-panel__header">
        <span className="notif-panel__title">{t('notifPanel.title', 'Notifications')}</span>
        {notifications.some((n) => !n.read) && (
          <button className="notif-panel__mark-all" onClick={onMarkAllRead}>
            {t('notifPanel.markAllRead', 'Mark all read')}
          </button>
        )}
      </div>
      <div className="notif-panel__list">
        {sorted.length === 0 ? (
          <div className="notif-panel__empty">{t('notifPanel.empty', 'No notifications')}</div>
        ) : (
          sorted.map((n) => (
            <div
              key={n.id}
              className={`notif-panel__item ${!n.read ? 'notif-panel__item--unread' : ''}`}
              onClick={() => {
                onJump(n.workspaceId, n.surfaceId, n.paneId);
                onClose();
              }}
            >
              {!n.read && <span className="notif-panel__dot" />}
              <div className="notif-panel__content">
                <span className="notif-panel__source">{workspaceNames.get(n.workspaceId) || t('notifPanel.unknownSource', 'Unknown')}</span>
                <span className="notif-panel__text">{n.text}</span>
                <span className="notif-panel__time">{timeAgo(n.timestamp, t)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
