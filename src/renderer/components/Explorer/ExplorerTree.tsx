import React, { useEffect, useRef, useState } from 'react';
import type { ExplorerRow } from './explorer-state';
import { computeKeyNavOutcome } from './explorer-keynav';
import { statFor, isTouched, type DiffStatMap } from './explorer-diff';

interface ExplorerTreeProps {
  rows: ExplorerRow[];
  selectedRelPath: string | null;
  onToggleDir: (relPath: string) => void;
  onSelect: (row: ExplorerRow) => void;
  /** Open a file: `keep` distinguishes a promoting gesture (double-click,
   *  Ctrl+click) from a plain preview click. */
  onActivate: (row: ExplorerRow, opts: { keep: boolean }) => void;
  onContextMenu: (row: ExplorerRow, event: React.MouseEvent) => void;
  /** +N/-N per row, folders included. Empty map = the column is simply absent. */
  diffStats: DiffStatMap;
  /** Paths an agent's Edit/Write touched this session. Empty = no dots. */
  touched: ReadonlySet<string>;
}

/**
 * The +N/-N cell.
 *
 * A zero side is omitted rather than rendered as `+0`, so the eye lands only on
 * what actually moved — a row reading `-22` alone is a pure deletion, and one
 * reading nothing at all did not change. The whole cell is absent for an
 * unchanged row, which is what keeps a tree of 200 files from becoming a wall
 * of zeroes.
 */
function DiffCell({ stat }: { stat: { additions: number; deletions: number } | null }):
React.JSX.Element | null {
  if (!stat || (stat.additions === 0 && stat.deletions === 0)) return null;
  return (
    <span className="explorer-row__diff">
      {stat.additions > 0 && (
        <span className="explorer-row__diff-add">+{stat.additions}</span>
      )}
      {stat.deletions > 0 && (
        <span className="explorer-row__diff-del">-{stat.deletions}</span>
      )}
    </span>
  );
}

/**
 * The row's name plus whatever the visual affordances say, as words — used for
 * both the tooltip and the accessible name.
 *
 * Deliberately NOT translated. Every other string in this panel goes through
 * `t()`, but these two fragments are `+N`/`-N` arithmetic and the word an agent
 * is called; inventing eighteen translations of "12 added, 3 removed" for a
 * tooltip is churn on every locale for no gain, and the numbers themselves are
 * already language-neutral where the user actually reads them.
 */
function describeRow(
  name: string,
  stat: { additions: number; deletions: number } | null,
  agentTouched: boolean,
): string {
  const parts = [name];
  if (stat && (stat.additions > 0 || stat.deletions > 0)) {
    parts.push(`+${stat.additions}/-${stat.deletions}`);
  }
  if (agentTouched) parts.push('(agent)');
  return parts.join('  ');
}

