/**
 * One agent, attached (#254): header, the terminal mirror, and a bottom stack
 * of choice bar → key bar → composer.
 *
 * The bottom stack follows `visualViewport`, not the layout viewport. When the
 * phone keyboard opens, iOS Safari does NOT shrink the layout viewport — it
 * pans it — so a `bottom: 0` stack ends up under the keyboard exactly when the
 * user is typing into it. Sizing the screen to `visualViewport.height` (and
 * offsetting by its `offsetTop`) keeps the composer on top of the keyboard on
 * both engines; the safe-area inset pads the home indicator when it is closed.
 *
 * An effective VIEWER sees no composer, no key bar and no choice buttons: the
 * server would refuse every one of those frames (`forbidden`, then 4429 on the
 * third), so offering them would be offering a way to get disconnected.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, RemoteKey, RemoteRosterEntry } from '../../../shared/remote-console-protocol';
import { ackMessageKey, stateWordKey, type RemoteT } from '../i18n';
import { armFromConfirm, tapKey, waivablePrompt, type KeyArm } from '../composer-state';
import { loadFitMode, saveFitMode, type FitMode } from '../fit';
import { isUnconfirmed, newNonce, type WsClient, type WsStatus } from '../ws-client';
import { ChoiceRow } from '../components/ChoiceRow';
import { attachTitle } from './attach-title';
import { Composer } from '../components/Composer';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { KeyBar } from '../components/KeyBar';
import { TermView, type TermStatus } from '../components/TermView';
import { connKey } from './ConsoleScreen';
import { useVisualViewport } from '../visual-viewport';

function safeStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * Which chips the header shows. The CONNECTION chip whenever the socket is not
 * ready, beside the agent's state: the mirror keeps its last frame across a
 * drop, so "Working" over a frozen terminal read as live while every Send hung
 * on "Sending…". This is the screen the user types on.
 */
export function attachHeaderChips(hasStateWord: boolean, status: WsStatus): ('state' | 'conn')[] {
  const chips: ('state' | 'conn')[] = [];
  if (hasStateWord) chips.push('state');
  if (status !== 'ready') chips.push('conn');
  return chips;
}

/**
 * The header toggle's label (#265). The key bar and the composer are ~110 px
 * of a phone screen; someone who is only WATCHING an agent gets that back, and
 * the choice buttons of a blocked agent stay either way — hiding the keys must
 * not hide the question.
 */
export function controlsToggleKey(shown: boolean): 'attach.hideKeys' | 'attach.showKeys' {
  return shown ? 'attach.hideKeys' : 'attach.showKeys';
}

/** Composer, keys and choices only while there is a live terminal to type into. */
export function acceptsInput(operator: boolean, termStatus: TermStatus): boolean {
  return operator && termStatus !== 'exit' && termStatus !== 'error';
}

interface Props {
  client: WsClient;
  s: string;
  entry: RemoteRosterEntry | undefined;
  status: WsStatus;
  operator: boolean;
  maxText: number;
  fontScale: number;
  dark: boolean;
  t: RemoteT;
  onBack(): void;
  onAnswer(s: string, choiceId: string, prompt: number | null): void;
  onError(text: string): void;
}

