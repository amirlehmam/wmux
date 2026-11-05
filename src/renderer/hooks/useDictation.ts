import { useCallback, useEffect, useState } from 'react';
import type { DictationBridge, DictationCommand, DictationState } from '../../shared/dictation';

const initial:DictationState={phase:'idle',account:'unknown',deviceId:'default'};
export function useDictation() {
  const [state,setState]=useState<DictationState>(initial);
  const bridge=()=>window.wmux?.dictation as DictationBridge|undefined;
  useEffect(()=>{
    const api=bridge();if(!api)return;
    let live=true;
    const unsubscribe=api.onState(s=>{if(live)setState(s);});
    void api.command({action:'state'}).then(s=>{if(live && !Array.isArray(s))setState(s);}).catch(()=>{});
    return ()=>{live=false;unsubscribe();};
  },[]);
  const command=useCallback(async(request:DictationCommand)=>{
    try {
      const result=await bridge()?.command(request);
      if(result && !Array.isArray(result))setState(result);
      return result;
    }catch{
      setState(s=>({...s,phase:'error',error:'transcription-failed'}));
      return undefined;
    }
  },[]);
  return {state,command};
}
