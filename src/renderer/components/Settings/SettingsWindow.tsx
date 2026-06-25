import { useState } from 'react';
import GeneralSettings from './GeneralSettings';
import SidebarSettings from './SidebarSettings';
import WorkspaceSettings from './WorkspaceSettings';
import TerminalSettings from './TerminalSettings';
import NotificationSettings from './NotificationSettings';
import BrowserSettings from './BrowserSettings';
import KeyboardSettings from './KeyboardSettings';
import QuickLaunchSettings from './QuickLaunchSettings';
import HelpSettings from './HelpSettings';
import { useT } from '../../i18n';
import '../../styles/settings.css';

const TABS = ['General', 'Sidebar', 'Workspace', 'Terminal', 'Notifications', 'Browser', 'Profiles', 'Shortcuts', 'Help'] as const;

// Map each tab to its i18n key (issue #56). Falls back to the English label.
const TAB_LABEL_KEYS: Record<typeof TABS[number], string> = {
  General: 'settings.tab.general',
  Sidebar: 'settings.tab.sidebar',
  Workspace: 'settings.tab.workspace',
  Terminal: 'settings.tab.terminal',
  Notifications: 'settings.tab.notifications',
  Browser: 'settings.tab.browser',
  Profiles: 'settings.tab.profiles',
  Shortcuts: 'settings.tab.shortcuts',
  Help: 'settings.tab.help',
};

interface SettingsWindowProps {
  onClose: () => void;
}

export default function SettingsWindow({ onClose }: SettingsWindowProps) {
  const [activeTab, setActiveTab] = useState<typeof TABS[number]>('Terminal');
  const t = useT();

  return (
    <div
      className="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-window">
        <div className="settings-header">
          <h2>{t('settings.title')}</h2>
          <button className="settings-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-tabs">
            {TABS.map((tab) => (
              <button
                key={tab}
                className={`settings-tab ${activeTab === tab ? 'settings-tab--active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {t(TAB_LABEL_KEYS[tab])}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {activeTab === 'General' && <GeneralSettings />}
            {activeTab === 'Sidebar' && <SidebarSettings />}
            {activeTab === 'Workspace' && <WorkspaceSettings />}
            {activeTab === 'Terminal' && <TerminalSettings />}
            {activeTab === 'Notifications' && <NotificationSettings />}
            {activeTab === 'Browser' && <BrowserSettings />}
            {activeTab === 'Profiles' && <QuickLaunchSettings />}
            {activeTab === 'Shortcuts' && <KeyboardSettings />}
            {activeTab === 'Help' && <HelpSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
