import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import {
  ensurePiExtension,
  getPiAgentDir,
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

const BOTH = { instructions: true, hooks: true };
const BLOCK = '<!-- wmux:start -->\nold instructions\n<!-- wmux:end -->';

describe('Pi scoped instruction installation', () => {
  let tmp: string;
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-'));
    saved = { ...process.env };
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    delete process.env.PI_CODING_AGENT_DIR;
    expect(os.homedir()).toBe(tmp);
  });

  afterEach(() => {
    for (const key of ['USERPROFILE', 'HOME', 'PI_CODING_AGENT_DIR', 'WMUX', 'WMUX_SURFACE_ID', 'PI_IMAGE_PROTOCOL']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const agentDir = () => path.join(tmp, '.pi', 'agent');
  const dest = () => path.join(agentDir(), 'extensions', 'wmux', 'index.js');
  const reference = () => path.join(path.dirname(dest()), 'reference.md');
  const legacy = () => path.join(agentDir(), 'extensions', 'wmux.js');
  const read = (file = dest()) => fs.readFileSync(file, 'utf-8');
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf-8');
  };

  it('honours the agent directory override, including tilde expansion', () => {
    expect(getPiAgentDir()).toBe(agentDir());
    expect(getPiExtensionPath()).toBe(dest());
    process.env.PI_CODING_AGENT_DIR = '~/custom-pi';
    expect(getPiAgentDir()).toBe(path.join(tmp, 'custom-pi'));
    process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'elsewhere');
    ensurePiExtension(BOTH);
    expect(fs.existsSync(getPiExtensionPath())).toBe(true);
    expect(fs.existsSync(dest())).toBe(false);
  });

  it('installs compact rules and a separate detailed reference, without a presence probe or global context', async () => {
    ensurePiExtension(BOTH);
    const guide = read(reference());
    expect(guide).toContain('wmux browser snapshot');
    expect(guide).toContain('wmux markdown set');
    expect(guide).toContain('wmux report-agent');
    expect(guide).not.toContain('wmux ping');
    expect(guide).not.toContain(CLI_BIN_PLACEHOLDER);
    for (const name of PI_CONTEXT_FILE_NAMES) expect(fs.existsSync(path.join(agentDir(), name))).toBe(false);

    process.env.WMUX = '1';
    process.env.WMUX_SURFACE_ID = 'surf-test';
    const factory = (await import(/* @vite-ignore */ dest())).default;
    const handlers = new Map();
    factory({ on: (name: string, handler: unknown) => handlers.set(name, handler) });
    const event = { systemPromptOptions: { sections: { personal: 'keep me' } } };
    handlers.get('before_agent_start')(event);
    const sections = event.systemPromptOptions.sections as Record<string, string>;
    expect(sections.personal).toBe('keep me');
    expect(sections.wmux).toContain(reference());
    expect(sections.wmux).toContain('wmux browser');
    expect(sections.wmux).toContain('wmux markdown');
    expect(sections.wmux).toContain('--blocked');
    expect(sections.wmux).toContain('--unblocked');
    expect(sections.wmux).toContain('wmux report-subagent');
    expect(sections.wmux).not.toContain('wmux ping');
    expect(sections.wmux).not.toContain('wmux browser snapshot');
    expect(sections.wmux.length).toBeLessThan(guide.length / 2);
  });

  it('does not rewrite unchanged files, but updates consent even at the same version', () => {
    ensurePiExtension(BOTH);
    const source = read();
    const times = [dest(), reference()].map(file => fs.statSync(file).mtimeMs);
    ensurePiExtension(BOTH);
    expect([dest(), reference()].map(file => fs.statSync(file).mtimeMs)).toEqual(times);
    ensurePiExtension({ instructions: false, hooks: true });
    expect(read()).not.toBe(source);
    expect(read()).toContain('"instructions":"","hooks":true');
    expect(fs.statSync(reference()).mtimeMs).toBe(times[1]);
  });

  it('installs the complete extension even for hooks-only consent, then removes the legacy entry point', () => {
    write(legacy(), '// wmux-plugin-version: 0\n// stale\n');
    ensurePiExtension({ instructions: false, hooks: true });
    expect(read()).toContain('"instructions":"","hooks":true');
    expect(fs.existsSync(legacy())).toBe(false);
    expect(fs.existsSync(reference())).toBe(true);
  });

  it.each(['legacy', 'directory'])('does not overwrite an unmanaged %s extension', (layout) => {
    const file = layout === 'legacy' ? legacy() : dest();
    write(file, 'export default () => {};\n');
    ensurePiExtension(BOTH);
    expect(read(file)).toBe('export default () => {};\n');
    expect(fs.existsSync(reference())).toBe(false);
    removePiExtension();
    expect(fs.existsSync(file)).toBe(true);
  });

  it.each(['index.ts', 'package.json'])('keeps the legacy extension when %s would shadow its replacement', (entry) => {
    write(legacy(), '// wmux-plugin-version: 0\n');
    const other = path.join(path.dirname(dest()), entry);
    write(other, entry === 'package.json' ? '{"pi":{"extensions":["custom.js"]}}' : 'export default () => {};\n');
    if (entry === 'package.json') write(path.join(path.dirname(dest()), 'custom.js'), 'export default () => {};\n');
    ensurePiExtension(BOTH);
    expect(fs.existsSync(legacy())).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(dest())).toBe(false);
    expect(fs.existsSync(reference())).toBe(false);
  });

  it('keeps an unmanaged reference and installs hooks without pointing instructions at it', () => {
    write(reference(), '# My reference\n');
    ensurePiExtension(BOTH);
    expect(read(reference())).toBe('# My reference\n');
    expect(read()).toContain('"instructions":"","hooks":true');
    removePiExtension();
    expect(read(reference())).toBe('# My reference\n');
  });

  it('does not remove the legacy entry point if replacement installation fails', () => {
    write(legacy(), '// wmux-plugin-version: 0\n');
    fs.mkdirSync(dest(), { recursive: true });
    ensurePiExtension(BOTH);
    expect(fs.existsSync(legacy())).toBe(true);
  });

  it('removes managed files and the empty directory, preserving other directory contents', () => {
    ensurePiExtension(BOTH);
    const personal = path.join(path.dirname(dest()), 'notes.md');
    write(personal, 'mine');
    removePiExtension();
    expect(fs.existsSync(dest())).toBe(false);
    expect(fs.existsSync(reference())).toBe(false);
    expect(read(personal)).toBe('mine');
    fs.unlinkSync(personal);
    ensurePiExtension(BOTH);
    removePiExtension();
    expect(fs.existsSync(path.dirname(dest()))).toBe(false);
    expect(() => removePiExtension()).not.toThrow();
  });

  it('does not remove an empty directory it did not create', () => {
    fs.mkdirSync(path.dirname(dest()), { recursive: true });
    removePiExtension();
    expect(fs.existsSync(path.dirname(dest()))).toBe(true);
  });

  it('cleans up managed legacy entry points even without a directory installation', () => {
    write(legacy(), '// wmux-plugin-version: 0\n');
    removePiExtension();
    expect(fs.existsSync(legacy())).toBe(false);
  });

  it('migrates every legacy context filename while preserving user text', () => {
    for (const name of PI_CONTEXT_FILE_NAMES) write(path.join(agentDir(), name), `# Mine\n\n${BLOCK}\n\nKeep this.\n`);
    removePiContext();
    for (const name of PI_CONTEXT_FILE_NAMES) {
      expect(read(path.join(agentDir(), name))).toBe('# Mine\n\nKeep this.\n');
    }
  });

  it('removes a context file containing only the old block and leaves unmanaged files untouched', () => {
    const agents = path.join(agentDir(), 'AGENTS.md');
    const override = path.join(agentDir(), 'AGENTS.override.md');
    write(agents, BLOCK);
    write(override, '# Mine\n');
    const mtime = fs.statSync(override).mtimeMs;
    removePiContext();
    expect(fs.existsSync(agents)).toBe(false);
    expect(read(override)).toBe('# Mine\n');
    expect(fs.statSync(override).mtimeMs).toBe(mtime);
    expect(() => removePiContext()).not.toThrow();
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
