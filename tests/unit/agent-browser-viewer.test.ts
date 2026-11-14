import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type WebSocket from 'ws';
import { AgentBrowserViewer, validatedViewerInput, type ViewerDeps } from '../../src/main/agent-browser-viewer';
import type { AgentViewerEvent, SurfaceId } from '../../src/shared/types';
import protocol from '../fixtures/agent-browser/viewer-protocol.json';

const ID = 'surf-viewer' as SurfaceId;
const SESSION = { surfaceId: ID, sessionName: 'wmux-surf-viewer', streamPort: 9301, dashboardUrl: 'unused' };
const ok = { ok: true, spawnFailed: false, data: { result: 'Selected 漢字' }, stdout: '', stderr: '' };

function harness(control: Pick<ViewerDeps, 'schedule' | 'resume'> = {}) {
  const sockets: Array<EventEmitter & { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }> = [];
  const run = vi.fn(async (_session: typeof SESSION, _argv: string[]) => ok);
  const events: AgentViewerEvent[] = [];
  const connect = vi.fn((_url: string) => {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), terminate: vi.fn() });
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const writeClipboard = vi.fn();
  const readClipboard = vi.fn(() => 'Pasted 漢字');
  let session: typeof SESSION | undefined = SESSION;
  const viewer = new AgentBrowserViewer({ connect, run, session: () => session,
    readClipboard, writeClipboard, ...control });
  viewer.attach(ID, 10, 'token-a', (event) => events.push(event));
  const receive = (message: unknown, index = sockets.length - 1) => sockets[index].emit('message', JSON.stringify(message));
  receive(protocol.status);
  receive(protocol.tabs);
  const present = (token = 'token-a') => {
    receive(protocol.frame);
    const frame = events.at(-1)!.message;
    if (frame.type !== 'frame') throw new Error('Expected delivered frame');
    viewer.ack(ID, 10, token, frame.id, true);
    sockets.at(-1)!.send.mockClear();
  };
  return { viewer, run, connect, readClipboard, writeClipboard, events, sockets, receive, present,
    replaceSession: () => { session = { ...SESSION }; } };
}

const key = { type: 'input_keyboard', eventType: 'char', text: '✓', windowsVirtualKeyCode: 0, modifiers: 0 };

