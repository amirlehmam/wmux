/**
 * Issue #237, second blocker: the CDP proxy forwarded every message to the
 * page-level debugger, so any real client died on its first browser-level call.
 *
 * These pin the emulated browser. The one that matters most is the
 * "page session emits nothing" pair near the bottom — that shape was found by
 * pointing real puppeteer at this module, not by reading it, and its failure
 * mode is a 4 GB heap rather than a wrong answer.
 */
import { describe, it, expect } from 'vitest';
import {
  BrowserDomainContext,
  connectionKind,
  handleBrowserCommand,
  tagEventSession,
  targetInfo,
} from '../../src/main/cdp-browser-domain';

const SESSION = 'wmux-page-1';

const ctx = (over: Partial<BrowserDomainContext> = {}): BrowserDomainContext => ({
  page: { title: 'wmux panel', url: 'https://example.com' },
  chromeVersion: '150.0.7871.46',
  v8Version: '15.0',
  userAgent: 'Mozilla/5.0 … Chrome/150.0.0.0 Safari/537.36',
  targetId: '1',
  sessionId: SESSION,
  ...over,
});

/** A browser-level command: no sessionId on the wire. */
const browserCmd = (method: string, params?: Record<string, unknown>) =>
  handleBrowserCommand(method, params, undefined, ctx());

/** The same command arriving down the attached page session. */
const sessionCmd = (method: string, params?: Record<string, unknown>) =>
  handleBrowserCommand(method, params, SESSION, ctx());

describe('connectionKind', () => {
  it('reads /devtools/browser/... as a browser connection', () => {
    expect(connectionKind('/devtools/browser/1')).toBe('browser');
    expect(connectionKind('/devtools/browser/abc-def')).toBe('browser');
  });

  it('reads /devtools/page/... as a page connection', () => {
    expect(connectionKind('/devtools/page/1')).toBe('page');
  });

  it('defaults anything else to a page connection', () => {
    // The proxy has always forwarded raw page protocol on whatever socket a
    // client opened. A client relying on that must not suddenly start getting
    // Target.* interception it never asked for.
    expect(connectionKind('/')).toBe('page');
    expect(connectionKind(undefined)).toBe('page');
    expect(connectionKind('/devtools/inspector.html')).toBe('page');
  });
});

describe('tagEventSession', () => {
  it('tags debugger events with the page session on a browser connection', () => {
    // A flattened-protocol client drops an untagged event as belonging to no
    // session it knows about.
    expect(tagEventSession('browser', SESSION)).toBe(SESSION);
  });

  it('leaves them untagged on a page connection', () => {
    expect(tagEventSession('page', SESSION)).toBeUndefined();
  });
});

describe('the handshake a real client performs (issue #237)', () => {
  it('answers Target.getBrowserContexts — the exact call the report died on', () => {
    const { action } = browserCmd('Target.getBrowserContexts');
    expect(action).toEqual({ type: 'result', result: { browserContextIds: [] } });
  });

  it('answers Browser.getVersion from the running Electron', () => {
    const { action } = browserCmd('Browser.getVersion');
    expect(action.type).toBe('result');
    expect((action as any).result.product).toBe('Chrome/150.0.7871.46');
    expect((action as any).result.protocolVersion).toBe('1.3');
  });

  it('emits Target.targetCreated BEFORE answering setDiscoverTargets', () => {
    // Chrome does; a client that waits for the event before continuing would
    // otherwise wait forever.
    const { events, action } = browserCmd('Target.setDiscoverTargets', { discover: true });
    expect(events).toHaveLength(1);
    expect(events[0].method).toBe('Target.targetCreated');
    expect((events[0].params as any).targetInfo.targetId).toBe('1');
    expect(action.type).toBe('result');
  });

  it('emits nothing when discovery is being switched off', () => {
    expect(browserCmd('Target.setDiscoverTargets', { discover: false }).events).toEqual([]);
  });

  it('auto-attaches the page and hands back its session', () => {
    const { events, action } = browserCmd('Target.setAutoAttach', { autoAttach: true, flatten: true });
    expect(events[0].method).toBe('Target.attachedToTarget');
    expect((events[0].params as any).sessionId).toBe(SESSION);
    expect((events[0].params as any).waitingForDebugger).toBe(false);
    expect(action.type).toBe('result');
  });

  it('returns the session id from an explicit attachToTarget, and announces it', () => {
    // Puppeteer's createSession() sends the command but reads the session out of
    // the EVENT, so both halves have to be there.
    const { events, action } = browserCmd('Target.attachToTarget', { targetId: '1', flatten: true });
    expect(events[0].method).toBe('Target.attachedToTarget');
    expect((action as any).result).toEqual({ sessionId: SESSION });
  });

  it('refuses to attach to a target that is not the one it advertises', () => {
    const { action } = browserCmd('Target.attachToTarget', { targetId: 'nope' });
    expect(action.type).toBe('error');
  });

  it('lists exactly one page target', () => {
    const { action } = browserCmd('Target.getTargets');
    expect((action as any).result.targetInfos).toHaveLength(1);
    expect((action as any).result.targetInfos[0].type).toBe('page');
  });

  it('reports the page live, not as it was at connection time', () => {
    const later = handleBrowserCommand('Target.getTargetInfo', {}, undefined,
      ctx({ page: { title: 'Moved', url: 'https://moved.example' } }));
    expect((later.action as any).result.targetInfo.url).toBe('https://moved.example');
  });
});

