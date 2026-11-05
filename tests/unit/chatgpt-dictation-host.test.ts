import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({wc:undefined as any,read:undefined as any,cleared:0,check:undefined as any}));
vi.mock('electron',()=>({
  session:{fromPartition:()=>({setPermissionCheckHandler:(fn:unknown)=>{mocks.check=fn;},setPermissionRequestHandler:vi.fn()})},
  BaseWindow:class extends EventEmitter {
    contentView={addChildView:vi.fn()};getContentSize(){return [980,760];}isDestroyed(){return false;}
    show(){}focus(){}hide(){}destroy(){this.emit('closed');}
  },
  WebContentsView:class {
    webContents=mocks.wc;setBounds(){}
  },
}));
import { ChatGPTDictationHost } from '../../src/main/chatgpt-dictation-host';

let host:ChatGPTDictationHost;
beforeEach(()=>{
  vi.useFakeTimers();mocks.cleared=0;
  mocks.read=vi.fn(async()=>({recording:true,capturing:true}));
  mocks.wc=Object.assign(new EventEmitter(),{
    id:42,isDestroyed:()=>false,getURL:()=> 'https://chatgpt.com/',loadURL:async()=>{},
    setWindowOpenHandler:vi.fn(),close:vi.fn(),
    executeJavaScript:vi.fn(async(source:string)=>{
      const command=JSON.parse(source.slice(source.lastIndexOf(')(')+2,-1));
      if(command.action==='inspect')return {account:'signed-in'};
      if(command.action==='read')return mocks.read();
      if(command.action==='clear')mocks.cleared++;
      return {};
    }),
  });
  host=new ChatGPTDictationHost({} as any);
});
afterEach(()=>{host.dispose();vi.useRealTimers();});

describe('owned ChatGPT page lifetime',()=>{
  it('does not revoke a newer recording when an obsolete start resumes',async()=>{
    let resolve!:(s:unknown)=>void;
    mocks.read=vi.fn(()=>new Promise(r=>{resolve=r;}));
    const old=host.start('default').catch(e=>e.message);
    await vi.advanceTimersByTimeAsync(0);
    await host.cancel();
    mocks.read=vi.fn(async()=>({recording:true,capturing:true}));
    await host.start('default');
    resolve({recording:true,capturing:true});
    expect(await old).toBe('cancelled');
    expect(mocks.check(mocks.wc,'media','https://chatgpt.com',{mediaType:'audio'})).toBe(true);
  });
  it('rejects same-origin navigation during processing without clearing another draft',async()=>{
    await host.start('default');
    mocks.read=vi.fn(async()=>({recording:false,text:'another draft',completed:true}));
    const pending=host.finish();const rejected=expect(pending).rejects.toThrow('cancelled');
    await Promise.resolve();
    mocks.wc.emit('did-start-navigation',{},'https://chatgpt.com/c/other',true,true);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;expect(mocks.cleared).toBe(0);
  });
  it('waits for confirmed completion while intermediate text is stable',async()=>{
    await host.start('default');
    let completed=false;
    mocks.read=vi.fn(async()=>({recording:false,text:completed?'final text':'intermediate',completed}));
    let result:string|undefined;
    const pending=host.finish().then(text=>{result=text;});
    await vi.advanceTimersByTimeAsync(1200);
    expect(result).toBeUndefined();expect(mocks.cleared).toBe(0);
    completed=true;await vi.advanceTimersByTimeAsync(1000);await pending;
    expect(result).toBe('final text');expect(mocks.cleared).toBe(1);
  });
});
