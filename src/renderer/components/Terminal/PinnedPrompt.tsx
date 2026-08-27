import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { surfaceTerminalRegistry } from '../../hooks/useTerminal';
import { jumpTo } from '../../utils/prompt-marks';
import { canAnchor } from '../../utils/prompt-anchor';
import type { PromptEntry } from '../../store/prompt-slice';
import '../../styles/prompt-marks.css';

/**
 * Frames the alt-buffer probe will wait for its surface's terminal to appear in
 * the registry.
 *
 * The only thing being waited on is a single React commit: `surfaceTerminalRegistry`
 * is written by useTerminal's mount effect, which belongs to this component's
 * PARENT, and a parent's effect runs after its children's — so the first look is
 * always a miss. Frames rather than a timer, and a handful rather than forever,
 * because this must never become the kind of standing poll issue #141 turned
 * into a render-speed loop: when the terminal has not shown up in five frames it
 * is not coming, and the header stays visible, which is the pre-existing
 * behaviour rather than a new failure.
 */
const ATTACH_FRAMES = 5;

/**
 * Is this surface's terminal currently showing an application's ALT buffer?
 *
 * `canAnchor` is the predicate — `buffer.active.type === 'normal'` — and it is
 * deliberately the same one prompt-anchor.ts uses, so the header and the pill
 * cannot disagree about whether a pane is being driven by a full-screen program.
 * It is not reactive on its own, so the honest trigger is xterm's own
 * `buffer.onBufferChange`: an event fired exactly when the active buffer
 * switches, which is the fact being read. No polling, and nothing to tune.
 *
 * Known gap, and it is the reason the alternative was considered: after a
 * split-tree restructure the replacement xterm reports `normal` even with tmux
 * drawing into it, because SerializeAddon replays the CONTENT and not the
 * DECSET that put the old terminal on the alt buffer (issue #164). The signal
 * that does survive that is `surfaceMouseModes`, but it answers a different
 * question — "has the application enabled mouse tracking" — and `less`, and vim
 * with `set mouse=`, enable none, so it would miss exactly the programs this
 * exists for. A remount briefly re-showing the header is a smaller and more
 * self-correcting wrong answer than never hiding it for a pager at all.
 */
function useAltBuffer(surfaceId: string): boolean {
  const [alt, setAlt] = useState(false);

  useEffect(() => {
    let subscription: { dispose(): void } | null = null;
    let frame: number | null = null;
    let attempts = 0;

    const attach = (): void => {
      frame = null;
      const terminal = surfaceTerminalRegistry.get(surfaceId);
      if (!terminal) {
        if (attempts++ < ATTACH_FRAMES) frame = requestAnimationFrame(attach);
        return;
      }
      const sync = () => setAlt(!canAnchor(terminal));
      sync();
      // A terminal is only ever disposed together with the pane that owns it,
      // and that remounts this component — so unsubscribing here is enough and
      // there is no disposed emulator left holding a listener.
      subscription = terminal.buffer.onBufferChange(sync);
    };
    attach();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      subscription?.dispose();
    };
  }, [surfaceId]);

  return alt;
}

/**
 * The sticky prompt header — idea 2 of issue #207: "I scroll up to remember what
 * I asked".
 *
 * Shows the hand-pinned prompt if there is one, otherwise the most recent one.
 * The distinction matters everywhere below: a hand pin is a CHOICE the user made
 * and only they may undo it, while the automatic header is a consequence of a
 * preference, so "close" means two different things and must say which one it
 * means before it does it.
 *
 * The header floats OVER the top rows rather than sitting above the terminal in
 * flow. A flow sibling would shrink xterm's container without firing the
 * ResizeObserver that tells the PTY, and the bottom rows would end up hidden
 * under the overlay with the shell still believing it has them — that is issue
 * #82, and it is the reason every overlay in this stylesheet is absolute.
 */
