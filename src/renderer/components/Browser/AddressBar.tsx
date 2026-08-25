import { useState, useRef, useCallback, KeyboardEvent, ChangeEvent } from 'react';
import { useT } from '../../i18n';
import type { BrowserEngine } from '../../../shared/types';

interface AddressBarProps {
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * Which backend this bar is addressing. It changes what the buttons mean —
   * but the bar knows nothing about agent-browser itself: `onNavigate` is still
   * "the user asked for this URL", and BrowserPane decides what that means.
   */
  engine?: BrowserEngine;
  onEngineChange?: (engine: BrowserEngine) => void;
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
  engine = 'web',
  onEngineChange,
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

  const isAgent = engine === 'agent';
  // In agent mode the remote page's history lives in a Chrome this pane cannot
  // reach, so back/forward arrive disabled (BrowserPane forces the flags) and
  // say why rather than looking broken. Reload addresses the viewer, which is
  // the only thing in the webview at that point.
  const backTitle = isAgent
    ? t('addressBar.backAgent', 'History is not available while the agent drives the browser')
    : t('addressBar.back', 'Back');
  const forwardTitle = isAgent
    ? t('addressBar.backAgent', 'History is not available while the agent drives the browser')
    : t('addressBar.forward', 'Forward');
  const reloadTitle = isAgent
    ? t('addressBar.reloadViewer', 'Reload the activity viewer (does not reload the page the agent is on)')
    : t('addressBar.reload', 'Reload');

  return (
    <div className="browser-address-bar">
      <button
        className="browser-address-bar__btn"
        disabled={!canGoBack}
        onClick={onBack}
        title={backTitle}
        aria-label={t('addressBar.back', 'Back')}
      >
        &#8592;
      </button>
      <button
        className="browser-address-bar__btn"
        disabled={!canGoForward}
        onClick={onForward}
        title={forwardTitle}
        aria-label={t('addressBar.forward', 'Forward')}
      >
        &#8594;
      </button>
      <button
        className="browser-address-bar__btn"
        onClick={isLoading ? onStop : onReload}
        title={isLoading ? t('addressBar.stop', 'Stop') : reloadTitle}
        aria-label={isLoading ? t('addressBar.stop', 'Stop') : t('addressBar.reload', 'Reload')}
      >
        {isLoading ? '\u2715' : '\u21BB'}
      </button>
      {onEngineChange && (
        <div
          className="browser-address-bar__engine"
          role="group"
          aria-label={t('addressBar.engineGroup', 'Browser engine')}
        >
          <button
            type="button"
            className={`browser-address-bar__engine-btn${!isAgent ? ' browser-address-bar__engine-btn--active' : ''}`}
            aria-pressed={!isAgent}
            onClick={() => onEngineChange('web')}
            title={t('addressBar.engineWebTitle', 'Browse in this panel. wmux drives the page itself \u2014 no extra install.')}
          >
            {t('addressBar.engineWeb', 'web')}
          </button>
          <button
            type="button"
            className={`browser-address-bar__engine-btn${isAgent ? ' browser-address-bar__engine-btn--active' : ''}`}
            aria-pressed={isAgent}
            onClick={() => onEngineChange('agent')}
            title={t('addressBar.engineAgentTitle', 'Hand this tab to a real Chrome outside wmux, and watch what your agent does to it here. Needs a one-time install.')}
          >
            {'\u2726 '}{t('addressBar.engineAgent', 'agent')}
          </button>
        </div>
      )}
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
