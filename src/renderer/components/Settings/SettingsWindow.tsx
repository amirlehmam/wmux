import { useState } from 'react';
import GeneralSettings from './GeneralSettings';
import SidebarSettings from './SidebarSettings';
import WorkspaceSettings from './WorkspaceSettings';
import TerminalSettings from './TerminalSettings';
import NotificationSettings from './NotificationSettings';
import BrowserSettings from './BrowserSettings';
import KeyboardSettings from './KeyboardSettings';
import PromptSettings from './PromptSettings';
import VoiceSettings from './VoiceSettings';
import QuickLaunchSettings from './QuickLaunchSettings';
import HelpSettings from './HelpSettings';
import ChangelogSettings from './ChangelogSettings';
import RemoteConsoleSettings from './RemoteConsoleSettings';
import { useT, type TranslationKey } from '../../i18n';
import '../../styles/settings.css';

// Changelog sits next to Help (issue #211) — both answer "tell me about wmux
// itself" rather than "change how wmux behaves", and neither belongs among the
// preference tabs above them. Remote (#254) closes the preference tabs: it is
// the one that exposes wmux beyond this machine, so it is not in the way of
// the everyday ones.
const TABS = ['General', 'Sidebar', 'Workspace', 'Terminal', 'Prompts', 'Voice', 'Notifications', 'Browser', 'Profiles', 'Shortcuts', 'Remote', 'Changelog', 'Help'] as const;

// Map each tab to its i18n key (issue #56). Typed as TranslationKey, not
// string: the lookup is what reaches t(), so the keys are checked here.
const TAB_LABEL_KEYS: Record<typeof TABS[number], TranslationKey> = {
  General: 'settings.tab.general',
  Sidebar: 'settings.tab.sidebar',
  Workspace: 'settings.tab.workspace',
  Terminal: 'settings.tab.terminal',
  Prompts: 'settings.tab.prompts',
  Voice: 'settings.tab.voice',
  Notifications: 'settings.tab.notifications',
  Browser: 'settings.tab.browser',
  Profiles: 'settings.tab.profiles',
  Shortcuts: 'settings.tab.shortcuts',
  Remote: 'settings.tab.remote',
  Changelog: 'settings.tab.changelog',
  Help: 'settings.tab.help',
};

export type SettingsTab = typeof TABS[number];

interface SettingsWindowProps {
  onClose: () => void;
  /** The tab to open on. Read once, at mount; the user can switch away freely. */
  initialTab?: SettingsTab;
  /** Help → tutorial. The tutorial is App state, so Settings asks for it. */
  onOpenTutorial?: () => void;
}

export default function SettingsWindow({ onClose, initialTab, onOpenTutorial }: SettingsWindowProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'Terminal');
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
            {activeTab === 'Voice' && <VoiceSettings />}
            {activeTab === 'Notifications' && <NotificationSettings />}
            {activeTab === 'Browser' && <BrowserSettings />}
            {activeTab === 'Profiles' && <QuickLaunchSettings />}
            {activeTab === 'Shortcuts' && <KeyboardSettings />}
            {/* Mounted only while selected (#254): its getState/onState pair
                is a live subscription to main, and nobody reading the font
                settings needs remote-console pushes re-rendering this window. */}
            {activeTab === 'Remote' && <RemoteConsoleSettings />}
            {/* Mounted only while selected, so opening Settings never fires the
                GitHub fetch for a user who came here to change their font. */}
            {activeTab === 'Changelog' && <ChangelogSettings />}
            {activeTab === 'Help' && <HelpSettings onOpenTutorial={onOpenTutorial} />}
          </div>
        </div>
      </div>
    </div>
  );
}
