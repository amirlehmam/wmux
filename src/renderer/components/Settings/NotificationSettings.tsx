import { useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { NOTIFICATION_SOUND_LABELS, previewNotificationSound, setCustomNotificationSound } from '../../notification-sound';

export default function NotificationSettings() {
  const t = useT();
  const { notificationPrefs, setNotificationPrefs } = useStore();
  const [soundError, setSoundError] = useState<string | null>(null);

  const chooseCustomSound = async () => {
    setSoundError(null);
    try {
      const result = await window.wmux?.notification?.pickSound?.();
      if (!result || result.canceled) return;
      if (result.error) {
        setSoundError(result.error);
        return;
      }
      setCustomNotificationSound(result.dataUrl);
      setNotificationPrefs({
        sound: 'custom',
        customSoundExtension: result.extension,
        customSoundName: result.name,
      });
      previewNotificationSound('custom');
    } catch {
      setSoundError('unreadable');
    }
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.notifications.alertsSection', 'Alerts')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.toast', 'Show toast notifications')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.toast}
          onChange={(e) => setNotificationPrefs({ toast: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.taskbarFlash', 'Taskbar flash')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.taskbarFlash}
          onChange={(e) => setNotificationPrefs({ taskbarFlash: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.paneRing', 'Pane ring')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.paneRing}
          onChange={(e) => setNotificationPrefs({ paneRing: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.paneFlashAnimation', 'Pane flash animation')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.paneFlashAnimation}
          onChange={(e) => setNotificationPrefs({ paneFlashAnimation: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.notifications.aiAgentsSection', 'AI agents')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.agentInputNotify', 'Notify when agent needs input')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.agentInputNotify}
          onChange={(e) => setNotificationPrefs({ agentInputNotify: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.agentStopNotify', "Notify when agent finishes its turn")}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.agentStopNotify}
          onChange={(e) => setNotificationPrefs({ agentStopNotify: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.notifications.soundSection', 'Sound')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.sound', 'Notification sound')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="settings-select"
            value={notificationPrefs.sound}
            onChange={(e) => {
              const sound = e.target.value as typeof notificationPrefs.sound;
              setSoundError(null);
              setNotificationPrefs({ sound });
              previewNotificationSound(sound);
            }}
          >
            {NOTIFICATION_SOUND_LABELS.map((s) => (
              <option key={s.value} value={s.value}>{t(s.labelKey, s.fallback)}</option>
            ))}
          </select>
          <button
            type="button"
            className="settings-button"
            disabled={notificationPrefs.sound === 'none' || (notificationPrefs.sound === 'custom' && !notificationPrefs.customSoundName)}
            onClick={() => previewNotificationSound(notificationPrefs.sound)}
          >
            {t('settings.notifications.preview', 'Preview')}
          </button>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.customSoundFile', 'Custom sound file')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span
            className="settings-hint"
            title={notificationPrefs.customSoundName ?? undefined}
            style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {notificationPrefs.customSoundName || t('settings.notifications.noCustomSound', 'No file selected')}
          </span>
          <button type="button" className="settings-button" onClick={() => void chooseCustomSound()}>
            {t('settings.notifications.chooseSoundFile', 'Choose audio file')}
          </button>
        </div>
      </div>
      {soundError && (
        <p className="settings-hint" role="alert">
          {soundError === 'too_large'
            ? t('settings.notifications.customSoundTooLarge', 'Audio files must be 10 MB or smaller.')
            : t('settings.notifications.customSoundError', 'Could not use that audio file.')}
        </p>
      )}
    </div>
  );
}
