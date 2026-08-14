import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import {
  ensureOmpContext,
  removeOmpContext,
  getOmpAgentsMdPath,
} from '../../src/main/omp-context';
import { CLI_BIN_PLACEHOLDER, injectWmuxBlock } from '../../src/main/agent-instructions';

const require_ = createRequire(import.meta.url);
const { AGENTS } = require_('../../resources/wmux-orchestrator/scripts/launch-agent.js') as {
  AGENTS: Record<string, { bin: string; args: (p: string) => string[] }>;
};

/**
 * Issue #165: a team running omp (Oh My Pi) on Windows 11 read wmux as
 * "only for Claude". omp's `native` discovery provider reads
 * ~/.omp/agent/AGENTS.md at user scope for every session, at the highest
 * discovery priority of any provider — so that is where the block belongs.
 */
describe('#165 omp context', () => {
  let tmp: string;
  let saved: { USERPROFILE?: string; HOME?: string };

  // Same approach as the Kiro suite: os.homedir() reads USERPROFILE on Windows
  // and HOME elsewhere, so redirecting the env gives a real temp HOME with no
  // module mocking — which is necessary as well as preferable, since ESM
  // namespaces are not spy-able and the point of these tests is what ends up
  // on disk.
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-omp-'));
    saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    expect(os.homedir()).toBe(tmp); // fail loudly if Node stops honouring this
  });

  afterEach(() => {
    for (const key of ['USERPROFILE', 'HOME'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const agentsMd = () => path.join(tmp, '.omp', 'agent', 'AGENTS.md');
  const read = () => fs.readFileSync(agentsMd(), 'utf-8');

  it('targets omp\'s user-scope native context file', () => {
    // The `agent` segment matters: ~/.omp/ is ALSO the project-local directory
    // name, and only the user-level file is nested under agent/.
    expect(getOmpAgentsMdPath()).toBe(agentsMd());
  });

  it('creates the file and the directories leading to it', () => {
    expect(fs.existsSync(agentsMd())).toBe(false);
    ensureOmpContext();
    expect(fs.existsSync(agentsMd())).toBe(true);
    expect(read()).toContain('wmux browser open');
  });

  it('renders the CLI path like every other agent gets it (#158)', () => {
    ensureOmpContext();
    expect(read()).not.toContain(CLI_BIN_PLACEHOLDER);
  });

  it('leaves the user\'s own instructions alone', () => {
    // Unlike Kiro's steering file, this one is shared — omp reads a single
    // AGENTS.md that the user may well have written in. So it is spliced, and
    // everything outside the markers survives both directions.
    fs.mkdirSync(path.dirname(agentsMd()), { recursive: true });
    fs.writeFileSync(agentsMd(), '# My rules\n\nAlways run the tests.\n');

    ensureOmpContext();
    expect(read()).toContain('Always run the tests.');
    expect(read()).toContain('wmux browser open');

    removeOmpContext();
    expect(read()).toContain('Always run the tests.');
    expect(read()).not.toContain('wmux browser open');
  });

  it('is idempotent and does not churn the file', () => {
    // omp watches these files; rewriting an identical file on every launch
    // would re-trigger discovery for nothing.
    ensureOmpContext();
    const first = read();
    const mtime = fs.statSync(agentsMd()).mtimeMs;
    ensureOmpContext();
    expect(read()).toBe(first);
    expect(fs.statSync(agentsMd()).mtimeMs).toBe(mtime);
  });

  it('replaces its own block rather than stacking copies', () => {
    ensureOmpContext();
    ensureOmpContext();
    const occurrences = read().split('<!-- wmux:start').length - 1;
    expect(occurrences).toBe(1);
  });

  it('removes the file entirely when nothing of the user\'s is left', () => {
    // #132's inverse requirement. A file that exists only because wmux wrote it
    // should not survive as a stray artefact of an integration just switched off.
    ensureOmpContext();
    removeOmpContext();
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it('tolerates being asked to remove what was never written', () => {
    expect(() => removeOmpContext()).not.toThrow();
  });

  it('re-splicing is a fixed point, not a file that grows every launch', () => {
    // The copy first written for omp dropped the block's trimEnd(), so the
    // block's trailing newline and the tail's own newline both survived and the
    // file gained one blank line per launch — in a document the agent loads
    // into context on every session. Asserted at the splice level as well as
    // through the file, because this is the property that has to hold.
    // Markers are what make the block re-findable, so the fixture needs them —
    // and the trailing newline is the whole point of the test.
    const block = '<!-- wmux:start -->\nhi\n<!-- wmux:end -->\n';
    const once = injectWmuxBlock('# Mine\n', block, s => s);
    const twice = injectWmuxBlock(once, block, s => s);
    expect(twice).toBe(once);
    expect(injectWmuxBlock(twice, block, s => s)).toBe(once);
  });

  it('appends when there is no block yet', () => {
    expect(injectWmuxBlock('', 'BLOCK', s => s)).toBe('BLOCK');
    expect(injectWmuxBlock('user text\n', 'BLOCK', s => s)).toBe('user text\n\nBLOCK');
  });
});

describe('#165 orchestrator can launch omp workers', () => {
  it('knows omp alongside claude and opencode', () => {
    expect(Object.keys(AGENTS)).toEqual(expect.arrayContaining(['claude', 'opencode', 'omp']));
    expect(AGENTS.omp.bin).toBe('omp');
  });

  it('keeps the prompt out of the flag parser', () => {
    // A prompt starting with '-' would otherwise be read as a flag by every one
    // of the three.
    for (const agent of Object.values(AGENTS)) {
      const args = agent.args('--not-a-flag');
      expect(args[args.length - 2]).toBe('--');
      expect(args[args.length - 1]).toBe('--not-a-flag');
    }
  });
});
