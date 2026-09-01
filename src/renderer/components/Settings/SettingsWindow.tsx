import { useState } from 'react';
import GeneralSettings from './GeneralSettings';
import SidebarSettings from './SidebarSettings';
import WorkspaceSettings from './WorkspaceSettings';
import TerminalSettings from './TerminalSettings';
import NotificationSettings from './NotificationSettings';
import BrowserSettings from './BrowserSettings';
import KeyboardSettings from './KeyboardSettings';
import PromptSettings from './PromptSettings';
import QuickLaunchSettings from './QuickLaunchSettings';
import HelpSettings from './HelpSettings';
import ChangelogSettings from './ChangelogSettings';
import { useT, type TranslationKey } from '../../i18n';
import '../../styles/settings.css';

// Changelog sits next to Help (issue #211) — both answer "tell me about wmux
// itself" rather than "change how wmux behaves", and neither belongs among the
// preference tabs above them.
const TABS = ['General', 'Sidebar', 'Workspace', 'Terminal', 'Prompts', 'Notifications', 'Browser', 'Profiles', 'Shortcuts', 'Changelog', 'Help'] as const;

// Map each tab to its i18n key (issue #56). Typed as TranslationKey, not
// string: the lookup is what reaches t(), so the keys are checked here.
const TAB_LABEL_KEYS: Record<typeof TABS[number], TranslationKey> = {
  General: 'settings.tab.general',
  Sidebar: 'settings.tab.sidebar',
  Workspace: 'settings.tab.workspace',
  Terminal: 'settings.tab.terminal',
  Prompts: 'settings.tab.prompts',
  Notifications: 'settings.tab.notifications',
  Browser: 'settings.tab.browser',
  Profiles: 'settings.tab.profiles',
  Shortcuts: 'settings.tab.shortcuts',
  Changelog: 'settings.tab.changelog',
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
      onMouseDown={(e) => {
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
            {activeTab === 'Prompts' && <PromptSettings />}
            {activeTab === 'Notifications' && <NotificationSettings />}
            {activeTab === 'Browser' && <BrowserSettings />}
            {activeTab === 'Profiles' && <QuickLaunchSettings />}
            {activeTab === 'Shortcuts' && <KeyboardSettings />}
            {/* Mounted only while selected, so opening Settings never fires the
                GitHub fetch for a user who came here to change their font. */}
            {activeTab === 'Changelog' && <ChangelogSettings />}
            {activeTab === 'Help' && <HelpSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
