// ─── Typing startup commands only once the shell is reading (issue #251) ─────
//
// A pane's `startupCommands` (quick-launch profiles #32, `wmux agent spawn`,
// `claude --resume <id>` on restore #186, a devcontainer re-entry #19) reach
// the shell one of two ways:
//
//   * PowerShell with the integration script: baked into WMUX_STARTUP_COMMANDS
//     and run by the script during init. No keystrokes at all — measured for
//     #251 by spawning pwsh 7 under node-pty exactly as PtyManager does, with a
//     stand-in `claude` that prints its argv: `["--resume","<id>"]` intact on
//     every run, via the npm `claude.ps1` shim and via a function wrapper.
//
//   * everything else (cmd, bash, WSL, PowerShell with no integration): TYPED
//     into the PTY. That used to happen in two places with two different rules.
//     The renderer wrote `<cmd>\r` on a blind 600 ms timer after pty.create,
//     and "pty created" is not "shell reading" — cmd measured 372 ms, pwsh
//     1.5 s to ready on the reporter's machine. agent-manager.ts had its own
//     prompt sniff for `wmux agent spawn`. Two deliveries with two ideas of
//     "ready" is how one of them stays broken while the other gets fixed.
//
//     This gate is NOT the fix for #251, though 2.14.0 shipped it as one. The
//     symptom there (`esume` in Claude's session picker) is Claude receiving
//     `-resume` with ONE dash — its parser reads that as `-r` with the value
//     `esume`, and the picker's search box is seeded from argv, never from
//     keystrokes. Measured afterwards over ~1,900 deliveries (cmd, pwsh 7,
//     5.1, both ConPTYs, the old blind timer at every delay from 0 to 1.8 s):
//     the timer never lost a character — the console input buffer holds
//     type-ahead — and a restored pwsh pane was never on this path at all. No
//     wmux path drops that dash; the open question is what `claude` resolves
//     to on the reporter's machine. Do not "fix" #251 here again: ask for the
//     `CommandLine` of the running `claude.exe` (from `Get-CimInstance
//     Win32_Process`) before touching delivery.
//
//     What that hunt did find: the PowerShell integration cleared
//     WMUX_STARTUP_COMMANDS AFTER its loop, so the command it launched
//     inherited the variable. Fixed in 2.16.0 and pinned by
//     `startup-commands-env.test.ts` — whose first version asserted on an
//     `echo %VAR%` and passed with the bug present, because the leaked value
//     was the probe's own text.
//
// So PtyManager owns delivery now, for every caller, and this module is the
// rule it applies. PtyManager's `startupCommandsConsumed` is therefore simply
// "were there any", and no caller may type them again. Readiness, strongest
// signal first:
//
//   1. an OSC 133 prompt mark (A = prompt start, B = input start). The cmd
//      integration emits both from PROMPT, the bash integration from PS1: the
//      shell has drawn its prompt and is about to read. Deterministic.
//   2. a prompt-shaped last line (`PS C:\>`, `$ `, `# `, `C:\>`), for a shell
//      with no integration. A heuristic, so it only ever SHORTENS the wait.
//   3. output that has gone quiet for `quietMs` — the shell printed a banner
//      and stopped, which is what waiting at a prompt looks like from outside.
//   4. `maxWaitMs` after spawn, so a shell that prints nothing recognisable
//      still gets its command rather than silently dropping it.
//
// The decision is pure (`startupGateStep`) so every branch is testable without
// a PTY; `deliverStartupCommandsWhenReady` is the thin impure driver.

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// OSC 133;A or ;B, BEL- or ST-terminated, with or without trailing params
// (`133;A;cl=m` is legal FinalTerm). C/D are deliberately not readiness: they
// bracket a command's OUTPUT, which is the opposite of the shell reading.
const PROMPT_MARK_RE = new RegExp(String.raw`${ESC}\]133;[AB](?:;[^${BEL}${ESC}]*)?(?:${BEL}|${ESC}\\)`);

