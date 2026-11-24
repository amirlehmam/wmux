import { useState, type FormEvent } from 'react';
import { useT } from '../../i18n';
import { useAppLock } from '../../hooks/useAppLock';
import { lockAppNow, MIN_PASSWORD_LENGTH, passwordChangeErrorKey, retrySeconds } from '../../utils/app-lock';
import type { AppLockResult } from '../../../shared/types';

/** The file a forgotten password is recovered by deleting. Shown, never opened from here. */
const LOCK_FILE = '%APPDATA%\\wmux\\app-lock.json';

type Notice = { kind: 'ok' | 'error'; text: string } | null;

/**
 * Settings > General > Password lock (issue #473).
 *
 * The state shown is main's (`useAppLock`), and every change is a call main
 * validates: the length check here only saves a round trip. The fields are
 * cleared after each attempt, so a password does not sit in this component
 * once it has been sent.
 *
 * The hint says what the lock is not. It is the one place a person reads
 * before relying on it, so it must not promise encryption.
 */
export default function AppLockSettings() {
  const t = useT();
  const state = useAppLock();
  const configured = state?.configured ?? false;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const clear = () => { setCurrent(''); setNext(''); setConfirm(''); };

  const report = (result: AppLockResult, okText: string) => {
    if (result.ok) {
      setNotice({ kind: 'ok', text: okText });
      return;
    }
    const text = t(passwordChangeErrorKey(result.error))
      .replace('{min}', String(MIN_PASSWORD_LENGTH))
      .replace('{seconds}', String(retrySeconds(result.retryAfterMs)));
    setNotice({ kind: 'error', text });
  };

  const run = async (call: () => Promise<AppLockResult>, okText: string) => {
    setBusy(true);
    setNotice(null);
    try {
      report(await call(), okText);
    } catch {
      setNotice({ kind: 'error', text: t('settings.general.lockSaveFailed') });
    } finally {
      clear();
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (next.length < MIN_PASSWORD_LENGTH) {
      setNotice({ kind: 'error', text: t('settings.general.lockTooShort').replace('{min}', String(MIN_PASSWORD_LENGTH)) });
      return;
    }
    if (next !== confirm) {
      setNotice({ kind: 'error', text: t('settings.general.lockMismatch') });
      return;
    }
    void run(() => window.wmux.appLock.setPassword(configured ? current : null, next), t('settings.general.lockSaved'));
  };

  const remove = () => {
    void run(() => window.wmux.appLock.removePassword(current), t('settings.general.lockRemoved'));
  };

  return (
    <>
      <h3 className="settings-section-title">{t('settings.general.lockSection')}</h3>
      <p className="settings-hint">{t('settings.general.lockHint')}</p>
      <p className="settings-hint">
        {configured ? t('settings.general.lockStatusOn') : t('settings.general.lockStatusOff')}
      </p>

      <form onSubmit={save}>
        {configured && (
          <div className="settings-row">
            <label className="settings-label" htmlFor="app-lock-current">{t('settings.general.lockCurrent')}</label>
            <input
              id="app-lock-current"
              className="settings-input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled={busy}
            />
          </div>
        )}
        <div className="settings-row">
          <label className="settings-label" htmlFor="app-lock-new">{t('settings.general.lockNew')}</label>
          <input
            id="app-lock-new"
            className="settings-input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="settings-row">
          <label className="settings-label" htmlFor="app-lock-confirm">{t('settings.general.lockConfirm')}</label>
          <input
            id="app-lock-confirm"
            className="settings-input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="settings-row">
          <button className="settings-button" type="submit" disabled={busy || next.length === 0}>
            {configured ? t('settings.general.lockChange') : t('settings.general.lockSet')}
          </button>
          {configured && (
            <>
              <button
                className="settings-button settings-button--danger"
                type="button"
                onClick={remove}
                disabled={busy || current.length === 0}
              >
                {t('settings.general.lockRemove')}
              </button>
              <button className="settings-button" type="button" onClick={() => void lockAppNow()} disabled={busy}>
                {t('settings.general.lockNow')}
              </button>
            </>
          )}
        </div>
      </form>

      <p className="settings-hint" role="status" style={notice?.kind === 'error' ? { color: '#ff8a8a' } : undefined}>
        {notice?.text ?? ''}
      </p>
      {configured && (
        <p className="settings-hint">{t('settings.general.lockForgot').replace('{file}', LOCK_FILE)}</p>
      )}
    </>
  );
}
