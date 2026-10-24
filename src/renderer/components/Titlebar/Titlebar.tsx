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
import { IconHelp, IconCode, IconSettings, IconPixelAgent, IconFocus, IconFolder } from './icons';
import WindowControls, { useIsFramelessWindow } from './WindowControls';
import { NotificationInfo, WorkspaceId, PaneId, SurfaceId } from '../../../shared/types';
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { formatBinding } from '../Settings/KeyboardSettings';
import '../../styles/titlebar.css';

interface TitlebarProps {
  title?: string;
  onHelpClick?: () => void;
  onDevToolsClick?: () => void;
  onSettingsClick?: () => void;
  onHubClick?: () => void;
  /** The agent-office easter egg (Settings, General). No pref, no button. */
  hubEnabled?: boolean;
  notifications: NotificationInfo[];
  workspaceNames: ReadonlyMap<string, string>;
  notificationPanelOpen: boolean;
  onToggleNotificationPanel: () => void;
  onNotificationJump: (workspaceId: WorkspaceId, surfaceId: SurfaceId, paneId?: PaneId) => void;
  onMarkAllNotificationsRead: () => void;
  /** Focus mode: every pane but the focused one is dimmed. */
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  /** File explorer of the active workspace (#324): a mouse way back to the
   *  panel once it has been closed. */
  explorerOpen?: boolean;
  onToggleExplorer?: () => void;
}

export default function Titlebar({
  title,
  onHelpClick,
  onDevToolsClick,
  onSettingsClick,
  onHubClick,
  hubEnabled,
  notifications,
  workspaceNames,
  notificationPanelOpen,
  onToggleNotificationPanel,
  onNotificationJump,
  onMarkAllNotificationsRead,
  focusMode,
  onToggleFocusMode,
  explorerOpen,
  onToggleExplorer,
}: TitlebarProps) {
  const t = useT();
  // The tooltip names the CONFIGURED key, not the default: a rebound shortcut
  // advertised as Ctrl+Shift+X would teach the user a key that does nothing.
  const explorerBinding = formatBinding(useStore((s) => s.shortcuts.toggleExplorer));
  const explorerLabel = t('shortcutAction.toggleExplorer', 'Toggle file explorer');
  // Clear-transparency windows are frameless and have no native caption
  // buttons, so this is where they come from.
  const frameless = useIsFramelessWindow();
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
        <button
          className={`titlebar__btn${focusMode ? ' titlebar__btn--active' : ''}`}
          onClick={onToggleFocusMode}
          title={t('titlebar.focusMode', 'Focus mode: dim every pane but the focused one')}
          aria-pressed={!!focusMode}
        >
          <IconFocus />
        </button>
        {onToggleExplorer && (
          <button
            className={`titlebar__btn${explorerOpen ? ' titlebar__btn--active' : ''}`}
            onClick={onToggleExplorer}
            title={explorerBinding ? `${explorerLabel} (${explorerBinding})` : explorerLabel}
            aria-label={explorerLabel}
            aria-pressed={!!explorerOpen}
          >
            <IconFolder />
          </button>
        )}
      </div>
      <span className="titlebar__title">{title ?? ''}</span>
      <div className="titlebar__right">
        {frameless && <WindowControls />}
      </div>
    </div>
  );
}
