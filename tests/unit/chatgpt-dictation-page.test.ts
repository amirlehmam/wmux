// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runChatGPTPageCommand } from '../../src/main/chatgpt-dictation-page';

const page = (extra = '', signedIn = true) => {
  document.body.innerHTML = `${signedIn ? '<button aria-label="Selecionar modelo do ChatGPT"></button>' : '<button>Entrar</button>'}<form><div role="textbox" contenteditable="true"></div><button type="button" aria-label="Ditar"></button><button type="submit" aria-label="Enviar"></button>${extra}</form>`;
};
beforeEach(() => { page(); delete (window as any).__wmuxDictationCapture; });
describe('ChatGPT page adapter', () => {
  it('blocks dictation before any recording when signed out', async () => {
    page('', false);
    expect(await runChatGPTPageCommand({ action: 'inspect' })).toMatchObject({ account: 'signed-out' });
    await expect(runChatGPTPageCommand({ action: 'start' })).rejects.toThrow('login-required');
  });
  it('does not infer login merely from an existing microphone', async () => {
    document.querySelector('button')!.remove();
    expect(await runChatGPTPageCommand({ action: 'inspect' })).toMatchObject({ account: 'unknown' });
    await expect(runChatGPTPageCommand({ action: 'start' })).rejects.toThrow('login-required');
  });
  it('ignores login controls hidden by a responsive ancestor', async () => {
    document.body.insertAdjacentHTML('beforeend','<div style="display:none"><button>Entrar</button></div>');
    expect(await runChatGPTPageCommand({action:'inspect'})).toMatchObject({account:'signed-in'});
  });
  it('requires restored dictation and enabled Send controls to confirm completion', async () => {
    const send=document.querySelector<HTMLButtonElement>('[aria-label=Enviar]')!;
    send.disabled=true;
    document.querySelector('[role=textbox]')!.textContent='intermediate';
    expect(await runChatGPTPageCommand({action:'read'})).toMatchObject({completed:false});
    send.disabled=false;
    expect(await runChatGPTPageCommand({action:'read'})).toMatchObject({completed:true});
    await expect(runChatGPTPageCommand({action:'clear',text:'different'})).rejects.toThrow('page-changed');
    expect(document.querySelector('[role=textbox]')!.textContent).toBe('intermediate');
  });
  it('rejects an existing draft instead of replacing it', async () => {
    document.querySelector('[role=textbox]')!.textContent = 'Existing draft';
    await expect(runChatGPTPageCommand({ action: 'start' })).rejects.toThrow('draft-not-empty');
  });
  it('uses the observed Portuguese Stop control, never Send', async () => {
    page('<button type="button" aria-label="Interromper ditado"></button><button type="button" aria-label="Cancelar ditado"></button>');
    let stopped = 0;
    let sent = 0;
    document.querySelector('[aria-label="Interromper ditado"]')!.addEventListener('click', () => { stopped++; });
    document.querySelector('[aria-label=Enviar]')!.addEventListener('click', e => { e.preventDefault(); sent++; });
    await runChatGPTPageCommand({ action: 'stop' });
    expect(stopped).toBe(1); expect(sent).toBe(0);
  });
  it('rejects ambiguous controls', async () => {
    page('<button type="button" aria-label="Interromper ditado"></button><button type="button" aria-label="Interromper ditado"></button>');
    await expect(runChatGPTPageCommand({ action: 'stop' })).rejects.toThrow('page-changed');
  });
  it('reports expired login rather than returning an old composer', async () => {
    page('', false);
    document.querySelector('[role=textbox]')!.textContent = 'stale';
    await expect(runChatGPTPageCommand({ action: 'read' })).rejects.toThrow('login-required');
  });
  it('keeps the verified session while the recording dialog hides account and composer controls',async()=>{
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn()}});
    await runChatGPTPageCommand({action:'start'});
    document.querySelector<HTMLButtonElement>('[aria-label="Selecionar modelo do ChatGPT"]')!.hidden=true;
    document.querySelector('form')!.hidden=true;
    document.body.insertAdjacentHTML('beforeend','<div role="dialog"><button type="button" aria-label="Interromper ditado"></button><button type="button" aria-label="Cancelar ditado"></button></div>');
    expect(await runChatGPTPageCommand({action:'inspect'})).toMatchObject({account:'unknown'});
    await expect(runChatGPTPageCommand({action:'read'})).resolves.toMatchObject({recording:true,completed:false,text:''});
    let stopped=false;
    document.querySelector('[aria-label="Interromper ditado"]')!.addEventListener('click',()=>{stopped=true;});
    await runChatGPTPageCommand({action:'stop'});expect(stopped).toBe(true);
    document.querySelector('[role=dialog]')!.remove();
    await expect(runChatGPTPageCommand({action:'read'})).resolves.toMatchObject({recording:false,completed:false});
    document.body.insertAdjacentHTML('beforeend','<button>Entrar</button>');
    await expect(runChatGPTPageCommand({action:'read'})).rejects.toThrow('login-required');
  });
  it('uses the selected microphone and releases it on cancellation', async () => {
    const stop=vi.fn();
    const track={getSettings:()=>({deviceId:'selected'}),addEventListener:vi.fn(),stop,readyState:'live'};
    const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
    const native=vi.fn(async()=>stream);
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:native}});
    await runChatGPTPageCommand({action:'start',deviceId:'selected'});
    await navigator.mediaDevices.getUserMedia({audio:true});
    expect(native).toHaveBeenCalledWith({audio:{deviceId:{exact:'selected'}},video:false});
    await runChatGPTPageCommand({action:'cancel'});
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('refreshes the website permission status before clicking Dictate',async()=>{
    const query=vi.fn(async()=>({state:'granted'}));
    Object.defineProperty(navigator,'permissions',{configurable:true,value:{query}});
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn()}});
    let queriedBeforeClick=false;
    document.querySelector('[aria-label=Ditar]')!.addEventListener('click',()=>{queriedBeforeClick=query.mock.calls.length===1;});
    await runChatGPTPageCommand({action:'start'});
    expect(query).toHaveBeenCalledWith({name:'microphone'});
    expect(queriedBeforeClick).toBe(true);
    Object.defineProperty(navigator,'permissions',{configurable:true,value:undefined});
  });
  it('does not let a cancelled pending capture poison the next recording', async () => {
    let resolve!:(s:unknown)=>void;
    const stop=vi.fn();
    const track={getSettings:()=>({}),addEventListener:vi.fn(),stop,readyState:'live'};
    const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
    const native=vi.fn(()=>new Promise(r=>{resolve=r;}));
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:native}});
    await runChatGPTPageCommand({action:'start'});
    const old=navigator.mediaDevices.getUserMedia({audio:true}).catch(()=>{});
    await runChatGPTPageCommand({action:'cancel'});
    await runChatGPTPageCommand({action:'start'});
    resolve(stream);await old;
    expect(stop).toHaveBeenCalled();
    await expect(runChatGPTPageCommand({action:'read'})).resolves.toMatchObject({capturing:false});
  });
});
