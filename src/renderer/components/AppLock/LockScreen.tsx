import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useT } from '../../i18n';
import { retrySeconds, unlockErrorKey } from '../../utils/app-lock';

interface LockScreenProps {
  /** The app is mounted behind this screen, so its terminals and agents are still running. */
  running: boolean;
}

/**
 * The lock screen (issue #473). It holds the password only while it is being
 * typed: the field is cleared after every attempt, right or wrong, and main
 * (`app-lock.ts`) is the one that decides.
 *
 * The form submits on Enter by itself. That matters: LockGate stops every key
 * event before a handler can see it, so an `onKeyDown` here would never run.
 */
export default function LockScreen({ running }: LockScreenProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The end of a wait, as a clock time, so the countdown survives re-renders.
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { inputRef.current?.focus(); }, []);

  const waiting = waitUntil > now;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [waiting]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || waiting || password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.wmux.appLock.unlock(password);
      // On success main's state change removes this screen; nothing to do here.
      if (!result.ok) {
        const key = unlockErrorKey(result.error, result.retryAfterMs);
        setError(t(key));
        if (retrySeconds(result.retryAfterMs) > 0) {
          setNow(Date.now());
          setWaitUntil(Date.now() + (result.retryAfterMs ?? 0));
        }
      }
    } catch {
      setError(t('appLock.failed'));
    } finally {
      setPassword('');
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const seconds = waiting ? Math.ceil((waitUntil - now) / 1000) : 0;
  const message = error?.replace('{seconds}', String(seconds));

  return (
    <div className="app-lock" role="dialog" aria-modal="true" aria-labelledby="app-lock-title">
      {/* The app's titlebar is not mounted at startup: this strip is what moves the window. */}
      <div className="app-lock__drag" />
      <form className="app-lock__card" onSubmit={submit}>
        <h1 id="app-lock-title" className="app-lock__title">{t('appLock.title')}</h1>
        <p className="app-lock__prompt">{t('appLock.prompt')}</p>
        <input
          ref={inputRef}
          className="app-lock__input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label={t('appLock.passwordLabel')}
          placeholder={t('appLock.passwordLabel')}
          autoComplete="current-password"
          spellCheck={false}
          disabled={busy}
        />
        <button className="app-lock__button" type="submit" disabled={busy || waiting || password.length === 0}>
          {busy ? t('appLock.unlocking') : t('appLock.unlock')}
        </button>
        <p className="app-lock__error" role="alert">{message ?? ''}</p>
        {running && <p className="app-lock__note">{t('appLock.runningNote')}</p>}
      </form>
    </div>
  );
}
