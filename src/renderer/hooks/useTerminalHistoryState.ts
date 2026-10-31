import { useEffect, useRef, useState } from 'react';
import type { TerminalHistoryBridge, TerminalHistoryState, TerminalHistoryStoreError } from '../../shared/terminal-history';
import { subscribeTerminalHistoryState } from '../utils/terminal-history-state';
import { reportTerminalHistoryFailure } from '../utils/terminal-history-feedback';

/** Consent stays authoritative in main, including failed and temporarily paused operations. */
export function useTerminalHistoryState() {
  const [state, setState] = useState<TerminalHistoryState>();
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<TerminalHistoryStoreError | 'state' | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const events = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const off = subscribeTerminalHistoryState(window.wmux?.terminalHistory,
      (next) => { events.current++; setState(next); setError(null); setUnavailable(false); },
      () => { setUnavailable(true); setError('state'); });
    return () => { mounted.current = false; off(); };
  }, []);

  const setEnabled = async (enabled: boolean) => {
    const bridge: TerminalHistoryBridge | undefined = window.wmux?.terminalHistory;
    if (busy.current || !state || !bridge?.setEnabled) return;
    busy.current = true;
    setPending(true);
    setError(null);
    let version = events.current;
    try {
      const result = await bridge.setEnabled(enabled);
      if (!mounted.current) return;
      if (result.ok) {
        if (events.current === version) setState(result.value);
      } else {
        if (events.current === version) setError(result.error);
        reportTerminalHistoryFailure(result.error);
        // A failed re-enable can still leave main enabled. Never infer consent
        // from an error result, or mistake a temporary pause for the final state.
        version = events.current;
        const current = await bridge.getState();
        if (mounted.current && events.current === version) {
          if (current.ok) {
            setState(current.value);
            setError(null);
            setUnavailable(false);
          } else setUnavailable(true);
        }
      }
    } catch {
      if (mounted.current && events.current === version) {
        setUnavailable(true);
        setError((previous) => previous ?? 'state');
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return { state, pending, unavailable, error: state?.error ?? error, setEnabled };
}
