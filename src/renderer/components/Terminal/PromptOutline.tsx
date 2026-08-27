import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { surfaceTerminalRegistry } from '../../hooks/useTerminal';
import { jumpTo } from '../../utils/prompt-marks';
import { togglePinnedPromptEntry } from '../../store/prompt-actions';
import { promptSummary, type PromptEntry } from '../../store/prompt-slice';
import '../../styles/prompt-marks.css';

/** hh:mm in the user's own locale — the outline lists a session, not a log file. */
function clockOf(at: number): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Take the caret back exactly ONCE if something steals it just after the panel
 * appeared, and stop caring the moment the user does anything themselves.
 *
 * Both bounds are the point. The steal this undoes is programmatic (see the
 * focus effect below), so a single recovery is enough for it; an unbounded
 * "always take the focus back" would instead fight a user who deliberately
 * clicked into the shell with the outline still open, and two components each
 * insisting on the caret is a loop, not a fix. A real user gesture — a pointer
 * press or a keystroke, captured so it is seen wherever it lands — is the
 * honest signal that whatever has the caret now has it on purpose.
 */
function armFocusRecovery(input: HTMLInputElement | null, reclaim: () => void): () => void {
  let armed = true;
  let frame: number | null = null;
  const disarm = () => { armed = false; };
  const onBlur = () => {
    if (!armed) return;
    armed = false;
    // Refocusing synchronously from inside a blur handler is not reliable, and
    // the steal being undone happens inside a frame callback — so the next
    // frame is both late enough to land after it and bounded to one attempt.
    frame = requestAnimationFrame(() => { frame = null; reclaim(); });
  };
  input?.addEventListener('blur', onBlur, { once: true });
  document.addEventListener('pointerdown', disarm, true);
  document.addEventListener('keydown', disarm, true);
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    input?.removeEventListener('blur', onBlur);
    document.removeEventListener('pointerdown', disarm, true);
    document.removeEventListener('keydown', disarm, true);
  };
}

/**
 * The prompt outline — idea 4 of issue #207: every prompt in this pane as a jump
 * list.
 *
 * Newest first, because the question a user opens this to answer is almost
 * always "where did the thing I just asked start", not "what did I ask an hour
 * ago". The filter exists for the hour-ago case and searches the FULL prompt
 * text, not the one-line summary the row shows — a prompt's distinguishing
 * detail is usually in its second paragraph.
 */
