import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The warning under test lives in the impure dispatch layer (`v2-browser.ts`),
 * not in the pure argv translator: agent-browser's `wait <selector>` has no
 * per-call timeout flag, so `toAgentBrowserArgv` DROPS a timeout sent alongside
 * a ref (pinned in agent-browser-verbs.test.ts). `runBrowserCommandForTarget`
 * is where the resolved engine and the original params are both available, so
 * it emits exactly one `console.warn` — without changing the argv, the result,
 * or the child-process deadline.
 *
 * Electron / CDP / the agent-browser runtime are mocked exactly as in
 * agent-browser-routing.test.ts, because importing v2-browser pulls in
 * ipc-handlers (node-pty + most of main) at module load.
 */
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));
vi.mock('../../src/main/ipc-handlers', () => ({
  cdpBridge: {
    wcIdForSurface: () => null,
    get isAttached() { return false; },
    get attachedWebContentsId() { return null; },
  },
}));
vi.mock('../../src/main/agent-browser-runtime', () => ({
  acquireDashboardFor: async () => {},
  sessionRegistry: {
    ensure: (surfaceId: string) => ({
      surfaceId,
      sessionName: `wmux-${surfaceId}`,
      streamPort: 9300,
      dashboardUrl: 'http://127.0.0.1:4848/?port=9300',
    }),
  },
}));

import {
  runBrowserCommandForTarget,
  type BrowserDeps,
  type BrowserTarget,
} from '../../src/main/v2-browser';

const SESSION = {
  surfaceId: 'surf-a',
  sessionName: 'wmux-surf-a',
  streamPort: 9300,
  dashboardUrl: 'http://127.0.0.1:4848/?port=9300',
} as any;

const agent = (): BrowserTarget => ({ kind: 'agent', session: SESSION });
const web = (wcId = 7): BrowserTarget => ({ kind: 'web', wcId });

const ok = (data: unknown = null, stdout = ''): any => ({ ok: true, spawnFailed: false, data, stdout, stderr: '' });

/** A bridge whose `wait` (and everything else) records but does nothing. */
function makeBridge() {
  return { wait: vi.fn(async () => {}) } as any;
}

function deps(runAgent: any = vi.fn(async () => ok())): BrowserDeps {
  return { bridge: makeBridge(), runAgent };
}

describe('agent-browser wait: unrepresentable per-call timeout warning', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('warns once when the agent engine gets a ref AND a finite timeout', async () => {
    const runAgent = vi.fn(async () => ok());
    await runBrowserCommandForTarget('browser.wait', { ref: 'e1', timeout: 3000 }, agent(), deps(runAgent));

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('3000ms');
    expect(msg).toContain('e1');
    expect(msg).toMatch(/no per-call timeout/i);

    // The warning is a diagnostic only: argv, result and deadline are unchanged.
    // With a ref present the translator drops the timeout, so argv is ref-only.
    expect(runAgent).toHaveBeenCalledWith(['--session', 'wmux-surf-a', 'wait', '@e1'], expect.any(Number));
  });

  it('does not warn for a ref-only wait (no timeout to lose)', async () => {
    await runBrowserCommandForTarget('browser.wait', { ref: 'e1' }, agent(), deps());
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for a timeout-only wait (represented as the sleep argument)', async () => {
    const runAgent = vi.fn(async () => ok());
    await runBrowserCommandForTarget('browser.wait', { timeout: 500 }, agent(), deps(runAgent));

    expect(warn).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith(['--session', 'wmux-surf-a', 'wait', '500'], expect.any(Number));
  });

  it('warns for timeout 0 alongside a ref, reporting 0ms', async () => {
    await runBrowserCommandForTarget('browser.wait', { ref: 'e1', timeout: 0 }, agent(), deps());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('0ms');
  });

  it('does not warn on the web engine, which honours the timeout', async () => {
    const bridge = makeBridge();
    await runBrowserCommandForTarget('browser.wait', { ref: 'e1', timeout: 3000 }, web(3), { bridge, runAgent: vi.fn() });

    expect(warn).not.toHaveBeenCalled();
    expect(bridge.wait).toHaveBeenCalledWith('e1', 3000, 3);
  });

  it('does not warn for a non-wait verb that carries a ref and a timeout', async () => {
    await runBrowserCommandForTarget('browser.click', { ref: 'e1', timeout: 3000 }, agent(), deps());
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when the timeout is non-finite', async () => {
    await runBrowserCommandForTarget('browser.wait', { ref: 'e1', timeout: Infinity }, agent(), deps());
    await runBrowserCommandForTarget('browser.wait', { ref: 'e1', timeout: NaN }, agent(), deps());
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The console is only half of it. `wmux browser wait e1 5000` is a SEPARATE
 * process whose entire view of the command is the JSON reply it prints, so a
 * warning that exists only on main's stdout is invisible in every packaged
 * build — it showed up under `npm run dev` and nowhere else. The same sentence
 * therefore rides back on the reply, and only in the case that is already
 * divergent between the engines: everywhere the two engines agree, they still
 * answer byte-identically.
 */
describe('agent-browser wait: the warning reaches the caller, not just the log', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('attaches the warning to the V2 reply alongside the normal result', async () => {
    const out = await runBrowserCommandForTarget(
      'browser.wait', { ref: 'e1', timeout: 5000 }, agent(), deps(),
    );

    expect(out.ok).toBe(true);
    expect(String(out.warning)).toContain('5000ms');
    expect(String(out.warning)).toContain('e1');
    // Unprefixed on the wire: '[wmux] agent-browser:' is a log-line marker, and
    // the reply already says which engine answered.
    expect(String(out.warning)).not.toContain('[wmux]');
  });

  it('says the same thing in both channels', async () => {
    const out = await runBrowserCommandForTarget(
      'browser.wait', { ref: 'e1', timeout: 5000 }, agent(), deps(),
    );
    expect(String(warn.mock.calls[0][0])).toContain(String(out.warning));
  });

  it('leaves the reply untouched when nothing is dropped', async () => {
    const refOnly = await runBrowserCommandForTarget('browser.wait', { ref: 'e1' }, agent(), deps());
    const msOnly = await runBrowserCommandForTarget('browser.wait', { timeout: 500 }, agent(), deps());
    const other = await runBrowserCommandForTarget('browser.click', { ref: 'e1', timeout: 3000 }, agent(), deps());

    for (const out of [refOnly, msOnly, other]) {
      expect(out).toEqual({ ok: true });
      expect('warning' in out).toBe(false);
    }
  });

  it('never attaches a warning on the web engine, which honours the timeout', async () => {
    const out = await runBrowserCommandForTarget(
      'browser.wait', { ref: 'e1', timeout: 5000 }, web(3), { bridge: makeBridge(), runAgent: vi.fn() },
    );
    expect(out).toEqual({ ok: true });
  });

  it('does not clobber a shaped payload — the warning is added, never substituted', async () => {
    // get_text carries a real payload; a wait never does. Pinned so a future
    // verb that both shapes a result AND drops something keeps both halves.
    const runAgent = vi.fn(async () => ok(null, 'hello'));
    const out = await runBrowserCommandForTarget('browser.get_text', {}, agent(), deps(runAgent));
    expect(out).toEqual({ text: 'hello' });
  });
});
