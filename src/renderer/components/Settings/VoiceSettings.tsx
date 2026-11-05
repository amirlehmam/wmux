import { useEffect, useState } from 'react';
import type { DictationDevice } from '../../../shared/dictation';
import { useDictation } from '../../hooks/useDictation';
import { useT } from '../../i18n';
import { dictationErrorMessage } from './voice-copy';

export default function VoiceSettings(){
  const t=useT();const {state,command}=useDictation();
  const [devices,setDevices]=useState<DictationDevice[]>([]);
  const [loading,setLoading]=useState(false);
  const busy=!['idle','error'].includes(state.phase);
  useEffect(()=>{void command({action:'refresh'});},[command]);
  const refreshDevices=async()=>{
    setLoading(true);try{const result=await command({action:'devices'});if(Array.isArray(result))setDevices(result);}finally{setLoading(false);}
  };
  const missing=state.deviceId!=='default'&&!devices.some(d=>d.id===state.deviceId);
  return <div className="settings-section">
    <h3 className="settings-section-title">{t('voice.title','Voice')}</h3>
    <p className="settings-hint">{t('voice.description','Dictate with the ChatGPT website using your account. Click the microphone in the titlebar, speak, then click Stop to insert text into the selected terminal. Nothing is sent to the terminal until you click Stop.')}</p>
    <div className="settings-row"><label className="settings-label">{t('voice.account','ChatGPT account')}</label>
      <span>{state.account==='signed-in'?t('voice.connected','Connected'):state.account==='signed-out'?t('voice.disconnected','Not connected'):t('voice.unknown','Not verified')}</span>
    </div>
    <div className="settings-row"><button type="button" className="settings-btn" disabled={busy} onClick={()=>{void command({action:'account'});}}>{state.account==='signed-in'?t('voice.manageAccount','Manage ChatGPT account'):t('voice.signIn','Sign in to ChatGPT')}</button>
      <button type="button" className="settings-btn" disabled={busy} onClick={()=>{void command({action:'refresh'});}}>{t('voice.checkAccount','Check connection')}</button></div>
    <p className="settings-hint">{t('voice.accountHint','Sign in manually in the dedicated ChatGPT window. This login is separate from ordinary browser tabs. A connected account is required; no API key is used.')}</p>
    <div className="settings-divider"/>
    <div className="settings-row"><label className="settings-label" htmlFor="voice-microphone">{t('voice.microphone','Microphone')}</label>
      <select id="voice-microphone" className="settings-select" disabled={busy||loading} value={state.deviceId} onChange={e=>{void command({action:'device',deviceId:e.target.value});}}>
        <option value="default">{t('voice.defaultMicrophone','System default')}</option>
        {devices.filter(d=>d.id!=='default').map((d,i)=><option key={d.id} value={d.id}>{d.label||`${t('voice.microphone','Microphone')} ${i+1}`}</option>)}
        {missing&&<option value={state.deviceId}>{t('voice.savedMicrophone','Saved microphone — refresh devices to verify')}</option>}
      </select>
    </div>
    <div className="settings-row"><button type="button" className="settings-btn" disabled={busy||loading||state.account!=='signed-in'} onClick={()=>{void refreshDevices();}}>{loading?t('voice.loadingDevices','Loading microphones…'):t('voice.refreshDevices','Allow microphone and refresh devices')}</button></div>
    <p className="settings-hint">{t('voice.deviceHint','Refreshing requests microphone access briefly to list device names, then releases it. A disconnected selected device causes an error instead of switching to another microphone.')}</p>
    {state.error&&<p className="settings-hint" role="alert">{dictationErrorMessage(state.error,t)}</p>}
  </div>;
}
