/**
 * The phone's text box into an agent (#254). All decisions live in the pure
 * `composerReducer` (composer-state.ts); this is the wiring: the textarea, the
 * draft's persistence, the socket request, and the confirm sheet.
 *
 * A reducer transition and the request it implies are computed TOGETHER from
 * a ref to the current state, not by an effect watching `phase`: an effect
 * would re-send whenever React re-ran it (StrictMode does, on purpose), and a
 * duplicate frame is exactly what the nonce exists to make harmless — but not
 * what this component should lean on it for.
 */

import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react';
import type { ClientMessage } from '../../../shared/remote-console-protocol';
import {
  canSubmit,
  clearSentDraft,
  composerLabel,
  composerReducer,
  initialComposer,
  loadDraft,
  saveDraft,
  waivablePrompt,
  type ComposerAction,
  type ComposerFrame,
  type ComposerState,
} from '../composer-state';
import { ackMessageKey, type RemoteT } from '../i18n';
import { isUnconfirmed, newNonce, type WsClient } from '../ws-client';
import { ConfirmSheet } from './ConfirmSheet';

/**
 * sessionStorage, not localStorage: a draft may be a password typed for a
 * sudo or ssh prompt, and it should not outlive the tab. It still survives a
 * reload, which is the case a draft exists for (see device-storage.ts).
 */
function safeStorage(): Storage | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

interface Props {
  client: WsClient;
  s: string;
  blocked: boolean;
  /** The roster's `promptId` for this pane: what a blocked waiver names. */
  prompt: number | null;
  maxText: number;
  t: RemoteT;
  /** The key bar's Enter: what the button is while blocked with an empty box (#266). */
  onEnter(): void;
  /** That Enter is armed, i.e. its first tap was held back and the next one sends. */
  enterArmed: boolean;
}

export function Composer({ client, s, blocked, prompt, maxText, t, onEnter, enterArmed }: Readonly<Props>) {
  const [state, dispatch] = useReducer(composerReducer, s, (id: string) => initialComposer(loadDraft(safeStorage(), id)));
  const stateRef = useRef<ComposerState>(state);
  stateRef.current = state;
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  // The prompt the blocked confirm on screen is about. The waiver is resent
  // after a reconnect as-is, so it must name the question the user saw, not
  // whatever the pane asks by the time the frame lands.
  const confirmPrompt = useRef<number | null>(null);

  useEffect(() => { saveDraft(safeStorage(), s, state.draft); }, [s, state.draft]);

  // Auto-grow; the 40vh cap is the CSS max-height, past which it scrolls.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [state.draft]);

  const transmit = useCallback((frame: ComposerFrame) => {
    const msg: Extract<ClientMessage, { t: 'send' }> = { t: 'send', s, nonce: frame.nonce, text: frame.text, submit: frame.submit };
    // Exactly the listed fields: the validator rejects an unknown one, and an
    // empty `force` list (which it also rejects) is noise.
    if (frame.force.length > 0) msg.force = [...frame.force];
    const waived = confirmPrompt.current ?? promptRef.current;
    if (frame.force.includes('blocked') && waived !== null) msg.prompt = waived;
    client.request(msg).then(
      (ack) => {
        // Only the prompt this phone is showing may be waived; a newer one
        // the server names is asked again once the roster shows it.
        if (ack.code === 'confirm' && ack.confirm === 'blocked') confirmPrompt.current = waivablePrompt(ack.prompt, promptRef.current);
        // Also when this composer is already unmounted — see clearSentDraft.
        if (ack.ok) clearSentDraft(safeStorage(), s, frame.text);
        dispatch({ type: 'ack', nonce: ack.nonce, ok: ack.ok, code: ack.code, confirm: ack.confirm, submitSkipped: ack.submitSkipped });
      },
      (err: unknown) => dispatch({ type: 'error', unconfirmed: isUnconfirmed(err) }),
    );
  }, [client, s]);

  const act = useCallback((action: ComposerAction) => {
    const next = composerReducer(stateRef.current, action);
    const willSend = next.phase === 'sending' && next.frame !== null && next !== stateRef.current;
    // Advance the ref now, not on the next render: two taps in one tick must
    // see each other, or both would pass the send-once check.
    stateRef.current = next;
    dispatch(action);
    if (willSend && next.frame) transmit(next.frame);
  }, [transmit]);

  const submit = () => {
    // Blocked: the sheet opens now, about the prompt on screen now.
    confirmPrompt.current = blocked ? promptRef.current : null;
    act({ type: 'submit', nonce: newNonce(), blocked, maxText });
  };

  const label = composerLabel(state, blocked);
  const labelText = {
    send: t.t('composer.send'),
    insert: t.t('composer.insert'),
    sending: t.t('composer.sending'),
    enter: `${t.t('keys.enter')} ↵`,
  }[label];
  const asEnter = label === 'enter';
  let sendClass = blocked ? 'rc-btn rc-btn--warn rc-composer__send' : 'rc-btn rc-btn--primary rc-composer__send';
  if (asEnter && enterArmed) sendClass = 'rc-btn rc-composer__send rc-composer__send--armed';

  let failure: string | null = null;
  if (state.phase === 'failed') {
    failure = state.code === 'unconfirmed'
      ? t.t('ack.unconfirmed')
      : t.t(ackMessageKey(state.code ?? undefined), { max: maxText });
  }

  let sheet: ReactNode = null;
  if (state.phase === 'confirm' && state.confirm) {
    const kind = state.confirm;
    sheet = (
      <ConfirmSheet
        title={t.t(`confirm.${kind}.title`)}
        body={t.t(`confirm.${kind}.body`)}
        okLabel={t.t(`confirm.${kind}.ok`)}
        cancelLabel={t.t('common.cancel')}
        danger={kind === 'interrupt'}
        onOk={() => act({ type: 'accept' })}
        onCancel={() => act({ type: 'cancel' })}
      />
    );
  }

  return (
    <div className="rc-composer">
      {failure && <p className="rc-composer__error" role="alert">{failure}</p>}
      {state.phase === 'acked' && state.submitSkipped && (
        <p className="rc-composer__error" role="status">{t.t('composer.submitSkipped')}</p>
      )}
      <div className="rc-composer__row">
        <textarea
          ref={boxRef}
          className="rc-composer__box"
          rows={1}
          value={state.draft}
          placeholder={t.t('composer.placeholder')}
          aria-label={t.t('composer.placeholder')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="enter"
          onChange={(e) => act({ type: 'edit', text: e.target.value })}
          onKeyDown={(e) => {
            // A phone's Enter is a newline; a hardware keyboard gets Ctrl/⌘+Enter to send.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className={sendClass}
          disabled={!asEnter && !canSubmit(state, blocked)}
          onClick={asEnter ? onEnter : submit}
        >
          {labelText}
        </button>
      </div>
      {sheet}
    </div>
  );
}
