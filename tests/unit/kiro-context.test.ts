import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  ensureKiroContext,
  removeKiroContext,
  getKiroSteeringPath,
  isWmuxManaged,
} from '../../src/main/kiro-context';
import { CLI_BIN_PLACEHOLDER, renderInstructions } from '../../src/main/agent-instructions';

/**
 * Issue #148 — Kiro CLI support.
 *
 * These drive the real filesystem against a throwaway HOME rather than mocking
 * fs, because the properties that matter are all about what is on disk
 * afterwards: that the steering file lands where Kiro actually reads it, that a
 * file wmux did not write is never touched, and that switching the integration
 * off leaves nothing behind (#132's inverse requirement).
 */
describe('#148 Kiro steering', () => {
  let home: string;
  let saved: { USERPROFILE?: string; HOME?: string };

  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so redirecting
  // the env gives a real temp HOME with no module mocking — which matters here,
  // since ESM namespaces are not spy-able and the point of these tests is the
  // actual on-disk result.
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-kiro-'));
    saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    expect(os.homedir()).toBe(home); // fail loudly if Node stops honouring this
  });

  afterEach(() => {
    for (const key of ['USERPROFILE', 'HOME'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const steering = () => path.join(home, '.kiro', 'steering', 'wmux.md');
  const read = () => fs.readFileSync(steering(), 'utf-8');

  it('targets the global steering dir Kiro CLI loads automatically', () => {
    // ~/.kiro/steering/ applies to every workspace; .kiro/steering/ in a project
    // is the user's, and writing there would be the #132 mistake.
    expect(getKiroSteeringPath()).toBe(steering());
  });

  it('writes the instructions, creating the steering dir', () => {
    expect(fs.existsSync(steering())).toBe(false);
    ensureKiroContext();
    expect(fs.existsSync(steering())).toBe(true);
    expect(read()).toContain('wmux browser open');
  });

  it('writes the same marker-wrapped block the other agents get', () => {
    ensureKiroContext();
    const written = read();
    // Compared against the RENDERED block, not the raw resource: since #158 the
    // source carries a placeholder for this install's CLI path, so the file on
    // disk is deliberately not byte-identical to it. What must still hold is
    // that Kiro gets exactly what the other two writers get.
    const source = renderInstructions(
      fs.readFileSync(path.join(__dirname, '../../resources/claude-instructions.md'), 'utf-8'),
    );
    expect(written.trimEnd()).toBe(source.trimEnd());
    expect(isWmuxManaged(written)).toBe(true);
  });

  it('leaves no unsubstituted placeholder in the steering file (issue #158)', () => {
    // A placeholder that reached disk would hand the reader a literal
    // "{{WMUX_CLI_BIN}}/wmux ping" to run, which is worse than the ambiguity it
    // was added to remove.
    ensureKiroContext();
    expect(read()).not.toContain(CLI_BIN_PLACEHOLDER);
  });

  it('is idempotent and does not churn the file', () => {
    ensureKiroContext();
    const first = read();
    const mtime = fs.statSync(steering()).mtimeMs;
    ensureKiroContext();
    expect(read()).toBe(first);
    expect(fs.statSync(steering()).mtimeMs).toBe(mtime);
  });

  it('refuses to overwrite a wmux.md the user wrote themselves', () => {
    fs.mkdirSync(path.dirname(steering()), { recursive: true });
    fs.writeFileSync(steering(), '# my own steering\nprefer tabs\n');
    ensureKiroContext();
    expect(read()).toBe('# my own steering\nprefer tabs\n');
  });

  it('removes what it wrote', () => {
    ensureKiroContext();
    expect(fs.existsSync(steering())).toBe(true);
    removeKiroContext();
    expect(fs.existsSync(steering())).toBe(false);
  });

  it('leaves an unmanaged wmux.md alone on removal', () => {
    fs.mkdirSync(path.dirname(steering()), { recursive: true });
    fs.writeFileSync(steering(), '# mine\n');
    removeKiroContext();
    expect(fs.existsSync(steering())).toBe(true);
  });

  it('removal is a no-op when nothing was ever written', () => {
    expect(() => removeKiroContext()).not.toThrow();
    expect(fs.existsSync(path.join(home, '.kiro'))).toBe(false);
  });

  it('round-trips: enable, disable, enable again', () => {
    ensureKiroContext();
    const first = read();
    removeKiroContext();
    ensureKiroContext();
    expect(read()).toBe(first);
  });
});

describe('isWmuxManaged', () => {
  it('recognises the wmux marker', () => {
    expect(isWmuxManaged('<!-- wmux:start v1 -->\nx')).toBe(true);
  });
  it('treats an unmarked file as the user\'s', () => {
    expect(isWmuxManaged('# my notes')).toBe(false);
  });
});
