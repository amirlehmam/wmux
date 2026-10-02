/**
 * The keys a phone keyboard does not have (#254).
 *
 * The primary row is what driving an agent TUI needs — Esc, Tab, ⇧Tab, arrows,
 * Enter, ^C, y/n — and ⋯ reveals the rest. An ARMED key is red AND says so in
 * words above the bar: its first tap was held back (by the roster, or by a
 * server `confirm`), and a second tap inside 1.5 s sends it with the same
 * nonce and `force`. Colour alone left a sighted user watching a key flash
 * and nothing happen. The decision is made by `tapKey` in composer-state.ts;
 * this component only renders it.
 */

import { useState } from 'react';
import type { ConfirmKind, RemoteKey } from '../../../shared/remote-console-protocol';
import type { RemoteMessageKey } from '../i18n/messages/en';
import type { RemoteT } from '../i18n';

/** `aria`: a translated name; `ctrl`: the letter of a Ctrl chord, spoken through `keys.ctrl`. */
interface KeyDef { key: RemoteKey; label: string; aria?: RemoteMessageKey; ctrl?: string }

/**
 * The ORDER is the feature (#266): the row is wider than a phone and scrolls,
 * so only its first few keys exist for someone who has not found that out.
 * Enter used to be eighth of a row that shows seven, and a menu the arrows
 * could walk had no visible way to be confirmed. Up, Down, Enter sit together
 * and ahead of everything that is not needed to answer a prompt; they fit
 * unscrolled on a 320 px screen.
 */
export const PRIMARY: readonly KeyDef[] = [
  { key: 'esc', label: 'Esc' },
  { key: 'up', label: '↑', aria: 'keys.up' },
  { key: 'down', label: '↓', aria: 'keys.down' },
  { key: 'enter', label: '↵', aria: 'keys.enter' },
  { key: 'tab', label: 'Tab' },
  { key: 'left', label: '←', aria: 'keys.left' },
  { key: 'right', label: '→', aria: 'keys.right' },
  { key: 'shift-tab', label: '⇧Tab' },
  { key: 'ctrl-c', label: '^C', ctrl: 'C' },
  { key: 'y', label: 'y' },
  { key: 'n', label: 'n' },
];

const EXTRA: readonly KeyDef[] = [
  { key: 'ctrl-d', label: '^D', ctrl: 'D' },
  { key: 'ctrl-l', label: '^L', ctrl: 'L' },
  { key: 'ctrl-r', label: '^R', ctrl: 'R' },
  { key: 'pageup', label: 'PgUp', aria: 'keys.pageUp' },
  { key: 'pagedown', label: 'PgDn', aria: 'keys.pageDown' },
  { key: 'home', label: 'Home', aria: 'keys.home' },
  { key: 'end', label: 'End', aria: 'keys.end' },
  { key: 'backspace', label: '⌫', aria: 'keys.backspace' },
];

function keyName(def: KeyDef, t: RemoteT): string {
  if (def.ctrl) return t.t('keys.ctrl', { key: def.ctrl });
  return def.aria ? t.t(def.aria) : def.label;
}

/**
 * What the second tap of an armed key DOES, in words. "Tap again to send"
 * hid the part that matters: on a working agent Esc and ^C interrupt the run,
 * and on a blocked one Enter, y and n answer its question. The composer says
 * so in a sheet; a key has only this line, so it says so here.
 */
export function armedLabelKey(reason: ConfirmKind | null): RemoteMessageKey {
  if (reason === 'interrupt') return 'keys.armedInterrupt';
  if (reason === 'blocked') return 'keys.armedAnswer';
  return 'keys.armed';
}

interface Props {
  armed: RemoteKey | null;
  /** The confirm the armed tap is waiting on (the last one it asked). */
  armedFor: ConfirmKind | null;
  t: RemoteT;
  onKey(key: RemoteKey): void;
}

function KeyButton({ def, armed, armedLabel, t, onKey }: Readonly<{ def: KeyDef; armed: boolean; armedLabel: string; t: RemoteT; onKey(k: RemoteKey): void }>) {
  const name = keyName(def, t);
  return (
    <button
      type="button"
      className={armed ? 'rc-key rc-key--armed' : 'rc-key'}
      aria-label={armed ? `${name} — ${armedLabel}` : name}
      // pointerdown-free on purpose: a key sent on touch START fires during a
      // scroll of the bar itself. `click` only fires on a tap that stayed put.
      onClick={() => onKey(def.key)}
    >
      {def.label}
    </button>
  );
}

export function KeyBar({ armed, armedFor, t, onKey }: Readonly<Props>) {
  const [more, setMore] = useState(false);
  const armedLabel = t.t(armedLabelKey(armedFor));
  const armedDef = armed ? [...PRIMARY, ...EXTRA].find((d) => d.key === armed) : undefined;
  return (
    <div className="rc-keybar">
      {armedDef && (
        <p className="rc-keybar__armed" role="status">{`${keyName(armedDef, t)} — ${armedLabel}`}</p>
      )}
      <div className="rc-keybar__row">
        {/* Only the keys scroll; ⋯ stays on screen (the full-screen hint points at it). */}
        <div className="rc-keybar__scroll">
          {PRIMARY.map((d) => <KeyButton key={d.key} def={d} armed={armed === d.key} armedLabel={armedLabel} t={t} onKey={onKey} />)}
        </div>
        <button
          type="button"
          className={more ? 'rc-key rc-key--on' : 'rc-key'}
          aria-expanded={more}
          aria-label={t.t('keys.more')}
          onClick={() => setMore((m) => !m)}
        >
          ⋯
        </button>
      </div>
      {more && (
        <div className="rc-keybar__row rc-keybar__row--wrap">
          {EXTRA.map((d) => <KeyButton key={d.key} def={d} armed={armed === d.key} armedLabel={armedLabel} t={t} onKey={onKey} />)}
        </div>
      )}
    </div>
  );
}
