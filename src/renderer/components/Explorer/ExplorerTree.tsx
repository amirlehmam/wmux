import React, { useEffect, useRef, useState } from 'react';
import type { ExplorerRow } from './explorer-state';
import { computeKeyNavOutcome } from './explorer-keynav';

interface ExplorerTreeProps {
  rows: ExplorerRow[];
  selectedRelPath: string | null;
  onToggleDir: (relPath: string) => void;
  onSelect: (row: ExplorerRow) => void;
  /** Open a file: `keep` distinguishes a promoting gesture (double-click,
   *  Ctrl+click) from a plain preview click. */
  onActivate: (row: ExplorerRow, opts: { keep: boolean }) => void;
  onContextMenu: (row: ExplorerRow, event: React.MouseEvent) => void;
}

export function ExplorerTree({
  rows, selectedRelPath, onToggleDir, onSelect, onActivate, onContextMenu,
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
            ].filter(Boolean).join(' ')}
            style={{ paddingLeft: 8 + row.depth * 14 }}
            title={row.entry.name}
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
            <span className="explorer-row__chevron">
              {isDir ? (row.expanded ? '▾' : '▸') : ''}
            </span>
            <span className="explorer-row__name">{row.entry.name}</span>
          </div>
        );
      })}
    </div>
  );
}
