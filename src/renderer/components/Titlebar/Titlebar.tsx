import React from 'react';
// Imported straight from resources/ rather than a copy under src/renderer/assets/
// (issue #137). The copy was the whole bug: the brand moved to the split-pane
// icon in 0.37.0 and every shipped asset followed except this one, so the app
// kept showing its own previous logo in the titlebar. There is now one file —
// and since the mark became three solid bars on a plate, one file is also all
// the art there is: the ≤32px variant this used to point at no longer exists,
// because the current silhouette measures identically at 16px and at 512px.
import logoSrc from '../../../../resources/icons/icon.svg';
import NotificationBell from './NotificationBell';
import UpdateBadge from './UpdateBadge';
import { IconHelp, IconCode, IconSettings, IconPixelAgent } from './icons';
import { useStore } from '../../store';
import WindowControls, { useIsFramelessWindow } from './WindowControls';
import { NotificationInfo, WorkspaceId, PaneId, SurfaceId } from '../../../shared/types';
import { useT } from '../../i18n';
import '../../styles/titlebar.css';

interface TitlebarProps {
  title?: string;
  onHelpClick?: () => void;
  onDevToolsClick?: () => void;
  onSettingsClick?: () => void;
  onHubClick?: () => void;
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
  onHubClick,
  notifications,
  workspaceNames,
  notificationPanelOpen,
  onToggleNotificationPanel,
  onNotificationJump,
  onMarkAllNotificationsRead,
}: TitlebarProps) {
  const t = useT();
  // Clear-transparency windows are frameless and have no native caption
  // buttons, so this is where they come from.
  const frameless = useIsFramelessWindow();
  // The agent-office easter egg (Settings → General). No pref, no button.
  const hubEnabled = useStore((s) => s.appearancePrefs.hubEnabled);
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
        <button className="titlebar__btn" onClick={onHelpClick} title={t('titlebar.help')}>
          <IconHelp />
        </button>
        <button className="titlebar__btn" onClick={onDevToolsClick} title={t('titlebar.devtools')}>
          <IconCode />
        </button>
        <NotificationBell
          notifications={notifications}
          workspaceNames={workspaceNames}
          isOpen={notificationPanelOpen}
          onToggle={onToggleNotificationPanel}
          onJump={onNotificationJump}
          onMarkAllRead={onMarkAllNotificationsRead}
        />
        <UpdateBadge />
        {hubEnabled && (
          <button
            className="titlebar__btn"
            onClick={onHubClick}
            title={t('titlebar.hub', 'Agent office')}
          >
            <IconPixelAgent />
          </button>
        )}
        <button
          className="titlebar__btn"
          onClick={onSettingsClick}
          title={t('titlebar.settings')}
        >
          <IconSettings />
        </button>
      </div>
      <span className="titlebar__title">{title ?? ''}</span>
      <div className="titlebar__right">
        {frameless && <WindowControls />}
      </div>
    </div>
  );
}