export default function PinnedPrompt({ surfaceId }: { surfaceId: string }) {
  const t = useT();
  const prefs = useStore((s) => s.promptPrefs);
  const prompts = useStore((s) => s.prompts[surfaceId]);
  const pinned = useStore((s) => s.pinnedPrompts[surfaceId]);
  const setPinnedPrompt = useStore((s) => s.setPinnedPrompt);
  const setPromptPrefs = useStore((s) => s.setPromptPrefs);
  const updatePrompt = useStore((s) => s.updatePrompt);
  const altBuffer = useAltBuffer(surfaceId);

  const manual = pinned ?? null;
  const entry = manual ?? (prompts && prompts.length > 0 ? prompts[prompts.length - 1] : null);

  const body = useMemo(() => {
    if (!entry) return '';
    // Blank lines each cost one of the clamped lines, so a prompt that opens
    // with one would spend the whole header budget showing nothing.
    return entry.text.split('\n').filter((line) => line.trim().length > 0).join('\n');
  }, [entry]);

  /**
   * Record that a prompt's mark is gone, in the store rather than in local
   * state.
   *
   * The header used to keep its own `lostId`, which meant the outline could go
   * on listing the same prompt as jumpable — two views disagreeing about one
   * fact (#207 review). `entry.line` is a snapshot nothing invalidates; a null
   * from `jumpTo` is the live answer and belongs where every view reads.
   */
  const markUnreachable = useCallback((target: PromptEntry) => {
    updatePrompt(surfaceId, target.id, { line: null });
    // `updatePrompt` also patches the hand-pinned COPY, but only while the entry
    // is still in the ring — and a pin deliberately outlives eviction, which is
    // what makes it a pin. For those the write above is a no-op, so patch the
    // pin itself as well; otherwise the header would keep advertising a jump it
    // has just failed to make.
    if (manual && manual.id === target.id) {
      setPinnedPrompt(surfaceId, { ...manual, line: null });
    }
  }, [manual, setPinnedPrompt, surfaceId, updatePrompt]);

  const jump = useCallback(() => {
    if (!entry) return;
    const terminal = surfaceTerminalRegistry.get(surfaceId);
    // No terminal means the pane is mid-remount, which is transient and says
    // nothing about the mark — not a reason to mark the entry unreachable.
    if (!terminal) return;
    if (jumpTo(terminal, surfaceId, entry.id) === null) markUnreachable(entry);
  }, [entry, markUnreachable, surfaceId]);

  const dismiss = useCallback(() => {
    // A manual pin is undone; the automatic header has nothing of its own to
    // undo, so the only thing "close" can mean there is the preference. The
    // titles below spell that out — a close button that silently rewrites a
    // global setting is a trap.
    if (manual) setPinnedPrompt(surfaceId, null);
    else setPromptPrefs({ pin: false });
  }, [manual, setPinnedPrompt, setPromptPrefs, surfaceId]);

  // Nothing to sit on top of, and nowhere it could be moved out of the way:
  // a pane running vim, tmux or less owns every row it draws and redraws them
  // in place, so a floating header covers live content that cannot be scrolled
  // out from under it. The alt buffer has no prompt to pin either (#207 review).
  if (!prefs.enabled || !prefs.pin || !entry || altBuffer) return null;

  const reachable = entry.line !== null;
  const sourceLabel = entry.source === 'agent'
    ? t('prompt.sourceAgent', 'agent')
    : t('prompt.sourceShell', 'shell');

  return (
    <div
      className="prompt-pin"
      // The terminal must keep the caret: a header the user clicks to look
      // around is not a request to stop typing into the shell behind it.
      onMouseDown={(e) => e.preventDefault()}
      style={{ '--wmux-pin-lines': prefs.pinLines } as React.CSSProperties}
    >
      <button
        type="button"
        className="prompt-pin__jump"
        onClick={jump}
        disabled={!reachable}
        title={reachable
          ? t('prompt.pinJump', 'Jump to this prompt')
          : t('prompt.pinUnreachable', 'This prompt has scrolled out of the terminal history')}
      >
        <span className="prompt-pin__badge">
          <span className="prompt-pin__seq">#{entry.seq}</span>
          <span className="prompt-pin__source">{sourceLabel}</span>
          {manual && <span className="prompt-pin__manual" title={t('prompt.pinnedByHand', 'Pinned by hand')}>&#x1F4CC;</span>}
        </span>
        <span className="prompt-pin__text">
          {body || t('prompt.noText', '(prompt text was not captured)')}
        </span>
      </button>
      <button
        type="button"
        className="prompt-pin__close"
        onClick={dismiss}
        title={manual
          ? t('prompt.unpin', 'Unpin — show the latest prompt again')
          : t('prompt.pinDisable', 'Hide the prompt header — turns the setting off for every pane')}
      >
        &#x00D7;
      </button>
    </div>
  );
}
