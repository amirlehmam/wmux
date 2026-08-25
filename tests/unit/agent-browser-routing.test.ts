import { describe, it, expect } from 'vitest';
import { engineOf } from '../../src/shared/types';
import type { SurfaceRef } from '../../src/shared/types';

describe('engineOf', () => {
  it('defaults an undefined engine to web', () => {
    const s = { id: 'surf-1', type: 'browser' } as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });

  it('returns an explicit engine', () => {
    const s = { id: 'surf-1', type: 'browser', browserEngine: 'agent' } as SurfaceRef;
    expect(engineOf(s)).toBe('agent');
  });

  it('treats a non-browser surface as web', () => {
    const s = { id: 'surf-1', type: 'terminal', browserEngine: 'agent' } as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });

  it('rejects an unknown engine string from a hand-edited session file', () => {
    const s = { id: 'surf-1', type: 'browser', browserEngine: 'evil' } as unknown as SurfaceRef;
    expect(engineOf(s)).toBe('web');
  });
});
