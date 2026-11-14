import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import {
  CLI_BIN_PLACEHOLDER,
  buildContextStub,
  buildSkillFile,
  getInstructionsPath,
  renderInstructions,
} from '../../src/main/agent-instructions';

/**
 * Issue #158: the probe the block hands its reader could not tell "wmux is not
 * running" from "this session cannot reach the wmux CLI", and the block told
 * the reader to assume the first.
 *
 * That is the common case, not the exotic one. wmux only puts `wmux` on PATH
 * for PTYs it spawns itself — nothing is persisted to the user's PATH — so
 * every session wmux did not spawn (a desktop app, a plain terminal, SSH, a
 * scheduled run) hits "command not found" while wmux is running perfectly well.
 * Those are precisely the sessions the block is written GLOBALLY to reach.
 */
describe('agent instruction block (issue #158)', () => {
  const raw = fs.readFileSync(getInstructionsPath(), 'utf-8');

  it('separates "not found" from "did not answer"', () => {
    // The old text collapsed three symptoms into one conclusion:
    //   "command not found, no reply, or an error → wmux is not running"
    expect(raw).not.toMatch(/command not found, no reply, or an error/);
    // No FIRST answer is evidence of absence: not found is the normal state
    // off a wmux pane (#158), and a bare `wmux` may be another app's CLI
    // (#282). Anything but `pong` goes to the absolute probe first.
    expect(raw).toMatch(/anything else[^]*do not\s+conclude yet/i);
  });

  it('gives the reader a second probe that does not depend on PATH', () => {
    expect(raw).toContain(CLI_BIN_PLACEHOLDER);
    // The fallback probe must be the placeholder plus the same verb, so a
    // session off PATH has something concrete to run rather than advice.
    expect(raw).toMatch(new RegExp(`${CLI_BIN_PLACEHOLDER.replace(/[{}]/g, '\\$&')}/wmux" ping`));
  });

  it('substitutes the install path, leaving no placeholder behind', () => {
    const out = renderInstructions(raw, 'C:\\Program Files\\wmux\\resources\\cli-bin');
    expect(out).not.toContain(CLI_BIN_PLACEHOLDER);
    expect(out).toContain('C:\\Program Files\\wmux\\resources\\cli-bin/wmux" ping');
  });

  it('substitutes every occurrence, not just the first', () => {
    const doubled = `a ${CLI_BIN_PLACEHOLDER} b ${CLI_BIN_PLACEHOLDER} c`;
    expect(renderInstructions(doubled, '/x')).toBe('a /x b /x c');
  });

  it('is a plain substitution, so a $-bearing install path survives intact', () => {
    // String.replace treats $& / $1 in the REPLACEMENT specially. A Windows
    // path can contain '$' (a hidden share, an env-expanded dir), and mangling
    // the path here would hand the reader a probe that cannot work.
    const weird = 'C:\\Users\\a$&b\\cli-bin';
    expect(renderInstructions(CLI_BIN_PLACEHOLDER, weird)).toBe(weird);
  });

  it('still tells a session with no wmux at all to stand down', () => {
    // The block must not become a machine for insisting wmux is present. If the
    // absolute probe also fails, the reader is told plainly to use normal tools.
    expect(raw).toMatch(/If it too does not answer `pong`, wmux is not\s+running for this\s+session/);
    expect(raw).toMatch(/Nothing here is a\s+restriction on what you may otherwise do/);
  });
});

describe('locked panes in the always-loaded instruction text', () => {
  const raw = fs.readFileSync(getInstructionsPath(), 'utf-8');

  const skillDescription = (): string => {
    const skill = buildSkillFile(renderInstructions(raw, '/cli-bin'));
    const line = skill.split('\n').find((l) => l.startsWith('description: '));
    expect(line).toBeDefined();
    return JSON.parse(line!.slice('description: '.length)) as string;
  };

  it('names the spawn and placement verbs where a lock changes the outcome in the skill description', () => {
    const description = skillDescription();
    for (const verb of ['wmux agent spawn', 'wmux new-surface', 'wmux layout grid']) {
      expect(description).toContain(verb);
    }
    expect(description).toMatch(/locked/i);
  });

  it('keeps the description as the existing triggers plus the lock, not a replacement', () => {
    const description = skillDescription();
    for (const kept of ['wmux ping', 'wmux browser', 'wmux markdown', 'wmux report-agent', 'wmux report-subagent']) {
      expect(description).toContain(kept);
    }
  });

  it('lists spawning and opening tabs among the moments to look in the stub', () => {
    const stub = buildContextStub('/cli-bin', '/skills/wmux/SKILL.md');
    expect(stub).toMatch(/spawn agents or open tabs/);
    expect(stub).toMatch(/locked/i);
  });

  it('says in the Locked panes section that wmux markdown skips locked panes too', () => {
    const section = raw.split(/^## /m).find((s) => s.startsWith('Locked panes'));
    expect(section).toBeDefined();
    expect(section).toMatch(/`wmux markdown <file>`[^]*skips locked panes/);
  });
});
