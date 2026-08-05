/**
 * key-sequence.ts — user-defined key remaps (issue #146).
 *
 * A remap answers one question: "when this chord is pressed in a terminal,
 * what bytes should the terminal send instead?" That is deliberately the whole
 * feature. It is not a plugin runtime — no third-party code runs — but it
 * covers the class of request that keeps arriving as "can I write a plugin
 * for…": ctrl+k should also send DEL, ctrl+w should send a literal command,
 * this key should be swallowed entirely.
 *
 * Config lives in `~/.wmux/config.toml`:
 *
 *   [keys]
 *   "ctrl+k"       = "<C-k><Delete>"   # kill-line, then pull the next line up
 *   "ctrl+alt+r"   = "clear<CR>"       # literal text is sent as typed
 *   "ctrl+shift+q" = ""                # empty = swallow the key
 *
 * Both the chord (left) and the sequence (right) accept vim-ish `<...>` names;
 * the chord additionally accepts the `ctrl+shift+key` spelling used everywhere
 * else in wmux's settings, so users don't have to learn a second notation.
 */

export interface KeyChord {
  /** Normalized to KeyboardEvent.key values: 'k', 'Delete', 'ArrowUp', ' '. */
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export interface KeyRemap {
  chord: KeyChord;
  /** Bytes to write to the PTY. Empty string means "swallow this key". */
  send: string;
  /** The chord as the user spelled it — for error messages and diagnostics. */
  source: string;
}

/** Aliases → KeyboardEvent.key. Everything is matched case-insensitively. */
const KEY_ALIASES: Record<string, string> = {
  cr: 'Enter', enter: 'Enter', return: 'Enter',
  esc: 'Escape', escape: 'Escape',
  space: ' ',
  tab: 'Tab',
  bs: 'Backspace', backspace: 'Backspace',
  del: 'Delete', delete: 'Delete',
  ins: 'Insert', insert: 'Insert',
  home: 'Home', end: 'End',
  pgup: 'PageUp', pageup: 'PageUp',
  pgdn: 'PageDown', pagedown: 'PageDown',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  lt: '<', gt: '>',
};

/**
 * What each named key transmits. These are the DEC/xterm defaults xterm.js
 * itself sends, so a remap is indistinguishable from the real keypress.
 */
const KEY_SEQUENCES: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  Insert: '\x1b[2~',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
  ' ': ' ',
  '<': '<',
  '>': '>',
};

function normalizeKeyName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return 'F' + lower.slice(1);
  // Single printable character — stored lowercase, matching how ShortcutBinding
  // stores letters (Shift uppercases e.key on Windows; the matcher folds case).
  if ([...name].length === 1) return lower;
  return null;
}

interface ParsedModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  rest: string;
}

/**
 * Peel modifiers off either spelling: `ctrl+shift+p` or the vim-ish `<C-S-p>`.
 * Angle brackets, if present, are stripped by the caller.
 */
function peelModifiers(spec: string): ParsedModifiers {
  let rest = spec.trim();
  const mods = { ctrl: false, shift: false, alt: false };

  // `ctrl+alt+k` — split on '+' but never consume a trailing literal '+' key.
  const plusParts = rest.split('+');
  if (plusParts.length > 1) {
    let tail = plusParts.pop() as string;
    // `ctrl++` splits to ['ctrl','','']: the empty tail means the final '+' was
    // the key, not a separator.
    if (tail === '') {
      plusParts.pop();
      tail = '+';
    }
    const consumed: boolean[] = plusParts.map((p) => {
      switch (p.trim().toLowerCase()) {
        case 'ctrl': case 'control': mods.ctrl = true; return true;
        case 'shift': mods.shift = true; return true;
        case 'alt': case 'option': case 'meta': mods.alt = true; return true;
        default: return false;
      }
    });
    // Any unrecognized segment means this wasn't a modifier list after all
    // (e.g. a literal "+" chord); fall through to the vim form below.
    if (consumed.every(Boolean)) return { ...mods, rest: tail };
    mods.ctrl = mods.shift = mods.alt = false;
    rest = spec.trim();
  }

  // `C-S-A-key`, consumed left to right.
  let matched = /^([CSAM])-(.+)$/i.exec(rest);
  while (matched) {
    const flag = matched[1].toUpperCase();
    if (flag === 'C') mods.ctrl = true;
    else if (flag === 'S') mods.shift = true;
    else mods.alt = true; // A- and M- are both Alt on Windows
    rest = matched[2];
    matched = /^([CSAM])-(.+)$/i.exec(rest);
  }

  return { ...mods, rest };
}

/**
 * Parse the left-hand side of a `[keys]` entry into a chord.
 * Returns null when the key name is not one we can match against a DOM event.
 */
