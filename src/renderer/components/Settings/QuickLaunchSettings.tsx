import { useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { QuickLaunchProfile, SurfaceType } from '../../../shared/types';

const TYPES: SurfaceType[] = ['terminal', 'browser', 'markdown'];

function blankProfile(t: (key: TranslationKey, fallback?: string) => string): QuickLaunchProfile {
  return { id: crypto.randomUUID(), name: t('settings.quickLaunch.newProfileName', 'New profile'), type: 'terminal' };
}

export default function QuickLaunchSettings() {
  const t = useT();
  const profiles = useStore((s) => s.quickLaunchProfiles);
  const setProfiles = useStore((s) => s.setQuickLaunchProfiles);
  const [importNote, setImportNote] = useState<string>('');

  const update = (id: string, patch: Partial<QuickLaunchProfile>) => {
    setProfiles(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };
  const remove = (id: string) => setProfiles(profiles.filter((p) => p.id !== id));
  const add = () => setProfiles([...profiles, blankProfile(t)]);

  const importFromWT = async () => {
    const imported: QuickLaunchProfile[] = (await window.wmux?.config?.importWindowsTerminalProfiles?.()) || [];
    if (imported.length === 0) {
      setImportNote(t('settings.quickLaunch.noWTProfiles', 'No Windows Terminal profiles found.'));
      return;
    }
    // De-dupe by id against existing profiles.
    const existing = new Set(profiles.map((p) => p.id));
    const fresh = imported.filter((p) => !existing.has(p.id));
    setProfiles([...profiles, ...fresh]);
    setImportNote(
      (fresh.length === 1
        ? t('settings.quickLaunch.importedOne', 'Imported {count} profile from Windows Terminal.')
        : t('settings.quickLaunch.importedMany', 'Imported {count} profiles from Windows Terminal.')
      ).replace('{count}', String(fresh.length)),
    );
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.quickLaunch.title', 'Quick-launch profiles')}</h3>
      <p className="settings-hint">
        {t('settings.quickLaunch.hintPart1', 'One-click tab presets shown in the ')}<strong>+</strong>
        {t('settings.quickLaunch.hintPart2', ' dropdown next to each pane. A terminal profile can pick a shell, auto-')}<code>cd</code>
        {t('settings.quickLaunch.hintPart3', ' into a directory and run startup commands; a browser profile opens a fixed URL. Project-specific profiles can also live in a committed')}
        <code> .wmux.json</code>{t('settings.quickLaunch.hintPart4', ' at a workspace root.')}
      </p>

      <div className="settings-row">
        <button className="settings-button" onClick={importFromWT}>{t('settings.quickLaunch.importFromWT', 'Import from Windows Terminal')}</button>
        {importNote && <span className="settings-hint">{importNote}</span>}
      </div>

      <div className="settings-divider" />

      {profiles.length === 0 && (
        <p className="settings-hint">{t('settings.quickLaunch.noProfilesYet', 'No profiles yet. Add one below.')}</p>
      )}

      {profiles.map((p) => (
        <div key={p.id} className="ql-profile">
          <div className="ql-profile__head">
            <input
              className="settings-input ql-profile__name"
              value={p.name}
              placeholder={t('settings.quickLaunch.namePlaceholder', 'Name')}
              onChange={(e) => update(p.id, { name: e.target.value })}
            />
            <input
              className="settings-input ql-profile__icon"
              value={p.icon ?? ''}
              placeholder={t('settings.quickLaunch.iconPlaceholder', 'icon')}
              title={t('settings.quickLaunch.iconTitle', 'Optional emoji/glyph')}
              maxLength={2}
              onChange={(e) => update(p.id, { icon: e.target.value || undefined })}
            />
            <select
              className="settings-select"
              value={p.type}
              onChange={(e) => update(p.id, { type: e.target.value as SurfaceType })}
            >
              {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <button className="settings-button settings-button--danger" onClick={() => remove(p.id)}>{t('settings.quickLaunch.remove', 'Remove')}</button>
          </div>

          {p.type === 'terminal' && (
            <div className="ql-profile__fields">
              <input
                className="settings-input"
                value={p.shell ?? ''}
                placeholder={t('settings.quickLaunch.shellPlaceholder', 'Shell (optional, e.g. pwsh.exe)')}
                onChange={(e) => update(p.id, { shell: e.target.value || undefined })}
              />
              <input
                className="settings-input"
                value={p.cwd ?? ''}
                placeholder={t('settings.quickLaunch.cwdPlaceholder', 'Working directory (optional)')}
                onChange={(e) => update(p.id, { cwd: e.target.value || undefined })}
              />
              <textarea
                className="settings-input ql-profile__commands"
                value={(p.startupCommands ?? []).join('\n')}
                placeholder={t('settings.quickLaunch.startupCommandsPlaceholder', 'Startup commands (one per line)')}
                rows={2}
                onChange={(e) =>
                  update(p.id, {
                    startupCommands: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0),
                  })
                }
              />
            </div>
          )}

          {p.type === 'browser' && (
            <div className="ql-profile__fields">
              <input
                className="settings-input"
                value={p.url ?? ''}
                placeholder={t('settings.quickLaunch.urlPlaceholder', 'URL (e.g. https://localhost:3000)')}
                onChange={(e) => update(p.id, { url: e.target.value || undefined })}
              />
            </div>
          )}
        </div>
      ))}

      <div className="settings-row">
        <button className="settings-button" onClick={add}>{t('settings.quickLaunch.addProfile', '+ Add profile')}</button>
      </div>
    </div>
  );
}
