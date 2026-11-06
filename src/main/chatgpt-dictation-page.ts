// This function is serialized into the owned ChatGPT document. Keep it closed:
// no imports/outer variables, credentials, network calls or chat submission.
// Labels below were observed in the live website; unknown UI fails closed.
export interface ChatGPTPageCommand { action: 'inspect' | 'start' | 'stop' | 'cancel' | 'read' | 'clear' | 'devices'; deviceId?: string; text?: string }
export interface ChatGPTPageResult { account?: 'signed-in' | 'signed-out' | 'unknown'; text?: string; recording?: boolean; completed?: boolean; capturing?: boolean; devices?: {id:string;label:string}[] }

export async function runChatGPTPageCommand(command: ChatGPTPageCommand): Promise<ChatGPTPageResult> {
  type Capture = { native: typeof navigator.mediaDevices.getUserMedia; streams: MediaStream[]; armed: boolean; deviceId: string; epoch: number; error?: string; composer?: HTMLElement; href?: string };
  const host = window as unknown as { __wmuxDictationCapture?: Capture };
  const visible = (e: Element) => {
    for (let node:Element|null=e;node;node=node.parentElement) {
      const style=getComputedStyle(node);
      if(node.hasAttribute('hidden') || node.getAttribute('aria-hidden')==='true' || style.display==='none' || style.visibility==='hidden')return false;
    }
    return true;
  };
  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(visible);
  const label = (e: Element) => (e.getAttribute('aria-label') || e.textContent || '').trim();
  const startLabels = /^(Ditar|Iniciar ditado|Dictate|Start dictation|Dicter|Démarrer la dictée)$/i;
  const stopLabels = /^(Interromper ditado|Parar ditado|Stop dictation|Submit dictation|Stop recording|Arrêter la dictée|Terminer la dictée)$/i;
  const cancelLabels = /^(Cancelar ditado|Cancel dictation|Annuler la dictée)$/i;
  const matching = (pattern: RegExp) => buttons().filter(e => pattern.test(label(e)));
  const one = (pattern: RegExp) => { const found = matching(pattern); if (found.length !== 1 || found[0].disabled) throw new Error('page-changed'); return found[0]; };
  const composer = () => {
    const found = Array.from(document.querySelectorAll<HTMLElement>('form [role="textbox"][contenteditable="true"], form textarea, #prompt-textarea')).filter(visible);
    const unique = [...new Set(found)];
    if (unique.length !== 1) throw new Error('page-changed');
    return unique[0];
  };
  const text = () => { const e = composer(); return e instanceof HTMLTextAreaElement ? e.value : e.textContent || ''; };
  const completed = () => {
    const starts=matching(startLabels);
    const sends=matching(/^(Enviar|Send|Send prompt|Envoyer)$/i).filter(e=>e.type==='submit');
    return matching(stopLabels).length===0 && matching(cancelLabels).length===0
      && starts.length===1 && !starts[0].disabled && sends.length===1 && !sends[0].disabled
      && !composer().closest('[aria-busy="true"]');
  };
  const checkOriginatingComposer = (allowHidden = false) => {
    const capture=host.__wmuxDictationCapture;
    if(capture?.composer && (capture.href!==location.href || !capture.composer.isConnected || (!allowHidden && capture.composer!==composer())))throw new Error('page-changed');
  };
  const account = () => {
    if (buttons().some(e => /^(Entrar|Log in|Se connecter)$/i.test(label(e))) || Array.from(document.querySelectorAll('a[href^="/auth/login"]')).some(visible)) return 'signed-out' as const;
    const positive = buttons().some(e => /^(Selecionar modelo do ChatGPT|Select ChatGPT model|ChatGPT model selector|Sélectionner le modèle ChatGPT)$/i.test(label(e)))
      || document.querySelector('[data-testid="profile-button"], [data-testid="accounts-profile-button"]');
    return positive ? 'signed-in' as const : 'unknown' as const;
  };
  const release = () => {
    const capture = host.__wmuxDictationCapture;
    if (!capture) return;
    capture.armed = false; capture.epoch++;
    capture.streams.forEach(s => s.getTracks().forEach(t => t.stop())); capture.streams = [];
  };
  if (command.action === 'inspect') return {account:account()};
  if (command.action === 'cancel') {
    const cancels = matching(cancelLabels);
    if (cancels.length === 1) cancels[0].click();
    release(); return {};
  }
  const accountState=account();
  // Recording's modal hides the signed-in header and composer. Keep only the
  // session positively verified at Start; a visible sign-out still invalidates
  // it. Unknown UI can never authorize a new recording or device enumeration.
  const continuing=host.__wmuxDictationCapture?.armed && ['read','stop','clear'].includes(command.action);
  if (accountState==='signed-out' || (accountState!=='signed-in' && !continuing)) throw new Error('login-required');
  if (command.action === 'stop') { one(stopLabels).click(); return {}; }
  if (command.action === 'read') {
    checkOriginatingComposer(true);
    const capture = host.__wmuxDictationCapture;
    if (capture?.error) throw new Error(capture.error);
    const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map(e => e.textContent || '').join(' ');
    if (/não foi possível transcrever|unable to transcribe|couldn.t transcribe|impossible de transcrire/i.test(alerts)) throw new Error('transcription-failed');
    const recording=matching(stopLabels).length > 0 || matching(cancelLabels).length > 0;
    const waiting=recording || (!!capture?.composer && !visible(capture.composer));
    return {text:waiting?'':text(), completed:!waiting && completed(), recording, capturing:capture?.streams.some(s=>s.getAudioTracks().some(t=>t.readyState==='live')) ?? false};
  }
  if (command.action === 'clear') {
    checkOriginatingComposer();
    if(!completed() || text()!==command.text)throw new Error('page-changed');
    const e = composer();
    // The dedicated draft was created by this operation only. Never clear a
    // user's draft as part of Start, and never submit a form.
    if (e instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(e,'');
    } else { e.textContent = ''; }
    e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
    release(); return {};
  }
  if (command.action === 'devices') {
    // An explicit settings action requests labels, then immediately releases
    // its temporary stream. It never sends this sample to ChatGPT.
    const native = host.__wmuxDictationCapture?.native ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const stream = await native({audio:true,video:false});
    try { return {devices:(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput').map(d=>({id:d.deviceId,label:d.label}))}; }
    finally { stream.getTracks().forEach(t=>t.stop()); }
  }
  if (command.action === 'start') {
    if (text().trim()) throw new Error('draft-not-empty');
    const start = one(startLabels);
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('microphone-unavailable');
    if (!host.__wmuxDictationCapture) {
      const capture: Capture = {native:navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),streams:[],armed:false,deviceId:'default',epoch:0};
      host.__wmuxDictationCapture = capture;
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (!capture.armed || !constraints?.audio || constraints.video) throw new DOMException('Dictation capture is not armed','NotAllowedError');
        const epoch = capture.epoch;
        try {
          const audio = typeof constraints.audio === 'object' ? {...constraints.audio} : {};
          if (capture.deviceId !== 'default') audio.deviceId = {exact:capture.deviceId};
          const stream = await capture.native({...constraints,audio,video:false});
          if (!capture.armed || epoch !== capture.epoch) { stream.getTracks().forEach(t=>t.stop()); throw new DOMException('Cancelled','AbortError'); }
          const track = stream.getAudioTracks()[0];
          if (!track || (capture.deviceId !== 'default' && track.getSettings().deviceId !== capture.deviceId)) {
            stream.getTracks().forEach(t=>t.stop()); throw new Error('microphone-unavailable');
          }
          capture.streams.push(stream);
          track.addEventListener('ended',()=>{if(capture.armed && matching(stopLabels).length) capture.error='microphone-unavailable';});
          return stream;
        } catch (error) { if(capture.armed && epoch===capture.epoch)capture.error='microphone-unavailable'; throw error; }
      };
    }
    const capture = host.__wmuxDictationCapture;
    release(); capture.deviceId = command.deviceId || 'default'; capture.error=undefined; capture.composer=composer(); capture.href=location.href; capture.armed=true;
    const epoch=capture.epoch;
    // Electron grants only during this operation. Re-query so PermissionStatus
    // objects cached by the site while idle receive the new granted state.
    if(navigator.permissions?.query) {
      const permission=await navigator.permissions.query({name:'microphone' as PermissionName});
      if(permission.state==='denied')throw new Error('microphone-unavailable');
      // Let the site's permission change listener commit its UI update.
      await new Promise<void>(resolve=>setTimeout(resolve,0));
    }
    if(!capture.armed || epoch!==capture.epoch)throw new Error('cancelled');
    start.click(); return {};
  }
  throw new Error('page-changed');
}
