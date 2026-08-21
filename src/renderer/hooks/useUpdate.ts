import { useCallback, useEffect, useState } from 'react';

export interface UpdateInfo {
  version: string;
  url: string;
  body?: string;
  publishedAt?: string;
}

export interface UpdateState {
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  version: string | null;
  percent: number;
  message?: string;
  needsElevation?: boolean;
}

const IDLE: UpdateState = { phase: 'idle', version: null, percent: 0 };

export interface UpdateTriggerResult {
  handled: boolean;
  reason?: string;
}

/**
 * Shared subscribe + click handler for the titlebar badge and the Help
 * panel's update button. Both surfaces drive the same main-process state
 * machine; duplicating the IPC wiring is how they would drift.
 */
export function useUpdate() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [state, setState] = useState<UpdateState>(IDLE);
  const [upToDate, setUpToDate] = useState(false);

  useEffect(() => {
    const wmux = (window as any).wmux;
    if (!wmux?.update) return;

    wmux.update.getLatest().then((info: UpdateInfo | null) => {
      if (info) setUpdate(info);
    }).catch(() => {});
    wmux.update.getState?.().then((s: UpdateState | null) => {
      if (s) setState(s);
    }).catch(() => {});

    const offAvailable = wmux.update.onAvailable((info: UpdateInfo) => {
      setUpdate(info);
      setUpToDate(false);
    });
    const offState = wmux.update.onState?.((s: UpdateState) => {
      setState(s);
      if (s.phase === 'downloading' || s.phase === 'checking' || s.phase === 'ready') {
        setUpToDate(false);
      }
    });
    return () => {
      offAvailable?.();
      offState?.();
    };
  }, []);

  const trigger = useCallback(async (): Promise<UpdateTriggerResult> => {
    const api = (window as any).wmux?.update;
    if (!api) return { handled: false, reason: 'not_supported' };
    const openRelease = () => update && api.openRelease?.(update.url);

    if (!api.install) {
      openRelease();
      return { handled: false, reason: 'not_supported' };
    }
    try {
      const result: UpdateTriggerResult = await api.install();
      if (!result?.handled) {
        if (result?.reason === 'no_update') {
          setUpToDate(true);
          return result;
        }
        openRelease();
      }
      return result ?? { handled: false, reason: 'error' };
    } catch {
      openRelease();
      return { handled: false, reason: 'error' };
    }
  }, [update]);

  return { update, state, upToDate, trigger };
}