export function parseChord(spec: string): KeyChord | null {
  const inner = spec.trim().replace(/^<(.*)>$/, '$1');
  const { ctrl, shift, alt, rest } = peelModifiers(inner);
  const key = normalizeKeyName(rest);
  if (!key) return null;
  return { key, ctrl, shift, alt };
}

/** The subset of KeyboardEvent a chord is matched against. */
export interface ChordEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
}

/**
 * Exact-modifier match. Exact matters: a remap of `ctrl+k` must not also fire
 * on Ctrl+Shift+K, which the user may well have bound to something else.
 */
export function matchesChord(event: ChordEvent, chord: KeyChord): boolean {
  if (event.metaKey) return false;
  const eventKey = [...event.key].length === 1 ? event.key.toLowerCase() : event.key;
  const chordKey = [...chord.key].length === 1 ? chord.key.toLowerCase() : chord.key;
  return (
    eventKey === chordKey &&
    event.ctrlKey === chord.ctrl &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt
  );
}

/** Ctrl+<letter> and the handful of Ctrl+punctuation codes VT defines. */
function controlByte(key: string): string | null {
  if (key.length !== 1) return null;
  const c = key.toLowerCase();
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
  const punctuation: Record<string, string> = {
    '@': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d',
    '^': '\x1e', '_': '\x1f', '?': '\x7f', ' ': '\x00',
  };
  return punctuation[c] ?? null;
}

/** Bytes for one `<...>` token, or null if the token names nothing we know. */
function tokenSequence(token: string): string | null {
  const { ctrl, shift, alt, rest } = peelModifiers(token);
  const key = normalizeKeyName(rest);
  if (!key) return null;

  // Shift+Tab has its own sequence (CSI Z); no other key encodes shift
  // separately — for letters it just means "the uppercase character".
  if (shift && key === 'Tab') return alt ? '\x1b\x1b[Z' : '\x1b[Z';

  let base: string;
  if (ctrl) {
    const byte = controlByte(key);
    if (byte === null) return null;
    base = byte;
  } else if (KEY_SEQUENCES[key] !== undefined) {
    base = KEY_SEQUENCES[key];
  } else if ([...key].length === 1) {
    base = shift ? key.toUpperCase() : key;
  } else {
    return null;
  }

  // Alt is transmitted as ESC-prefix (the "meta sends escape" convention every
  // Windows/Linux terminal follows).
  return alt ? '\x1b' + base : base;
}

export interface SequenceResult {
  sequence: string;
  errors: string[];
}

/**
 * Render the right-hand side of a `[keys]` entry into the bytes to transmit.
 *
 * Text outside `<...>` is sent literally, so `"clear<CR>"` types the word and
 * presses Enter. An unknown `<token>` is an error rather than a silent literal:
 * a typo'd `<Dlete>` should tell the user, not quietly type "Dlete" into their
 * shell.
 */
export function renderSequence(spec: string): SequenceResult {
  const errors: string[] = [];
  let out = '';
  let i = 0;

  while (i < spec.length) {
    const open = spec.indexOf('<', i);
    if (open === -1) {
      out += spec.slice(i);
      break;
    }
    out += spec.slice(i, open);
    const close = spec.indexOf('>', open + 1);
    if (close === -1) {
      errors.push(`unterminated "<" at position ${open}`);
      out += spec.slice(open);
      break;
    }
    const token = spec.slice(open + 1, close);
    const bytes = tokenSequence(token);
    if (bytes === null) errors.push(`unknown key <${token}>`);
    else out += bytes;
    i = close + 1;
  }

  return { sequence: out, errors };
}

/**
 * Turn a `[keys]` table into remaps. Bad entries are reported and skipped —
 * one typo must not cost the user the rest of their bindings.
 */
export function parseKeyRemaps(
  table: Record<string, unknown>,
  errors: string[] = [],
): KeyRemap[] {
  const remaps: KeyRemap[] = [];
  for (const [rawChord, rawSend] of Object.entries(table)) {
    if (typeof rawSend !== 'string') {
      errors.push(`keys."${rawChord}": expected a string`);
      continue;
    }
    const chord = parseChord(rawChord);
    if (!chord) {
      errors.push(`keys."${rawChord}": not a key chord`);
      continue;
    }
    const { sequence, errors: seqErrors } = renderSequence(rawSend);
    if (seqErrors.length) {
      for (const e of seqErrors) errors.push(`keys."${rawChord}": ${e}`);
      continue;
    }
    remaps.push({ chord, send: sequence, source: rawChord });
  }
  return remaps;
}

/** First remap whose chord matches, or null. */
export function findKeyRemap(event: ChordEvent, remaps: readonly KeyRemap[]): KeyRemap | null {
  for (const remap of remaps) {
    if (matchesChord(event, remap.chord)) return remap;
  }
  return null;
}
