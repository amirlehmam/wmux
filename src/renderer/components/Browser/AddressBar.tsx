import { useState, useRef, useCallback, KeyboardEvent, ChangeEvent } from 'react';
import { useT } from '../../i18n';

interface AddressBarProps {
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onDevTools?: () => void;
}

export default function AddressBar({
  url,
  isLoading,
  canGoBack,
  canGoForward,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onDevTools,
}: AddressBarProps) {
  const t = useT();
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const displayUrl = editingUrl !== null ? editingUrl : url;

  const handleFocus = useCallback(() => {
    setEditingUrl(url);
    // Select all text on focus
    requestAnimationFrame(() => {
      inputRef.current?.select();
    });
  }, [url]);

  const handleBlur = useCallback(() => {
    setEditingUrl(null);
  }, []);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEditingUrl(e.target.value);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        const val = (editingUrl ?? url).trim();
        if (val) {
          onNavigate(val);
        }
        inputRef.current?.blur();
      } else if (e.key === 'Escape') {
        setEditingUrl(null);
        inputRef.current?.blur();
      }
    },
    [editingUrl, url, onNavigate],
  );

  return (
    <div className="browser-address-bar">
      <button
        className="browser-address-bar__btn"
        disabled={!canGoBack}
        onClick={onBack}
        title={t('addressBar.back', 'Back')}
        aria-label={t('addressBar.back', 'Back')}
      >
        &#8592;
      </button>
      <button
        className="browser-address-bar__btn"
        disabled={!canGoForward}
        onClick={onForward}
        title={t('addressBar.forward', 'Forward')}
        aria-label={t('addressBar.forward', 'Forward')}
      >
        &#8594;
      </button>
      <button
        className="browser-address-bar__btn"
        onClick={isLoading ? onStop : onReload}
        title={isLoading ? t('addressBar.stop', 'Stop') : t('addressBar.reload', 'Reload')}
        aria-label={isLoading ? t('addressBar.stop', 'Stop') : t('addressBar.reload', 'Reload')}
      >
        {isLoading ? '\u2715' : '\u21BB'}
      </button>
      {onDevTools && (
        <button
          className="browser-address-bar__btn"
          onClick={onDevTools}
          title={t('addressBar.openDevTools', 'Open DevTools for this page')}
          aria-label={t('addressBar.devTools', 'DevTools')}
        >
          &#9881;
        </button>
      )}
      <input
        ref={inputRef}
        className="browser-address-bar__url"
        type="text"
        value={displayUrl}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  );
}