const OSC_SEQ = String.raw`${ESC}\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\)`;
const CSI_SEQ = String.raw`${ESC}\[[0-9;?]*[A-Za-z]`;
// Moved here from agent-manager.ts unchanged (#251).
//
// Does this chunk of shell output end on a prompt? Two things are easy to get
// wrong here, and each one silently costs every spawn the 1500 ms debounce:
//
//  - The prompt CHARACTER is not the last thing on the line any more. Since
//    #207 the shell integrations wrap the prompt in OSC 133 marks, so a
//    PowerShell prompt arrives as `PS C:\x> ` FOLLOWED BY `ESC ] 133;B ESC \`,
//    and PSReadLine / oh-my-posh tack CSI sequences (cursor show, SGR reset)
//    on after that. So after the prompt character this allows any run of
//    whitespace, OSC strings (BEL- or ST-terminated) and CSI sequences before
//    end-of-line — and nothing else, or a `>` in the middle of a banner would
//    count.
//  - `/m` is load-bearing: a chunk can carry several lines, and the prompt is
//    the last one.
//
// ESC and BEL are spelled out via fromCharCode rather than as `\x1b`/`\x07`
// in the literal: they are the terminator bytes of the very sequences this
// matches, and a raw control character in a regex literal is what the
// no-control-regex lint (rightly, elsewhere) rejects.
const PROMPT_RE = new RegExp(String.raw`(?:PS\s.*>|[$#%>])(?:\s|${OSC_SEQ}|${CSI_SEQ})*$`, 'm');

/** Does this chunk end in something that looks like a shell prompt? */
export function looksLikePrompt(data: string): boolean {
  return PROMPT_RE.test(data);
}

/** Does this chunk carry an OSC 133 prompt-start / input-start mark? */
export function hasPromptMark(data: string): boolean {
  return PROMPT_MARK_RE.test(data);
}

export interface StartupGateTiming {
  /** Pause after a readiness signal, so the rest of the prompt draws first. */
  settleMs: number;
  /** Output silence that counts as "waiting at a prompt". */
  quietMs: number;
  /** Hard ceiling from spawn: send even if nothing ever looked ready. */
  maxWaitMs: number;
}

export const DEFAULT_STARTUP_GATE_TIMING: StartupGateTiming = {
  settleMs: 150,
  quietMs: 1500,
  maxWaitMs: 5000,
};

/**
 * `signal` is the one re-armable timer (settle or quiet) firing; `ceiling` is
 * the fixed `maxWaitMs` deadline armed once at spawn. They are separate timers
 * on purpose: if output re-armed the ceiling, a shell that never stops
 * printing would never get its command.
 */
export type StartupGateEvent =
  | { kind: 'data'; data: string }
  | { kind: 'signal' }
  | { kind: 'ceiling' };

export type StartupSignal = 'prompt-mark' | 'prompt-text' | 'quiet';
export type StartupReadyReason = StartupSignal | 'max-wait';

/**
 * What the driver should do next. `arm` (re)places the signal timer; `send`
 * means type the commands now and stop listening.
 */
export type StartupGateAction =
  | { kind: 'wait' }
  | { kind: 'arm'; delayMs: number; signal: StartupSignal }
  | { kind: 'send'; reason: StartupReadyReason };

export interface StartupGateState {
  /** Which signal the armed signal timer stands for, if one is armed. */
  pending: StartupSignal | null;
  sent: boolean;
}

export function initialStartupGateState(): StartupGateState {
  return { pending: null, sent: false };
}

const RANK: Record<StartupSignal, number> = { quiet: 0, 'prompt-text': 1, 'prompt-mark': 2 };

/** Strongest readiness signal a chunk carries. */
export function classifyStartupChunk(data: string): StartupSignal {
  if (hasPromptMark(data)) return 'prompt-mark';
  if (looksLikePrompt(data)) return 'prompt-text';
  return 'quiet';
}

