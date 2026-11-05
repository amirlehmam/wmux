// A recording belongs to the terminal captured at Start, never to later focus.
// The page owns capture; cancel must also release pending getUserMedia streams.
import { randomUUID } from 'crypto';
import { dictationError, safeDictationText, type DictationAccount, type DictationResult, type DictationState } from '../shared/dictation';

export interface DictationPage {
  inspect(): Promise<{ account: string }>;
  start(deviceId: string): Promise<void>;
  finish(): Promise<string>;
  cancel(): Promise<void>;
}
export class DictationCoordinator {
  private state: DictationState = { phase: 'idle', account: 'unknown', deviceId: 'default' };
  private generation = 0;
  private binding = '';
  constructor(private page: DictationPage, private deliver: (result: DictationResult) => Promise<boolean>, private changed: (state: DictationState) => void) {}
  getState(): DictationState { return { ...this.state }; }
  private set(patch: Partial<DictationState>): void { this.state = { ...this.state, ...patch }; this.changed(this.getState()); }
  setDevice(deviceId: string): void { if (!this.busy()) this.set({ deviceId }); }
  private busy(): boolean { return !['idle','error'].includes(this.state.phase); }
  async refresh(): Promise<void> {
    if (this.busy()) return;
    const generation=this.generation;
    try {
      const s = await this.page.inspect();
      if(generation!==this.generation)return;
      this.set({account:s.account as DictationAccount,
        ...(s.account==='signed-in' && this.state.error==='login-required' ? {phase:'idle',error:undefined} : {}),
      });
    } catch { if(generation===this.generation)this.set({account:'unknown'}); }
  }
  async start(surfaceId: string, deviceId: string, binding = ''): Promise<void> {
    if (this.busy()) return;
    const generation = ++this.generation;
    this.binding = binding;
    this.set({ phase:'starting', surfaceId, deviceId, error:undefined, transcript:undefined });
    try {
      const inspected = await this.page.inspect();
      if (generation !== this.generation) return;
      this.set({account:inspected.account as DictationAccount});
      if (inspected.account !== 'signed-in') throw new Error('login-required');
      await this.page.start(deviceId);
      if (generation === this.generation) this.set({phase:'recording'});
    } catch (error) { if (generation === this.generation) await this.fail(error,generation); }
  }
  async stop(): Promise<void> {
    if (this.state.phase !== 'recording') return;
    const generation = this.generation;
    const target = { surfaceId: this.state.surfaceId!, binding: this.binding };
    this.set({phase:'processing'});
    try {
      const text = safeDictationText(await this.page.finish());
      if (generation !== this.generation) return;
      const delivered=await this.deliver({id:randomUUID(), ...target, text});
      if (generation !== this.generation) return;
      if (!delivered) {
        this.set({phase:'error',error:'target-closed',transcript:text}); return;
      }
      if (generation === this.generation) this.set({phase:'idle',error:undefined});
    } catch (error) { if (generation === this.generation) await this.fail(error,generation); }
  }
  async cancel(): Promise<void> {
    const generation=++this.generation;
    this.set({phase:'cancelling',transcript:undefined});
    try { await this.page.cancel(); } finally { if(generation===this.generation)this.set({phase:'idle',error:undefined}); }
  }
  private async fail(error: unknown, generation:number): Promise<void> {
    const code = dictationError(error);
    try { await this.page.cancel(); } catch { /* host destroys the guest on cancellation failure */ }
    if(generation!==this.generation)return;
    this.set({phase:'error', error:code, ...(code === 'login-required' ? {account:'signed-out' as const} : {})});
  }
  dispose(): void { ++this.generation; void this.page.cancel().catch(() => {}); }
}
