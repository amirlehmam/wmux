import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { UserColorScheme } from '../../store/settings-slice';

/** First family of a CSS font stack, unquoted — used to match the picker. */
function firstFamily(stack: string): string {
  const first = (stack || '').split(',')[0].trim();
  return first.replace(/^['"]/, '').replace(/['"]$/, '');
}

/** Quote a family name for CSS if it needs it (spaces etc.). */
function cssFamily(name: string): string {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(name) ? name : `'${name}'`;
}

export default function TerminalSettings() {
  const t = useT();
  const { terminalPrefs, setTerminalPrefs } = useStore();
  const [themes, setThemes] = useState<string[]>(['Monokai']);
  const [newSchemeName, setNewSchemeName] = useState('');
  // Installed font families for the picker (issue #89) — enumerated by the
  // main process from the Windows font registry, so users don't have to guess
  // what to type into the free-text stack field.
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  // Load the list of bundled themes from the main process on mount so the
  // dropdown reflects actual files in resources/themes/ rather than a stub.
  useEffect(() => {
    (window as any).wmux?.config?.getThemeList?.().then((list: string[]) => {
      if (Array.isArray(list) && list.length > 0) setThemes(list);
    });
    (window as any).wmux?.system?.getFonts?.().then((list: string[]) => {
      if (Array.isArray(list)) setSystemFonts(list);
    }).catch(() => { /* picker simply stays hidden */ });
  }, []);

  const currentFamily = firstFamily(terminalPrefs.fontFamily);
  const pickerValue = systemFonts.includes(currentFamily) ? currentFamily : '';

  const userSchemeNames = Object.keys(terminalPrefs.userColorSchemes || {});
  const allSchemes = Array.from(new Set([...themes, ...userSchemeNames])).sort((a, b) => a.localeCompare(b));

  const addUserScheme = () => {
    const name = newSchemeName.trim();
    if (!name) return;
    setTerminalPrefs({
      userColorSchemes: {
        ...terminalPrefs.userColorSchemes,
        [name]: { background: '#1e1e1e', foreground: '#dddddd', cursor: '#ffffff' },
      },
    });
    setNewSchemeName('');
  };

  const updateUserScheme = (name: string, patch: Partial<UserColorScheme>) => {
    setTerminalPrefs({
      userColorSchemes: {
        ...terminalPrefs.userColorSchemes,
        [name]: { ...terminalPrefs.userColorSchemes[name], ...patch },
      },
    });
  };

  const removeUserScheme = (name: string) => {
    const next = { ...terminalPrefs.userColorSchemes };
    delete next[name];
    setTerminalPrefs({ userColorSchemes: next });
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.terminalPanel.font', 'Font')}</h3>

      {systemFonts.length > 0 && (
        <div className="settings-row">
          <label className="settings-label">{t('settings.terminalPanel.font', 'Font')}</label>
          <select
            className="settings-select"
            value={pickerValue}
            onChange={(e) => {
              const name = e.target.value;
              if (name) setTerminalPrefs({ fontFamily: `${cssFamily(name)}, Consolas, monospace` });
            }}
          >
            <option value="">{pickerValue
              ? t('settings.terminalPanel.customStack', 'Custom stack…')
              : t('settings.terminalPanel.pickInstalledFont', 'Pick an installed font ({count})…').replace('{count}', String(systemFonts.length))}</option>
            {systemFonts.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>
      )}

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.fontStackAdvanced', 'Font stack (advanced)')}</label>
        <input
          type="text"
          className="settings-input"
          value={terminalPrefs.fontFamily}
          onChange={(e) => setTerminalPrefs({ fontFamily: e.target.value })}
          placeholder={t('settings.terminalPanel.fontStackPlaceholder', 'e.g. Consolas, Menlo, monospace')}
        />
      </div>

      {/* Live preview in the selected font, so a pick is verifiable at a glance */}
      <div className="settings-row">
        <div
          style={{
            width: '100%',
            padding: '6px 10px',
            borderRadius: 4,
            border: '1px solid rgba(128,128,128,0.25)',
            fontFamily: terminalPrefs.fontFamily || 'monospace',
            fontSize: terminalPrefs.fontSize || 13,
            opacity: 0.9,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {currentFamily || 'monospace'} — 0O 1lI {'{}'} =&gt; -&gt; :: 42
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.fontSize', 'Font size')}</label>
        <input
          type="number"
          className="settings-input settings-input--narrow"
          value={terminalPrefs.fontSize}
          min={8}
          max={72}
          onChange={(e) => setTerminalPrefs({ fontSize: Number(e.target.value) })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.terminalPanel.colorSchemeSection', 'Color scheme')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.defaultScheme', 'Default scheme')}</label>
        <div className="settings-theme-row">
          <select
            className="settings-select"
            value={terminalPrefs.theme}
            onChange={(e) => setTerminalPrefs({ theme: e.target.value })}
          >
            {allSchemes.map((scheme) => (
              <option key={scheme} value={scheme}>{scheme}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="settings-row" style={{ opacity: 0.7, fontSize: '12px' }}>
        {t('settings.terminalPanel.schemeHintPart1', 'Applied to new panes. Override per pane via ')}<code>wmux split --color-scheme NAME</code>{t('settings.terminalPanel.schemeHintPart2', ' or ')}<code>wmux set-color-scheme NAME</code>{t('settings.terminalPanel.schemeHintPart3', '.')}
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.terminalPanel.customSchemesSection', 'Custom schemes')}</h3>
      <div className="settings-row" style={{ opacity: 0.7, fontSize: '12px' }}>
        {t('settings.terminalPanel.customSchemesHint', 'Define named overrides (dev / staging / prod). Only the fields you set are overridden; the rest fall back to the bundled base theme.')}
      </div>

      {userSchemeNames.map((name) => {
        const scheme = terminalPrefs.userColorSchemes[name];
        return (
          <div key={name} className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{name}</strong>
              <button className="settings-btn settings-btn--secondary" onClick={() => removeUserScheme(name)}>{t('settings.terminalPanel.remove', 'Remove')}</button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {t('settings.terminalPanel.bg', 'bg')}
                <input type="color" value={scheme.background || '#1e1e1e'}
                  onChange={(e) => updateUserScheme(name, { background: e.target.value })} />
              </label>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {t('settings.terminalPanel.fg', 'fg')}
                <input type="color" value={scheme.foreground || '#dddddd'}
                  onChange={(e) => updateUserScheme(name, { foreground: e.target.value })} />
              </label>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {t('settings.terminalPanel.cursorAbbr', 'cursor')}
                <input type="color" value={scheme.cursor || '#ffffff'}
                  onChange={(e) => updateUserScheme(name, { cursor: e.target.value })} />
              </label>
            </div>
          </div>
        );
      })}

      <div className="settings-row">
        <input
          type="text"
          className="settings-input"
          placeholder={t('settings.terminalPanel.newSchemeNamePlaceholder', 'new scheme name (e.g. prod)')}
          value={newSchemeName}
          onChange={(e) => setNewSchemeName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addUserScheme(); }}
        />
        <button className="settings-btn settings-btn--secondary" onClick={addUserScheme}>{t('settings.terminalPanel.addScheme', 'Add scheme')}</button>
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.terminalPanel.cursorSection', 'Cursor')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.cursorStyle', 'Cursor style')}</label>
        <select
          className="settings-select"
          value={terminalPrefs.cursorStyle}
          onChange={(e) =>
            setTerminalPrefs({ cursorStyle: e.target.value as 'block' | 'underline' | 'bar' })
          }
        >
          <option value="block">{t('settings.terminalPanel.cursorStyle.block', 'Block')}</option>
          <option value="underline">{t('settings.terminalPanel.cursorStyle.underline', 'Underline')}</option>
          <option value="bar">{t('settings.terminalPanel.cursorStyle.bar', 'Bar')}</option>
        </select>
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.cursorBlink', 'Cursor blink')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={terminalPrefs.cursorBlink}
          onChange={(e) => setTerminalPrefs({ cursorBlink: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.terminalPanel.scrollbackSection', 'Scrollback')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.scrollbackLines', 'Scrollback lines')}</label>
        <input
          type="number"
          className="settings-input settings-input--narrow"
          value={terminalPrefs.scrollbackLines}
          min={100}
          max={100000}
          step={100}
          onChange={(e) => setTerminalPrefs({ scrollbackLines: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
