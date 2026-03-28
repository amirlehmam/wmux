import React from 'react';
import logoSrc from '../../assets/logo.png';
import NotificationBell from './NotificationBell';
import { NotificationInfo, WorkspaceId, PaneId, SurfaceId } from '../../../shared/types';
import '../../styles/titlebar.css';

interface TitlebarProps {
  title?: string;
  onHelpClick?: () => void;
  onDevToolsClick?: () => void;
  notifications: NotificationInfo[];
  workspaceNames: Map<string, string>;
  notificationPanelOpen: boolean;
  onToggleNotificationPanel: () => void;
  onNotificationJump: (workspaceId: WorkspaceId, surfaceId: SurfaceId, paneId?: PaneId) => void;
  onMarkAllNotificationsRead: () => void;
}

export default function Titlebar({
  title,
  onHelpClick,
  onDevToolsClick,
  notifications,
  workspaceNames,
  notificationPanelOpen,
  onToggleNotificationPanel,
  onNotificationJump,
  onMarkAllNotificationsRead,
}: TitlebarProps) {
  return (
    <div className="titlebar">
      <div className="titlebar__left">
        <img
          src={logoSrc}
          alt="wmux"
          className="titlebar__logo"
          draggable={false}
          style={{ cursor: 'pointer' }}
          onClick={() => window.wmux?.system?.openExternal?.('https://wmux.netlify.app') }
          title="wmux.netlify.app"
        />
        <button className="titlebar__btn" onClick={onHelpClick} title="Help / Tutorial">?</button>
        <button className="titlebar__btn" onClick={onDevToolsClick} title="Toggle Developer Tools">&lt;/&gt;</button>
        <NotificationBell
          notifications={notifications}
          workspaceNames={workspaceNames}
          isOpen={notificationPanelOpen}
          onToggle={onToggleNotificationPanel}
          onJump={onNotificationJump}
          onMarkAllRead={onMarkAllNotificationsRead}
        />
      </div>
      <span className="titlebar__title">{title ?? ''}</span>
      <div className="titlebar__right" />
    </div>
  );
}
