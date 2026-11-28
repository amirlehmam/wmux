import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultHermesHome,
  ensureHermesPlugin,
  findHermesExecutable,
  getHermesHome,
  getHermesPluginDir,
  hermesConfigEnablesWmux,
  removeHermesPlugin,
} from '../../src/main/hermes-context';
import { INTEGRATION_CONSENT_DETAIL } from '../../src/main/agent-integration';
import { identifyAgentCommand } from '../../src/main/agent-argv';
import { isFileEditTool } from '../../src/shared/agent-tools';

const SRC = path.join(__dirname, '../../resources/hermes-plugin');

let home: string;
let hermesHome: string;
let env: NodeJS.ProcessEnv;
let enableCalls: string[];
const enable = (h: string) => { enableCalls.push(h); };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hermes-'));
  hermesHome = path.join(home, 'hermes-home');
  env = { HERMES_HOME: hermesHome };
  enableCalls = [];
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const pluginFile = (name: string) => path.join(getHermesPluginDir(hermesHome), name);

describe('Hermes home', () => {
  it('defaults to %LOCALAPPDATA%\\hermes on Windows and ~/.hermes elsewhere', () => {
    expect(defaultHermesHome({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32'))
      .toBe(path.join('C:\\Users\\u\\AppData\\Local', 'hermes'));
    expect(defaultHermesHome({}, '/home/u', 'linux')).toBe(path.join('/home/u', '.hermes'));
  });

  it('honours HERMES_HOME only when absolute', () => {
    expect(getHermesHome({ HERMES_HOME: hermesHome }, home)).toBe(path.normalize(hermesHome));
    expect(getHermesHome({ HERMES_HOME: 'relative/dir' }, home)).toBe(defaultHermesHome({ HERMES_HOME: 'relative/dir' }, home));
  });
});

describe('Hermes plugin install', () => {
  it('is named in the consent prompt (#132)', () => {
    expect(INTEGRATION_CONSENT_DETAIL).toContain('plugins\\wmux\\');
    expect(INTEGRATION_CONSENT_DETAIL).toContain('hermes plugins enable wmux');
  });

  it('writes nothing where Hermes has never run (#132)', async () => {
    await ensureHermesPlugin({ env, home, srcDir: SRC, enable });
    expect(fs.existsSync(hermesHome)).toBe(false);
    expect(enableCalls).toEqual([]);
  });

  it('installs both files and asks Hermes to enable the plugin', async () => {
    fs.mkdirSync(hermesHome);
    await ensureHermesPlugin({ env, home, srcDir: SRC, enable });
    for (const name of ['plugin.yaml', '__init__.py']) {
      expect(fs.readFileSync(pluginFile(name), 'utf-8')).toBe(fs.readFileSync(path.join(SRC, name), 'utf-8'));
    }
    expect(enableCalls).toEqual([path.normalize(hermesHome)]);
  });

  it('does not re-enable a plugin config.yaml already lists', async () => {
    fs.mkdirSync(hermesHome);
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'plugins:\n  enabled:\n    - memory-wiki\n    - wmux\n');
    await ensureHermesPlugin({ env, home, srcDir: SRC, enable });
    expect(enableCalls).toEqual([]);
  });

  it('never touches config.yaml itself', async () => {
    fs.mkdirSync(hermesHome);
    const cfg = path.join(hermesHome, 'config.yaml');
    fs.writeFileSync(cfg, 'model: x\n');
    await ensureHermesPlugin({ env, home, srcDir: SRC, enable });
    expect(fs.readFileSync(cfg, 'utf-8')).toBe('model: x\n');
  });

  it('leaves a same-named plugin of the user alone', async () => {
    const dir = getHermesPluginDir(hermesHome);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '__init__.py'), 'def register(ctx): pass\n');
    await ensureHermesPlugin({ env, home, srcDir: SRC, enable });
    expect(fs.readFileSync(path.join(dir, '__init__.py'), 'utf-8')).toBe('def register(ctx): pass\n');
    removeHermesPlugin({ env, home });
    expect(fs.existsSync(path.join(dir, '__init__.py'))).toBe(true);
    expect(enableCalls).toEqual([]);
  });

  it('respects a plugin the user disabled in Hermes', async () => {
    fs.mkdirSync(hermesHome);
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'plugins:\n  enabled: []\n  disabled:\n    - wmux\n');
    await ensureHermesPlugin({ env, home, srcDir: SRC, enable });
    expect(enableCalls).toEqual([]);
  });

  it('completes and removes an install interrupted after plugin.yaml', async () => {
    fs.mkdirSync(getHermesPluginDir(hermesHome), { recursive: true });
    fs.copyFileSync(path.join(SRC, 'plugin.yaml'), pluginFile('plugin.yaml'));
    removeHermesPlugin({ env, home });
    expect(fs.existsSync(getHermesPluginDir(hermesHome))).toBe(false);
    fs.mkdirSync(getHermesPluginDir(hermesHome), { recursive: true });
    fs.copyFileSync(path.join(SRC, 'plugin.yaml'), pluginFile('plugin.yaml'));
    await ensureHermesPlugin({ env, home, srcDir: SRC, enable });
    expect(fs.existsSync(pluginFile('__init__.py'))).toBe(true);
  });

  it('removes everything it wrote, including Python bytecode', async () => {
    fs.mkdirSync(hermesHome);
    await ensureHermesPlugin({ env, home, srcDir: SRC, enable });
    fs.mkdirSync(pluginFile('__pycache__'));
    fs.writeFileSync(path.join(pluginFile('__pycache__'), 'x.pyc'), '');
    removeHermesPlugin({ env, home });
    expect(fs.existsSync(getHermesPluginDir(hermesHome))).toBe(false);
  });
});

