import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { AgentBrowserTab, AgentViewerAction, AgentViewerBridge, AgentViewerEvent, AgentViewerInput } from '../../../shared/types';
import { useStore } from '../../store';
import { guestShortcutAction } from '../../hooks/useKeyboardShortcuts';
import { matchIndexShortcut } from '../../utils/index-shortcuts';
import { useT } from '../../i18n';

export interface AgentViewerHandle {
  action: (action: AgentViewerAction) => Promise<void>;
}

interface Props {
  surfaceId: string;
  visible: boolean;
  focused?: boolean;
  onActivate?: () => void;
  onPageState: (url: string, title?: string) => void;
  onTabs?: (tabs: AgentBrowserTab[]) => void;
  onConnection?: (connected: boolean) => void;
  onDashboard?: () => void;
  onStartNew?: () => void;
  ref?: Ref<AgentViewerHandle>;
}

export function viewerCoordinates(clientX: number, clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, width: number, height: number): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: Math.max(0, Math.min(width - 1, (clientX - rect.left) * width / rect.width)),
    y: Math.max(0, Math.min(height - 1, (clientY - rect.top) * height / rect.height)) };
}

export function viewerModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return Number(e.altKey) + Number(e.ctrlKey) * 2 + Number(e.metaKey) * 4 + Number(e.shiftKey) * 8;
}

