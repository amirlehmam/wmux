import { describe, expect, it } from 'vitest';
import { browserRequest } from '../../src/cli/wmux';

describe('browser panel selector', () => {
  it.each([
    ['open', 'https://example.org'], ['snapshot'], ['click', 'e1'], ['type', 'e1', '--panel'],
    ['fill', 'e2', 'hello'], ['screenshot', '--full'], ['get-text', 'e1'], ['eval', 'document.title'],
    ['wait', 'e1', '250'], ['back'], ['forward'], ['reload'], ['engine'], ['engine', 'web'],
  ])('preserves the %s method, arguments and deadline', (...args) => {
    const ordinary = browserRequest(['browser', ...args], 'terminal')!;
    expect(browserRequest(['browser', '--panel', ...args], 'terminal')).toEqual({
      ...ordinary, params: { ...ordinary.params, panel: true },
    });
  });

  it('also accepts a trailing flag outside free-form text', () => {
    expect(browserRequest(['browser', 'screenshot', '--full', '--panel'])?.params).toEqual({ fullPage: true, panel: true });
    expect(browserRequest(['browser', 'snapshot', '--panel'])).toEqual(browserRequest(['browser', '--panel', 'snapshot']));
  });

  it.each<[string, string[], string]>([['eval', ['--panel'], 'js'], ['type', ['e1', '--panel'], 'text'], ['fill', ['e1', '--panel'], 'value']])(
    'does not reinterpret existing %s payloads', (verb, args, key) => {
      const req = browserRequest(['browser', verb, ...args]);
      expect(req?.params[key]).toBe('--panel');
      expect(req?.params).not.toHaveProperty('panel');
    });

  it.each<[string[], string]>([[['type', 'e1'], 'text'], [['fill', 'e2'], 'value'], [['eval'], 'js']])(
    'keeps selector-looking tokens literal in a prefixed %j payload', (verb, key) => {
      expect(browserRequest(['browser', '--panel', ...verb, '--surface', '--panel'], 'terminal')?.params)
        .toMatchObject({ panel: true, caller: 'terminal', [key]: '--surface --panel' });
    });

  it.each([[], [''], ['--panel'], ['--full']])('rejects a missing or flag-shaped surface ID: %j', (...tail) => {
    expect(() => browserRequest(['browser', 'snapshot', '--surface', ...tail], 'terminal')).toThrow(/requires a surface ID/);
  });

  it('rejects conflicting selectors and non-web panel opens', () => {
    expect(() => browserRequest(['browser', 'snapshot', '--surface', 's', '--panel'])).toThrow(/cannot be combined/);
    expect(() => browserRequest(['browser', '--panel', 'snapshot', '--panel'])).toThrow(/only once/);
    expect(() => browserRequest(['browser', 'open', 'https://example.org', 'extra', '--panel'])).toThrow(/http\(s\)/);
    for (const url of ['', 'report.html', 'file:///C:/work/report.html']) {
      expect(() => browserRequest(['browser', 'open', url, '--panel'])).toThrow(/http\(s\)/);
    }
  });
});
