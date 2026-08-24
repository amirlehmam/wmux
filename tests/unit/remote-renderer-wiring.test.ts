import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'),
  'utf8',
);

describe('remote insertion renderer wiring', () => {
  it('passes dropped File objects to preload instead of renderer-resolved paths', () => {
    expect(source).toContain("resolveDrop(surfaceId ?? '', Array.from(files), ev.shiftKey)");
    expect(source).not.toContain("resolveDrop(surfaceId ?? '', localPaths");
  });

  it('applies late results only to the current terminal with the current translator', () => {
    expect(source).toContain('const currentTerminal = xtermRef.current');
    expect(source).toContain('if (!currentTerminal || !ptyIdRef.current) return');
    expect(source).toContain('translatorRef.current, result');
  });
});
