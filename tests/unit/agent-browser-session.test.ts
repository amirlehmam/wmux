import { describe, it, expect } from 'vitest';
import { SessionRegistry, sessionNameFor, DASHBOARD_PORT } from '../../src/main/agent-browser-session';

describe('sessionNameFor', () => {
  it('derives a stable name from the surface id', () => {
    expect(sessionNameFor('surf-abc123' as any)).toBe('wmux-surf-abc123');
    expect(sessionNameFor('surf-abc123' as any)).toBe('wmux-surf-abc123');
  });

  it('namespaces wmux sessions so the reaper can recognise its own', () => {
    expect(sessionNameFor('surf-x' as any).startsWith('wmux-')).toBe(true);
  });

  it('throws on a surface id starting with a dash (would parse as a flag)', () => {
    expect(() => sessionNameFor('-rf' as any)).toThrow();
  });

  it('throws on a surface id containing whitespace', () => {
    expect(() => sessionNameFor('surf-abc 123' as any)).toThrow();
  });

  it('throws on a surface id containing a path separator', () => {
    expect(() => sessionNameFor('surf-abc/../etc' as any)).toThrow();
    expect(() => sessionNameFor('surf-abc\\..\\etc' as any)).toThrow();
  });

  it('throws on an empty surface id', () => {
    expect(() => sessionNameFor('' as any)).toThrow();
  });

  it('throws on a surface id over the length bound', () => {
    const tooLong = `surf-${'a'.repeat(129)}`;
    expect(() => sessionNameFor(tooLong as any)).toThrow();
  });
});

describe('SessionRegistry', () => {
  it('assigns a distinct stream port per surface', () => {
    const r = new SessionRegistry(9300);
    const a = r.ensure('surf-a' as any);
    const b = r.ensure('surf-b' as any);
    expect(a.streamPort).toBe(9300);
    expect(b.streamPort).toBe(9301);
    expect(a.sessionName).not.toBe(b.sessionName);
  });

  it('is idempotent for the same surface, returning the SAME object', () => {
    const r = new SessionRegistry(9300);
    expect(r.ensure('surf-a' as any)).toBe(r.ensure('surf-a' as any));
  });

  it('deep-links the dashboard to the session stream port', () => {
    const r = new SessionRegistry(9300);
    expect(r.ensure('surf-a' as any).dashboardUrl)
      .toBe(`http://127.0.0.1:${DASHBOARD_PORT}/?port=9300`);
  });

  it('releases a port so a later surface can reuse it', () => {
    const r = new SessionRegistry(9300);
    r.ensure('surf-a' as any);
    r.ensure('surf-b' as any);
    r.release('surf-a' as any);
    expect(r.ensure('surf-c' as any).streamPort).toBe(9300);
  });

  it('reports nothing for a surface it has never seen', () => {
    expect(new SessionRegistry(9300).get('surf-nope' as any)).toBeUndefined();
  });

  it('lists live sessions so teardown can close them all', () => {
    const r = new SessionRegistry(9300);
    r.ensure('surf-a' as any);
    r.ensure('surf-b' as any);
    expect(r.all().map((s) => s.sessionName).sort()).toEqual(['wmux-surf-a', 'wmux-surf-b']);
  });

  it('tracks size across ensure and release', () => {
    const r = new SessionRegistry(9300);
    expect(r.size).toBe(0);
    r.ensure('surf-a' as any);
    expect(r.size).toBe(1);
    r.ensure('surf-b' as any);
    expect(r.size).toBe(2);
    r.ensure('surf-a' as any); // idempotent, does not grow size
    expect(r.size).toBe(2);
    r.release('surf-a' as any);
    expect(r.size).toBe(1);
  });
});
