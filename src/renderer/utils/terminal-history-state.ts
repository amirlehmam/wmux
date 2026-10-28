import type { TerminalHistoryBridge, TerminalHistoryState } from '../../shared/terminal-history';

/** A late seed must not undo a main-process broadcast received after subscribing. */
export function subscribeTerminalHistoryState(
  bridge: TerminalHistoryBridge | undefined,
  accept: (state: TerminalHistoryState) => void,
  unavailable: () => void,
): () => void {
  let stopped = false;
  let events = 0;
  let off: (() => void) | undefined;
  try {
    if (!bridge?.onState || !bridge.getState) throw new Error('Unavailable');
    off = bridge.onState((state) => {
      if (stopped) return;
      events++;
      accept(state);
    });
    const version = events;
    void bridge.getState().then((result) => {
      if (stopped || events !== version) return;
      if (result.ok) accept(result.value);
      else unavailable();
    }, () => { if (!stopped && events === version) unavailable(); });
  } catch { unavailable(); }
  return () => { stopped = true; off?.(); };
}