describe('surface stream subscriptions', () => {
  it('resolves only the registered loopback endpoint and relays finite page state', () => {
    const h = harness();
    expect(h.connect).toHaveBeenCalledWith('ws://127.0.0.1:9301/?pacing=ack&maxFps=30');
    h.receive(protocol.url);
    h.receive({ type: 'result', success: false });
    h.receive({ type: 'console', text: 'not page state' });
    expect(h.events.map((event) => event.message.type)).toEqual(['status', 'tabs', 'url']);
    expect(h.events[1].message).toEqual({ type: 'tabs', tabs: [{ tabId: 't1', title: 'Fixture', url: 'https://fixture.test/', active: true }] });
  });

  it.each(['detach', 'replacement', 'teardown'])('invalidates a pending authorized attach on %s', async (mode) => {
    const h = harness();
    let authorize!: () => void;
    const pending = h.viewer.attachAuthorized(ID, 10, 'pending',
      () => new Promise<void>((resolve) => { authorize = resolve; }), () => {});
    if (mode === 'detach') h.viewer.detach(ID, 10, 'pending');
    if (mode === 'teardown') h.viewer.forget(ID);
    if (mode === 'replacement') await h.viewer.attachAuthorized(ID, 10, 'newer', async () => {}, () => {});
    const connects = h.connect.mock.calls.length;
    authorize();
    await pending;
    expect(h.connect).toHaveBeenCalledTimes(connects);
  });

  it('does not let wrong-window attach/detach invalidate the owner pending or live subscription', async () => {
    const h = harness();
    let authorize!: () => void;
    const pending = h.viewer.attachAuthorized(ID, 10, 'pending',
      () => new Promise<void>((resolve) => { authorize = resolve; }), () => {});
    await expect(h.viewer.attachAuthorized(ID, 99, 'pending', async () => { throw new Error('Unauthorized'); }, () => {})).rejects.toThrow('Unauthorized');
    h.viewer.detach(ID, 99, 'pending');
    expect(h.sockets[0].terminate).not.toHaveBeenCalled();
    authorize();
    await pending;
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.sockets[0].terminate).toHaveBeenCalledOnce();
    expect(h.sockets[1].terminate).not.toHaveBeenCalled();
  });

  it('requires a drawn current-tab frame after attach or tab change, not just connection or a drop ack', async () => {
    const h = harness();
    h.viewer.input(ID, 10, 'token-a', 1, key);
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow('frame');
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
    h.receive(protocol.frame);
    h.viewer.ack(ID, 10, 'token-a', 1, false);
    h.sockets[0].send.mockClear();
    h.viewer.input(ID, 10, 'token-a', 1, key);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.receive(protocol.frame);
    h.receive({ ...protocol.tabs, tabs: [{ ...protocol.tabs.tabs[0], tabId: 't2' }] });
    h.viewer.ack(ID, 10, 'token-a', 2, true);
    h.sockets[0].send.mockClear();
    h.viewer.input(ID, 10, 'token-a', 2, key);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.present();
    await h.viewer.input(ID, 10, 'token-a', 2, key);
    expect(JSON.parse(h.sockets[0].send.mock.calls[0][0])).toEqual(key);
  });

  it('bounds IPC to one outstanding frame and the newest pending frame', () => {
    const h = harness();
    for (let seq = 1; seq <= 100; seq++) h.receive({ ...protocol.frame, seq });
    expect(h.events.filter((event) => event.message.type === 'frame')).toHaveLength(1);
    h.viewer.ack(ID, 99, 'token-a', 1, false);
    h.viewer.ack(ID, 10, 'stale', 1, false);
    h.viewer.ack(ID, 10, 'token-a', 2, false);
    expect(h.events.filter((event) => event.message.type === 'frame')).toHaveLength(1);
    h.viewer.ack(ID, 10, 'token-a', 1, false);
    expect(h.events.filter((event) => event.message.type === 'frame').map((event) => event.message)).toEqual([
      { type: 'frame', id: 1, data: protocol.frame.data, width: 900, height: 640 },
      { type: 'frame', id: 100, data: protocol.frame.data, width: 900, height: 640 },
    ]);
    expect(h.sockets[0].send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ack', seq: 100 }));
  });

  it('isolates wrong owners, replaced tokens, and late socket callbacks', async () => {
    const h = harness();
    const late = h.sockets[0].listeners('message')[0] as (data: string) => void;
    h.viewer.input(ID, 99, 'token-a', 1, key);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.viewer.attach(ID, 10, 'token-b', (event) => h.events.push(event));
    h.receive(protocol.status);
    h.viewer.input(ID, 10, 'token-a', 0, key);
    h.viewer.detach(ID, 10, 'token-a');
    late(JSON.stringify(protocol.frame));
    expect(h.sockets[0].terminate).toHaveBeenCalledOnce();
    expect(h.events.some((event) => event.message.type === 'frame')).toBe(false);
    h.present('token-b');
    await h.viewer.input(ID, 10, 'token-b', 0, key);
    expect(JSON.parse(h.sockets[1].send.mock.calls[0][0])).toEqual(key);
    h.viewer.detach(ID, 10, 'token-b');
    expect(h.sockets[1].terminate).toHaveBeenCalledOnce();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('drops stale tab input and queued native work after agent-driven tab selection', async () => {
    const h = harness();
    h.present();
    const action = h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    h.receive({ ...protocol.tabs, tabs: [{ ...protocol.tabs.tabs[0], tabId: 't2' }] });
    h.viewer.input(ID, 10, 'token-a', 1, key);
    await expect(action).rejects.toThrow('Stale');
    expect(h.run).not.toHaveBeenCalled();
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.viewer.input(ID, 10, 'token-a', 2, key);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    h.present();
    await h.viewer.input(ID, 10, 'token-a', 2, key);
    expect(JSON.parse(h.sockets[0].send.mock.calls[0][0])).toEqual(key);
  });

  it('pauses on observed loss, with no remount/toggle bypass or session closure', async () => {
    const h = harness();
    h.receive({ ...protocol.status, connected: false });
    expect(h.viewer.canAct(ID)).toBe(false);
    expect(() => h.viewer.attach(ID, 10, 'token-b', () => {})).toThrow('unavailable');
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow();
    expect(h.run).not.toHaveBeenCalled();
    h.viewer.forget(ID);
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it('reconnects only the existing stream with a fresh token and authoritative state, without native commands or replay', async () => {
    const h = harness();
    h.present();
    const queued = h.viewer.action(ID, 10, 'token-a', 1, { type: 'reload' }).catch(() => {});
    const lateError = h.sockets[0].listeners('error')[0] as () => void;
    h.receive({ ...protocol.status, connected: false });
    await queued;
    expect(() => h.viewer.attach(ID, 10, 'remount', () => {})).toThrow('unavailable');
    await h.viewer.attachAuthorized(ID, 10, 'recovered', async () => {}, (e) => h.events.push(e), 'remount');
    lateError();
    h.receive(protocol.status);
    h.receive(protocol.tabs);
    h.receive(protocol.url);
    expect(h.viewer.canAct(ID)).toBe(true);
    expect(h.events.slice(-3).map((e) => [e.token, e.message.type])).toEqual([
      ['recovered', 'status'], ['recovered', 'tabs'], ['recovered', 'url'],
    ]);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.run).not.toHaveBeenCalled();
    await expect(h.viewer.action(ID, 10, 'remount', 1, { type: 'reload' })).rejects.toThrow();
    await expect(h.viewer.action(ID, 10, 'recovered', 1, { type: 'paste' })).rejects.toThrow('frame');
  });

  it('waits for an explicit checked resume before reconnecting the stream', async () => {
    let complete!: () => void;
    const barrier = new Promise<void>((resolve) => { complete = resolve; });
    const resume = vi.fn(async (_session, check: () => Promise<void>) => { await check(); await barrier; await check(); });
    const h = harness({ resume });
    h.viewer.pauseCommands(ID, 'Command outcome is unknown');
    const recovery = h.viewer.attachAuthorized(ID, 10, 'recovering', async () => {}, () => {}, 'token-a');
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.viewer.canAct(ID)).toBe(false);
    complete();
    await recovery;
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.viewer.canAct(ID)).toBe(true);
    expect(h.run).not.toHaveBeenCalled();
  });

  it.each(['authorization', 'detach', 'session'])('does not clear a command pause when %s changes during the resume barrier', async (change) => {
    let complete!: () => void;
    const barrier = new Promise<void>((resolve) => { complete = resolve; });
    const resume = vi.fn(async (_session, check: () => Promise<void>) => { await check(); await barrier; await check(); });
    const h = harness({ resume });
    h.viewer.pauseCommands(ID, 'Command outcome is unknown');
    let authorized = true;
    const recovery = h.viewer.attachAuthorized(ID, 10, 'recovering', async () => {
      if (!authorized) throw new Error('Unauthorized');
    }, () => {}, 'token-a');
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    if (change === 'authorization') authorized = false;
    if (change === 'detach') h.viewer.detach(ID, 10, 'recovering');
    if (change === 'session') h.replaceSession();
    complete();
    await expect(recovery).rejects.toThrow();
    expect(h.viewer.canAct(ID)).toBe(false);
    expect(h.connect).toHaveBeenCalledOnce();
  });

  it('submits native actions and stream input immediately to the shared queue in receive order', async () => {
    let release!: () => void;
    let shared = new Promise<void>((resolve) => { release = resolve; });
    const schedule = vi.fn<NonNullable<ViewerDeps['schedule']>>((_session, work) => {
      const next = shared.then(() => work(async (argv, check) => { check?.(); return h.run(SESSION, argv); }));
      shared = next.catch(() => {});
      return next;
    });
    const h = harness({ schedule });
    h.present();
    const action = h.viewer.action(ID, 10, 'token-a', 1, { type: 'reload' });
    const input = h.viewer.input(ID, 10, 'token-a', 1, key);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    release();
    await Promise.all([action, input]);
    expect(h.run).toHaveBeenCalledExactlyOnceWith(SESSION, ['reload']);
    expect(h.sockets[0].send).toHaveBeenCalledOnce();
    expect(JSON.parse(h.sockets[0].send.mock.calls[0][0])).toEqual(key);
  });

  it('rechecks page intent after asynchronous control preflight without pausing the newer view', async () => {
    let release!: () => void;
    const preflight = new Promise<void>((resolve) => { release = resolve; });
    const schedule: NonNullable<ViewerDeps['schedule']> = (_session, work) => Promise.resolve(work(async (argv, check) => {
      await preflight;
      check?.();
      return h.run(SESSION, argv);
    }));
    const h = harness({ schedule });
    h.present();
    const action = h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: false });
    release();
    await expect(action).rejects.toThrow('Stale');
    expect(h.run).not.toHaveBeenCalled();
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it.each(['unauthorized', 'detach', 'teardown', 'newer-attach'])('does not let %s recovery clear a pause or affect later subscriptions', async (mode) => {
    const h = harness();
    h.receive({ ...protocol.status, connected: false });
    let authorize!: () => void;
    const recovery = h.viewer.attachAuthorized(ID, 10, 'recovering', () => new Promise<void>((resolve, reject) => {
      authorize = () => mode === 'unauthorized' ? reject(new Error('Unauthorized')) : resolve();
    }), () => {}, 'token-a').catch((err) => err);
    if (mode === 'detach') h.viewer.detach(ID, 10, 'recovering');
    if (mode === 'teardown') {
      h.viewer.forget(ID);
      h.viewer.attach(ID, 10, 'new-session', (e) => h.events.push(e));
      h.receive({ ...protocol.status, connected: false });
    }
    if (mode === 'newer-attach') expect(() => h.viewer.attach(ID, 10, 'newer', () => {})).toThrow();
    authorize();
    await recovery;
    expect(h.viewer.canAct(ID)).toBe(false);
    expect(h.connect).toHaveBeenCalledTimes(mode === 'teardown' ? 2 : 1);
  });

  it('does not let delayed recovery clear a newly observed loss or a changed registry session', async () => {
    for (const change of ['loss', 'session']) {
      const h = harness();
      let authorize!: () => void;
      const pending = h.viewer.attachAuthorized(ID, 10, 'recovery', () => new Promise<void>((resolve) => { authorize = resolve; }), () => {}, 'token-a');
      if (change === 'session') h.replaceSession();
      h.receive({ ...protocol.status, connected: false });
      authorize();
      await expect(pending).rejects.toThrow('Stale');
      expect(h.viewer.canAct(ID)).toBe(false);
      expect(h.connect).toHaveBeenCalledOnce();
    }
  });

  it('rejects wrong-owner/stale recovery and preserves a retryable pause when connect throws', async () => {
    const h = harness();
    h.receive({ ...protocol.status, connected: false });
    const authorize = vi.fn(async () => {});
    for (const [owner, token] of [[99, 'token-a'], [10, 'stale']] as const) {
      await expect(h.viewer.attachAuthorized(ID, owner, 'new-token', authorize, () => {}, token)).rejects.toThrow('Stale');
    }
    expect(authorize).not.toHaveBeenCalled();
    h.connect.mockImplementationOnce(() => { throw new Error('socket failed'); });
    await expect(h.viewer.attachAuthorized(ID, 10, 'new-token', authorize, () => {}, 'token-a')).rejects.toThrow('socket failed');
    expect(h.viewer.canAct(ID)).toBe(false);
    await h.viewer.attachAuthorized(ID, 10, 'retry', authorize, () => {}, 'token-a');
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it('accepts only a current finite decode report and keeps it paused after detach/remount', () => {
    const h = harness();
    for (const [owner, token, revision, failure] of [[99, 'token-a', 1, 'decode'], [10, 'old', 1, 'decode'], [10, 'token-a', 0, 'decode'], [10, 'token-a', 1, 'arbitrary error']] as const) {
      h.viewer.reportFailure(ID, owner, token, revision, failure);
      expect(h.viewer.canAct(ID)).toBe(true);
    }
    h.viewer.reportFailure(ID, 10, 'token-a', 1, 'decode');
    h.viewer.detach(ID, 10, 'token-a');
    expect(() => h.viewer.attach(ID, 10, 'remount', () => {})).toThrow('decode');
    expect(h.sockets[0].listenerCount('message')).toBe(0);
    expect(h.sockets[0].listenerCount('close')).toBe(0);
    expect(h.sockets[0].terminate).toHaveBeenCalledOnce();
  });

  it('keeps a failed-restart pause gated even with an available session, without blocking ordinary Dashboard reuse', async () => {
    const h = harness();
    h.receive({ ...protocol.status, connected: false });
    expect(h.viewer.canEnable(ID)).toBe(true);
    const complete = h.viewer.pauseForRestart(ID);
    h.viewer.pauseCommands(ID, 'A late command failed');
    expect(h.viewer.canEnable(ID)).toBe(false);
    expect(h.viewer.canAct(ID)).toBe(false);
    expect(() => h.viewer.attach(ID, 10, 'remount', () => {})).toThrow('Close the previous');
    await expect(h.viewer.attachAuthorized(ID, 10, 'recovery', async () => {}, () => {}, 'remount')).rejects.toThrow('Close the previous');
    expect(h.connect).toHaveBeenCalledOnce();
    complete();
    expect(h.viewer.canEnable(ID)).toBe(true);
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it('never lets a late successful restart clear a later session pause', () => {
    const h = harness();
    const completeOld = h.viewer.pauseForRestart(ID);
    h.viewer.forget(ID);
    h.viewer.attach(ID, 10, 'new-session', (event) => h.events.push(event));
    h.receive({ ...protocol.status, connected: false });
    completeOld();
    expect(h.viewer.canAct(ID)).toBe(false);
    expect(() => h.viewer.attach(ID, 10, 'remount', () => {})).toThrow('unavailable');
  });

  it('does not dispatch against a replacement registry session', async () => {
    const h = harness();
    h.replaceSession();
    h.viewer.input(ID, 10, 'token-a', 1, key);
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'copy' })).rejects.toThrow();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.viewer.canAct(ID)).toBe(false);
    expect(h.events.at(-1)?.message).toMatchObject({ type: 'error', message: expect.stringContaining('session changed') });
  });

  it('rejects malformed known protocol with a readable error', () => {
    const h = harness();
    h.receive({ type: 'frame', data: 'not an image' });
    expect(h.events.at(-1)?.message.type).toBe('error');
    expect(h.sockets[0].terminate).toHaveBeenCalledOnce();
  });
});

describe('finite native actions and input', () => {
  it('keeps CSS viewport dimensions with fixed 2x density and only main-owned paste/selection evaluations', async () => {
    const h = harness();
    h.present();
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste', argv: ['close'] });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'copy', js: 'malicious' });
    expect(h.run.mock.calls).toEqual([
      [SESSION, ['set', 'viewport', '900', '640', '2']],
      [SESSION, ['eval', `document.execCommand('insertText', false, "Pasted 漢字")`]],
      [SESSION, ['eval', expect.stringContaining('selectionStart')]],
    ]);
    expect(h.run.mock.calls[2][1][1]).not.toContain('malicious');
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    expect(h.writeClipboard).toHaveBeenCalledWith('Selected 漢字');
    for (const action of [{ type: 'exec', argv: ['close'] }, { type: 'viewport', width: NaN, height: 4 }]) {
      await expect(h.viewer.action(ID, 10, 'token-a', 1, action)).rejects.toThrow();
    }
    expect(h.run).toHaveBeenCalledTimes(3);
  });

  it.each(['--version', '--json', '', 'Unicode café 日本語 🙂', '--leading-dash\nquotes \' \" and 漢字', '\");throw new Error("injected");//'])('encodes clipboard text %j only inside a main-owned literal', async (value) => {
    const h = harness();
    h.present();
    h.readClipboard.mockReturnValue(value);
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste', js: 'throw new Error("renderer script")' });
    expect(h.viewer.canAct(ID)).toBe(true);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    if (value) {
      expect(h.run).toHaveBeenCalledOnce();
      const argv = h.run.mock.calls[0][1];
      expect(argv[0]).toBe('eval');
      expect(argv).not.toContain(value);
      const insert = vi.fn(() => true);
      new Function('document', `return ${argv[1]}`)({ execCommand: insert });
      expect(insert).toHaveBeenCalledExactlyOnceWith('insertText', false, value);
    } else expect(h.run).not.toHaveBeenCalled();
  });

  it('rejects oversized encoded paste before spawning without pausing the healthy page', async () => {
    const h = harness();
    h.present();
    for (const value of ['x'.repeat(12000), '"'.repeat(6000), '\u0000'.repeat(2500)]) {
      h.readClipboard.mockReturnValue(value);
      await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow('encoded limit');
      expect(h.run).not.toHaveBeenCalled();
      expect(h.viewer.canAct(ID)).toBe(true);
    }
    h.readClipboard.mockReturnValue('still healthy');
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    expect(h.run).toHaveBeenCalledOnce();
  });

  it('inserts committed text only inside a main-owned literal without clipboard access', async () => {
    const h = harness();
    h.present();
    const value = '--version --json\n日本語入力テスト café 🙂 ");throw new Error("injected");//';
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'insert-text', text: value, js: 'renderer script', argv: ['close'] });
    expect(h.run).toHaveBeenCalledOnce();
    const argv = h.run.mock.calls[0][1];
    expect(argv).toEqual(['eval', `document.execCommand('insertText', false, ${JSON.stringify(value)})`]);
    const insert = vi.fn(() => true);
    new Function('document', `return ${argv[1]}`)({ execCommand: insert });
    expect(insert).toHaveBeenCalledExactlyOnceWith('insertText', false, value);
    expect(h.readClipboard).not.toHaveBeenCalled();
    expect(h.writeClipboard).not.toHaveBeenCalled();
    expect(h.sockets[0].send).not.toHaveBeenCalled();
  });

  it('rejects malformed/raw/encoded text caps before queue retention and leaves empty insertion a no-op', async () => {
    const h = harness();
    h.present();
    let finish!: (result: typeof ok) => void;
    h.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const resize = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'insert-text', text: '' });
    for (const value of [undefined, 7, {}, 'x'.repeat(12001), 'x'.repeat(12000), '"'.repeat(6000), '\u0000'.repeat(2500)]) {
      await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'insert-text', text: value })).rejects.toThrow(/text|Text/);
      expect(h.viewer.canAct(ID)).toBe(true);
    }
    expect(h.run).toHaveBeenCalledOnce();
    const insertion = h.viewer.action(ID, 10, 'token-a', 1, { type: 'insert-text', text: 'still healthy' });
    finish(ok);
    await Promise.all([resize, insertion]);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it.each(['owner', 'token', 'revision', 'undrawn', 'hidden', 'tab'])('rejects committed text against %s-stale input state', async (state) => {
    const h = harness();
    if (state !== 'undrawn') h.present();
    if (state === 'hidden') await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: false });
    if (state === 'tab') h.receive({ ...protocol.tabs, tabs: [{ ...protocol.tabs.tabs[0], tabId: 't2' }] });
    await expect(h.viewer.action(ID, state === 'owner' ? 99 : 10, state === 'token' ? 'old-token' : 'token-a',
      state === 'revision' ? 0 : state === 'tab' ? 2 : 1, { type: 'insert-text', text: '日本語入力テスト' })).rejects.toThrow();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it('preserves resize -> paste -> committed text -> typing/pointer receive order across native work', async () => {
    const h = harness();
    h.present();
    const order: string[] = [];
    let finishResize!: (result: typeof ok) => void;
    let finishPaste!: (result: typeof ok) => void;
    h.run.mockImplementationOnce(async () => {
      order.push('resize');
      return new Promise((resolve) => { finishResize = resolve; });
    }).mockImplementationOnce(async () => {
      order.push('paste');
      return new Promise((resolve) => { finishPaste = resolve; });
    });
    h.run.mockImplementationOnce(async () => { order.push('committed text'); return ok; });
    h.sockets[0].send.mockImplementation((payload: string) => {
      const input = JSON.parse(payload);
      order.push(input.type === 'input_keyboard' ? 'typing' : 'pointer');
    });
    const resize = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
    await vi.waitFor(() => expect(order).toEqual(['resize']));
    const paste = h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    const committed = h.viewer.action(ID, 10, 'token-a', 1, { type: 'insert-text', text: '日本語入力テスト' });
    const typing = h.viewer.input(ID, 10, 'token-a', 1, { ...key, text: '字' });
    const pointer = h.viewer.input(ID, 10, 'token-a', 1, { type: 'input_mouse', eventType: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 0 });
    expect(order).toEqual(['resize']);
    finishResize(ok);
    await resize;
    await vi.waitFor(() => expect(order).toEqual(['resize', 'paste']));
    finishPaste(ok);
    await Promise.all([paste, committed, typing, pointer]);
    expect(order).toEqual(['resize', 'paste', 'committed text', 'typing', 'pointer']);
  });

  it.each(['tab', 'subscription'])('drops queued old input/paste and does not pause a replacement %s on a late native failure', async (replacement) => {
    const h = harness();
    h.present();
    let failOld!: (result: typeof ok) => void;
    h.run.mockImplementationOnce(() => new Promise((resolve) => { failOld = resolve; }));
    const oldResize = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 }).catch((err) => err);
    await vi.waitFor(() => expect(failOld).toBeTypeOf('function'));
    const oldPaste = h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' }).catch((err) => err);
    const oldInput = h.viewer.input(ID, 10, 'token-a', 1, key);
    const oldCommitted = h.viewer.action(ID, 10, 'token-a', 1, { type: 'insert-text', text: '日本語入力テスト' }).catch((err) => err);
    let token = 'token-a', revision = 2;
    if (replacement === 'subscription') {
      token = 'token-b'; revision = 0;
      h.viewer.attach(ID, 10, token, (event) => h.events.push(event));
      h.receive(protocol.status);
    } else h.receive({ ...protocol.tabs, tabs: [{ ...protocol.tabs.tabs[0], tabId: 't2' }] });
    h.present(token);
    const newInput = h.viewer.input(ID, 10, token, revision, { ...key, text: '新' });
    failOld({ ...ok, ok: false, stderr: 'old native failure' });
    await Promise.all([oldResize, oldPaste, oldInput, newInput]);
    expect(await oldCommitted).toBeInstanceOf(Error);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.viewer.canAct(ID)).toBe(true);
    expect(h.events.filter((event) => event.message.type === 'error')).toEqual([]);
    expect(h.sockets.at(-1)!.send.mock.calls.map((call) => JSON.parse(call[0]))).toEqual([
      expect.objectContaining({ type: 'input_keyboard', text: '新' }),
    ]);
  });

  it('drops committed text queued before a hide/return, without replay after a fresh frame', async () => {
    const h = harness();
    h.present();
    const insertion = h.viewer.action(ID, 10, 'token-a', 1, { type: 'insert-text', text: '日本語入力テスト' }).catch((err) => err);
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: false });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: true });
    expect(await insertion).toBeInstanceOf(Error);
    h.viewer.ack(ID, 10, 'token-a', 2, true);
    expect(h.run).not.toHaveBeenCalled();
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'insert-text', text: 'fresh commit' });
    expect(h.run).toHaveBeenCalledOnce();
  });

  it('bounds input queued behind native work and pauses instead of accumulating indefinitely', async () => {
    const h = harness();
    h.present();
    let finish!: (result: typeof ok) => void;
    h.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const resize = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 }).catch(() => {});
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const input = Array.from({ length: 500 }, () => h.viewer.input(ID, 10, 'token-a', 1, key));
    expect(h.events.filter((event) => event.message.type === 'error')).toHaveLength(1);
    expect(h.events.at(-1)?.message).toMatchObject({ type: 'error', message: expect.stringContaining('queue is full') });
    finish(ok);
    await Promise.all([resize, ...input]);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    expect(h.viewer.canAct(ID)).toBe(false);
  });

  it('copies only the actual selection, blocks password values, and preserves clipboard on empty selection', async () => {
    const h = harness();
    h.present();
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'copy' });
    const script = h.run.mock.calls[0][1][1];
    const evaluate = new Function('document', 'window', `return ${script}`);
    for (const tagName of ['INPUT', 'TEXTAREA']) {
      expect(evaluate({ activeElement: { tagName, type: 'text', value: 'full selected value', selectionStart: 5, selectionEnd: 13 } }, {})).toBe('selected');
      expect(evaluate({ activeElement: { tagName, type: 'text', value: 'not selected', selectionStart: 2, selectionEnd: 2 } }, {})).toBe('');
    }
    expect(evaluate({ activeElement: { tagName: 'INPUT', type: 'password', value: 'secret', selectionStart: 0, selectionEnd: 6 } }, {})).toBe('');
    expect(evaluate({ activeElement: { tagName: 'DIV' } }, { getSelection: () => 'DOM selected' })).toBe('DOM selected');
    h.writeClipboard.mockClear();
    h.run.mockResolvedValueOnce({ ...ok, data: { result: '' } });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'copy' });
    expect(h.writeClipboard).not.toHaveBeenCalled();
  });

  it('stops queued mutations when a native command fails', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce({ ...ok, ok: false, stderr: 'Browser unavailable' });
    h.present();
    const first = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
    const second = h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.viewer.canAct(ID)).toBe(false);
  });

  it('uses finite navigation commands without a drawn frame and does not pause at history boundaries', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce({ ...ok, ok: false, stderr: 'No history entry' });
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'back' })).rejects.toThrow('No history');
    expect(h.viewer.canAct(ID)).toBe(true);
    for (const type of ['forward', 'reload']) await h.viewer.action(ID, 10, 'token-a', 1, { type });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'navigate', url: 'file:///C:/fixture.html' });
    for (const url of ['chrome://extensions', 'javascript:alert(1)', '--version']) {
      await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'navigate', url })).rejects.toThrow('Invalid');
    }
    expect(h.run.mock.calls.map((call) => call[1])).toEqual([['back'], ['forward'], ['reload'], ['open', 'file:///C:/fixture.html']]);
  });

  it('suspends frames/input/queued viewport writes while hidden, retaining only the newest frame', async () => {
    const h = harness();
    h.present();
    const resize = h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 800, height: 600 }).catch((err) => err);
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: false });
    await resize;
    expect(h.run).not.toHaveBeenCalled();
    h.viewer.input(ID, 10, 'token-a', 1, key);
    h.events.length = 0;
    for (let seq = 1; seq <= 100; seq++) h.receive({ ...protocol.frame, seq });
    expect(h.events).toHaveLength(0);
    h.receive(protocol.url);
    expect(h.events.at(-1)?.message.type).toBe('url');
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'reload' });
    expect(h.run).toHaveBeenCalledOnce();
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: true });
    expect(h.events.at(-1)?.message).toMatchObject({ type: 'frame', id: 102 });
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow('frame');
    h.viewer.ack(ID, 10, 'token-a', 102, true);
    await h.viewer.input(ID, 10, 'token-a', 1, key);
    expect(JSON.parse(h.sockets[0].send.mock.calls.at(-1)![0])).toEqual(key);
  });

  it('redelivers an acknowledged static current-tab frame on repeated returns without native repaint', async () => {
    const h = harness();
    h.present();
    for (let id = 2; id <= 4; id++) {
      await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: false });
      await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: true });
      expect(h.events.at(-1)?.message).toEqual({ type: 'frame', id, data: protocol.frame.data, width: 900, height: 640 });
      await h.viewer.action(ID, 10, 'token-a', 1, { type: 'viewport', width: 900, height: 640 });
      await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow('frame');
      h.viewer.ack(ID, 10, 'token-a', id, true);
      await h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    }
    expect(h.run.mock.calls.map((call) => call[1][0])).toEqual(['set', 'eval', 'set', 'eval', 'set', 'eval']);
  });

  it('bounds repeated visibility replays behind an old in-flight decode and requires a fresh draw ack', async () => {
    const h = harness();
    h.receive(protocol.frame);
    for (let id = 2; id <= 4; id++) {
      await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: false });
      await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: true });
      expect(h.events.filter((event) => event.message.type === 'frame')).toHaveLength(1);
    }
    h.viewer.ack(ID, 10, 'token-a', 1, true);
    expect(h.events.at(-1)?.message).toMatchObject({ type: 'frame', id: 4 });
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow('frame');
    h.viewer.ack(ID, 10, 'old-token', 4, true);
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow('frame');
    h.viewer.ack(ID, 10, 'token-a', 4, true);
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' });
    expect(h.events.filter((event) => event.message.type === 'frame')).toHaveLength(2);
  });

  it('does not replay a cached frame after the active tab changes while hidden', async () => {
    const h = harness();
    h.present();
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: false });
    h.receive({ type: 'tabs', tabs: [{ ...protocol.tabs.tabs[0], tabId: 't9' }] });
    await h.viewer.action(ID, 10, 'token-a', 2, { type: 'visibility', visible: true });
    expect(h.events.at(-1)?.message.type).toBe('tabs');
    await expect(h.viewer.action(ID, 10, 'token-a', 2, { type: 'paste' })).rejects.toThrow('frame');
    h.present();
    await h.viewer.action(ID, 10, 'token-a', 2, { type: 'paste' });
  });

  it.each(['failed-original', 'success-drawn', 'success-inflight', 'success-pending'])('preserves authoritative frame state through tab command completion: %s', async (mode) => {
    const h = harness();
    const tabs = [protocol.tabs.tabs[0], { ...protocol.tabs.tabs[0], tabId: 't9', active: false }];
    h.receive({ type: 'tabs', tabs });
    h.present();
    let finish!: (result: typeof ok) => void;
    h.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const select = h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-select', tabId: 't9' }).catch((err) => err);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const revision = mode === 'failed-original' ? 1 : 2;
    if (mode !== 'failed-original') {
      h.receive({ type: 'tabs', tabs: tabs.map((tab) => ({ ...tab, active: tab.tabId === 't9' })) });
      if (mode === 'success-drawn') h.present();
      else h.receive(protocol.frame);
      if (mode === 'success-pending') h.receive({ ...protocol.frame, data: 'BBBB' });
    }
    finish(mode === 'failed-original' ? { ...ok, ok: false, stderr: 'Tab is locked' } : ok);
    const result = await select;
    if (mode === 'failed-original') expect(result).toBeInstanceOf(Error);
    else expect(result).toBeUndefined();
    if (mode === 'success-inflight' || mode === 'success-pending') h.viewer.ack(ID, 10, 'token-a', 2, true);
    if (mode === 'success-pending') {
      expect(h.events.at(-1)?.message).toMatchObject({ type: 'frame', id: 3, data: 'BBBB' });
      h.viewer.ack(ID, 10, 'token-a', 3, true);
    }
    await h.viewer.input(ID, 10, 'token-a', revision, key);
    expect(JSON.parse(h.sockets[0].send.mock.calls.at(-1)![0])).toEqual(key);
    await h.viewer.action(ID, 10, 'token-a', revision, { type: 'paste' });
    await h.viewer.action(ID, 10, 'token-a', revision, { type: 'visibility', visible: false });
    await h.viewer.action(ID, 10, 'token-a', revision, { type: 'visibility', visible: true });
    expect(h.events.at(-1)?.message).toMatchObject({ type: 'frame', data: mode === 'success-pending' ? 'BBBB' : protocol.frame.data });
  });

  it('selects stable IDs rather than visual indices and accepts its own early stream update', async () => {
    const h = harness();
    const tabs = [protocol.tabs.tabs[0], { ...protocol.tabs.tabs[0], tabId: 't9', active: false }];
    h.receive({ type: 'tabs', tabs });
    h.run.mockImplementationOnce(async () => {
      h.receive({ type: 'tabs', tabs: tabs.map((tab) => ({ ...tab, active: tab.tabId === 't9' })) });
      return ok;
    });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-select', tabId: 't9' });
    expect(h.run.mock.calls[0][1]).toEqual(['tab', 't9']);
    await expect(h.viewer.action(ID, 10, 'token-a', 2, { type: 'tab-select', tabId: '1' })).rejects.toThrow('Invalid');
    await expect(h.viewer.action(ID, 10, 'token-a', 2, { type: 'tab-close', tabId: 't88' })).rejects.toThrow('no longer');
  });

  it.each(['active', 'inactive', 'last'])('closes the original stable ID safely: %s tab', async (mode) => {
    const h = harness();
    const tabs = mode === 'last' ? protocol.tabs.tabs : [protocol.tabs.tabs[0], { ...protocol.tabs.tabs[0], tabId: 't9', active: false }];
    h.receive({ type: 'tabs', tabs });
    let current = tabs;
    h.run.mockImplementation(async (_session, argv) => {
      if (argv[1] === 'new') current = [...current.map((tab) => ({ ...tab, active: false })), { ...tabs[0], tabId: 't12', active: true, url: 'about:blank' }];
      else if (argv[1] === 'close') current = current.filter((tab) => tab.tabId !== argv[2]);
      else current = current.map((tab) => ({ ...tab, active: tab.tabId === argv[1] }));
      h.receive({ type: 'tabs', tabs: current });
      return { ...ok, data: { tabId: 't12' } } as typeof ok;
    });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-close', tabId: mode === 'inactive' ? 't9' : 't1' });
    expect(h.run.mock.calls.map((call) => call[1])).toEqual(mode === 'inactive' ? [['tab', 'close', 't9']]
      : mode === 'last' ? [['tab', 'new', 'about:blank'], ['tab', 'close', 't1']]
      : [['tab', 't9'], ['tab', 'close', 't1']]);
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it.each(['creation', 'close'])('retains authoritative available tabs after last-close %s failure', async (failure) => {
    const h = harness();
    const both = [ { ...protocol.tabs.tabs[0], active: false }, { ...protocol.tabs.tabs[0], tabId: 't9', active: true, url: 'about:blank' } ];
    h.run.mockImplementation(async (_session, argv) => {
      if (argv[1] === 'new' && failure !== 'creation') {
        h.receive({ type: 'tabs', tabs: both });
        return { ...ok, data: { tabId: 't9' } } as typeof ok;
      }
      return { ...ok, ok: false, stderr: `${failure} failed` };
    });
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-close', tabId: 't1' })).rejects.toThrow(`${failure} failed`);
    expect(h.run).toHaveBeenCalledTimes(failure === 'creation' ? 1 : 2);
    expect(h.events.at(-1)?.message).toEqual({ type: 'tabs', tabs: (failure === 'creation' ? protocol.tabs.tabs : both)
      .map(({ tabId, title, url, active }) => ({ tabId, title, url, active })) });
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it.each(['external-active', 'external-membership', 'detach', 'session'])('stops a dependent close after %s changes during selection', async (change) => {
    const h = harness();
    const tabs = [protocol.tabs.tabs[0], { ...protocol.tabs.tabs[0], tabId: 't9', active: false }];
    h.receive({ type: 'tabs', tabs });
    h.run.mockImplementationOnce(async () => {
      h.receive({ type: 'tabs', tabs: tabs.map((tab) => ({ ...tab, active: tab.tabId === 't9' })) });
      if (change === 'external-active') h.receive({ type: 'tabs', tabs });
      if (change === 'external-membership') h.receive({ type: 'tabs', tabs: [tabs[1]] });
      if (change === 'detach') h.viewer.detach(ID, 10, 'token-a');
      if (change === 'session') h.replaceSession();
      return ok;
    });
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-close', tabId: 't1' })).rejects.toThrow('Tabs changed');
    expect(h.run).toHaveBeenCalledOnce();
  });

  it('drops input queued before or received during a tab change even when its stream update is late', async () => {
    const h = harness();
    h.receive({ type: 'tabs', tabs: [protocol.tabs.tabs[0], { ...protocol.tabs.tabs[0], tabId: 't9', active: false }] });
    h.present();
    let finish!: (result: typeof ok) => void;
    h.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const select = h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-select', tabId: 't9' });
    const queued = h.viewer.input(ID, 10, 'token-a', 1, key);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    h.viewer.input(ID, 10, 'token-a', 1, key);
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'paste' })).rejects.toThrow('frame');
    finish(ok);
    await Promise.all([select, queued]);
    h.viewer.input(ID, 10, 'token-a', 1, key);
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    const delivered = h.events.length;
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: false });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: true });
    expect(h.events).toHaveLength(delivered);
    h.present();
    await h.viewer.input(ID, 10, 'token-a', 1, key);
    expect(JSON.parse(h.sockets[0].send.mock.calls.at(-1)![0])).toEqual(key);
  });

  it('does not close the active original when selection fails', async () => {
    const h = harness();
    h.receive({ type: 'tabs', tabs: [protocol.tabs.tabs[0], { ...protocol.tabs.tabs[0], tabId: 't9', active: false }] });
    h.run.mockResolvedValueOnce({ ...ok, ok: false, stderr: 'Tab is locked' });
    await expect(h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-close', tabId: 't1' })).rejects.toThrow('locked');
    expect(h.run.mock.calls.map((call) => call[1])).toEqual([['tab', 't9']]);
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it('continues a last-close when the expected tab update arrives after creation completion', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce({ ...ok, data: { tabId: 't9' } } as typeof ok).mockImplementationOnce(async () => {
      h.receive({ type: 'tabs', tabs: [{ ...protocol.tabs.tabs[0], active: false }, { ...protocol.tabs.tabs[0], tabId: 't9', active: true }] });
      h.receive({ type: 'tabs', tabs: [{ ...protocol.tabs.tabs[0], tabId: 't9', active: true }] });
      return ok;
    });
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-close', tabId: 't1' });
    expect(h.run.mock.calls.map((call) => call[1])).toEqual([['tab', 'new', 'about:blank'], ['tab', 'close', 't1']]);
  });

  it.each(['launched', 'relaunchedBrowser', 'restartedBackground'])('stops queued work and the dependent close on native lifecycle.%s, even on a failed result', async (flag) => {
    const h = harness();
    h.run.mockResolvedValueOnce({ ...ok, ok: false, data: { success: false, data: { lifecycle: { [flag]: true }, tabId: 't9' } } } as typeof ok);
    const close = h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-close', tabId: 't1' });
    const reload = h.viewer.action(ID, 10, 'token-a', 1, { type: 'reload' });
    await expect(close).rejects.toThrow('session changed');
    await expect(reload).rejects.toThrow();
    expect(h.run.mock.calls.map((call) => call[1])).toEqual([['tab', 'new', 'about:blank']]);
    expect(h.viewer.canAct(ID)).toBe(false);
    expect(h.events.at(-1)?.message).toMatchObject({ type: 'error', message: expect.stringContaining('not retried') });
  });

  it('observes a late native replacement after hiding but never lets an obsolete subscription pause its replacement', async () => {
    for (const replace of [false, true]) {
      const h = harness();
      let finish!: (result: typeof ok) => void;
      h.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const action = h.viewer.action(ID, 10, 'token-a', 1, { type: 'reload' }).catch(() => {});
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await h.viewer.action(ID, 10, 'token-a', 1, { type: 'visibility', visible: false });
      if (replace) h.viewer.attach(ID, 10, 'replacement', () => {});
      finish({ ...ok, data: { lifecycle: { launched: true } } } as typeof ok);
      await action;
      expect(h.viewer.canAct(ID)).toBe(replace);
    }
  });

  it('does not infer replacement from effectiveLaunch browser state or imprecise numeric identities', async () => {
    const h = harness();
    h.run.mockResolvedValue({ ...ok, data: { tabId: 't9', lifecycle: { launched: false, relaunchedBrowser: false, restartedBackground: false },
      effectiveLaunch: { browserLaunched: true }, browserId: 18446744073709551615 } } as typeof ok);
    await h.viewer.action(ID, 10, 'token-a', 1, { type: 'tab-close', tabId: 't1' });
    expect(h.run.mock.calls.map((call) => call[1])).toEqual([['tab', 'new', 'about:blank'], ['tab', 'close', 't1']]);
    expect(h.viewer.canAct(ID)).toBe(true);
  });

  it('validates finite mouse/key messages and strips arbitrary CDP/argv fields', () => {
    expect(validatedViewerInput({ ...key, method: 'Browser.close', argv: ['close'] })).toEqual(key);
    expect(validatedViewerInput({ ...key, modifiers: 32 })).toBeNull();
    expect(validatedViewerInput({ ...key, eventType: 'execute' })).toBeNull();
    expect(validatedViewerInput({ ...key, text: '日本語入力テスト' })).toBeNull();
    expect(validatedViewerInput({ ...key, text: 'ab' })).toBeNull();
    expect(validatedViewerInput({ ...key, text: '🙂' })).toMatchObject({ text: '🙂' });
    expect(validatedViewerInput({ ...key, eventType: 'keyDown', key: 'Enter', text: '\r' })).toMatchObject({ text: '\r' });
    expect(validatedViewerInput({ ...key, eventType: 'keyDown', key: 'Control', text: undefined })).not.toBeNull();
    const mouse = { type: 'input_mouse', eventType: 'mouseWheel', x: 12, y: 30, button: 'none', clickCount: 0, modifiers: 0, deltaY: 100 };
    expect(validatedViewerInput(mouse)).toMatchObject(mouse);
    expect(validatedViewerInput({ ...mouse, x: Infinity })).toBeNull();
    expect(validatedViewerInput({ ...mouse, deltaY: NaN })).toBeNull();
  });
});