describe('the page session answers, and stays silent (issue #237)', () => {
  // This pair is the fix for a hang, not for a wrong answer. Puppeteer sends
  // Target.setAutoAttach down every session it attaches, looking for OOPIFs.
  // When that answered like the browser connection — with an attachedToTarget
  // for the page — puppeteer attached to the "child", sent setAutoAttach down
  // the new session, and got another attachment for the same target. Real
  // puppeteer 24 went from connect() to `Ineffective mark-compacts near heap
  // limit` inside browser.pages().
  it('answers setAutoAttach on the page session with no events at all', () => {
    const { events, action } = sessionCmd('Target.setAutoAttach', { autoAttach: true, flatten: true });
    expect(events).toEqual([]);
    expect(action).toEqual({ type: 'result', result: {} });
  });

  it('answers setDiscoverTargets on the page session with no events at all', () => {
    expect(sessionCmd('Target.setDiscoverTargets', { discover: true }).events).toEqual([]);
  });

  it('refuses to attach to anything from the page session', () => {
    // There is nothing under this page to attach to, and inventing a second
    // session is how the loop started.
    expect(sessionCmd('Target.attachToTarget', { targetId: '1' }).action.type).toBe('error');
  });

  it('still describes itself', () => {
    const { action } = sessionCmd('Target.getTargetInfo', {});
    expect((action as any).result.targetInfo.targetId).toBe('1');
  });

  it('rejects a session id it never handed out', () => {
    const { action } = handleBrowserCommand('Page.navigate', { url: 'x' }, 'someone-elses', ctx());
    expect(action).toMatchObject({ type: 'error', code: -32001 });
  });
});

describe('what forwards and what does not', () => {
  it('forwards page protocol untouched, on either scope', () => {
    for (const r of [browserCmd('Page.navigate', { url: 'https://x' }), sessionCmd('Runtime.evaluate', { expression: '1' })]) {
      expect(r.action.type).toBe('forward');
    }
  });

  it('never forwards an unknown Target.* to the page debugger', () => {
    // Electron answers browser-level Target.* with "Not allowed", which reads to
    // the client as wmux's page being broken rather than as a command wmux does
    // not implement.
    const { action } = browserCmd('Target.somethingNewInChrome199');
    expect(action).toMatchObject({ type: 'error', code: -32601 });
  });
});

describe('the single-pane concessions', () => {
  it('treats createTarget as "put this URL in the pane"', () => {
    const { action } = browserCmd('Target.createTarget', { url: 'https://example.org' });
    expect((action as any).result).toEqual({ targetId: '1' });
    expect((action as any).sideEffect).toEqual({ method: 'Page.navigate', params: { url: 'https://example.org' } });
  });

  it('defaults a target created with no url to about:blank', () => {
    expect((browserCmd('Target.createTarget', {}).action as any).sideEffect.params.url).toBe('about:blank');
  });

  it('declines to close the target rather than lying about it', () => {
    // A client told `true` would go on waiting for a target that never goes away.
    expect((browserCmd('Target.closeTarget', { targetId: '1' }).action as any).result).toEqual({ success: false });
  });

  it('declines an incognito context rather than handing back a shared one', () => {
    expect(browserCmd('Target.createBrowserContext').action.type).toBe('error');
  });

  it('swallows Browser.close — the "browser" here is the user\'s window', () => {
    expect(browserCmd('Browser.close').action).toEqual({ type: 'result', result: {} });
  });

  it('accepts the determinism knobs a client sets before a run', () => {
    for (const m of ['Browser.setDownloadBehavior', 'Browser.grantPermissions', 'Browser.resetPermissions']) {
      expect(browserCmd(m).action.type).toBe('result');
    }
  });
});

describe('targetInfo', () => {
  it('omits browserContextId so clients fall back to the default context', () => {
    // Inventing one would mean answering Target.getBrowserContexts with it too,
    // and honouring it on every command that takes one.
    expect(targetInfo(ctx()).browserContextId).toBeUndefined();
  });

  it('matches the id /json/list advertises', () => {
    expect(targetInfo(ctx()).targetId).toBe('1');
  });
});
