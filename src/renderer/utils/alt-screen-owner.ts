/**
 * Who is on a pane's alternate screen, read from the pane's own output (#357).
 *
 * Reset terminal state must not leave the alternate screen under a program that
 * is still drawing there (#347), and must leave it when that program died and
 * left the pane stuck (#175). The shell-state report can tell the two apart only
 * where wmux's PowerShell integration runs. The output stream can tell them
 * apart almost everywhere, and in-band, so the order of events is exact:
 *
 * - `program` — a DECSET 47/1047/1049 arrived. Something entered the alternate
 *   screen, or re-entered the one the pane is already on (a TUI started from a
 *   prompt that a dead program's screen was holding). xterm fires no buffer
 *   change for a re-entry, which is why this is a CSI hook and not
 *   `onBufferChange`.
 * - `shell` — an OSC 133;A arrived while the active buffer was the alternate
 *   one. A shell is prompting there, so whatever entered it is gone. wmux's
 *   PowerShell, cmd and bash integrations emit these marks, and so do Starship,
 *   oh-my-posh and bash-preexec setups, including on a remote host.
 *
 * Returning to the normal buffer clears the record: there is no alternate
 * screen left to own. The prompt mark is not parsed again here — the prompt
 * log's OSC 133 handler already parses every mark and reports prompt starts to
 * {@link notePromptStart}.
 *
 * Known gap: a terminal rebuilt from a snapshot (the remount fallback) replays
 * `?1049h`, so a screen recorded as the shell's reads as a program's again. The
 * cost is one extra press, never a leave under a live program.
 *
 * Module maps rather than store state, like `surfaceMouseModes`: nothing
 * renders from them.
 */
import type { IDisposable, Terminal } from '@xterm/xterm';
import {
  alternateScreenResetAction,
  FORCE_LEAVE_WINDOW_MS,
  resetTerminalModes,
  type AlternateScreenResetAction,
} from './terminal-reset';
import { previousSurfaceShellState } from './surface-shell-state';

export type AlternateScreenOwner = 'program' | 'shell';

/** DEC private modes that activate the alternate buffer in xterm.js. */
const ALTERNATE_SCREEN_MODES: ReadonlySet<number> = new Set([47, 1047, 1049]);

const owners = new Map<string, AlternateScreenOwner>();

/** When each surface's last manual reset kept the alternate screen. */
const keptAt = new Map<string, number>();

/** Does a DECSET (`CSI ? Pm h`) with these parameters enter the alternate screen? */
export function entersAlternateScreen(params: readonly (number | number[])[]): boolean {
  return params.some((param) => typeof param === 'number' && ALTERNATE_SCREEN_MODES.has(param));
}

export function noteAlternateScreenEntered(surfaceId: string): void {
  owners.set(surfaceId, 'program');
}

/** An OSC 133;A. Only a prompt drawn ON the alternate screen says anything about it. */
export function notePromptStart(surfaceId: string, bufferType: string): void {
  if (bufferType === 'alternate') owners.set(surfaceId, 'shell');
}

export function noteNormalBuffer(surfaceId: string): void {
  owners.delete(surfaceId);
}

export function alternateScreenOwner(surfaceId: string): AlternateScreenOwner | undefined {
  return owners.get(surfaceId);
}

/**
 * Watch `terminal` for alternate-screen entries and exits. The CSI handler
 * declines every sequence, so xterm still applies the mode itself.
 */
export function trackAlternateScreenOwner(terminal: Terminal, surfaceId: string): IDisposable {
  const csi = terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (entersAlternateScreen(params)) noteAlternateScreenEntered(surfaceId);
    return false;
  });
  const buffer = terminal.buffer.onBufferChange((active) => {
    if (active.type === 'normal') noteNormalBuffer(surfaceId);
  });
  return {
    dispose() {
      csi.dispose();
      buffer.dispose();
    },
  };
}

/** The surface is gone. */
export function forgetAlternateScreen(surfaceId: string): void {
  owners.delete(surfaceId);
  keptAt.delete(surfaceId);
}

/**
 * The non-modal notice a kept reset shows: `until` is when it and the force
 * window end, `null` hides it.
 */
export const RESET_NOTICE_EVENT = 'wmux:reset-kept-alternate-screen';

export interface ResetNoticeDetail {
  surfaceId: string;
  until: number | null;
}

/**
 * The command palette's "Reset terminal state (leave alternate screen)" entry.
 * Not a ShortcutAction: it has no default binding, and the press-twice route
 * already covers the keyboard.
 */
export const RESET_TERMINAL_LEAVE_ALT_ACTION = 'resetTerminalLeaveAlternateScreen';

export interface ManualResetOptions {
  /** The palette's "leave alternate screen" entry. */
  forceLeave?: boolean;
  now?: number;
  notify?: (detail: ResetNoticeDetail) => void;
}

/**
 * The `wmux:reset-terminal` handler's work for one surface: decide about the
 * alternate screen, reset, arm or disarm the force window, and show or hide
 * the notice. Returns what it did, for the tests.
 */
export function applyManualReset(
  terminal: Terminal,
  surfaceId: string,
  options: ManualResetOptions = {},
): AlternateScreenResetAction {
  const now = options.now ?? Date.now();
  let onAlternateBuffer = false;
  try {
    onAlternateBuffer = terminal.buffer.active.type === 'alternate';
  } catch {
    // Unreadable buffer: resetTerminalModes takes the same safe branch.
  }
  const action = alternateScreenResetAction({
    onAlternateBuffer,
    owner: owners.get(surfaceId),
    shellState: previousSurfaceShellState(surfaceId),
    lastKeptAt: keptAt.get(surfaceId),
    now,
    forceRequested: options.forceLeave === true,
  });
  resetTerminalModes(terminal, { keepAlternateScreen: action === 'keep' });
  if (action === 'keep') keptAt.set(surfaceId, now);
  else keptAt.delete(surfaceId);
  options.notify?.({ surfaceId, until: action === 'keep' ? now + FORCE_LEAVE_WINDOW_MS : null });
  return action;
}

/** Tests only. */
export function resetAlternateScreenOwners(): void {
  owners.clear();
  keptAt.clear();
}