export function AttachScreen({ client, s, entry, status, operator, maxText, fontScale, dark, t, onBack, onAnswer, onError }: Readonly<Props>) {
  const [mode, setMode] = useState<FitMode>(() => loadFitMode(safeStorage(), s));
  const [arm, setArm] = useState<KeyArm | null>(null);
  // The prompt an arm is about. A blocked waiver answers ONE question: the
  // second tap names it, and a pane that moved on in between is asked again.
  const armPrompt = useRef<number | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [termStatus, setTermStatus] = useState<TermStatus>('loading');
  // Per attach, never remembered: a composer that stayed hidden from last week
  // reads as a console that cannot type.
  const [controls, setControls] = useState(true);
  const vv = useVisualViewport();

  // Disarm when the window lapses, so the red key goes back to normal by itself.
  useEffect(() => {
    if (!arm) return;
    const id = globalThis.setTimeout(() => setArm(null), Math.max(0, arm.until - Date.now()));
    return () => globalThis.clearTimeout(id);
  }, [arm]);

  const agentState = entry?.state ?? null;
  // The roster drops a closed pane's entry; the header keeps the name it had
  // rather than falling back to a raw surf-<uuid>.
  const [lastLabel, setLastLabel] = useState<string | null>(entry?.label ?? null);
  const label = entry?.label;
  useEffect(() => { if (label) setLastLabel(label); }, [label]);
  const blocked = agentState === 'blocked';

  const sendKey = useCallback((key: RemoteKey) => {
    const now = Date.now();
    const r = tapKey(arm, key, agentState, now, newNonce);
    if (r.action === 'arm') {
      armPrompt.current = entry?.promptId ?? null;
      setArm(r.arm);
      return;
    }
    setArm(null);
    const prompt = armPrompt.current ?? entry?.promptId ?? null;
    // Exactly the listed fields: an empty `force` is noise, and the validator refuses one.
    const frame: Extract<ClientMessage, { t: 'key' }> = r.force.length > 0
      ? { t: 'key', s, nonce: r.nonce, key, force: r.force }
      : { t: 'key', s, nonce: r.nonce, key };
    if (r.force.includes('blocked') && prompt !== null) frame.prompt = prompt;
    client.request(frame).then(
      (ack) => {
        if (ack.ok) return;
        // The server knew better than the roster (declared blocked, or a live
        // run depth): arm with the nonce it refused, so the next tap is it.
        if (ack.code === 'confirm' && ack.confirm) {
          // Only a prompt this phone displays can be waived (see waivablePrompt).
          armPrompt.current = waivablePrompt(ack.prompt, entry?.promptId ?? null);
          setArm(armFromConfirm(key, ack.nonce, Date.now(), ack.confirm, r.force));
        }
        else onError(t.t(ackMessageKey(ack.code), { max: maxText }));
      },
      (err: unknown) => {
        // Too old to resend (ws-client rule 4): it may have landed.
        if (isUnconfirmed(err)) onError(t.t('ack.unconfirmed'));
      },
    );
  }, [arm, agentState, entry, client, s, onError, t, maxText]);

  const toggleMode = () => {
    const next: FitMode = mode === 'fit' ? 'pan' : 'fit';
    setMode(next);
    saveFitMode(safeStorage(), s, next);
  };

  const wordKey = entry ? stateWordKey(entry.state) : null;
  const style = vv ? { height: `${vv.height}px`, transform: `translateY(${vv.top}px)` } : undefined;
  const chips = attachHeaderChips(wordKey !== null, status);
  const canType = acceptsInput(operator, termStatus);

  return (
    <main className="rc-screen rc-attach" style={style}>
      <header className="rc-bar">
        <button type="button" className="rc-bar__btn" onClick={onBack} aria-label={t.t('common.back')}>‹</button>
        {/* The state chip sits UNDER the title: beside it, with the back and
            fit buttons, it left a 433 px phone ~80 px of label — every Claude
            pane read "claud…", the part that tells two agents apart cut off. */}
        <div className="rc-attach__heading">
          <h1 className="rc-bar__title rc-attach__title">{attachTitle(entry?.label, lastLabel, t)}</h1>
          {chips.includes('state') && wordKey && <span className={`rc-chip rc-chip--${entry?.state}`}>{t.t(wordKey)}</span>}
        </div>
        {chips.includes('conn') && <span className={`rc-chip rc-chip--${status}`}>{t.t(connKey(status))}</span>}
        <button type="button" className="rc-bar__btn rc-bar__btn--text" onClick={toggleMode} aria-pressed={mode === 'pan'}>
          {mode === 'fit' ? t.t('attach.pan') : t.t('attach.fit')}
        </button>
        {canType && (
          <button
            type="button"
            className={controls ? 'rc-bar__btn rc-bar__btn--keys' : 'rc-bar__btn rc-bar__btn--keys rc-bar__btn--off'}
            onClick={() => setControls((c) => !c)}
            aria-pressed={controls}
            aria-label={t.t(controlsToggleKey(controls))}
          >
            ⌨
          </button>
        )}
      </header>

      <TermView client={client} s={s} mode={mode} fontScale={fontScale} dark={dark} t={t} operator={operator} onLink={setLink} onStatus={setTermStatus} />

      <div className="rc-attach__stack">
        {canType && blocked && entry && !entry.answerPending && (
          <ChoiceRow choices={entry.choices} onAnswer={(id) => onAnswer(s, id, entry.promptId)} />
        )}
        {blocked && entry?.answerPending && <p className="rc-attach__pending">{t.t('card.answerPending')}</p>}
        {canType && controls && <KeyBar armed={arm?.key ?? null} armedFor={arm?.force.at(-1) ?? null} t={t} onKey={sendKey} />}
        {canType && controls && (
          <Composer
            key={s}
            client={client}
            s={s}
            blocked={blocked}
            prompt={entry?.promptId ?? null}
            maxText={maxText}
            t={t}
            onEnter={() => sendKey('enter')}
            enterArmed={arm?.key === 'enter'}
          />
        )}
      </div>

      {link && (
        <ConfirmSheet
          title={t.t('link.title')}
          detail={link}
          okLabel={t.t('link.ok')}
          cancelLabel={t.t('common.cancel')}
          onOk={() => {
            globalThis.open(link, '_blank', 'noopener,noreferrer');
            setLink(null);
          }}
          onCancel={() => setLink(null)}
        />
      )}
    </main>
  );
}
