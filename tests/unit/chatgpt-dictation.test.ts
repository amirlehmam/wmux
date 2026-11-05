import { describe, it, expect, vi } from 'vitest';
import { DictationCoordinator } from '../../src/main/chatgpt-dictation';

function setup(account = 'signed-in') {
  const page = { inspect: vi.fn(async () => ({ account })), start: vi.fn(async () => {}), finish: vi.fn(async () => 'Olá mundo'), cancel: vi.fn(async () => {}) };
  const deliver = vi.fn(async () => true);
  const session = new DictationCoordinator(page, deliver, () => {});
  return { session, page, deliver };
}
describe('DictationCoordinator', () => {
  it('requires a connected account before starting microphone capture', async () => {
    const {session,page} = setup('signed-out');
    await session.start('surf-a', 'default');
    expect(page.start).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({phase:'error',error:'login-required'});
  });
  it('clears obsolete login guidance after a successful account recheck',async()=>{
    const {session,page}=setup('signed-out');
    await session.start('surf-a','default');
    page.inspect.mockResolvedValue({account:'signed-in'});
    await session.refresh();
    expect(session.getState()).toMatchObject({phase:'idle',account:'signed-in',error:undefined});
  });
  it('delivers exactly once to the original target on Stop', async () => {
    const {session,deliver} = setup();
    await session.start('surf-a', 'default');
    await Promise.all([session.stop(), session.stop()]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({surfaceId:'surf-a',text:'Olá mundo'});
  });
  it('discards late results after cancellation', async () => {
    const {session,page,deliver} = setup();
    let resolve!: (text: string) => void;
    page.finish.mockImplementation(() => new Promise(r=>{resolve=r;}));
    await session.start('surf-a', 'default');
    const stopping = session.stop();
    await session.cancel();
    resolve('late'); await stopping;
    expect(deliver).not.toHaveBeenCalled();
  });
  it('retains text for recovery if the target was destroyed', async () => {
    const {session,deliver} = setup(); deliver.mockResolvedValue(false);
    await session.start('surf-a', 'default'); await session.stop();
    expect(session.getState()).toMatchObject({phase:'error',error:'target-closed',transcript:'Olá mundo'});
  });
  it('does not restart recording while an earlier start is pending', async () => {
    const {session,page} = setup();
    let resolve!: () => void;
    page.start.mockImplementation(() => new Promise(r=>{resolve=r;}));
    const first = session.start('surf-a','default');
    await Promise.resolve(); await Promise.resolve();
    await session.start('surf-b','default');
    resolve(); await first;
    expect(page.start).toHaveBeenCalledTimes(1);
    expect(session.getState().surfaceId).toBe('surf-a');
  });
  it('does not let obsolete error cleanup overwrite a later recording',async()=>{
    const {session,page}=setup();
    let cleanup!:()=>void;
    page.start.mockRejectedValueOnce(new Error('microphone-unavailable'));
    page.cancel.mockImplementationOnce(()=>new Promise(r=>{cleanup=r;}));
    const first=session.start('surf-a','default');
    for(let i=0;i<6;i++)await Promise.resolve();
    await session.cancel();
    await session.start('surf-b','default');
    cleanup();await first;
    expect(session.getState()).toMatchObject({phase:'recording',surfaceId:'surf-b'});
  });
});
