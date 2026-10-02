/**
 * The phone's read-only mirror of one desktop terminal (#254).
 *
 * It is a MIRROR, and every wiring choice below follows from that:
 *
 *  - `disableStdin`, and no `onData` at all. Keystrokes reach the PTY only
 *    through the composer and the key bar, which carry nonces, arm, and pass
 *    the server's blocked/interrupt guards. An xterm wired to the socket would
 *    be a second input path around every one of those.
 *  - The grid is the desktop's (`term.reset` carries cols×rows). The phone
 *    never resizes a PTY (I4) — only the FONT is ours, per fit.ts.
 *  - No clipboard or OSC 52 addon: a program in the pane must not be able to
 *    write the phone's clipboard.
 *  - Links: only `http:`/`https:`, only OSC 8 hyperlinks the program declared,
 *    and only after a confirm sheet shows the full URL — a terminal is the
 *    easiest place in the world to make link text lie about its target.
 *
 * Scrolling is LOCAL: a finger scrolls this xterm's own scrollback, through the
 * same pure recognisers the desktop uses (touch-pan.ts, touch-fling.ts), and
 * never becomes wheel reports to the PTY. The alternate screen has no
 * scrollback, so there the hint points at PgUp/PgDn on the key bar.
 *
 * The grid can be TALLER than the box (the rows are the desktop's, the font
 * follows the width). The box is then a window over it, pinned to the bottom
 * rows, and the same finger slides it — see vertical-clip.ts (#265).
 *
 * Terminal output never touches React state: `term.data` goes straight from
 * the socket listener into `term.write`. A setState per chunk would re-render
 * the whole attach screen at PTY speed, which is #141 on a phone CPU.
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import type { ServerMessage } from '../../../shared/remote-console-protocol';
import { createTouchPanTracker } from '../../utils/touch-pan';
import { createFlingVelocityTracker, startFling, stepFling, type Fling } from '../../utils/touch-fling';
import { fontForMode, mirrorPans, type FitMode } from '../fit';
import type { RemoteT } from '../i18n';
import { isPinned, panClip, pinClip, reclip, UNCLIPPED, type ClipState } from '../vertical-clip';
import type { WsClient } from '../ws-client';

/** A URL this view will offer to open, or null. Everything that is not plain http(s) is refused. */
export function safeHttpUrl(text: string): string | null {
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const DARK: ITheme = { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: '#264f78' };
const LIGHT: ITheme = {
  background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: '#b6d7ff',
  // The default ANSI white is unreadable on white; darken the two that vanish.
  white: '#6e7781', brightWhite: '#8c959f', yellow: '#9a6700', brightYellow: '#7d4e00',
};

export type TermStatus = 'loading' | 'live' | 'lag' | 'exit' | 'error';

/** How long the full-screen hint stays up (it also goes on a tap). */
export const ALT_HINT_MS = 6000;

/**
 * Surfaces whose full-screen hint was already shown on this page. The hint sat
 * over the top row of the mirrored app for as long as it stayed on the
 * alternate screen — for opencode and friends, the whole session — hiding its
 * header. So it shows ONCE per surface, briefly.
 */
const altHintShown = new Set<string>();

/** Show the hint now? Records the surface when it says yes. */
export function claimAltHint(shown: Set<string>, s: string): boolean {
  if (shown.has(s)) return false;
  shown.add(s);
  return true;
}
type TermError = Extract<ServerMessage, { t: 'term.error' }>['code'];

interface Props {
  client: WsClient;
  s: string;
  mode: FitMode;
  fontScale: number;
  dark: boolean;
  t: RemoteT;
  /** Whether the key bar (and so PgUp / PgDn) is on screen at all. */
  operator: boolean;
  onLink(url: string): void;
  /** The mirror's state, so the attach screen can stop offering input into an exited terminal. */
  onStatus?(status: TermStatus): void;
}

/**
 * What the full-screen-app hint says. A view-only device has no key bar, so
 * naming keys it cannot press would be a false promise; an operator's PgUp /
 * PgDn live in the key bar's extra row, behind ⋯.
 */
export function altHintKey(operator: boolean): 'attach.altHint' | 'attach.altHintViewer' {
  return operator ? 'attach.altHint' : 'attach.altHintViewer';
}

export function errorKey(code: TermError) {
  if (code === 'timeout') return 'attach.errTimeout' as const;
  if (code === 'gone') return 'attach.errGone' as const;
  if (code === 'rate') return 'ack.rate' as const;
  return 'attach.errNoTerminal' as const;
}

/**
 * Whether the overlay offers Retry: the attach was refused (the per-device
 * attach budget) or its snapshot never came, so asking again can work. Nothing
 * else sends the attach again — the view sends it once, at mount.
 */
export function attachRetryable(code: TermError | null): boolean {
  return code === 'rate' || code === 'timeout';
}

export function TermView({ client, s, mode, fontScale, dark, t, operator, onLink, onStatus }: Readonly<Props>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const onLinkRef = useRef(onLink);
  onLinkRef.current = onLink;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const layoutRef = useRef({ mode, fontScale });
  layoutRef.current = { mode, fontScale };
  const refitRef = useRef<(() => void) | null>(null);
  /** The window over a grid taller than the box (#265). Not state: it moves at pan speed. */
  const clipRef = useRef<ClipState>(UNCLIPPED);

  const [status, setStatus] = useState<TermStatus>('loading');
  const [exitCode, setExitCode] = useState(0);
  const [error, setError] = useState<TermError | null>(null);
  const [alt, setAlt] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [hint, setHint] = useState(false);
  /** `fit` hit the floor font and the grid is still wider than the screen: pan sideways. */
  const [clipped, setClipped] = useState(false);
  /** The window was dragged off the grid's bottom rows: offer the way back. */
  const [raised, setRaised] = useState(false);

  useEffect(() => { onStatusRef.current?.(status); }, [status]);

  // The full-screen hint: once per surface, for ALT_HINT_MS, or until tapped.
  const altLive = alt && status === 'live';
  useEffect(() => {
    if (!altLive || !claimAltHint(altHintShown, s)) return;
    setHint(true);
    const id = globalThis.setTimeout(() => setHint(false), ALT_HINT_MS);
    return () => globalThis.clearTimeout(id);
  }, [altLive, s]);

  // ── Terminal lifetime + stream ──────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    const wrap = wrapRef.current;
    if (!host || !wrap) return;
    const term = new Terminal({
      disableStdin: true,
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cursorBlink: false,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (_e, text) => {
          const url = safeHttpUrl(text);
          if (url) onLinkRef.current(url);
        },
      },
    });
    termRef.current = term;
    term.open(host);

    const refit = () => {
      const { mode: m, fontScale: sc } = layoutRef.current;
      const size = fontForMode(m, wrap.clientWidth, term.cols, sc);
      if (term.options.fontSize !== size) term.options.fontSize = size;
      const drawn = host.querySelector('.xterm-screen')?.getBoundingClientRect().width ?? 0;
      setClipped(mirrorPans(m, wrap.clientWidth, term.cols, drawn));
    };
    refitRef.current = refit;
    // The grid's height is not ours to choose, so the box may be shorter than
    // it. Re-measured on every layout change; a pinned window stays pinned,
    // which is what keeps the agent's input row above the phone keyboard.
    const applyClip = () => {
      const next = reclip(clipRef.current, wrap.scrollHeight - wrap.clientHeight);
      clipRef.current = next;
      if (wrap.scrollTop !== next.offset) wrap.scrollTop = next.offset;
      setRaised(!isPinned(next));
    };
    const relayout = () => {
      refit();
      applyClip();
    };
    const trackBottom = () => {
      const b = term.buffer.active;
      setAtBottom(b.viewportY >= b.baseY);
    };

    const subs = [
      term.buffer.onBufferChange((b) => setAlt(b.type === 'alternate')),
      term.onScroll(trackBottom),
      term.onWriteParsed(trackBottom),
    ];

    const unsubscribe = client.subscribe((msg) => {
      if (!msg.t.startsWith('term.') || !('s' in msg) || msg.s !== s) return;
      switch (msg.t) {
        case 'term.reset':
          term.reset();
          term.resize(msg.cols, msg.rows);
          // A new screen starts on its bottom rows, wherever the last one was left.
          clipRef.current = pinClip(clipRef.current);
          relayout();
          term.write(msg.data);
          setError(null);
          setStatus('live');
          break;
        case 'term.data':
          term.write(msg.data);
          break;
        case 'term.lag':
          setStatus('lag');
          break;
        case 'term.exit':
          setExitCode(msg.code);
          setStatus('exit');
          break;
        case 'term.error':
          setError(msg.code);
          setStatus('error');
          break;
      }
    });

    // The box AND the grid: a font or row change resizes the grid without
    // touching the box, and the window has to follow either.
    const ro = new ResizeObserver(relayout);
    ro.observe(wrap);
    const screen = host.querySelector('.xterm-screen');
    if (screen) ro.observe(screen);
    client.attach(s);

    return () => {
      unsubscribe();
      client.detach();
      ro.disconnect();
      for (const d of subs) d.dispose();
      term.dispose();
      termRef.current = null;
      refitRef.current = null;
    };
  }, [client, s]);

  // ── Font follows the fit mode / scale ───────────────────────────────────
  useEffect(() => {
    refitRef.current?.();
    // xterm lays the grid out at the new font on its next frame; measure then too.
    const id = requestAnimationFrame(() => refitRef.current?.());
    return () => cancelAnimationFrame(id);
  }, [mode, fontScale]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = dark ? DARK : LIGHT;
  }, [dark]);

  // ── Touch: local scrollback via the desktop's pure recognisers ─────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const pan = createTouchPanTracker();
    const velocity = createFlingVelocityTracker();
    let carry = 0;
    let fling: Fling | null = null;
    let raf = 0;
    let lastFrame = 0;

    const cellHeight = (): number => {
      const term = termRef.current;
      const screen = hostRef.current?.querySelector('.xterm-screen');
      if (!term || !screen || term.rows <= 0) return 16;
      return Math.max(1, screen.clientHeight / term.rows);
    };
    // Pixels in, whole lines out, remainder carried — so a slow drag still
    // scrolls, one line per cell of travel, instead of rounding to nothing.
    const scrollPx = (delta: number) => {
      const term = termRef.current;
      if (!term) return;
      // The window over a too-tall grid moves first (towards older content) or
      // last (back down); what is left over is the scrollback's.
      const b = term.buffer.active;
      const clip = panClip(clipRef.current, delta, b.viewportY >= b.baseY);
      if (clip.state !== clipRef.current) {
        clipRef.current = clip.state;
        wrap.scrollTop = clip.state.offset;
        setRaised(!isPinned(clip.state));
      }
      const px = clip.rest;
      carry += px;
      const h = cellHeight();
      const lines = Math.trunc(carry / h);
      if (lines !== 0) {
        carry -= lines * h;
        term.scrollLines(lines);
      }
    };
    const stopFling = () => {
      fling = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const frame = (ts: number) => {
      if (!fling) return;
      const step = stepFling(fling, ts - lastFrame);
      lastFrame = ts;
      scrollPx(step.deltaY);
      fling = step.next;
      raf = fling ? requestAnimationFrame(frame) : 0;
    };

    const onDown = (e: PointerEvent) => {
      stopFling();
      if (e.pointerType !== 'touch') return;
      pan.down(e.pointerId, e.clientX, e.clientY);
      velocity.reset();
      carry = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const delta = pan.move(e.pointerId, e.clientX, e.clientY);
      if (!pan.panning) return;
      e.preventDefault();
      velocity.add(e.timeStamp, e.clientY);
      if (delta !== 0) scrollPx(delta);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const wasPanning = pan.panning;
      pan.up(e.pointerId);
      if (e.type === 'pointerup' && wasPanning && pan.phase === 'idle') {
        fling = startFling(velocity.releaseVelocity(e.timeStamp));
        if (fling) {
          lastFrame = performance.now();
          raf = requestAnimationFrame(frame);
        }
      }
    };

    wrap.addEventListener('pointerdown', onDown);
    wrap.addEventListener('pointermove', onMove, { passive: false });
    wrap.addEventListener('pointerup', onUp);
    wrap.addEventListener('pointercancel', onUp);
    return () => {
      stopFling();
      wrap.removeEventListener('pointerdown', onDown);
      wrap.removeEventListener('pointermove', onMove);
      wrap.removeEventListener('pointerup', onUp);
      wrap.removeEventListener('pointercancel', onUp);
    };
  }, []);

  let overlay: string | null = null;
  if (status === 'loading') overlay = t.t('attach.loading');
  else if (status === 'error' && error) overlay = t.t(errorKey(error));
  else if (status === 'exit') overlay = t.t('attach.exited', { code: exitCode });

  return (
    <div className="rc-term">
      <div ref={wrapRef} className={mode === 'pan' || clipped ? 'rc-term__wrap rc-term__wrap--pan' : 'rc-term__wrap'}>
        <div ref={hostRef} className="rc-term__host" />
      </div>
      {overlay && (
        <div className="rc-term__overlay" role="status">
          <span>{overlay}</span>
          {status === 'error' && attachRetryable(error) && (
            <button
              type="button"
              className="rc-btn rc-term__retry"
              onClick={() => {
                setError(null);
                setStatus('loading');
                client.attach(s);
              }}
            >
              {t.t('common.retry')}
            </button>
          )}
        </div>
      )}
      {status === 'lag' && <div className="rc-term__pill rc-term__pill--lag" role="status">{t.t('attach.lag')}</div>}
      {altLive && hint && (
        <button type="button" className="rc-term__hint" onClick={() => setHint(false)}>{t.t(altHintKey(operator))}</button>
      )}
      {((!atBottom && !alt) || raised) && (
        <button
          type="button"
          className="rc-term__pill rc-term__jump"
          onClick={() => {
            termRef.current?.scrollToBottom();
            clipRef.current = pinClip(clipRef.current);
            if (wrapRef.current) wrapRef.current.scrollTop = clipRef.current.offset;
            setRaised(false);
          }}
        >
          {t.t('attach.jumpBottom')} ↓
        </button>
      )}
    </div>
  );
}
