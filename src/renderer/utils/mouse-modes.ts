/**
 * Per-surface DEC private mouse mode tracking, so a remount can put the
 * replacement xterm back into the mode the still-running TUI believes it is in
 * (issue #164).
 *
 * ## Why wmux has to track this at all
 *
 * A split-tree restructure remounts the pane, which disposes the xterm instance
 * and builds a new one. The PTY survives, so the application on the other end
 * has no idea anything happened — it keeps sending and expecting whatever it
 * negotiated at startup.
 *
 * The buffer is carried across by SerializeAddon, and that is where the gap is:
 * `serialize()` emits the mouse *tracking protocol* (?9, ?1000, ?1002, ?1003)
 * and nothing else. The *coordinate encoding* — ?1006 SGR, ?1016 SGR-pixels —
 * is not serialized at all. So the replacement terminal comes up tracking drags
 * but reporting them in the legacy encoding, while the TUI is still decoding
 * SGR. Clicks land in the wrong place or are dropped entirely; the application
 * is not going to re-send its DECSET, because from its side nothing happened.
 *
 * wmux's wheel handler survived this because it never used xterm's encoding —
 * it writes SGR reports itself — which is exactly why the bug presented as
 * "the wheel still works but clicking doesn't".
 *
 * ## Why a set per category rather than one value
 *
 * Terminals treat these as independent flags, and applications do turn several
 * on. Setting ?1003 while ?1002 is on leaves both set, and resetting ?1002 must
 * not then imply the application stopped wanting motion reports. Keeping the
 * set and deriving the effective mode by precedence is what real terminals do,
 * and it means a DECRST for a mode that was never on cannot corrupt the state.
 */

/** Tracking protocols, least to most information. Highest active one wins. */
const PROTOCOL_MODES = [9, 1000, 1001, 1002, 1003] as const;

/** Coordinate encodings, least to most capable. Highest active one wins. */
const ENCODING_MODES = [1005, 1015, 1006, 1016] as const;

export interface MouseModeState {
  /** Active tracking protocols (?9 / ?1000 / ?1001 / ?1002 / ?1003). */
  protocols: Set<number>;
  /** Active coordinate encodings (?1005 / ?1015 / ?1006 / ?1016). */
  encodings: Set<number>;
}

export function emptyMouseModeState(): MouseModeState {
  return { protocols: new Set(), encodings: new Set() };
}

/** Whether any mouse tracking is active — the signal the wheel handler needs. */
export function isMouseTracking(state: MouseModeState | undefined): boolean {
  return !!state && state.protocols.size > 0;
}

/** The protocol a terminal would actually use, or null when none is active. */
export function effectiveProtocol(state: MouseModeState): number | null {
  for (let i = PROTOCOL_MODES.length - 1; i >= 0; i--) {
    if (state.protocols.has(PROTOCOL_MODES[i])) return PROTOCOL_MODES[i];
  }
  return null;
}

/** The encoding a terminal would actually use, or null for the default. */
export function effectiveEncoding(state: MouseModeState): number | null {
  for (let i = ENCODING_MODES.length - 1; i >= 0; i--) {
    if (state.encodings.has(ENCODING_MODES[i])) return ENCODING_MODES[i];
  }
  return null;
}

/**
 * All DEC private mode set/reset sequences in a chunk, in order.
 *
 * Matches `ESC [ ? p1 ; p2 ; … h|l`. The parameter list matters: applications
 * routinely combine modes into one sequence (`ESC[?1002;1006h` is the common
 * spelling for "drag tracking, SGR encoding"), and the previous single-mode
 * regex saw such a chunk as one mode and silently missed the other. Scanning
 * every occurrence matters for the same reason — enabling and disabling in one
 * write is normal when an application switches modes.
 */
const DEC_PRIVATE_MODE = /\x1b\[\?([0-9;]*)([hl])/g;

/**
 * Fold a chunk of PTY output into the mode state.
 *
 * Mutates and returns `state` — this runs on every PTY data event, so it is
 * deliberately allocation-free in the overwhelmingly common case of a chunk
 * containing no mode changes at all.
 */
/** Which set a mode belongs to, or null for a mode we do not track. */
function bucketFor(state: MouseModeState, mode: number): Set<number> | null {
  if ((PROTOCOL_MODES as readonly number[]).includes(mode)) return state.protocols;
  if ((ENCODING_MODES as readonly number[]).includes(mode)) return state.encodings;
  return null;
}

/** Apply one `ESC[?…h|l` sequence's parameter list. */
function applyOneSequence(state: MouseModeState, params: string, set: boolean): void {
  for (const raw of params.split(';')) {
    if (raw === '') continue;
    const bucket = bucketFor(state, Number(raw));
    if (!bucket) continue;
    if (set) bucket.add(Number(raw));
    else bucket.delete(Number(raw));
  }
}

export function applyMouseModeSequences(state: MouseModeState, data: string): MouseModeState {
  // Cheap bail-out: no CSI ? at all means nothing here can change the state.
  if (data.indexOf('\x1b[?') === -1) return state;

  DEC_PRIVATE_MODE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DEC_PRIVATE_MODE.exec(data)) !== null) {
    applyOneSequence(state, match[1], match[2] === 'h');
  }
  return state;
}

/**
 * The sequences that put a fresh xterm back into `state`.
 *
 * Every active mode is emitted, not just the effective one, so the replacement
 * terminal's flags match the original rather than merely behaving the same
 * today — a later DECRST from the application has to land on the same state it
 * would have found.
 *
 * Empty string when nothing is active, so the caller can skip the write.
 */
export function mouseModeReplaySequence(state: MouseModeState | undefined): string {
  if (!state) return '';
  const modes = [
    ...PROTOCOL_MODES.filter(m => state.protocols.has(m)),
    ...ENCODING_MODES.filter(m => state.encodings.has(m)),
  ];
  return modes.map(m => `\x1b[?${m}h`).join('');
}
