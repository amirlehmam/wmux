import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { UserColorScheme } from '../../store/settings-slice';

export default function TerminalSettings() {
  const { terminalPrefs, setTerminalPrefs } = useStore();
  const [themes, setThemes] = useState<string[]>(['Monokai']);
  const [newSchemeName, setNewSchemeName] = useState('');

  // Load the list of bundled themes from the main process on mount so the
  // dropdown reflects actual files in resources/themes/ rather than a stub.
  useEffect(() => {
    (window as any).wmux?.config?.getThemeList?.().then((list: string[]) => {
      if (Array.isArray(list) && list.length > 0) setThemes(list);
    });
  }, []);

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
      <h3 className="settings-section-title">Font</h3>

      <div className="settings-row">
        <label className="settings-label">Font family</label>
        <input
          type="text"
          className="settings-input"
          value={terminalPrefs.fontFamily}
          onChange={(e) => setTerminalPrefs({ fontFamily: e.target.value })}
          placeholder="e.g. Consolas, Menlo, monospace"
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Font size</label>
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
      <h3 className="settings-section-title">Color scheme</h3>

      <div className="settings-row">
        <label className="settings-label">Default scheme</label>
        <div className="settings-theme-row">
          <select
            className="settings-select"
            value={terminalPrefs.theme}
            onChange={(e) => setTerminalPrefs({ theme: e.target.value })}
          >
            {allSchemes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="settings-row" style={{ opacity: 0.7, fontSize: '12px' }}>
        Applied to new panes. Override per pane via <code>wmux split --color-scheme NAME</code> or <code>wmux set-color-scheme NAME</code>.
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">Custom schemes</h3>
      <div className="settings-row" style={{ opacity: 0.7, fontSize: '12px' }}>
        Define named overrides (dev / staging / prod). Only the fields you set are overridden; the rest fall back to the bundled base theme.
      </div>

      {userSchemeNames.map((name) => {
        const scheme = terminalPrefs.userColorSchemes[name];
        return (
          <div key={name} className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{name}</strong>
              <button className="settings-btn settings-btn--secondary" onClick={() => removeUserScheme(name)}>Remove</button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                bg
                <input type="color" value={scheme.background || '#1e1e1e'}
                  onChange={(e) => updateUserScheme(name, { background: e.target.value })} />
              </label>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                fg
                <input type="color" value={scheme.foreground || '#dddddd'}
                  onChange={(e) => updateUserScheme(name, { foreground: e.target.value })} />
              </label>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                cursor
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
          placeholder="new scheme name (e.g. prod)"
          value={newSchemeName}
          onChange={(e) => setNewSchemeName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addUserScheme(); }}
        />
        <button className="settings-btn settings-btn--secondary" onClick={addUserScheme}>Add scheme</button>
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">Cursor</h3>

      <div className="settings-row">
        <label className="settings-label">Cursor style</label>
        <select
          className="settings-select"
          value={terminalPrefs.cursorStyle}
          onChange={(e) =>
            setTerminalPrefs({ cursorStyle: e.target.value as 'block' | 'underline' | 'bar' })
          }
        >
          <option value="block">Block</option>
          <option value="underline">Underline</option>
          <option value="bar">Bar</option>
        </select>
      </div>

      <div className="settings-row">
        <label className="settings-label">Cursor blink</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={terminalPrefs.cursorBlink}
          onChange={(e) => setTerminalPrefs({ cursorBlink: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">Scrollback</h3>

      <div className="settings-row">
        <label className="settings-label">Scrollback lines</label>
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