describe('hermesConfigEnablesWmux', () => {
  it.each([
    ['plugins:\n  enabled:\n    - wmux\n', true],
    ['plugins:\n  enabled:\n    - "wmux"   # ours\n', true],
    ['plugins:\n  enabled: [memory-wiki, wmux]\n', true],
    ['plugins:\n  enabled:\n    - memory-wiki\n  disabled:\n    - wmux\n', false],
    ['plugins:\n  disabled: [wmux]\n', false],
    ['other:\n  enabled:\n    - wmux\n', false],
    ['', false],
  ])('%j -> %s', (yaml, want) => {
    expect(hermesConfigEnablesWmux(yaml)).toBe(want);
  });
});

describe('findHermesExecutable', () => {
  it('only looks inside the Hermes home', () => {
    expect(findHermesExecutable(hermesHome, 'win32')).toBeNull();
    fs.mkdirSync(path.join(hermesHome, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(hermesHome, 'bin', 'hermes.exe'), '');
    expect(findHermesExecutable(hermesHome, 'win32')).toBe(path.join(hermesHome, 'bin', 'hermes.exe'));
  });
});

describe('Hermes as an agent kind', () => {
  it('names a hermes command line and counts write_file as an edit', () => {
    expect(identifyAgentCommand('hermes')).toBe('hermes');
    expect(identifyAgentCommand('C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe chat')).toBe('hermes');
    expect(isFileEditTool('write_file')).toBe(true);
  });
});

// The plugin itself, run under a real Python with a fake Hermes ctx and a fake
// wmux-hook.js that records what it was sent.
const python = ['python3', 'python', 'py'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

describe.skipIf(!python)('Hermes plugin (Python)', () => {
  function run(script: string, extraEnv: Record<string, string> = {}) {
    const cliDir = path.join(home, 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    const log = path.join(home, 'events.jsonl');
    fs.writeFileSync(path.join(cliDir, 'wmux-hook.js'),
      `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),payload:JSON.parse(d||'{}')})+'\\n')});`);
    fs.writeFileSync(path.join(cliDir, 'wmux.js'), '');
    const driver = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("wmux_plugin", ${JSON.stringify(path.join(SRC, '__init__.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
hooks = {}
class Ctx:
    def register_hook(self, name, fn): hooks[name] = fn
m.register(Ctx())
def fire(name, **kw):
    if name in hooks: hooks[name](**kw)
${script}
if m._reporter: m._reporter.flush(10)
print(",".join(sorted(hooks)))
`;
    const res = spawnSync(python as string, ['-c', driver], {
      env: { ...process.env, WMUX: '1', WMUX_SURFACE_ID: 'surf-1', WMUX_CLI: path.join(cliDir, 'wmux.js'), WMUX_NODE: process.execPath, PYTHONDONTWRITEBYTECODE: '1', ...extraEnv },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(res.stderr).toBe('');
    const events = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
    return { hooks: res.stdout.trim(), events };
  }

  it('registers nothing outside a wmux pane', () => {
    const { hooks, events } = run('fire("pre_llm_call", session_id="s1", user_message="hi")', { WMUX: '' });
    expect(hooks).toBe('');
    expect(events).toEqual([]);
  });

  it('maps a turn with an approval onto Claude Code hook events, in order', () => {
    const { events } = run(`
fire("on_session_start", session_id="s1", platform="cli")
fire("pre_llm_call", session_id="s1", user_message="fix it")
fire("pre_tool_call", session_id="s1", tool_name="terminal", tool_call_id="call_1", args={"command": "rm -rf x"})
fire("on_human_input_request", kind="approval", request_id="r", session_id="s1", prompt="rm -rf x")
fire("post_tool_call", session_id="s1", tool_name="terminal", tool_call_id="call_1", args={}, result="")
fire("post_tool_call", session_id="s1", tool_name="write_file", tool_call_id="call_2", args={"path": "a.txt", "content": "secret"}, result="")
fire("on_session_end", session_id="s1", completed=True)
fire("on_session_finalize", session_id="s1")
`);
    expect(events.map((e) => e.argv[1])).toEqual([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'PostToolUse', 'PostToolUse', 'Stop', 'SessionEnd',
    ]);
    expect(events[1].payload).toEqual({ prompt: 'fix it' });
    expect(events[2].payload).toEqual({ tool_name: 'Bash', tool_use_id: 'call_1' });
    expect(events[3].payload).toEqual({ message: 'Hermes needs your approval: rm -rf x', notification_type: 'permission_prompt' });
    // Only the path of an edit crosses, never its content.
    expect(events[5].payload).toEqual({ tool_name: 'Write', tool_use_id: 'call_2', tool_input: { file_path: 'a.txt' } });
    // A session id would be filed as Claude's and typed into `claude --resume`.
    expect(JSON.stringify(events)).not.toContain('"session_id"');
  });

  it('keeps a subagent off the main thread', () => {
    const { events } = run(`
fire("pre_llm_call", session_id="main", user_message="go")
fire("pre_llm_call", session_id="child", parent_session_id="main", user_message="brief")
fire("pre_tool_call", session_id="child", tool_name="read_file", tool_call_id="c1", args={})
fire("on_session_end", session_id="child", completed=True)
fire("on_session_end", session_id="main", completed=True)
`);
    expect(events.map((e) => e.argv[1])).toEqual(['UserPromptSubmit', 'PreToolUse', 'SubagentStop', 'Stop']);
    expect(events[1].payload).toMatchObject({ tool_name: 'Read', agent_id: 'child' });
    expect(events[2].payload).toEqual({ agent_id: 'child', agent_type: 'subagent' });
  });

  it('ignores the SessionStart of a subagent, which carries no parent id', () => {
    const { events } = run(`
fire("pre_llm_call", session_id="main", user_message="go")
fire("subagent_start", parent_session_id="main", child_session_id="child", child_goal="x")
fire("on_session_start", session_id="child", platform="cli")
fire("on_session_end", session_id="child", completed=True)
`);
    expect(events.map((e) => e.argv[1])).toEqual(['UserPromptSubmit', 'SubagentStop']);
  });

  it('drops tool events after the turn ended (the background review fork)', () => {
    const { events } = run(`
fire("pre_llm_call", session_id="s1", user_message="go")
fire("on_session_end", session_id="s1", completed=True)
fire("pre_tool_call", session_id="s1", tool_name="memory", tool_call_id="m1", args={})
fire("post_tool_call", session_id="s1", tool_name="memory", tool_call_id="m1", args={}, result="")
`);
    expect(events.map((e) => e.argv[1])).toEqual(['UserPromptSubmit', 'Stop']);
  });

  it('marks a clarify question as a question', () => {
    const { events } = run('fire("on_human_input_request", kind="clarify", request_id="r", session_id="s", prompt="Which one?")');
    expect(events[0].payload).toEqual({ message: 'Hermes has a question: Which one?', notification_type: 'elicitation_dialog' });
  });
});