export default function PromptOutline({ surfaceId }: { surfaceId: string }) {
  const t = useT();
  const prefs = useStore((s) => s.promptPrefs);
  const prompts = useStore((s) => s.prompts[surfaceId]);
  const openSurface = useStore((s) => s.promptOutlineSurface);
  const setPromptOutlineSurface = useStore((s) => s.setPromptOutlineSurface);
  const updatePrompt = useStore((s) => s.updatePrompt);
  // The id, not the entry: the rows only ever ask "is this the pinned one", and
  // subscribing to the entry would re-render the whole list every time the pin's
  // own copy is patched (updatePrompt keeps it in sync).
  const pinnedId = useStore((s) => s.pinnedPrompts[surfaceId]?.id ?? null);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const open = prefs.enabled && prefs.outline && openSurface === surfaceId;

  const rows = useMemo(() => {
    const all = prompts ? [...prompts].reverse() : [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((e) => e.text.toLowerCase().includes(needle));
  }, [prompts, query]);

  /**
   * Put the caret in the filter, unless it is already somewhere in this panel.
   *
   * Idempotent on purpose: it runs from the reveal, from a window focus and
   * from the one-shot recovery above, and "the caret is already here" must
   * never be answered by yanking it out of the control the user just reached.
   */
  const focusFilter = useCallback(() => {
    if (document.hidden) return;
    if (panelRef.current?.contains(document.activeElement)) return;
    inputRef.current?.focus();
  }, []);

  // The panel is opened by an explicit gesture (a shortcut or a menu item), so
  // taking the caret is what the user asked for — unlike the pinned header,
  // which must never steal it.
  //
  // What this effect must survive is losing it again. TerminalPane renders the
  // outline on `visible && focused`, so leaving pane A for pane B and coming
  // back is a fresh mount — and this effect, being a CHILD's, always runs
  // before useTerminal's own `[visible, focused]` effect, which ends in
  // `term.focus()` inside a double requestAnimationFrame. The panel then sat
  // there looking open while Escape, the arrows and Enter all went to the shell
  // (#207 review). Gating that `term.focus()` while an outline owns the surface
  // is the real fix and lives on the terminal side; this is the half that
  // recovers when anything else takes the caret, deliberately without racing
  // frame counts against a sibling component.
  useEffect(() => {
    if (!open) return undefined;
    focusFilter();
    const disarmRecovery = armFocusRecovery(inputRef.current, focusFilter);
    // Coming back from another window, or another OS desktop, restores focus
    // wherever the platform left it — which is not necessarily inside a panel
    // that never closed in the first place.
    window.addEventListener('focus', focusFilter);
    document.addEventListener('visibilitychange', focusFilter);
    return () => {
      disarmRecovery();
      window.removeEventListener('focus', focusFilter);
      document.removeEventListener('visibilitychange', focusFilter);
    };
  }, [open, focusFilter]);

  // Clamp instead of resetting: a prompt arriving while the user reads the list
  // must not throw their cursor back to the top.
  useEffect(() => {
    setSelected((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows.length]);

  const close = useCallback(() => {
    setPromptOutlineSurface(null);
    // Hand the keyboard back where it came from. Closing an overlay and leaving
    // focus on a detached node means the next keystroke goes nowhere, which
    // reads as a frozen terminal.
    surfaceTerminalRegistry.get(surfaceId)?.focus();
  }, [setPromptOutlineSurface, surfaceId]);

  /**
   * Scroll to a prompt. Returns whether it actually went anywhere.
   *
   * `entry.line` is only the store's last known answer — a SNAPSHOT taken when
   * the prompt was recorded, which nothing invalidates. The marker behind it
   * dies the moment its row is trimmed out of the scrollback, so the live answer
   * is the return of `jumpTo`, and a null from it is news the store has to hear:
   * without writing it back, a row for a prompt that scrolled out of history
   * keeps rendering as jumpable and keeps doing nothing when clicked (#207
   * review).
   */
  const jump = useCallback((entry: PromptEntry | undefined): boolean => {
    if (!entry) return false;
    const terminal = surfaceTerminalRegistry.get(surfaceId);
    // No terminal means the pane is mid-remount. That is transient and says
    // nothing about the mark — blaming the entry for the pane's own lifecycle
    // would disable a row that is about to work again.
    if (!terminal) return false;
    if (jumpTo(terminal, surfaceId, entry.id) !== null) return true;
    updatePrompt(surfaceId, entry.id, { line: null });
    return false;
  }, [surfaceId, updatePrompt]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // While the panel is open it owns the keys it uses, and it owns plain typing
    // so the filter input is not also driving the terminal's global shortcuts.
    // Modified keys are deliberately let through — the shortcut that opened this
    // panel has to be able to close it again from inside it.
    const typing = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
    const handled = ['Escape', 'ArrowUp', 'ArrowDown', 'Enter'].includes(e.key);
    if (typing || handled) e.stopPropagation();
    if (!handled) return;
    e.preventDefault();
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Enter') { jump(rows[selected]); return; }
    const step = e.key === 'ArrowDown' ? 1 : -1;
    setSelected((i) => Math.max(0, Math.min(rows.length - 1, i + step)));
  };

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="prompt-outline"
      data-side={prefs.outlineSide}
      onKeyDown={handleKeyDown}
    >
      <div className="prompt-outline__head">
        <input
          ref={inputRef}
          className="prompt-outline__filter"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
          placeholder={t('prompt.outlineFilter', 'Filter prompts...')}
        />
        <button
          type="button"
          className="prompt-outline__close"
          onClick={close}
          title={t('prompt.outlineClose', 'Close (Esc)')}
        >
          &#x00D7;
        </button>
      </div>

      <div className="prompt-outline__list" ref={listRef}>
        {rows.map((entry, index) => {
          const isPinned = pinnedId === entry.id;
          return (
            <div
              key={entry.id}
              className="prompt-outline__row"
              data-selected={index === selected}
              data-reachable={entry.line !== null}
            >
              <button
                type="button"
                className="prompt-outline__jump"
                // A double click fires this once on the way to the second click.
                // Jumping twice to the same line is idempotent, so the pair is
                // "jump, then close" — exactly what the gesture promises.
                onClick={() => { setSelected(index); jump(entry); }}
                // Only on a jump that went somewhere: a row that has just
                // discovered its mark is gone disables itself, and closing the
                // panel would hide the one piece of feedback the user gets.
                onDoubleClick={() => { if (jump(entry)) close(); }}
                disabled={entry.line === null}
                title={entry.line !== null
                  ? t('prompt.outlineJump', 'Click to jump, double-click to jump and close')
                  : t('prompt.pinUnreachable', 'This prompt has scrolled out of the terminal history')}
              >
                <span className="prompt-outline__meta">
                  <span className="prompt-outline__seq">#{entry.seq}</span>
                  <span className="prompt-outline__time">{clockOf(entry.at)}</span>
                </span>
                <span className="prompt-outline__text">
                  {promptSummary(entry.text) || t('prompt.noText', '(prompt text was not captured)')}
                </span>
              </button>
              <button
                type="button"
                className="prompt-outline__pin"
                // Through the shared action, never through `setPinnedPrompt`
                // directly: pinning also has to turn the sticky header on when
                // it is off, and that rule had been written down in the
                // keyboard path only — so this button wrote state and showed
                // nothing on a fresh install, where `pin` is false (#207).
                onClick={() => togglePinnedPromptEntry(surfaceId, entry)}
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
            {query.trim()
              ? t('prompt.outlineNoMatch', 'No prompt matches this filter.')
              : t('prompt.outlineEmpty', 'No prompts recorded yet — wmux learns them from Claude Code’s hooks or from shell integration.')}
          </p>
        )}
      </div>
    </div>
  );
}