/** Textarea supplies a real IME target; committed composition is sent exactly once. */
export default function AgentBrowserViewer({ surfaceId, visible, focused, onActivate, onPageState, onTabs, onConnection, onDashboard, onStartNew, ref }: Props) {
  const t = useT();
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const state = useRef({ token: '', revision: 0, ready: false, drawnRevision: -1, width: 1, height: 1 });
  const callbacks = useRef({ onPageState, onActivate, onTabs, onConnection, t });
  callbacks.current = { onPageState, onActivate, onTabs, onConnection, t };
  const isVisible = useRef(visible);
  isVisible.current = visible;
  const visibilityChanged = useRef<() => void>(() => {});
  const visibilityGeneration = useRef(0);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const reconnect = useRef<() => void>(() => {});
  const composing = useRef<{ token: string; revision: number; generation: number; interactive: boolean } | null>(null);
  const committedComposition = useRef<string | null>(null);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  const lastPress = useRef<{ time: number; x: number; y: number; button: number; count: number } | null>(null);

  useEffect(() => {
    const el = canvas.current;
    const wheel = (event: WheelEvent) => wheelHandler.current(event);
    el?.addEventListener('wheel', wheel, { passive: false });
    return () => el?.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    if (focused === false || !visible) keyboard.current?.blur();
  }, [focused, visible]);

  useEffect(() => { visibilityChanged.current(); }, [visible]);

  useImperativeHandle(ref, () => ({
    action: async (value) => {
      const { token, revision, ready } = state.current;
      if (!ready) throw new Error('Page is not connected');
      try {
        await (window.wmux.agentViewer as AgentViewerBridge).action(surfaceId, token, revision, value);
        if (state.current.token === token && state.current.ready) setError('');
      } catch (err) {
        if (state.current.token === token && state.current.ready) setError(String(err));
        throw err;
      }
    },
  }), [surfaceId]);

  useEffect(() => {
    const api = window.wmux.agentViewer as AgentViewerBridge;
    let token = crypto.randomUUID();
    state.current = { token, revision: 0, ready: false, drawnRevision: -1, width: 1, height: 1 };
    setError('');
    setConnected(false);
    callbacks.current.onConnection?.(false);
    setHasFrame(false);
    let disposed = false;
    let failed = false;
    let recoveryPending = false;
    let recoveryFrom: string | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let resizing = false;
    let pendingSize: { width: number; height: number; revision: number } | undefined;
    let lastSize = '';
    let activeTab: string | undefined;
    let activeUrl: string | undefined;
    const observeUrl = (url: string) => {
      if (activeUrl !== undefined && activeUrl !== url && composing.current) composing.current.interactive = false;
      activeUrl = url;
    };
    const resize = async () => {
      if (resizing || !state.current.ready || disposed || !isVisible.current || document.hidden) return;
      resizing = true;
      try {
        while (pendingSize && !disposed && state.current.ready && isVisible.current && !document.hidden) {
          const { width, height, revision } = pendingSize;
          pendingSize = undefined;
          if (revision !== state.current.revision) continue;
          const generation = visibilityGeneration.current;
          const key = `${generation}:${revision}:${width}x${height}`;
          if (key === lastSize) continue;
          try {
            await api.action(surfaceId, token, revision, { type: 'viewport', width, height });
            if (!disposed && revision === state.current.revision && generation === visibilityGeneration.current) lastSize = key;
          } catch (err) {
            if (!disposed && revision === state.current.revision && generation === visibilityGeneration.current) {
              setError(String(err));
              pendingSize = undefined;
              break;
            }
            // Obsolete work is dropped, but the newest current-tab measurement still drains.
          }
        }
      } finally { resizing = false; }
    };
    const measure = () => {
      const el = area.current;
      if (!el || disposed || document.hidden || !isVisible.current) return;
      const rect = el.getBoundingClientRect();
      const width = Math.floor(rect.width), height = Math.floor(rect.height);
      if (width < 1 || height < 1) return;
      pendingSize = { width, height, revision: state.current.revision };
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { void resize(); }, 120);
    };
    const syncVisibility = () => {
      const shown = isVisible.current && !document.hidden;
      visibilityGeneration.current++;
      state.current.drawnRevision = -1;
      setHasFrame(false);
      pendingSize = undefined;
      lastSize = '';
      clearTimeout(resizeTimer);
      void api.action(surfaceId, token, state.current.revision, { type: 'visibility', visible: shown }).catch(() => {});
      if (shown) measure();
    };
    visibilityChanged.current = syncVisibility;
    reconnect.current = () => {
      if (disposed || recoveryPending) return;
      recoveryPending = true;
      setRecovering(true);
      recoveryFrom = token;
      const previousToken = token;
      token = crypto.randomUUID();
      state.current = { token, revision: 0, ready: false, drawnRevision: -1, width: 1, height: 1 };
      failed = false;
      visibilityGeneration.current++;
      pendingSize = undefined;
      lastSize = '';
      activeTab = undefined;
      activeUrl = undefined;
      setError('');
      setHasFrame(false);
      setConnected(false);
      callbacks.current.onConnection?.(false);
      // Main checks uncertain CLI work when needed; the new stream supplies page state.
      void api.reconnect(surfaceId, previousToken, token).then(() => {
        if (!disposed && (!isVisible.current || document.hidden)) syncVisibility();
      }).catch((err) => {
        if (disposed) return;
        token = previousToken;
        state.current.token = token;
        failed = true;
        setError(String(err));
      }).finally(() => {
        recoveryPending = false;
        recoveryFrom = undefined;
        if (!disposed) setRecovering(false);
      });
    };
    const off = api.onEvent((event: AgentViewerEvent) => {
      if (disposed || failed || event.surfaceId !== surfaceId || event.token !== token || event.revision < state.current.revision) return;
      const { message } = event;
      if (state.current.revision !== event.revision) {
        state.current.drawnRevision = -1;
        setHasFrame(false);
      }
      state.current.revision = event.revision;
      switch (message.type) {
        case 'error':
          failed = true;
          state.current.ready = false;
          state.current.drawnRevision = -1;
          setHasFrame(false);
          pendingSize = undefined;
          setError(message.message);
          setConnected(false);
          callbacks.current.onConnection?.(false);
          break;
        case 'status':
          state.current.ready = message.connected;
          setConnected(message.connected);
          callbacks.current.onConnection?.(message.connected);
          measure();
          break;
        case 'url':
          observeUrl(message.url);
          callbacks.current.onPageState(message.url);
          break;
        case 'tabs': {
          callbacks.current.onTabs?.(message.tabs);
          const active = message.tabs.find((tab) => tab.active);
          if (active) {
            observeUrl(active.url);
            callbacks.current.onPageState(active.url, active.title);
          }
          if (active?.tabId !== activeTab) {
            activeTab = active?.tabId;
            lastSize = '';
            measure();
          }
          break;
        }
        case 'frame': {
          if (!isVisible.current || document.hidden) {
            api.ack(surfaceId, token, message.id, false);
            break;
          }
          const revision = event.revision;
          const frameToken = token;
          const generation = visibilityGeneration.current;
          const image = new Image();
          const finish = (drawn: boolean) => api.ack(surfaceId, frameToken, message.id, drawn);
          image.onload = () => {
            let drawn = false;
            try {
              const el = canvas.current;
              if (!disposed && frameToken === token && isVisible.current && !document.hidden && generation === visibilityGeneration.current && state.current.ready && state.current.revision === revision && el) {
                el.width = image.naturalWidth;
                el.height = image.naturalHeight;
                const context = el.getContext('2d');
                if (context) {
                  context.drawImage(image, 0, 0);
                  state.current.width = message.width;
                  state.current.height = message.height;
                  state.current.drawnRevision = revision;
                  drawn = true;
                  setHasFrame(true);
                }
              }
            } catch { decodeFailure(); }
            finally { finish(drawn); }
          };
          const decodeFailure = () => {
            if (!disposed && frameToken === token && !failed && isVisible.current && generation === visibilityGeneration.current && state.current.revision === revision) {
              failed = true;
              state.current.ready = false;
              state.current.drawnRevision = -1;
              pendingSize = undefined;
              setHasFrame(false);
              setConnected(false);
              callbacks.current.onConnection?.(false);
              setError(callbacks.current.t('browser.agent.decodeError', 'Could not decode the page stream. Open dashboard or reconnect to continue.'));
              api.reportFailure(surfaceId, frameToken, revision, 'decode');
            }
          };
          image.onerror = () => { decodeFailure(); finish(false); };
          image.src = `data:image/jpeg;base64,${message.data}`;
          break;
        }
      }
    });
    void api.attach(surfaceId, token).then(() => { if (!disposed && (!isVisible.current || document.hidden)) syncVisibility(); })
      .catch((err) => { if (!disposed) setError(String(err)); });
    const observer = new ResizeObserver(measure);
    if (area.current) observer.observe(area.current);
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      disposed = true;
      state.current.ready = false;
      pendingSize = undefined;
      clearTimeout(resizeTimer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', syncVisibility);
      visibilityChanged.current = () => {};
      reconnect.current = () => {};
      off();
      api.detach(surfaceId, token);
      if (recoveryFrom) api.detach(surfaceId, recoveryFrom);
    };
  }, [surfaceId]);

  const input = (value: AgentViewerInput) => {
    const s = state.current;
    if (visible && !document.hidden && s.ready && s.drawnRevision === s.revision) window.wmux.agentViewer.input(surfaceId, s.token, s.revision, value);
  };
  const action = (value: AgentViewerAction) => {
    const s = state.current;
    if (visible && !document.hidden && s.ready && s.drawnRevision === s.revision) {
      const { token, revision } = s;
      const generation = visibilityGeneration.current;
      void (window.wmux.agentViewer as AgentViewerBridge).action(surfaceId, token, revision, value).catch((err) => {
        if (state.current.token === token && state.current.ready && state.current.revision === revision && generation === visibilityGeneration.current) setError(String(err));
      });
    }
  };
  const commitText = (value: string) => {
    if (!value) return;
    if (value.length <= 2 && Array.from(value).length === 1) {
      input({ type: 'input_keyboard', eventType: 'char', text: value, windowsVirtualKeyCode: 0, modifiers: 0 });
    } else action({ type: 'insert-text', text: value });
  };
  const mouse = (e: React.PointerEvent<HTMLCanvasElement> | WheelEvent, eventType: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel') => {
    const el = canvas.current;
    if (!el) return;
    const s = state.current;
    const pos = viewerCoordinates(e.clientX, e.clientY, el.getBoundingClientRect(), s.width, s.height);
    if (!pos) return;
    const button = eventType === 'mouseWheel' ? 'none' : eventType === 'mouseMoved'
      ? (e.buttons & 1 ? 'left' : e.buttons & 2 ? 'right' : e.buttons & 4 ? 'middle' : 'none')
      : (['left', 'middle', 'right'][e.button] ?? 'none') as 'left';
    let clickCount = 0;
    if (eventType === 'mousePressed') {
      const previous = lastPress.current;
      const time = Date.now();
      const consecutive = previous && previous.button === e.button && time - previous.time <= 500
        && Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= 5;
      clickCount = consecutive ? Math.min(3, previous.count + 1) : 1;
      lastPress.current = { time, x: e.clientX, y: e.clientY, button: e.button, count: clickCount };
    } else if (eventType === 'mouseReleased') {
      clickCount = lastPress.current?.button === e.button ? lastPress.current.count : 1;
    }
    input({ type: 'input_mouse', eventType, ...pos, button, clickCount,
      modifiers: viewerModifiers(e), ...('deltaX' in e ? { deltaX: e.deltaX, deltaY: e.deltaY } : {}) });
  };
  wheelHandler.current = (event) => { event.preventDefault(); mouse(event, 'mouseWheel'); };
  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>, eventType: 'keyDown' | 'keyUp') => {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const { shortcuts, keyboardPrefs } = useStore.getState();
    if (guestShortcutAction({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, repeat: false }, shortcuts)
      || matchIndexShortcut(e.nativeEvent, keyboardPrefs.workspaceIndexModifiers) !== null
      || matchIndexShortcut(e.nativeEvent, keyboardPrefs.surfaceIndexModifiers) !== null) return;
    e.stopPropagation();
    const lower = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['c', 'v'].includes(lower)) {
      e.preventDefault();
      if (eventType === 'keyDown' && !e.repeat) action({ type: lower === 'c' ? 'copy' : 'paste' });
      return;
    }
    if (e.key === 'Dead' || e.key === 'Process') return;
    const printable = Array.from(e.key).length === 1
      && ((!e.ctrlKey && !e.metaKey && !e.altKey) || e.getModifierState('AltGraph'));
    if (printable) {
      if (eventType === 'keyDown') committedComposition.current = null;
      input({ type: 'input_keyboard', eventType: eventType === 'keyDown' ? 'rawKeyDown' : 'keyUp',
        key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: viewerModifiers(e) });
      return; // The textarea supplies text separately, including dead keys and Unicode.
    }
    e.preventDefault();
    input({ type: 'input_keyboard', eventType, key: e.key, code: e.code,
      windowsVirtualKeyCode: e.keyCode, modifiers: viewerModifiers(e),
      ...(eventType === 'keyDown' && e.key === 'Enter' ? { text: '\r' } : {}) });
  };

  return <div ref={area} className="agent-browser-viewer" style={{ position: 'absolute', inset: 0, overflow: 'hidden', visibility: visible ? 'visible' : 'hidden' }}>
    <canvas ref={canvas} style={{ width: '100%', height: '100%', objectFit: 'fill', touchAction: 'none' }}
      onPointerDown={(e) => { callbacks.current.onActivate?.(); keyboard.current?.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); mouse(e, 'mousePressed'); e.preventDefault(); }}
      onPointerMove={(e) => mouse(e, 'mouseMoved')}
      onPointerUp={(e) => { mouse(e, 'mouseReleased'); e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={(e) => mouse(e, 'mouseReleased')}
      onContextMenu={(e) => e.preventDefault()} />
    <textarea ref={keyboard} aria-label={t('browser.agent.pageInput', 'Agent browser page input')} autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onFocus={() => callbacks.current.onActivate?.()}
      style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
      onKeyDown={(e) => key(e, 'keyDown')} onKeyUp={(e) => key(e, 'keyUp')}
      onCompositionStart={() => {
        const { token, revision, ready, drawnRevision } = state.current;
        composing.current = { token, revision, generation: visibilityGeneration.current,
          interactive: visible && !document.hidden && ready && drawnRevision === revision };
        committedComposition.current = null;
      }}
      onCompositionEnd={(e) => {
        const origin = composing.current;
        composing.current = null;
        committedComposition.current = e.data;
        // A deferred commit belongs to its original interactive page, not a newly drawn tab.
        if (origin?.interactive && origin.token === state.current.token && origin.revision === state.current.revision
          && origin.generation === visibilityGeneration.current) commitText(e.data);
        e.currentTarget.value = '';
      }}
      onInput={(e) => {
        if (composing.current || (e.nativeEvent as InputEvent).isComposing) return;
        const value = e.currentTarget.value;
        if (committedComposition.current !== null && (e.nativeEvent as InputEvent).data === committedComposition.current) {
          committedComposition.current = null;
          e.currentTarget.value = '';
          return;
        }
        committedComposition.current = null;
        commitText(value);
        e.currentTarget.value = '';
      }}
      onPaste={(e) => { e.preventDefault(); action({ type: 'paste' }); }}
      onCopy={(e) => { e.preventDefault(); action({ type: 'copy' }); }} />
    {(!connected || !hasFrame || error) && <div className="browser-pane__blank agent-browser-viewer__overlay" role="status">
      <p className="browser-pane__blank-title">{error || (connected
        ? t('browser.agent.waitingFrame', 'Waiting for page frame…')
        : t('browser.agent.connecting', 'Connecting to page…'))}</p>
      {error && !connected && <button className="browser-pane__setup-btn" disabled={recovering} onClick={() => reconnect.current()}>
        {t('browser.agent.reconnect', 'Reconnect / Continue')}
      </button>}
      {error && !connected && onStartNew && <button className="browser-pane__setup-btn" disabled={recovering} onClick={onStartNew}>
        {t('browser.agent.startNew', 'Start new session')}
      </button>}
      {error && onDashboard && <button className="browser-pane__setup-btn" onClick={onDashboard}>
        {t('browser.agent.showDashboard', 'Show dashboard')}
      </button>}
      {error && connected && <button className="browser-pane__setup-btn" onClick={() => setError('')}>
        {t('browser.agent.dismissError', 'Dismiss')}
      </button>}
    </div>}
  </div>;
}
