import { useState, useRef, useCallback, useEffect, KeyboardEvent, ChangeEvent } from 'react';
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
  onMoveToWorkspace?: () => void;
  agentConnected?: boolean;
  presentation?: 'page' | 'dashboard';
  onToggleDashboard?: () => void;
  onNewTab?: () => void;
  focusRequest?: number;
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
  onMoveToWorkspace,
  agentConnected = false,
  presentation = 'page',
  onToggleDashboard,
  onNewTab,
  focusRequest = 0,
}: AddressBarProps) {
  const t = useT();
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!focusRequest) return;
    inputRef.current?.focus();
    setEditingUrl('');
  }, [focusRequest]);

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);

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
  const backTitle = t('addressBar.back', 'Back');
  const forwardTitle = t('addressBar.forward', 'Forward');
  const reloadTitle = t('addressBar.reload', 'Reload');

  return (
    <div className="browser-address-bar">
      {onMoveToWorkspace && <button className="browser-address-bar__btn" onClick={onMoveToWorkspace}
        title={t('panel.workspace', 'Move into workspace')} aria-label={t('panel.workspace', 'Move into workspace')}>↗</button>}
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
        disabled={isAgent && !agentConnected}
        onClick={!isAgent && isLoading ? onStop : onReload}
        title={!isAgent && isLoading ? t('addressBar.stop', 'Stop') : reloadTitle}
        aria-label={!isAgent && isLoading ? t('addressBar.stop', 'Stop') : t('addressBar.reload', 'Reload')}
      >
        {!isAgent && isLoading ? '\u2715' : '\u21BB'}
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
      {onDevTools && !isAgent && (
        <button
          className="browser-address-bar__btn"
          onClick={onDevTools}
          title={t('addressBar.openDevTools', 'Open DevTools for this page')}
          aria-label={t('addressBar.devTools', 'DevTools')}
        >
          &#9881;
        </button>
      )}
      {isAgent && <span className={`browser-address-bar__connection${agentConnected ? ' browser-address-bar__connection--live' : ''}`}
        role="status" aria-label={agentConnected ? t('browser.agent.connected', 'Page connected') : t('browser.agent.disconnected', 'Page disconnected')}
        title={agentConnected ? t('browser.agent.connected', 'Page connected') : t('browser.agent.disconnected', 'Page disconnected')} />}
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
      {isAgent && <div className="browser-address-bar__menu" ref={menuRef}>
        <button type="button" className="browser-address-bar__btn" aria-label={t('browser.agent.menu', 'Browser menu')}
          aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>…</button>
        {menuOpen && <div className="browser-address-bar__menu-items">
          <button type="button" disabled={!agentConnected} onClick={() => { setMenuOpen(false); onNewTab?.(); }}>
            {t('browser.agent.newTab', 'New tab')}
          </button>
          <button type="button" onClick={() => { setMenuOpen(false); onToggleDashboard?.(); }}>
            {presentation === 'page' ? t('browser.agent.showDashboard', 'Show dashboard') : t('browser.agent.returnToPage', 'Return to page')}
          </button>
        </div>}
      </div>}
    </div>
  );
}
