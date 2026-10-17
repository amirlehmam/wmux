import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import {
  ensureOmpContext,
  removeOmpContext,
  getOmpAgentDir,
  getOmpAgentsMdPath,
  ensureOmpExtension,
  removeOmpExtension,
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
  let saved: { USERPROFILE?: string; HOME?: string; PI_CODING_AGENT_DIR?: string; PI_CONFIG_DIR?: string };

  // Same approach as the Kiro suite: os.homedir() reads USERPROFILE on Windows
  // and HOME elsewhere, so redirecting the env gives a real temp HOME with no
  // module mocking — which is necessary as well as preferable, since ESM
  // namespaces are not spy-able and the point of these tests is what ends up
  // on disk.
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-omp-'));
    saved = {
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
    };
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CONFIG_DIR;
    expect(os.homedir()).toBe(tmp); // fail loudly if Node stops honouring this
  });

  afterEach(() => {
    for (const key of ['USERPROFILE', 'HOME', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR'] as const) {
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
  it('installs and removes only its own status extension', () => {
    const extension = path.join(tmp, '.omp', 'agent', 'extensions', 'wmux.js');
    ensureOmpExtension();
    expect(fs.readFileSync(extension, 'utf-8')).toContain('wmux-plugin-version:');
    const mtime = fs.statSync(extension).mtimeMs;
    ensureOmpExtension();
    expect(fs.statSync(extension).mtimeMs).toBe(mtime);
    removeOmpExtension();
    expect(fs.existsSync(extension)).toBe(false);
  });

  it('does not overwrite or delete a user-owned extension', () => {
    const extension = path.join(tmp, '.omp', 'agent', 'extensions', 'wmux.js');
    fs.mkdirSync(path.dirname(extension), { recursive: true });
    fs.writeFileSync(extension, 'export default function mine() {}');
    ensureOmpExtension();
    removeOmpExtension();
    expect(fs.readFileSync(extension, 'utf-8')).toBe('export default function mine() {}');
  });

  it('honours PI_CODING_AGENT_DIR for both the context file and the extension', () => {
    const agentDir = path.join(tmp, 'elsewhere');
    process.env.PI_CODING_AGENT_DIR = agentDir;
    expect(getOmpAgentDir()).toBe(agentDir);
    expect(getOmpAgentsMdPath()).toBe(path.join(agentDir, 'AGENTS.md'));

    ensureOmpContext();
    ensureOmpExtension();
    expect(fs.readFileSync(path.join(agentDir, 'AGENTS.md'), 'utf-8')).toContain('wmux browser open');
    const extension = path.join(agentDir, 'extensions', 'wmux.js');
    expect(fs.readFileSync(extension, 'utf-8')).toContain('wmux-plugin-version:');
    // Nothing is written into the default root while the override is set.
    expect(fs.existsSync(path.join(tmp, '.omp'))).toBe(false);

    removeOmpContext();
    removeOmpExtension();
    expect(fs.existsSync(path.join(agentDir, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(extension)).toBe(false);
  });

  it('expands a leading ~ in PI_CODING_AGENT_DIR the way omp does', () => {
    process.env.PI_CODING_AGENT_DIR = '~/custom-omp';
    expect(getOmpAgentDir()).toBe(path.join(tmp, 'custom-omp'));
  });

  it('nests the agent dir under PI_CONFIG_DIR, and PI_CODING_AGENT_DIR still wins', () => {
    process.env.PI_CONFIG_DIR = '.omp-dev';
    expect(getOmpAgentDir()).toBe(path.join(tmp, '.omp-dev', 'agent'));

    process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'elsewhere');
    expect(getOmpAgentDir()).toBe(path.join(tmp, 'elsewhere'));
  });

  it('installs and removes the extension under PI_CONFIG_DIR without touching the default root', () => {
    process.env.PI_CONFIG_DIR = '.omp-dev';
    const agentDir = path.join(tmp, '.omp-dev', 'agent');
    ensureOmpExtension();
    const extension = path.join(agentDir, 'extensions', 'wmux.js');
    expect(fs.readFileSync(extension, 'utf-8')).toContain('wmux-plugin-version:');
    expect(fs.existsSync(path.join(tmp, '.omp', 'agent', 'extensions', 'wmux.js'))).toBe(false);
    removeOmpExtension();
    expect(fs.existsSync(extension)).toBe(false);
  });

  it('protects a user-owned extension under a custom agent dir too', () => {
    process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'elsewhere');
    const extension = path.join(tmp, 'elsewhere', 'extensions', 'wmux.js');
    fs.mkdirSync(path.dirname(extension), { recursive: true });
    fs.writeFileSync(extension, 'export default function mine() {}');
    ensureOmpExtension();
    removeOmpExtension();
    expect(fs.readFileSync(extension, 'utf-8')).toBe('export default function mine() {}');
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
