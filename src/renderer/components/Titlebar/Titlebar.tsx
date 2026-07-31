import React from 'react';
// Imported straight from resources/ rather than a copy under src/renderer/assets/
// (issue #137). The copy was the whole bug: the brand moved to the split-pane
// icon in 0.37.0 and every shipped asset followed except this one, so the app
// kept showing its own previous logo in the titlebar. There is now one file.
// The *small* variant is deliberate — it is drawn for ≤32px, which is exactly
// the size the titlebar renders at, and the full icon's `>_` prompts vanish there.
import logoSrc from '../../../../resources/icons/icon-small.svg';
import NotificationBell from './NotificationBell';
import UpdateBadge from './UpdateBadge';
import { NotificationInfo, WorkspaceId, PaneId, SurfaceId } from '../../../shared/types';
import { useT } from '../../i18n';
import '../../styles/titlebar.css';

interface TitlebarProps {
  title?: string;
  onHelpClick?: () => void;
  onDevToolsClick?: () => void;
  onSettingsClick?: () => void;
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
  onSettingsClick,
  notifications,
  workspaceNames,
  notificationPanelOpen,
  onToggleNotificationPanel,
  onNotificationJump,
  onMarkAllNotificationsRead,
}: TitlebarProps) {
  const t = useT();
  return (
    <div className="titlebar">
      <div className="titlebar__left">
        <img
          src={logoSrc}
          alt="wmux"
          className="titlebar__logo"
          draggable={false}
          style={{ cursor: 'pointer' }}
          onClick={() => window.wmux?.system?.openExternal?.('https://wmux.org') }
          title="wmux.org"
        />
        <button className="titlebar__btn" onClick={onHelpClick} title={t('titlebar.help')}>?</button>
        <button className="titlebar__btn" onClick={onDevToolsClick} title={t('titlebar.devtools')}>&lt;/&gt;</button>
        <NotificationBell
          notifications={notifications}
          workspaceNames={workspaceNames}
          isOpen={notificationPanelOpen}
          onToggle={onToggleNotificationPanel}
          onJump={onNotificationJump}
          onMarkAllRead={onMarkAllNotificationsRead}
        />
        <UpdateBadge />
        <button
          className="titlebar__btn"
          onClick={onSettingsClick}
          title={t('titlebar.settings')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M9.837.187a1.25 1.25 0 0 0-1.674 0L7.17 1.08a.25.25 0 0 1-.236.063l-1.181-.316a1.25 1.25 0 0 0-1.533.887l-.316 1.18a.25.25 0 0 1-.173.173l-1.18.316a1.25 1.25 0 0 0-.887 1.533l.316 1.181a.25.25 0 0 1-.063.236l-.894.993a1.25 1.25 0 0 0 0 1.674l.894.993a.25.25 0 0 1 .063.236l-.316 1.181a1.25 1.25 0 0 0 .887 1.533l1.18.316a.25.25 0 0 1 .173.173l.316 1.18a1.25 1.25 0 0 0 1.533.887l1.181-.316a.25.25 0 0 1 .236.063l.993.894a1.25 1.25 0 0 0 1.674 0l.993-.894a.25.25 0 0 1 .236-.063l1.181.316a1.25 1.25 0 0 0 1.533-.887l.316-1.18a.25.25 0 0 1 .173-.173l1.18-.316a1.25 1.25 0 0 0 .887-1.533l-.316-1.181a.25.25 0 0 1 .063-.236l.894-.993a1.25 1.25 0 0 0 0-1.674l-.894-.993a.25.25 0 0 1-.063-.236l.316-1.181a1.25 1.25 0 0 0-.887-1.533l-1.18-.316a.25.25 0 0 1-.173-.173l-.316-1.18a1.25 1.25 0 0 0-1.533-.887l-1.181.316a.25.25 0 0 1-.236-.063L9.837.187ZM8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"/>
          </svg>
        </button>
      </div>
      <span className="titlebar__title">{title ?? ''}</span>
      <div className="titlebar__right" />
    </div>
  );
}
