// Owns a dedicated browser profile and an unprivileged account window. Its
// WebContentsView never receives wmux's preload, cookies from other browsers,
// a terminal-write bridge or API credentials. Only fixed DOM commands run here.
import { BaseWindow, BrowserWindow, WebContentsView, session, type Session, type WebContents } from 'electron';
import { runChatGPTPageCommand, type ChatGPTPageCommand, type ChatGPTPageResult } from './chatgpt-dictation-page';
import type { DictationPage } from './chatgpt-dictation';

const PARTITION = 'persist:wmux-chatgpt-dictation';
const captureOwners = new Map<number,symbol>();
const releaseCapture = (id:number, token:symbol) => {
  if(captureOwners.get(id)===token)captureOwners.delete(id);
};
let permissionsInstalled = false;
let dedicatedProfile: Session | undefined;
export function isChatGPTDictationContents(contents:WebContents):boolean {
  return !!dedicatedProfile && contents.session===dedicatedProfile;
}
const chatGPT = (url: string): boolean => { try { return new URL(url).origin === 'https://chatgpt.com'; } catch { return false; } };
const pause = (ms: number) => new Promise<void>(resolve=>setTimeout(resolve,ms));

function dictationSession() {
  const profile = session.fromPartition(PARTITION);
  dedicatedProfile=profile;
  if (!permissionsInstalled) {
    permissionsInstalled = true;
    profile.setPermissionCheckHandler((wc,permission,origin,details) => !!wc && permission==='media'
      && captureOwners.has(wc.id) && chatGPT(origin) && chatGPT(wc.getURL()) && details.mediaType==='audio');
    profile.setPermissionRequestHandler((wc,permission,callback,details) => {
      callback(permission==='media' && captureOwners.has(wc.id) && chatGPT(wc.getURL())
        && chatGPT(details.requestingUrl) && details.isMainFrame
        && 'mediaTypes' in details && details.mediaTypes?.length===1 && details.mediaTypes[0]==='audio');
    });
  }
  return profile;
}

