import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import {
  ensurePiContext,
  ensurePiExtension,
  getPiAgentDir,
  getPiContextFilePath,
  getPiExtensionPath,
  removePiContext,
  removePiExtension,
  PI_CONTEXT_FILE_NAMES,
} from '../../src/main/pi-context';
import { CLI_BIN_PLACEHOLDER } from '../../src/main/agent-instructions';

const require_ = createRequire(import.meta.url);
const { AGENTS } = require_('../../resources/wmux-orchestrator/scripts/launch-agent.js') as {
  AGENTS: Record<string, { bin: string; args: (p: string) => string[] }>;
};

/**
 * Issue #231: #165 was filed as "omp/pi" and closed once omp worked, which left
 * upstream pi out. They are separate harnesses with separate config roots, and
 * a pi pane sat on "Running" for as long as pi was open.
 *
 * The env-redirection approach is lifted from the Kiro and omp suites:
 * os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so a temp HOME
 * exercises what actually lands on disk with no module mocking — which is
 * necessary as well as preferable, since ESM namespaces are not spy-able.
 */
describe('#231 pi context', () => {
  let tmp: string;
  let saved: { USERPROFILE?: string; HOME?: string; PI_CODING_AGENT_DIR?: string };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-'));
    saved = {
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    delete process.env.PI_CODING_AGENT_DIR;
    expect(os.homedir()).toBe(tmp); // fail loudly if Node stops honouring this
  });

  afterEach(() => {
    for (const key of ['USERPROFILE', 'HOME', 'PI_CODING_AGENT_DIR'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const agentDir = () => path.join(tmp, '.pi', 'agent');
  const agentsMd = () => path.join(agentDir(), 'AGENTS.md');
  const read = (p = agentsMd()) => fs.readFileSync(p, 'utf-8');
  const write = (name: string, body: string) => {
    fs.mkdirSync(agentDir(), { recursive: true });
    fs.writeFileSync(path.join(agentDir(), name), body, 'utf-8');
  };

  it("targets pi's user-scope agent dir", () => {
    // The `agent` segment matters, as it does for omp: ~/.pi/ is ALSO the
    // project-local config directory name, and only the user-level files live
    // under agent/.
    expect(getPiAgentDir()).toBe(agentDir());
  });

  it('honours PI_CODING_AGENT_DIR, tilde included', () => {
    process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'elsewhere');
    expect(getPiAgentDir()).toBe(path.join(tmp, 'elsewhere'));
    process.env.PI_CODING_AGENT_DIR = '~/custom-pi';
    expect(getPiAgentDir()).toBe(path.join(tmp, 'custom-pi'));
  });

  it('creates AGENTS.md and the directories leading to it', () => {
    expect(fs.existsSync(agentsMd())).toBe(false);
    ensurePiContext();
    expect(fs.existsSync(agentsMd())).toBe(true);
    expect(read()).toContain('wmux browser open');
  });

  it('renders the CLI path like every other agent gets it (#158)', () => {
    ensurePiContext();
    expect(read()).not.toContain(CLI_BIN_PLACEHOLDER);
  });

  /**
   * The trap this module exists for.
   *
   * pi's loadContextFileFromDir takes the FIRST name that exists from
   * [AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD] and never
   * looks at the rest. Writing AGENTS.md unconditionally — which is what the
   * omp integration does, correctly, because omp has no such list — would
   * create a file, report success, and reach nobody.
   */
  it('splices into the file pi will actually read, not always AGENTS.md', () => {
    write('AGENTS.override.md', '# Override\n');
    expect(getPiContextFilePath()).toBe(path.join(agentDir(), 'AGENTS.override.md'));

    ensurePiContext();
    expect(read(path.join(agentDir(), 'AGENTS.override.md'))).toContain('wmux browser open');
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it('prefers the highest-priority existing file when several are present', () => {
    write('CLAUDE.md', '# Claude\n');
    expect(getPiContextFilePath()).toBe(path.join(agentDir(), 'CLAUDE.md'));
    write('AGENTS.md', '# Agents\n');
    expect(getPiContextFilePath()).toBe(agentsMd());
    write('AGENTS.override.md', '# Override\n');
    expect(getPiContextFilePath()).toBe(path.join(agentDir(), 'AGENTS.override.md'));
  });

  it('ignores a DIRECTORY that shares a candidate name', () => {
    // `statSync(...).isFile()` rather than existsSync: a directory called
    // AGENTS.md is not a context file, and writing to it throws EISDIR on every
    // launch instead of falling through to the name that works.
    fs.mkdirSync(path.join(agentDir(), 'AGENTS.override.md'), { recursive: true });
    expect(getPiContextFilePath()).toBe(agentsMd());
    expect(() => ensurePiContext()).not.toThrow();
    expect(read()).toContain('wmux browser open');
  });

  it("leaves the user's own instructions alone", () => {
    write('AGENTS.md', '# My rules\n\nAlways run the tests.\n');

    ensurePiContext();
    expect(read()).toContain('Always run the tests.');
    expect(read()).toContain('wmux browser open');

    removePiContext();
    expect(read()).toContain('Always run the tests.');
    expect(read()).not.toContain('wmux browser open');
  });

  it('is idempotent and does not churn the file', () => {
    ensurePiContext();
    const first = read();
    const mtime = fs.statSync(agentsMd()).mtimeMs;
    ensurePiContext();
    expect(read()).toBe(first);
    expect(fs.statSync(agentsMd()).mtimeMs).toBe(mtime);
  });

  it('replaces its own block rather than stacking copies', () => {
    ensurePiContext();
    ensurePiContext();
    expect(read().split('<!-- wmux:start').length - 1).toBe(1);
  });

  it('removes the file entirely when nothing of the user\'s is left', () => {
    ensurePiContext();
    removePiContext();
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  /**
   * An uninstall that cannot uninstall is the original #132 complaint.
   *
   * wmux writes AGENTS.md; the user later adds an AGENTS.override.md, which
   * changes which file `ensure` targets. A removal that only looked at today's
   * target would leave the old block orphaned in a file nothing reads and
   * nothing can ever clean up.
   */
  it('sweeps every candidate name on removal, not just the current target', () => {
    ensurePiContext();
    expect(fs.existsSync(agentsMd())).toBe(true);
    write('AGENTS.override.md', '# Override\n');
    expect(getPiContextFilePath()).not.toBe(agentsMd());

    removePiContext();
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it('never touches a candidate file that holds no wmux block', () => {
    write('AGENTS.md', '# Mine only\n');
    removePiContext();
    expect(read()).toBe('# Mine only\n');
  });

  it('tolerates being asked to remove what was never written', () => {
    expect(() => removePiContext()).not.toThrow();
  });

  it("mirrors pi's candidate list exactly, order included", () => {
    // Pinned as a literal because the ORDER is the load-bearing part; a future
    // reader diffs this against pi's loadContextFileFromDir.
    expect([...PI_CONTEXT_FILE_NAMES]).toEqual([
      'AGENTS.override.md',
      'AGENTS.md',
      'AGENTS.MD',
      'CLAUDE.md',
      'CLAUDE.MD',
    ]);
  });
});

describe('#231 pi extension install', () => {
  let tmp: string;
  let saved: { USERPROFILE?: string; HOME?: string };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-ext-'));
    saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    for (const key of ['USERPROFILE', 'HOME'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const dest = () => path.join(tmp, '.pi', 'agent', 'extensions', 'wmux.js');

  it('installs into the global extensions dir pi auto-discovers', () => {
    expect(getPiExtensionPath()).toBe(dest());
    ensurePiExtension();
    expect(fs.existsSync(dest())).toBe(true);
    expect(fs.readFileSync(dest(), 'utf-8')).toContain('wmux-plugin-version:');
  });

  it('is idempotent once the marker matches', () => {
    ensurePiExtension();
    const mtime = fs.statSync(dest()).mtimeMs;
    ensurePiExtension();
    expect(fs.statSync(dest()).mtimeMs).toBe(mtime);
  });

  it('reinstalls when the marker differs', () => {
    fs.mkdirSync(path.dirname(dest()), { recursive: true });
    fs.writeFileSync(dest(), '// wmux-plugin-version: 0\n// stale\n', 'utf-8');
    ensurePiExtension();
    expect(fs.readFileSync(dest(), 'utf-8')).not.toContain('// stale');
  });

  it('removes only a file it recognises as its own', () => {
    ensurePiExtension();
    removePiExtension();
    expect(fs.existsSync(dest())).toBe(false);

    // A wmux.js the user wrote themselves carries no marker and must survive:
    // uninstalling wmux's integration is not a licence to delete a file that
    // merely shares a name.
    fs.mkdirSync(path.dirname(dest()), { recursive: true });
    fs.writeFileSync(dest(), 'export default () => {};\n', 'utf-8');
    removePiExtension();
    expect(fs.existsSync(dest())).toBe(true);
  });

  it('tolerates being asked to remove what was never installed', () => {
    expect(() => removePiExtension()).not.toThrow();
  });
});

describe('#231 orchestrator can launch pi workers', () => {
  it('knows pi alongside claude, opencode and omp', () => {
    expect(Object.keys(AGENTS)).toEqual(
      expect.arrayContaining(['claude', 'opencode', 'omp', 'pi']),
    );
    expect(AGENTS.pi.bin).toBe('pi');
  });

  it('keeps the prompt out of the flag parser', () => {
    for (const agent of Object.values(AGENTS)) {
      const args = agent.args('--not-a-flag');
      expect(args[args.length - 2]).toBe('--');
      expect(args[args.length - 1]).toBe('--not-a-flag');
    }
  });
});