/**
 * One step of the gate.
 *
 * A weaker signal never overrides a stronger one already armed: once a prompt
 * mark has been seen, a later chunk (the rest of the prompt, a right-prompt
 * redraw) must not push the send back out to the quiet timer. A quiet timer IS
 * re-armed by further output, which is what makes it "quiet" rather than "N ms
 * after the first byte" — the old agent-manager debounce fired 1.5 s after the
 * FIRST chunk however much the shell was still printing.
 */
export function startupGateStep(
  state: StartupGateState,
  event: StartupGateEvent,
  timing: StartupGateTiming = DEFAULT_STARTUP_GATE_TIMING,
): { state: StartupGateState; action: StartupGateAction } {
  if (state.sent) return { state, action: { kind: 'wait' } };

  if (event.kind === 'ceiling') {
    return { state: { pending: null, sent: true }, action: { kind: 'send', reason: 'max-wait' } };
  }
  if (event.kind === 'signal') {
    // A signal timer with nothing recorded against it cannot happen through
    // the driver; treat it as the ceiling rather than dropping the command.
    const reason = state.pending ?? 'max-wait';
    return { state: { pending: null, sent: true }, action: { kind: 'send', reason } };
  }

  const signal = classifyStartupChunk(event.data);
  const current = state.pending;
  if (current !== null) {
    if (RANK[current] > RANK[signal]) return { state, action: { kind: 'wait' } };
    // Same non-quiet signal again (a second prompt draw): keep the timer that
    // is already counting down rather than pushing it back.
    if (current === signal && signal !== 'quiet') return { state, action: { kind: 'wait' } };
  }
  const delayMs = signal === 'quiet' ? timing.quietMs : timing.settleMs;
  return { state: { pending: signal, sent: false }, action: { kind: 'arm', delayMs, signal } };
}

/** What a typed delivery writes: each command followed by Enter, in order. */
export function startupKeystrokes(commands: readonly string[]): string {
  return commands.map((c) => `${c}\r`).join('');
}

export interface StartupDeliveryDeps {
  onData(cb: (data: string) => void): () => void;
  write(data: string): void;
  /** False once the PTY has exited — a dead shell gets nothing. */
  isAlive(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log?(message: string): void;
}

/**
 * Type `commands` into a PTY once the shell looks ready (see the header).
 * Returns a cancel function. Sends at most once.
 */
export function deliverStartupCommandsWhenReady(
  deps: StartupDeliveryDeps,
  commands: readonly string[],
  timing: StartupGateTiming = DEFAULT_STARTUP_GATE_TIMING,
): () => void {
  let state = initialStartupGateState();
  let signalTimer: unknown = null;
  let ceilingTimer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  const t0 = Date.now();

  const stop = () => {
    if (signalTimer !== null) deps.clearTimeout(signalTimer);
    if (ceilingTimer !== null) deps.clearTimeout(ceilingTimer);
    signalTimer = null;
    ceilingTimer = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  const feed = (event: StartupGateEvent) => {
    const next = startupGateStep(state, event, timing);
    state = next.state;
    const action = next.action;
    if (action.kind === 'wait') return;
    if (action.kind === 'arm') {
      if (signalTimer !== null) deps.clearTimeout(signalTimer);
      signalTimer = deps.setTimeout(() => {
        signalTimer = null;
        feed({ kind: 'signal' });
      }, action.delayMs);
      return;
    }
    stop();
    if (!deps.isAlive()) return;
    deps.log?.(`startup commands sent after ${Date.now() - t0} ms (${action.reason})`);
    deps.write(startupKeystrokes(commands));
  };

  unsubscribe = deps.onData((data) => feed({ kind: 'data', data }));
  ceilingTimer = deps.setTimeout(() => {
    ceilingTimer = null;
    feed({ kind: 'ceiling' });
  }, timing.maxWaitMs);
  return stop;
}
