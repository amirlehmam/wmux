// Desktop-owned dictation IPC. Remote browser documents have no bridge and
// cannot select a target; main checks the requesting window and PTY lifetime.
import { app, ipcMain, BrowserWindow, type WebContents } from 'electron';
import { IPC_CHANNELS, type SurfaceId } from '../shared/types';
import { dictationError, type DictationCommand, type DictationState } from '../shared/dictation';
import { ChatGPTDictationHost } from './chatgpt-dictation-host';
import { DictationCoordinator } from './chatgpt-dictation';
import { loadSettings, saveSetting } from './settings-store';

interface DictationOwner { host:ChatGPTDictationHost; coordinator:DictationCoordinator; targetPid?:number; surfaceId?:string; watchingSignIn?:boolean }
export function registerDictationIpc(deps:{ desktop:(wc:WebContents)=>boolean; owns:(id:unknown,wc:WebContents)=>boolean; pid:(id:SurfaceId)=>number|undefined }):void {
  const owners=new Map<number,DictationOwner>();
  const stored=loadSettings()['wmux-voice-device'];
  let deviceId=typeof stored==='string' && stored.length<1024 ? stored : 'default';
  const dispose=(id:number)=>{const o=owners.get(id);if(!o)return;owners.delete(id);o.coordinator.dispose();o.host.dispose();};
  app.on('before-quit',()=>{for(const id of owners.keys())dispose(id);});
  const getOwner=(wc:WebContents):DictationOwner=>{
    const existing=owners.get(wc.id);if(existing)return existing;
    const win=BrowserWindow.fromWebContents(wc);
    if(!win || !deps.desktop(wc))throw new Error('Unauthorized dictation owner');
    const host=new ChatGPTDictationHost(win);
    const owner:DictationOwner={host,coordinator:new DictationCoordinator(host,async result=>{
      if(wc.isDestroyed() || !deps.owns(result.surfaceId,wc) || deps.pid(result.surfaceId as SurfaceId)!==owner.targetPid)return false;
      try {
        return await wc.executeJavaScript(`window.__wmux_deliverDictation?.(${JSON.stringify(result)}) === true`)===true;
      } catch{return false;}
    },state=>{if(!wc.isDestroyed())wc.send(IPC_CHANNELS.DICTATION_STATE,state);})};
    owner.coordinator.setDevice(deviceId);owners.set(wc.id,owner);
    wc.once('destroyed',()=>dispose(wc.id));win.once('closed',()=>dispose(wc.id));
    return owner;
  };
  // Re-check the account when the user comes back from the sign-in window.
  // Armed only by an explicit 'account' action: a refresh loads chatgpt.com,
  // which must never happen on an ordinary window focus.
  const watchSignIn=(wc:WebContents,owner:DictationOwner)=>{
    if(owner.watchingSignIn)return;
    const win=BrowserWindow.fromWebContents(wc);
    if(!win)return;
    owner.watchingSignIn=true;
    const refreshAccount=()=>{void owner.coordinator.refresh();};
    win.on('focus',refreshAccount);
    wc.once('destroyed',()=>win.removeListener('focus',refreshAccount));
  };
  ipcMain.handle(IPC_CHANNELS.DICTATION_COMMAND,async(event,raw:unknown)=>{
    if(!deps.desktop(event.sender) || event.senderFrame!==event.sender.mainFrame)throw new Error('Unauthorized dictation owner');
    if(!raw || typeof raw!=='object' || !('action' in raw) || typeof raw.action!=='string')throw new Error('Invalid dictation command');
    const command=raw as DictationCommand;
    const owner=getOwner(event.sender);const {coordinator,host}=owner;
    try {
      switch(command.action){
        case 'state':return coordinator.getState();
        case 'refresh':await coordinator.refresh();break;
        case 'account':host.show();watchSignIn(event.sender,owner);await coordinator.refresh();break;
        case 'devices':
          if(!['idle','error'].includes(coordinator.getState().phase))return [];
          return await host.devices();
        case 'device':
          if(typeof command.deviceId!=='string'||command.deviceId.length>1024)throw new Error('microphone-unavailable');
          if(!['idle','error'].includes(coordinator.getState().phase))break;
          deviceId=command.deviceId;saveSetting('wmux-voice-device',deviceId);
          for(const other of owners.values())other.coordinator.setDevice(deviceId);
          break;
        case 'start':
          if(typeof command.surfaceId!=='string'||typeof command.binding!=='string'||command.binding.length>100||!deps.owns(command.surfaceId,event.sender)) {
            return {...coordinator.getState(),phase:'error',error:'no-terminal'} satisfies DictationState;
          }
          if(!['idle','error'].includes(coordinator.getState().phase))break;
          owner.surfaceId=command.surfaceId;owner.targetPid=deps.pid(command.surfaceId as SurfaceId);
          await coordinator.start(command.surfaceId,deviceId,command.binding);break;
        case 'stop':await coordinator.stop();break;
        case 'cancel':await coordinator.cancel();break;
        default:throw new Error('Invalid dictation command');
      }
      return coordinator.getState();
    }catch(error){return {...coordinator.getState(),phase:'error',error:dictationError(error)} satisfies DictationState;}
  });
}
