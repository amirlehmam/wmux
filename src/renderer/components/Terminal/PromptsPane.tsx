import { useCallback, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import type { Translator } from '../../i18n/core';
import { surfaceTerminalRegistry } from '../../hooks/useTerminal';
import { jumpTo } from '../../utils/prompt-marks';
import { togglePinnedPromptEntry } from '../../store/prompt-actions';
import { promptSummary, type PromptEntry } from '../../store/prompt-slice';
import '../../styles/prompt-marks.css';

/**
 * The prompt outline as a PANE (issue #207 follow-up).
 *
 * The overlay in PromptOutline.tsx answers "what did I ask, just now" — you open
 * it, you jump, it goes away. This answers a different question: "keep the list
 * of what I have asked visible next to the terminal, permanently." Those want
 * opposite things from the layout. An overlay floats over the pane it describes
 * and takes rows from it, which is fine for a glance and wrong for a panel; a
 * surface lives in the split tree, so it splits and resizes like anything else
 * and competes with nothing.
 *
 * They are two VIEWS over one prompt log, not two implementations. Everything
 * below reads the same `prompts` map and jumps through the same marks.
 *
 * ─── Which terminal does it list? ────────────────────────────────────────────
 *
 * The overlay never had to ask: it is rendered by the pane whose prompts it
 * shows. A panel sits somewhere else entirely, so it follows the last terminal
 * to hold focus (`promptSourceSurface`), and can be pinned to one terminal when
 * following is the wrong behaviour — which it is the moment there are two
 * terminals and you want to watch one while typing in the other.
 */
export default function PromptsPane({ surfaceId }: { surfaceId: string }) {
  const t = useT();
  const prefs = useStore((s) => s.promptPrefs);
  const following = useStore((s) => s.promptSourceSurface);
  const lockedTo = useStore((s) => s.promptPaneLocks[surfaceId]);
  const setPromptPaneLock = useStore((s) => s.setPromptPaneLock);
  const updatePrompt = useStore((s) => s.updatePrompt);

  // A lock wins; otherwise whichever terminal last had focus.
  const sourceId = lockedTo ?? following;
  const prompts = useStore((s) => (sourceId ? s.prompts[sourceId] : undefined));
  const pinnedId = useStore((s) => (sourceId ? s.pinnedPrompts[sourceId]?.id ?? null : null));

  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    // Newest first, like the overlay: the row a user wants is almost always the
    // one they just submitted.
    const all = prompts ? [...prompts].reverse() : [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    // The FULL text, not the one-line summary the row shows — a prompt's
    // distinguishing detail is usually in its second paragraph.
    return all.filter((e) => e.text.toLowerCase().includes(needle));
  }, [prompts, query]);

  /**
   * Scroll the source terminal to a prompt.
   *
   * `entry.line` is a snapshot the store never invalidates; the live answer is
   * whether `jumpTo` found the mark. A null is news the store has to hear, or a
   * row for a prompt that has scrolled out of history keeps advertising a jump
   * it can no longer perform.
   */
  const jump = useCallback((entry: PromptEntry | undefined): boolean => {
    if (!entry || !sourceId) return false;
    const terminal = surfaceTerminalRegistry.get(sourceId);
    // No terminal means that pane is mid-remount — transient, and nothing to do
    // with this entry, so the row must not be blamed for it.
    if (!terminal) return false;
    if (jumpTo(terminal, sourceId, entry.id) !== null) return true;
    updatePrompt(sourceId, entry.id, { line: null });
    return false;
  }, [sourceId, updatePrompt]);

  // Unlike the overlay, this panel never steals the caret and never handles
  // Escape: it is a permanent part of the layout, so the shell keeps the
  // keyboard until the user clicks in here themselves.
  if (!prefs.enabled) {
    return (
      <div className="prompts-pane">
        <p className="prompt-outline__empty">
          {t('prompt.paneDisabled', 'Prompt tracking is off. Turn it on in Settings → Prompts.')}
        </p>
      </div>
    );
  }

  return (
    <div className="prompts-pane">
      <div className="prompts-pane__head">
        <input
          className="prompt-outline__filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('prompt.outlineFilter', 'Filter prompts...')}
        />
        <button
          type="button"
          className="prompts-pane__lock"
          // Locking targets whatever is on screen RIGHT NOW, which is why it
          // reads `sourceId` rather than `following`: pressing the button must
          // pin the list the user is looking at, including when that list is
          // already there because of an earlier lock.
          onClick={() => setPromptPaneLock(surfaceId, lockedTo ? null : sourceId ?? null)}
          disabled={!sourceId}
          aria-pressed={!!lockedTo}
          data-locked={!!lockedTo}
          title={lockedTo
            ? t('prompt.paneUnlock', 'Following a fixed pane — click to follow the focused pane again')
            : t('prompt.paneLock', 'Following the focused pane — click to pin this list to it')}
        >
          {lockedTo ? '\u{1F512}' : '\u{1F513}'}
        </button>
      </div>

      <div className="prompts-pane__list" ref={listRef}>
        {rows.map((entry) => {
          const isPinned = pinnedId === entry.id;
          return (
            <div
              key={entry.id}
              className="prompt-outline__row"
              data-reachable={entry.line !== null}
            >
              <button
                type="button"
                className="prompt-outline__jump"
                onClick={() => jump(entry)}
                disabled={entry.line === null}
                title={entry.line !== null
                  ? t('prompt.paneJump', 'Jump the terminal to this prompt')
                  : t('prompt.pinUnreachable', 'This prompt has scrolled out of the terminal history')}
              >
                <span className="prompt-outline__meta">
                  <span className="prompt-outline__seq">#{entry.seq}</span>
                  <span className="prompt-outline__time">{clockOf(entry.at)}</span>
                  <span className="prompt-outline__source">{entry.source}</span>
                </span>
                <span className="prompts-pane__text">
                  {promptSummary(entry.text) || t('prompt.noText', '(prompt text was not captured)')}
                </span>
              </button>
              <button
                type="button"
                className="prompt-outline__pin"
                // Through the shared action, never `setPinnedPrompt` directly:
                // pinning also has to switch the sticky header on when it is off,
                // and that rule lives in exactly one place.
                onClick={() => togglePinnedPromptEntry(sourceId ?? null, entry)}
                aria-pressed={isPinned}
                data-pinned={isPinned}
                title={isPinned
                  ? t('prompt.unpinThis', 'Unpin this prompt')
                  : t('prompt.pinThis', 'Pin this prompt to the top of the pane')}
              >
                &#x1F4CC;
              </button>
            </div>
          );
        })}

        {rows.length === 0 && (
          <p className="prompt-outline__empty">
            {emptyMessage(t, { hasSource: !!sourceId, filtered: !!query.trim() })}
          </p>
        )}
      </div>
    </div>
  );
}

/** hh:mm in the user's own locale — this lists a session, not a log file. */
function clockOf(at: number): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Three empty states, because they need three different actions from the user.
 *
 * "No terminal yet" and "no prompts yet" look identical in a panel — both are a
 * blank list — and telling a user to check their shell integration when the real
 * problem is that they have not focused a terminal sends them to fix something
 * that was never broken.
 */
function emptyMessage(
  t: Translator,
  state: { hasSource: boolean; filtered: boolean },
): string {
  if (state.filtered) return t('prompt.outlineNoMatch', 'No prompt matches this filter.');
  if (!state.hasSource) {
    return t('prompt.paneNoSource', 'Focus a terminal pane and this panel will list its prompts.');
  }
  return t(
    'prompt.outlineEmpty',
    'No prompts recorded yet — wmux learns them from Claude Code’s hooks or from shell integration.',
  );
}
