import { useEffect, useState } from 'react';
import { useT } from '../../i18n';

/**
 * Minimise / maximise / close, drawn by us.
 *
 * Only rendered in clear-transparency mode. Everywhere else the window keeps
 * its native frame and `titleBarOverlay` paints these, so drawing them here too
 * would stack two sets of buttons in the same corner.
 *
 * Whether this window was built frameless is asked of main, not derived from
 * the transparency pref: while a restart is pending the pref says the opposite
 * of what the window actually is, and guessing there would hide the caption
 * buttons of a window that still has no native ones — leaving no way to close
 * it. Fixed for the window's lifetime, so it is asked once.
 */
export function useIsFramelessWindow(): boolean {
  const [frameless, setFrameless] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.wmux?.window?.isFrameless?.()
      .then((v: boolean) => { if (!cancelled) setFrameless(v === true); })
      .catch(() => { /* older preload — a native frame is the safe assumption */ });
    return () => { cancelled = true; };
  }, []);
  return frameless;
}

export default function WindowControls() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  // Driven by resize rather than by a timer. Maximising and restoring both
  // change the content area, so every transition this icon cares about — the
  // buttons here, the caption double-click, Win+Up, snap layouts — arrives as a
  // resize. The previous version polled over IPC twice a second for as long as
  // the titlebar was mounted, which in clear mode is the whole session, to
  // catch a two-icon swap that happens a handful of times a day.
  useEffect(() => {
    let cancelled = false;
    let queued = 0;
    const sync = async () => {
      const value = await window.wmux?.window?.isMaximized?.();
      if (!cancelled) setMaximized(value === true);
    };
    // Coalesced: a drag-resize fires this continuously, and the answer only
    // changes at the ends of one.
    const onResize = () => {
      window.clearTimeout(queued);
      queued = window.setTimeout(sync, 100);
    };
    sync();
    window.addEventListener('resize', onResize);
    return () => {
      cancelled = true;
      window.clearTimeout(queued);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div className="titlebar__window-controls">
      <button
        className="titlebar__wc"
        onClick={() => window.wmux?.window?.minimize?.()}
        title={t('titlebar.minimize', 'Minimize')}
        aria-label={t('titlebar.minimize', 'Minimize')}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        className="titlebar__wc"
        onClick={() => window.wmux?.window?.maximize?.()}
        title={maximized ? t('titlebar.restore', 'Restore') : t('titlebar.maximize', 'Maximize')}
        aria-label={maximized ? t('titlebar.restore', 'Restore') : t('titlebar.maximize', 'Maximize')}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
            <path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button
        className="titlebar__wc titlebar__wc--close"
        onClick={() => window.wmux?.window?.closeSelf?.()}
        title={t('titlebar.close', 'Close')}
        aria-label={t('titlebar.close', 'Close')}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="currentColor" fill="none" />
        </svg>
      </button>
    </div>
  );
}