export class ChatGPTDictationHost implements DictationPage {
  private accountWindow?: BaseWindow;
  private view?: WebContentsView;
  private loading?: Promise<void>;
  private generation = 0;
  private disposed = false;
  constructor(private owner: BrowserWindow) {}
  private ensure(): WebContents {
    if (this.disposed) throw new Error('cancelled');
    if (this.view && !this.view.webContents.isDestroyed()) return this.view.webContents;
    const win = new BaseWindow({width:980,height:760,minWidth:640,minHeight:500,show:false,parent:this.owner,title:'ChatGPT — wmux Voice'});
    const view = new WebContentsView({webPreferences:{session:dictationSession(),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,autoplayPolicy:'document-user-activation-required'}});
    this.accountWindow=win; this.view=view;
    win.contentView.addChildView(view);
    const resize = () => { const [width,height]=win.getContentSize(); view.setBounds({x:0,y:0,width,height}); };
    resize(); win.on('resize',resize);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({url}) => {
      // Authentication popups retain their opener, but never gain a preload.
      if (!/^https:\/\//i.test(url)) return {action:'deny'};
      return {action:'allow',overrideBrowserWindowOptions:{parent:this.owner,autoHideMenuBar:true,webPreferences:{session:dictationSession(),nodeIntegration:false,contextIsolation:true,sandbox:true}}};
    });
    wc.on('will-navigate',(_event,url)=>{ if(!chatGPT(url)) { this.generation++; captureOwners.delete(wc.id); } });
    wc.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{
      if(!isMainFrame || !captureOwners.has(wc.id))return;
      ++this.generation;captureOwners.delete(wc.id);
      // Also catches same-origin SPA routes. Never read a different draft.
      void this.run({action:'cancel'},true).catch(()=>this.destroyView());
    });
    wc.on('render-process-gone',()=>{this.generation++;captureOwners.delete(wc.id);});
    // Closing account setup hides it; closing the owning wmux window destroys
    // both the view and any recording, including pending microphone requests.
    win.on('close',event=>{if(!this.disposed){event.preventDefault();win.hide();}});
    win.on('closed',()=>{captureOwners.delete(wc.id); if(!wc.isDestroyed())wc.close();});
    this.loading = wc.loadURL('https://chatgpt.com/').catch(()=>{throw new Error('page-changed');});
    return wc;
  }
  private async run(command: ChatGPTPageCommand, userGesture = false): Promise<ChatGPTPageResult> {
    const wc=this.ensure(); await this.loading;
    if(wc.isDestroyed() || !chatGPT(wc.getURL())) throw new Error('login-required');
    try {
      return await wc.executeJavaScript(`(${runChatGPTPageCommand.toString()})(${JSON.stringify(command)})`,userGesture);
    } catch(error) {
      const message=error instanceof Error ? error.message : '';
      const code=['login-required','page-changed','draft-not-empty','microphone-unavailable','transcription-failed'].find(x=>message.includes(x));
      throw new Error(code || 'page-changed', {cause:error});
    }
  }
  async inspect(): Promise<{account:string}> {
    const generation=this.generation;
    // Account hydration is async. Never interpret absence of a login button
    // alone as proof of authentication.
    const deadline=Date.now()+12000;
    do {
      const result=await this.run({action:'inspect'});
      if(generation!==this.generation) throw new Error('cancelled');
      if(result.account!=='unknown')return {account:result.account!};
      await pause(250);
    } while(Date.now()<deadline);
    return {account:'unknown'};
  }
  show(): void { this.ensure(); this.accountWindow!.show(); this.accountWindow!.focus(); }
  async devices(): Promise<{id:string;label:string}[]> {
    const wc=this.ensure();
    if((await this.inspect()).account!=='signed-in')throw new Error('login-required');
    const token=Symbol();captureOwners.set(wc.id,token);
    try { return (await this.run({action:'devices'},true)).devices ?? []; }
    finally {releaseCapture(wc.id,token);}
  }
  async start(deviceId: string): Promise<void> {
    const wc=this.ensure(); const generation=++this.generation;
    const token=Symbol();captureOwners.set(wc.id,token);
    try {
      await this.run({action:'start',deviceId},true);
      const deadline=Date.now()+12000;
      do {
        if(generation!==this.generation)throw new Error('cancelled');
        const state=await this.run({action:'read'});
        if(generation!==this.generation)throw new Error('cancelled');
        if(state.recording && state.capturing)return;
        await pause(150);
      } while(Date.now()<deadline);
      throw new Error('microphone-unavailable');
    } catch(error) {releaseCapture(wc.id,token);throw error;}
  }
  async finish(): Promise<string> {
    const generation=this.generation;
    await this.run({action:'stop'},true);
    const deadline=Date.now()+90000;
    let last=''; let stable=0;
    do {
      if(generation!==this.generation)throw new Error('cancelled');
      const result=await this.run({action:'read'});
      if(generation!==this.generation)throw new Error('cancelled');
      if(result.completed && !result.recording && result.text?.trim()) {
        stable=result.text===last ? stable+1 : 0; last=result.text;
        if(stable>=2){
          await this.run({action:'clear',text:last});
          if(generation!==this.generation)throw new Error('cancelled');
          captureOwners.delete(this.view!.webContents.id); return last;
        }
      } else { stable=0; }
      await pause(250);
    } while(Date.now()<deadline);
    throw new Error('timeout');
  }
  async cancel(): Promise<void> {
    ++this.generation;
    const wc=this.view?.webContents;
    if(!wc || wc.isDestroyed())return;
    captureOwners.delete(wc.id);
    try { await this.run({action:'cancel'},true); }
    catch { this.destroyView(); }
  }
  private destroyView(): void {
    const wc=this.view?.webContents;
    if(wc && !wc.isDestroyed()){captureOwners.delete(wc.id);wc.close();}
    this.view=undefined;
    const win=this.accountWindow; this.accountWindow=undefined;
    if(win && !win.isDestroyed())win.destroy();
    this.loading=undefined;
  }
  dispose(): void { this.disposed=true; ++this.generation;this.destroyView(); }
}
