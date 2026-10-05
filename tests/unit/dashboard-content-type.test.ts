import { describe, expect, it } from 'vitest';
import { correctedDashboardHeaders, DASHBOARD_HEADER_FILTER } from '../../src/main/dashboard-content-type';

const DEEP_LINK = 'http://127.0.0.1:4848/?port=9301';
const OCTET = { 'content-type': ['application/octet-stream'], 'content-length': ['16987'] };

describe('correctedDashboardHeaders (#269)', () => {
  it('relabels the dashboard deep link as HTML and keeps the other headers', () => {
    expect(correctedDashboardHeaders(DEEP_LINK, 'mainFrame', OCTET)).toEqual({
      'content-length': ['16987'],
      'Content-Type': ['text/html; charset=utf-8'],
    });
  });

  it('matches the header name in any case and drops a Content-Disposition', () => {
    const out = correctedDashboardHeaders(DEEP_LINK, 'subFrame', {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': ['attachment'],
    });
    expect(out).toEqual({ 'Content-Type': ['text/html; charset=utf-8'] });
  });

  it('covers an extensionless SPA route, not only the root', () => {
    expect(correctedDashboardHeaders('http://127.0.0.1:4848/sessions?port=9301', 'mainFrame', OCTET)).not.toBeNull();
  });

  it.each([
    ['an asset with an extension', 'http://127.0.0.1:4848/assets/app.js?port=1', 'mainFrame'],
    ['another port', 'http://127.0.0.1:9301/?port=9301', 'mainFrame'],
    ['another host', 'http://localhost:4848/?port=9301', 'mainFrame'],
    ['https', 'https://127.0.0.1:4848/?port=9301', 'mainFrame'],
    ['a subresource', DEEP_LINK, 'xhr'],
    ['an unparseable url', 'not a url', 'mainFrame'],
  ])('leaves %s alone', (_label, url, type) => {
    expect(correctedDashboardHeaders(url, type, OCTET)).toBeNull();
  });

  it('leaves a correctly labelled response alone', () => {
    expect(correctedDashboardHeaders(DEEP_LINK, 'mainFrame', { 'content-type': ['text/html; charset=utf-8'] })).toBeNull();
    expect(correctedDashboardHeaders(DEEP_LINK, 'mainFrame', {})).toBeNull();
    expect(correctedDashboardHeaders(DEEP_LINK, 'mainFrame', undefined)).toBeNull();
  });

  it('registers on a portless loopback pattern, so the port check is in code', () => {
    expect(DASHBOARD_HEADER_FILTER.urls).toEqual(['http://127.0.0.1/*']);
  });
});
