import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { surfaceTerminalRegistry } from '../../hooks/useTerminal';
import { ANCHOR_EVENT, anchorFor, release, type AnchorEventDetail } from '../../utils/prompt-anchor';
import '../../styles/prompt-marks.css';

/**
 * The "you are not at the bottom" pill — the visible half of idea 3 in issue
 * #207, where the view is held at the start of an answer while the agent keeps
 * writing below it.
 *
 * Its state comes from a throttled DOM event rather than from the store, and
 * that is load-bearing: the pending-line count changes on every PTY chunk, so a
 * store-backed counter would re-render every subscriber at PTY speed — the
 * shape of the bug issue #141 documents. prompt-anchor.ts caps the event at
 * 8/s, which is already faster than anyone reads a number.
 */
export default function NewOutputPill({ surfaceId }: { surfaceId: string }) {
  const t = useT();
  const prefs = useStore((s) => s.promptPrefs);
  /**
   * Pending lines while anchored, or null while following.
   *
   * Deliberately NOT an `AnchorState`: the event carries a count and nothing
   * else, and widening it back into the full anchor here would mean inventing
   * an anchor line the pill has no business knowing. Seeded from the module
   * state because the anchor is set the moment a prompt lands and may well
   * predate this component, in which case its opening event is already spent.
   */
  const [pending, setPending] = useState<number | null>(() => anchorFor(surfaceId)?.pending ?? null);

  useEffect(() => {
    setPending(anchorFor(surfaceId)?.pending ?? null);
    const onAnchor = (event: Event) => {
      const detail = (event as CustomEvent<AnchorEventDetail>).detail;
      if (!detail || detail.surfaceId !== surfaceId) return;
      setPending(detail.active ? detail.pending : null);
    };
    document.addEventListener(ANCHOR_EVENT, onAnchor);
    return () => document.removeEventListener(ANCHOR_EVENT, onAnchor);
  }, [surfaceId]);

  const follow = useCallback(() => {
    // release() tolerates a missing terminal — it just cannot scroll one, which
    // is the right outcome for a pane that is mid-remount.
    release(surfaceId, surfaceTerminalRegistry.get(surfaceId));
  }, [surfaceId]);

  // The preference gate, and not only "is something anchored right now": the
  // anchor lives in a module map that no preference change reaches, so turning
  // the master switch — or 'Hold the view' — off used to leave an already-held
  // pane held, with this pill still on screen, directly contradicting what the
  // settings panel promises ("Turned off, none of them run and nothing is
  // recorded"). Freeing the viewport itself is prompt-anchor's job, on the
  // preference's own path; the pill's job is not to advertise a feature the
  // user has just switched off (#207 review).
  if (!prefs.enabled || !prefs.anchor) return null;
  if (pending === null) return null;

  const unit = pending === 1
    ? t('prompt.pillLine', 'new line')
    : t('prompt.pillLines', 'new lines');
  const label = pending === 0
    ? t('prompt.pillPaused', 'Following paused')
    : `↓ ${pending} ${unit}`;

  return (
    <button
      type="button"
      className="prompt-pill"
      onClick={follow}
      // Same rule as the pinned header: looking at the rest of the output is not
      // a request to take the caret away from the shell.
      onMouseDown={(e) => e.preventDefault()}
      title={t('prompt.pillHint', 'Jump to the newest output and follow it again')}
    >
      {label}
    </button>
  );
}
