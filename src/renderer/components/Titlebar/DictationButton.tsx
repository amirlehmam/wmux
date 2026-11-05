import { useEffect, useState } from 'react';
import { useDictation } from '../../hooks/useDictation';
import { useT } from '../../i18n';
import { dictationDelivery } from '../../utils/dictation-delivery';
import { dictationErrorMessage } from '../Settings/voice-copy';

export default function DictationButton({surfaceId}:{surfaceId?:string}) {
  const t=useT();const {state,command}=useDictation();
  const [localError,setLocalError]=useState(false);
  const recording=state.phase==='recording';
  const pending=['starting','processing','cancelling'].includes(state.phase);
  const toggle=async()=>{
    if(state.phase==='cancelling')return;
    if(pending){await command({action:'cancel'});return;}
    if(recording){await command({action:'stop'});return;}
    const binding=surfaceId && dictationDelivery.binding(surfaceId);
    if(!surfaceId||!binding){setLocalError(true);return;}
    setLocalError(false);await command({action:'start',surfaceId,binding});
  };
  useEffect(()=>{
    const handler=()=>{void toggle();};
    document.addEventListener('wmux:dictation-toggle',handler);
    return()=>document.removeEventListener('wmux:dictation-toggle',handler);
  });
  const waitingLabel=state.phase==='starting'?t('voice.starting','Checking ChatGPT and starting microphone…'):t('voice.processing','Processing dictation…');
  const label=recording?t('voice.stop','Stop dictation'):pending?t('voice.cancel','Cancel dictation'):t('voice.start','Start dictation');
  const error=localError?'no-terminal':state.error;
  return <div className="dictation-control">
    <button type="button" className={`titlebar__btn${recording?' titlebar__btn--recording':''}${pending?' titlebar__btn--dictation-busy':''}`} title={pending?`${waitingLabel} — ${label}`:label} aria-label={label} aria-pressed={recording} disabled={state.phase==='cancelling'}
      onMouseDown={e=>e.preventDefault()} onClick={()=>{void toggle();}}>
      {pending?<><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg><span className="dictation-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></>
        :recording?<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
        :<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>}
    </button>
    {error && !recording && !pending && <div className="dictation-panel" role="status" aria-live="polite">
      <strong>{t('voice.title','Voice')}</strong>
      <p>{dictationErrorMessage(error,t)}</p>
      {error==='login-required' && <button type="button" className="settings-btn" onClick={()=>{void command({action:'account'});}}>{t('voice.signIn','Sign in to ChatGPT')}</button>}
      {error && error!=='login-required' && error!=='no-terminal' && <button type="button" className="settings-btn" onClick={()=>{void command({action:'account'});}}>{t('voice.openPage','Open ChatGPT')}</button>}
      {state.transcript && <textarea className="settings-input" readOnly value={state.transcript} aria-label={t('voice.recoveredText','Transcript — select and copy to recover')}/>}
      <button type="button" className="settings-btn" onClick={()=>{setLocalError(false);void command({action:'cancel'});}}>{t('voice.dismiss','Dismiss')}</button>
    </div>}
  </div>;
}
