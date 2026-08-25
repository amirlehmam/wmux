import { describe, it, expect } from 'vitest';
import { toAgentBrowserArgv, normaliseRef } from '../../src/main/agent-browser-verbs';

const S = 'surf-abc';
/** Strip the leading session flags so each case asserts only its own verb. */
const verb = (method: string, params?: any) => toAgentBrowserArgv(method, params, S).slice(2);

describe('normaliseRef', () => {
  it('adds the @ agent-browser expects', () => expect(normaliseRef('e12')).toBe('@e12'));
  it('leaves an already-prefixed ref alone', () => expect(normaliseRef('@e12')).toBe('@e12'));
  it('passes a CSS selector through untouched', () => expect(normaliseRef('#submit')).toBe('#submit'));
  it('passes a text selector through untouched', () => expect(normaliseRef('.item a')).toBe('.item a'));
});

describe('toAgentBrowserArgv', () => {
  it('always pins the session first', () => {
    expect(toAgentBrowserArgv('browser.snapshot', {}, S).slice(0, 2)).toEqual(['--session', S]);
  });

  it('maps navigate to open', () => {
    expect(verb('browser.navigate', { url: 'https://example.com' })).toEqual(['open', 'https://example.com']);
  });

  it('maps snapshot', () => expect(verb('browser.snapshot')).toEqual(['snapshot']));

  it('maps click with a ref', () => {
    expect(verb('browser.click', { ref: 'e2' })).toEqual(['click', '@e2']);
  });

  it('maps type', () => {
    expect(verb('browser.type', { ref: 'e3', text: 'hello' })).toEqual(['type', '@e3', 'hello']);
  });

  it('maps fill', () => {
    expect(verb('browser.fill', { ref: 'e3', value: 'a@b.com' })).toEqual(['fill', '@e3', 'a@b.com']);
  });

  it('maps get_text with a ref to `get text`', () => {
    expect(verb('browser.get_text', { ref: 'e1' })).toEqual(['get', 'text', '@e1']);
  });

  it('maps get_text with NO ref to `read` (whole page)', () => {
    expect(verb('browser.get_text', {})).toEqual(['read']);
  });

  it('maps screenshot, and --full only when asked', () => {
    expect(verb('browser.screenshot', {})).toEqual(['screenshot', '--json']);
    expect(verb('browser.screenshot', { fullPage: true })).toEqual(['screenshot', '--full', '--json']);
  });

  it('maps eval', () => {
    expect(verb('browser.eval', { js: '1+1' })).toEqual(['eval', '1+1']);
  });

  it('maps wait with a ref, and with a bare timeout', () => {
    expect(verb('browser.wait', { ref: 'e5' })).toEqual(['wait', '@e5']);
    expect(verb('browser.wait', { timeout: 500 })).toEqual(['wait', '500']);
  });

  it('maps the history verbs', () => {
    expect(verb('browser.back')).toEqual(['back']);
    expect(verb('browser.forward')).toEqual(['forward']);
    expect(verb('browser.reload')).toEqual(['reload']);
  });

  it('throws a -32601 for an unknown method, matching the web engine', () => {
    expect(() => toAgentBrowserArgv('browser.nope', {}, S)).toThrow(/Unknown/);
  });

  it('never returns a single shell string — argv stays an array', () => {
    const argv = toAgentBrowserArgv('browser.eval', { js: 'a && b; rm -rf /' }, S);
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toContain('a && b; rm -rf /');
  });

  describe('ref-required verbs reject a missing ref (-32602)', () => {
    it('click without a ref throws -32602', () => {
      try {
        toAgentBrowserArgv('browser.click', {}, S);
        throw new Error('expected toAgentBrowserArgv to throw');
      } catch (e: any) {
        expect(e.rpcCode).toBe(-32602);
        expect(e.message).toMatch(/ref/i);
      }
    });

    it('type without a ref throws -32602', () => {
      try {
        toAgentBrowserArgv('browser.type', { text: 'hello' }, S);
        throw new Error('expected toAgentBrowserArgv to throw');
      } catch (e: any) {
        expect(e.rpcCode).toBe(-32602);
        expect(e.message).toMatch(/ref/i);
      }
    });

    it('fill without a ref throws -32602', () => {
      try {
        toAgentBrowserArgv('browser.fill', { value: 'x' }, S);
        throw new Error('expected toAgentBrowserArgv to throw');
      } catch (e: any) {
        expect(e.rpcCode).toBe(-32602);
        expect(e.message).toMatch(/ref/i);
      }
    });
  });

  describe('wait requires a ref or an explicit timeout', () => {
    it('throws -32602 when neither ref nor timeout is given', () => {
      try {
        toAgentBrowserArgv('browser.wait', {}, S);
        throw new Error('expected toAgentBrowserArgv to throw');
      } catch (e: any) {
        expect(e.rpcCode).toBe(-32602);
        expect(e.message).toMatch(/ref|timeout/i);
      }
    });

    it('accepts an explicit timeout of 0', () => {
      expect(verb('browser.wait', { timeout: 0 })).toEqual(['wait', '0']);
    });
  });
});
