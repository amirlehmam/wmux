/**
 * Named key → raw PTY bytes.
 *
 * Moved out of index.ts for the Remote Console (#254): `surface.send_key`, the
 * `pane.answer_agent` writer and the phone's key bar must type the SAME bytes
 * for the same name, and two tables would drift. `PTY_KEY_MAP` and
 * `translateKeyName` are byte-identical to the originals; `REMOTE_KEY_BYTES` is
 * the phone's closed subset, keyed by the protocol's `RemoteKey` so a key the
 * protocol accepts can never be missing a byte sequence here.
 */
import type { RemoteKey } from '../shared/remote-console-protocol';

// Named-key → raw PTY input translation. Fallback rules:
//   - length === 1            → literal character (covers Ctrl+letter flow).
//   - known multi-char name   → translated to real control/escape bytes.
//   - unknown multi-char name → null (caller returns -32602 invalid params).
export const PTY_KEY_MAP: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  esc: '\x1b',
  escape: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  space: ' ',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-u': '\x15',
  'ctrl-l': '\x0c',
  'ctrl-a': '\x01',
  'ctrl-e': '\x05',
  'ctrl-k': '\x0b',
  'ctrl-w': '\x17',
  'ctrl-r': '\x12',
  'ctrl-z': '\x1a',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS',
  f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~',
  f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};
export function translateKeyName(key: string, shift: boolean): string | null {
  if (key.length === 1) return shift ? key.toUpperCase() : key;
  const normalized = key.toLowerCase();
  if (normalized in PTY_KEY_MAP) return PTY_KEY_MAP[normalized];
  return null;
}

/**
 * The phone key bar. Only `shift-tab`, `y` and `n` are not read off
 * PTY_KEY_MAP: shift-tab has no entry there, and y/n are literals so the
 * session's "is this answering input" check sees exactly the byte an agent's
 * y/n prompt reads.
 */
export const REMOTE_KEY_BYTES: Readonly<Record<RemoteKey, string>> = Object.freeze({
  esc: PTY_KEY_MAP.esc,
  tab: PTY_KEY_MAP.tab,
  'shift-tab': '\x1b[Z',
  enter: PTY_KEY_MAP.enter,
  up: PTY_KEY_MAP.up,
  down: PTY_KEY_MAP.down,
  left: PTY_KEY_MAP.left,
  right: PTY_KEY_MAP.right,
  pageup: PTY_KEY_MAP.pageup,
  pagedown: PTY_KEY_MAP.pagedown,
  home: PTY_KEY_MAP.home,
  end: PTY_KEY_MAP.end,
  backspace: PTY_KEY_MAP.backspace,
  'ctrl-c': PTY_KEY_MAP['ctrl-c'],
  'ctrl-d': PTY_KEY_MAP['ctrl-d'],
  'ctrl-l': PTY_KEY_MAP['ctrl-l'],
  'ctrl-r': PTY_KEY_MAP['ctrl-r'],
  y: 'y',
  n: 'n',
});
