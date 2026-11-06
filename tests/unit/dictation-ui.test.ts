// @vitest-environment jsdom
import { describe,it,expect,vi,afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import DictationButton from '../../src/renderer/components/Titlebar/DictationButton';
import { useStore } from '../../src/renderer/store';

(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
vi.mock('../../src/renderer/i18n',()=>({useT:()=> (_key:string,fallback?:string)=>fallback||_key}));
vi.mock('../../src/renderer/utils/dictation-delivery',()=>({dictationDelivery:{binding:()=> 'live-binding'}}));
let phase='idle';
let error:string|undefined;
const command=vi.fn(async()=>({phase,account:'signed-out',deviceId:'default',error}));
vi.mock('../../src/renderer/hooks/useDictation',()=>({useDictation:()=>({state:{phase,account:'signed-out',deviceId:'default',error},command})}));
let root:Root|undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.innerHTML='';phase='idle';error=undefined;command.mockClear();});
async function mount(){const div=document.createElement('div');document.body.append(div);root=createRoot(div);await act(async()=>root!.render(React.createElement(DictationButton,{surfaceId:'surf-test'})));return div;}
describe('dictation titlebar',()=>{
  it('shows the configured shortcut in the tooltip and follows rebinding',async()=>{
    const original=useStore.getState().shortcuts;
    try{
      const div=await mount();
      expect(div.querySelector('button')!.title).toBe('Start dictation');
      await act(async()=>useStore.setState({shortcuts:{...original,toggleDictation:{key:'F8'}}}));
      expect(div.querySelector('button')!.title).toBe('Start dictation (F8)');
      await act(async()=>useStore.setState({shortcuts:{...original,toggleDictation:{key:''}}}));
      expect(div.querySelector('button')!.title).toBe('Start dictation');
    }finally{await act(async()=>useStore.setState({shortcuts:original}));}
  });
  it('places the single global control immediately before Keep Computer Awake',()=>{
    const src=readFileSync(join(__dirname,'../../src/renderer/components/Titlebar/Titlebar.tsx'),'utf8');
    expect(src).toMatch(/<DictationButton[^>]*\/>\}\s*<KeepAwakeMenu/);
  });
  it('renders the titlebar control only once dictation is enabled',()=>{
    const src=readFileSync(join(__dirname,'../../src/renderer/components/Titlebar/Titlebar.tsx'),'utf8');
    expect(src).toMatch(/\{dictationEnabled && <DictationButton/);
  });
  it('starts with the captured terminal binding',async()=>{
    const div=await mount();await act(async()=>div.querySelector('button')!.click());
    expect(command).toHaveBeenCalledWith({action:'start',surfaceId:'surf-test',binding:'live-binding'});
  });
  it('shows Stop while recording and stops only on the explicit click',async()=>{
    phase='recording';const div=await mount();
    expect(div.querySelector('button')!.getAttribute('aria-label')).toBe('Stop dictation');
    expect(div.querySelector('.dictation-panel')).toBeNull();
    await act(async()=>div.querySelector('button')!.click());expect(command).toHaveBeenCalledWith({action:'stop'});
  });
  it('shows login guidance on the first signed-out attempt',async()=>{
    error='login-required';phase='error';const div=await mount();
    expect(div.textContent).toContain('Sign in to ChatGPT');
    expect(div.textContent).toContain('before using dictation');
  });
  it('shows only a clickable cancel icon and animated dots while processing',async()=>{
    phase='processing';const div=await mount();
    const button=div.querySelector('button')!;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Cancel dictation');
    expect(div.querySelector('.dictation-panel')).toBeNull();
    expect(div.querySelectorAll('.dictation-dots > span')).toHaveLength(3);
    await act(async()=>button.click());
    expect(command).toHaveBeenCalledWith({action:'cancel'});
  });
  it('prevents another cancellation while already cancelling',async()=>{
    phase='cancelling';const div=await mount();
    expect(div.querySelector('button')!.disabled).toBe(true);
    expect(div.querySelector('.dictation-panel')).toBeNull();
  });
});
