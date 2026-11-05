import { safeDictationText, type DictationResult } from '../../shared/dictation';

/** Live emulator identity, not focus, grants delivery. paste() is synchronous. */
export class DictationDelivery {
  private targets=new Map<string,{binding:string;paste:(text:string)=>void;alive:()=>boolean}>();
  private delivered=new Set<string>();
  private targeted=new Set<string>();
  register(surfaceId:string,binding:string,paste:(text:string)=>void,alive:()=>boolean):()=>void {
    const target={binding,paste,alive}; this.targets.set(surfaceId,target);
    return ()=>{if(this.targets.get(surfaceId)===target)this.targets.delete(surfaceId);};
  }
  binding(surfaceId:string):string|undefined {const t=this.targets.get(surfaceId);return t?.alive()?t.binding:undefined;}
  isTargeted(surfaceId:string):boolean {return this.targeted.has(surfaceId);}
  deliver(result:DictationResult):boolean {
    if(this.delivered.has(result.id))return true;
    const target=this.targets.get(result.surfaceId);
    if(!target || target.binding!==result.binding || !target.alive())return false;
    let text:string;
    try{text=safeDictationText(result.text);}catch{return false;}
    this.targeted.add(result.surfaceId);
    try {
      target.paste(`${text} `);
      this.delivered.add(result.id);
      if(this.delivered.size>512)this.delivered.delete(this.delivered.values().next().value!);
      return true;
    } finally {this.targeted.delete(result.surfaceId);}
  }
}
export const dictationDelivery=new DictationDelivery();
