import { useState, useCallback, useEffect, useRef } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import FindBar from './FindBar';
import CopyMode from './CopyMode';
import PinnedPrompt from './PinnedPrompt';
import PromptOutline from './PromptOutline';
import NewOutputPill from './NewOutputPill';
import '../../styles/terminal.css';
import '../../styles/prompt-marks.css';

interface TerminalPaneProps {
  surfaceId?: string;
  shell?: string;
  cwd?: string;
  /** Per-surface color scheme override (issue #4). */
  colorScheme?: string;
  /** Quick-launch profile startup commands (issue #32). */
  startupCommands?: string[];
  /** Claude Code session to resume on a restored pane (issue #186). */
  claudeSessionId?: string;
  focused?: boolean;
  visible?: boolean;
  showFindBar?: boolean;
  onFindBarClose?: () => void;
  copyModeActive?: boolean;
}

export default function TerminalPane({
  surfaceId,
  shell,
  cwd,
  colorScheme,
  startupCommands,
  claudeSessionId,
  focused = true,
  visible = true,
  showFindBar = false,
  onFindBarClose,
  copyModeActive = false,
}: TerminalPaneProps) {
  const { terminalRef, searchAddonRef, xtermRef } = useTerminal({ surfaceId, shell, cwd, visible, focused, colorScheme, startupCommands, claudeSessionId });

  const [_lastQuery, setLastQuery] = useState('');

  // Latest values mirrored into refs so the global F3 / Shift+F3 listener (issue
  // #64) can read them without re-subscribing on every keystroke or focus change.
  const lastQueryRef = useRef(_lastQuery);
  lastQueryRef.current = _lastQuery;
  const activeRef = useRef(false);
  activeRef.current = focused && visible;

  // F3 / Shift+F3 cycle search matches without reopening the find bar. Only the
  // focused, visible terminal acts (there's exactly one at a time).
  useEffect(() => {
    const cycle = (forward: boolean) => {
      if (!activeRef.current || !searchAddonRef.current || !lastQueryRef.current) return;
      if (forward) searchAddonRef.current.findNext(lastQueryRef.current);
      else searchAddonRef.current.findPrevious(lastQueryRef.current);
    };
    const onNext = () => cycle(true);
    const onPrev = () => cycle(false);
    document.addEventListener('wmux:find-next', onNext);
    document.addEventListener('wmux:find-prev', onPrev);
    return () => {
      document.removeEventListener('wmux:find-next', onNext);
      document.removeEventListener('wmux:find-prev', onPrev);
    };
  }, [searchAddonRef]);

  // Explorer Escape (issue: file-explorer keyboard nav) hands DOM focus back
  // to whichever terminal is currently the focused, visible one — same
  // activeRef gate F3 cycling above uses, since "there's exactly one at a
  // time" applies here too.
  useEffect(() => {
    const onFocusTerminal = () => {
      if (!activeRef.current) return;
      try { xtermRef.current?.focus(); } catch { /* no-op */ }
    };
    document.addEventListener('wmux:focus-terminal', onFocusTerminal);
    return () => document.removeEventListener('wmux:focus-terminal', onFocusTerminal);
  }, [xtermRef]);

  const handleSearch = useCallback((query: string) => {
    setLastQuery(query);
    if (!searchAddonRef.current) return;
    if (!query) {
      // Clear highlights when query is empty
      searchAddonRef.current.clearDecorations();
      return;
    }
    searchAddonRef.current.findNext(query, { incremental: true });
  }, [searchAddonRef]);

  const handleNext = useCallback(() => {
    if (!searchAddonRef.current || !_lastQuery) return;
    searchAddonRef.current.findNext(_lastQuery);
  }, [searchAddonRef, _lastQuery]);

  const handlePrevious = useCallback(() => {
    if (!searchAddonRef.current || !_lastQuery) return;
    searchAddonRef.current.findPrevious(_lastQuery);
  }, [searchAddonRef, _lastQuery]);

  const handleFindBarClose = useCallback(() => {
    if (searchAddonRef.current) {
      searchAddonRef.current.clearDecorations();
    }
    onFindBarClose?.();
  }, [searchAddonRef, onFindBarClose]);

  return (
    <div className={`terminal-pane ${focused ? 'terminal-pane--focused' : ''}`}>
      <div ref={terminalRef} className="terminal-pane__container" />
      {/* Prompt-log views (issue #207). All three are absolutely positioned over
          the container, never flow siblings of it: a flow sibling would be
          pushed out of the container's height:100% box WITHOUT firing the
          ResizeObserver, so the PTY would keep its old row count and the bottom
          lines would hide underneath (issue #82).

          Gated on `visible`, not on `focused`: every tab in a pane stays mounted
          (visibility:hidden unmounts nothing), so without the gate a hidden tab
          would render its own sticky header on top of the tab the user is
          actually looking at. The outline additionally needs `focused` — it
          takes keyboard focus, and only one pane may. */}
      {visible && surfaceId && <PinnedPrompt surfaceId={surfaceId} />}
      {visible && surfaceId && <NewOutputPill surfaceId={surfaceId} />}
      {visible && focused && surfaceId && <PromptOutline surfaceId={surfaceId} />}
      {showFindBar && (
        <FindBar
          onSearch={handleSearch}
          onNext={handleNext}
          onPrevious={handlePrevious}
          onClose={handleFindBarClose}
        />
      )}
      <CopyMode active={copyModeActive} />
    </div>
  );
}