export function ExplorerTree({
  rows, selectedRelPath, onToggleDir, onSelect, onActivate, onContextMenu,
  diffStats, touched,
}: ExplorerTreeProps): React.JSX.Element {
  // Roving tabIndex (ARIA tree pattern): exactly one row is a tab stop at a
  // time, everything else is -1. This is deliberately separate from
  // `selectedRelPath` — keyboard focus and selection are different states,
  // even though moving focus also moves selection below (matching how a
  // click both selects AND focuses).
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  // Did the pending focusedIndex change come from a key press?
  //
  // The roving index moves for three reasons — a key press, a click, and the
  // bounds clamp below — but only ONE of them may pull real DOM focus. A click
  // must not: the mousedown handler already preventDefaults so a click cannot
  // take focus off the terminal, and calling .focus() from the effect a moment
  // later undid exactly that (click a file to preview it, keep typing, and the
  // keystrokes went into the tree). The clamp must not either, for the same
  // reason — nor may the initial mount, which would steal focus the instant the
  // panel opens.
  //
  // Setting a flag rather than skipping the index update is what keeps the two
  // states honest: a click still moves the tab stop onto the clicked row, so
  // tabbing back into the tree resumes from where the user last pointed. Only
  // the .focus() call is gated.
  const focusFromKeyboard = useRef(false);

  // Rows change shape on every expand/collapse/refresh (new array from
  // flattenVisible). Keep the roving index inside bounds rather than
  // stranding it past the end of a now-shorter list.
  useEffect(() => {
    if (rows.length === 0) return;
    if (focusedIndex > rows.length - 1) setFocusedIndex(rows.length - 1);
  }, [rows, focusedIndex]);

  // Move actual DOM focus to match focusedIndex, but ONLY for the
  // arrow/Home/End-driven moves — see focusFromKeyboard above.
  useEffect(() => {
    if (!focusFromKeyboard.current) return;
    focusFromKeyboard.current = false;
    rowEls.current[focusedIndex]?.focus();
  }, [focusedIndex]);

  // The only mover that arms the flag. Arming it at the TOP of handleKeyDown
  // instead would leave it set for outcomes that never change the index
  // (`activate`, `none`), and the next clamp or click would then consume the
  // stale arm and steal focus after all.
  const moveFocusByKey = (index: number): void => {
    focusFromKeyboard.current = true;
    setFocusedIndex(index);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const outcome = computeKeyNavOutcome(rows, focusedIndex, e.key);
    switch (outcome.type) {
      case 'move': {
        e.preventDefault();
        moveFocusByKey(outcome.index);
        onSelect(rows[outcome.index]);
        break;
      }
      case 'expand':
      case 'collapse': {
        e.preventDefault();
        moveFocusByKey(outcome.index);
        onToggleDir(rows[outcome.index].relPath);
        break;
      }
      case 'activate': {
        e.preventDefault();
        const row = rows[outcome.index];
        // Same guard the mouse onClick below carries — openInPreviewTab
        // deliberately doesn't check `viewable` itself, so every call site
        // must, or Enter on a non-viewable file (e.g. a .exe) tries to
        // preview it.
        if (row.entry.viewable) onActivate(row, { keep: false });
        break;
      }
      case 'focus-terminal': {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('wmux:focus-terminal'));
        break;
      }
      case 'none':
      default:
        break;
    }
  };

  return (
    <div className="explorer-tree" role="tree" onKeyDown={handleKeyDown}>
      {rows.map((row, index) => {
        const isDir = row.entry.kind === 'dir';
        // A symlink is inert: the jail refuses to traverse it and
        // markdown.readFile refuses to read one, so neither affordance applies.
        const isLink = row.entry.kind === 'symlink';
        const dimmed = !isDir && !row.entry.viewable;
        const isFocused = index === focusedIndex;
        const stat = statFor(diffStats, row.relPath);
        // A folder's dot means "something under here was touched", which is what
        // makes a collapsed tree still tell you where the agent has been.
        const agentTouched = isTouched(touched, row.relPath);
        let chevron = '';
        if (isDir) chevron = row.expanded ? '▾' : '▸';
        return (
          <div
            key={row.relPath}
            ref={(el) => { rowEls.current[index] = el; }}
            role="treeitem"
            tabIndex={isFocused ? 0 : -1}
            aria-level={row.depth + 1}
            aria-expanded={isDir ? row.expanded : undefined}
            aria-selected={row.relPath === selectedRelPath}
            className={[
              'explorer-row',
              row.relPath === selectedRelPath ? 'explorer-row--selected' : '',
              isFocused ? 'explorer-row--focused' : '',
              dimmed ? 'explorer-row--dimmed' : '',
              isLink ? 'explorer-row--link' : '',
              stat ? 'explorer-row--changed' : '',
            ].filter(Boolean).join(' ')}
            style={{ paddingLeft: 8 + row.depth * 14 }}
            title={describeRow(row.entry.name, stat, agentTouched)}
            // The dot and the +N/-N cell are both purely visual. Screen readers
            // get the same two facts as words here instead, which is why the
            // dot itself is aria-hidden rather than given a label of its own.
            aria-label={describeRow(row.entry.name, stat, agentTouched)}
            // A plain click on a div is not focusable by itself, but this
            // guards against it becoming one later (or an ancestor doing so)
            // — the store's focusedPaneId must stay on whatever terminal pane
            // was last focused, not steal DOM focus into the tree via a
            // click. preventDefault on mousedown does not cancel the
            // subsequent click, so onSelect/onToggleDir below still fire.
            //
            // The row itself IS keyboard-focusable (roving tabIndex above),
            // so a click also moves the roving index onto the clicked row —
            // otherwise a click could select a row while leaving a stale
            // keyboard focus target. Moving the tab stop is all it does: the
            // roving-focus effect deliberately does NOT call .focus() for a
            // click, or the preventDefault above would be undone a tick later.
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              // Disarm: a key press whose outcome left the index unchanged
              // never reached the effect, so the arm could still be pending.
              focusFromKeyboard.current = false;
              setFocusedIndex(index);
              onSelect(row);
              if (isDir) onToggleDir(row.relPath);
              // Ctrl+click promotes, same as a double-click.
              else if (row.entry.viewable) onActivate(row, { keep: e.ctrlKey });
            }}
            onDoubleClick={() => {
              if (!isDir && row.entry.viewable) onActivate(row, { keep: true });
            }}
            onContextMenu={(e) => { e.preventDefault(); onContextMenu(row, e); }}
          >
            <span className="explorer-row__chevron">{chevron}</span>
            {agentTouched && (
              // Marks WHO changed it, which the numbers cannot say. Decorative
              // to the accessibility tree only because the row's aria-label
              // below carries the same fact as words.
              <span className="explorer-row__agent-dot" aria-hidden="true">●</span>
            )}
            <span className="explorer-row__name">{row.entry.name}</span>
            <DiffCell stat={stat} />
          </div>
        );
      })}
    </div>
  );
}
