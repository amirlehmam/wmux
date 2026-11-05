// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KeyboardSettings from '../../src/renderer/components/Settings/KeyboardSettings';
import { useKeyboardShortcuts } from '../../src/renderer/hooks/useKeyboardShortcuts';
import { useStore } from '../../src/renderer/store';
import { DEFAULT_SHORTCUTS } from '../../src/renderer/store/settings-slice';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;let host:HTMLDivElement;let persist:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  persist=vi.fn();Object.defineProperty(window,'wmux',{configurable:true,value:{settings:{set:persist}}});
  useStore.setState({language:'en',shortcuts:{...DEFAULT_SHORTCUTS}});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();Reflect.deleteProperty(window,'wmux');localStorage.clear();vi.clearAllMocks();});

describe('dictation shortcut configuration',()=>{
  it('uses an available default for press-to-start and press-to-stop',()=>{
    expect(DEFAULT_SHORTCUTS.toggleDictation).toEqual({key:'s',ctrl:true,shift:true});
    const same=Object.entries(DEFAULT_SHORTCUTS).filter(([,b])=>b.key.toLowerCase()==='s'&&b.ctrl&&b.shift&&!b.alt);
    expect(same.map(([action])=>action)).toEqual(['toggleDictation']);
  });
  it('records a custom dictation shortcut in Shortcuts and persists it',()=>{
    act(()=>root.render(createElement(KeyboardSettings)));
    const row=[...host.querySelectorAll('.shortcut-row')].find(r=>r.querySelector('.shortcut-action-label')?.textContent==='Start or stop dictation');
    const recorder=row?.querySelector<HTMLButtonElement>('.shortcut-recorder__btn');
    expect(recorder).not.toBeNull();
    act(()=>recorder!.click());
    act(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Y',ctrlKey:true,altKey:true,bubbles:true,cancelable:true})));
    expect(useStore.getState().shortcuts.toggleDictation).toMatchObject({key:'Y',ctrl:true,alt:true});
    expect(persist).toHaveBeenCalledWith('wmux-shortcuts',expect.objectContaining({toggleDictation:expect.objectContaining({key:'Y'})}));
  });
  it('dispatches once per press, without auto-repeat stopping or cancelling it',()=>{
    function Harness(){useKeyboardShortcuts(null);return null;}
    useStore.setState({shortcuts:{...DEFAULT_SHORTCUTS,toggleDictation:{key:'y',ctrl:true,alt:true}}});
    const toggle=vi.fn();document.addEventListener('wmux:dictation-toggle',toggle);
    try{
      act(()=>root.render(createElement(Harness)));
      const press=(repeat=false)=>act(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,altKey:true,repeat,bubbles:true,cancelable:true})));
      press();press(true);expect(toggle).toHaveBeenCalledTimes(1);
      press();expect(toggle).toHaveBeenCalledTimes(2);
    }finally{document.removeEventListener('wmux:dictation-toggle',toggle);}
  });
});
