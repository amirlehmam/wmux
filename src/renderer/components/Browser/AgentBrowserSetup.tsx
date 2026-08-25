import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';

/**
 * Why the pane is showing this instead of a viewport.
 *
 * `not-installed` and `no-dashboard` are genuinely different situations and
 * must not share a card. The first means nothing works yet and there is an
 * install to run; the second means the agent browser is working fine and only
 * its OPTIONAL viewer is missing — telling that user to install 240 MB would be
 * both wrong and insulting.
 */
export type AgentBrowserSetupReason = 'not-installed' | 'no-dashboard';

interface AgentBrowserSetupProps {
  reason: AgentBrowserSetupReason;
  /** The binary appeared — the pane should try entering agent mode again. */
  onInstalled: () => void;
  /** Re-run the enable sequence (used by the dashboard-missing card). */
  onRetry: () => void;
  /** Give up and put the surface back on the web engine. */
  onCancel: () => void;
}

/** How often to ask whether the binary has appeared, while an install runs. */
const POLL_MS = 2000;
/** Stop polling eventually — an install the user abandoned must not poll forever. */
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

export default function AgentBrowserSetup({ reason, onInstalled, onRetry, onCancel }: AgentBrowserSetupProps) {
  const t = useT();
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The callbacks are inline arrows from the parent, so a fresh identity on
  // every render. Mirroring them keeps the poll's dependency array empty —
  // issue #141 is what a poll whose deps change every render costs.
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const handleInstall = useCallback(async () => {
    setFailed(false);
    let started: boolean;
    try {
      started = (await window.wmux?.agentBrowser?.install())?.started === true;
    } catch {
      started = false;
    }
    if (!started) { setFailed(true); return; }
    setInstalling(true);

    // The install runs in a REAL terminal pane the user can read, so there is
    // nothing to report here — only "has the binary shown up yet?". Polling
    // status() is how a card in one pane notices work finishing in another.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    stopPolling();
    timerRef.current = setInterval(async () => {
      if (Date.now() > deadline) { stopPolling(); setInstalling(false); return; }
      try {
        if ((await window.wmux?.agentBrowser?.status())?.installed) {
          stopPolling();
          setInstalling(false);
          onInstalledRef.current();
        }
      } catch { /* the bridge went away; the next tick will find out */ }
    }, POLL_MS);
  }, [stopPolling]);

  if (reason === 'no-dashboard') {
    return (
      <div className="browser-pane__setup" role="status">
        <div className="browser-pane__setup-card">
          <h2 className="browser-pane__setup-title">
            {t('agentBrowser.noDashTitle', 'The activity viewer did not start')}
          </h2>
          <p className="browser-pane__setup-body">
            {t(
              'agentBrowser.noDashBody',
              'Your agent still drives a real Chrome from this tab — every browser command works. Only the live viewport and activity feed, which run on http://127.0.0.1:4848, are unavailable. Something else may be using that port.',
            )}
          </p>
          <div className="browser-pane__setup-actions">
            <button className="browser-pane__setup-btn browser-pane__setup-btn--primary" onClick={onRetry}>
              {t('agentBrowser.retry', 'Try again')}
            </button>
            <button className="browser-pane__setup-btn" onClick={onCancel}>
              {t('agentBrowser.backToWeb', 'Back to the built-in browser')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="browser-pane__setup" role="status">
      <div className="browser-pane__setup-card">
        <h2 className="browser-pane__setup-title">
          {t('agentBrowser.setupTitle', 'Let your agent drive a real Chrome')}
        </h2>
        <p className="browser-pane__setup-body">
          {t(
            'agentBrowser.setupBody',
            'agent-browser gives this tab a real Chrome instead of the built-in panel: real profiles, real extensions, sites that refuse an embedded browser. You watch a live viewport and a chronological feed of every command your agent runs.',
          )}
        </p>
        <p className="browser-pane__setup-cost">
          {t('agentBrowser.setupCost', 'One-time download of about 240 MB (the tool plus its own Chrome).')}
        </p>
        <pre className="browser-pane__setup-cmds">{'npm i -g agent-browser\nagent-browser install'}</pre>
        {installing ? (
          <p className="browser-pane__setup-status">
            {t('agentBrowser.installing', 'Installing in the terminal pane below — watch it there. This tab switches over on its own when it finishes.')}
          </p>
        ) : (
          <p className="browser-pane__setup-hint">
            {t('agentBrowser.installHint', 'Install opens a terminal pane and runs these there, so you can read the output if anything goes wrong.')}
          </p>
        )}
        {failed && (
          <p className="browser-pane__setup-error">
            {t('agentBrowser.installFailed', 'wmux could not open a terminal pane for the install. Run the two commands above in any terminal, then switch back to agent.')}
          </p>
        )}
        <div className="browser-pane__setup-actions">
          <button
            className="browser-pane__setup-btn browser-pane__setup-btn--primary"
            onClick={handleInstall}
            disabled={installing}
          >
            {installing ? t('agentBrowser.waiting', 'Waiting…') : t('agentBrowser.install', 'Install')}
          </button>
          <button className="browser-pane__setup-btn" onClick={onCancel}>
            {t('agentBrowser.cancel', 'Cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
