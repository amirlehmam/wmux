import { describe,it,expect,vi } from 'vitest';
import { DictationDelivery } from '../../src/renderer/utils/dictation-delivery';
describe('targeted dictation delivery',()=>{
  it('appends successive segments through the same live terminal, exactly once',()=>{
    const d=new DictationDelivery();const paste=vi.fn();
    d.register('surf-a','binding-a',paste,()=>true);
    expect(d.deliver({id:'1',surfaceId:'surf-a',binding:'binding-a',text:'Olá.'})).toBe(true);
    d.deliver({id:'1',surfaceId:'surf-a',binding:'binding-a',text:'Olá.'});
    d.deliver({id:'2',surfaceId:'surf-a',binding:'binding-a',text:'Segundo.'});
    expect(paste.mock.calls.map(c=>c[0]).join('')).toBe('Olá. Segundo. ');
  });
  it('does not deliver to a replacement or an exited terminal',()=>{
    const d=new DictationDelivery();const paste=vi.fn();
    d.register('surf-a','new',paste,()=>true);
    expect(d.deliver({id:'1',surfaceId:'surf-a',binding:'old',text:'test'})).toBe(false);
    d.register('surf-a','new',paste,()=>false);
    expect(d.deliver({id:'2',surfaceId:'surf-a',binding:'new',text:'test'})).toBe(false);
    expect(paste).not.toHaveBeenCalled();
  });
  it('suppresses broadcast only during targeted paste',()=>{
    const d=new DictationDelivery();
    d.register('surf-a','a',()=>{expect(d.isTargeted('surf-a')).toBe(true);expect(d.isTargeted('surf-b')).toBe(false);},()=>true);
    d.deliver({id:'1',surfaceId:'surf-a',binding:'a',text:'test'});
    expect(d.isTargeted('surf-a')).toBe(false);
  });
  it('flattens newlines and rejects terminal control sequences',()=>{
    const d=new DictationDelivery();const paste=vi.fn();d.register('surf-a','a',paste,()=>true);
    expect(d.deliver({id:'1',surfaceId:'surf-a',binding:'a',text:'one\r\ntwo'})).toBe(true);
    expect(paste).toHaveBeenCalledWith('one two ');
    expect(d.deliver({id:'2',surfaceId:'surf-a',binding:'a',text:'\x1b[201~exit\r'})).toBe(false);
    expect(paste).toHaveBeenCalledTimes(1);
  });
});
