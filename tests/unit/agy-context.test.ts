import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  buildAgyHooks,
  ensureAgyPlugin,
  getAgyPluginDir,
  removeAgyPlugin,
} from '../../src/main/agy-context';
import { INTEGRATION_CONSENT_DETAIL } from '../../src/main/agent-integration';

const SCRIPT = path.join(__dirname, '../../resources/agy-plugin/wmux-agy-hook.cjs');
const require = createRequire(import.meta.url);
const { conversationToReport, inWmuxPane } = require(SCRIPT) as {
  conversationToReport: (raw: string, event: string) => string | null;
  inWmuxPane: (env: NodeJS.ProcessEnv) => boolean;
};
const ID = '46b139cc-e5cf-4c37-887b-188e6274d14a';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-agy-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const agyInstalled = () => fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
const pluginFile = (name: string) => path.join(getAgyPluginDir(home), name);

describe('agy plugin install', () => {
  it('is named in the consent prompt, like every other file wmux writes (#132)', () => {
    expect(INTEGRATION_CONSENT_DETAIL).toContain('~/.gemini/config/plugins/wmux/');
  });

  it('writes nothing where agy has never run (#132)', () => {
    ensureAgyPlugin(home, SCRIPT);
    expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
  });

  it('installs a manifest, its hooks and the hook script', () => {
    agyInstalled();
    ensureAgyPlugin(home, SCRIPT);
    expect(JSON.parse(fs.readFileSync(pluginFile('plugin.json'), 'utf-8'))).toEqual({ name: 'wmux' });
    expect(fs.readFileSync(pluginFile('wmux-agy-hook.cjs'), 'utf-8')).toBe(fs.readFileSync(SCRIPT, 'utf-8'));
    const hooks = JSON.parse(fs.readFileSync(pluginFile('hooks.json'), 'utf-8'));
    expect(Object.keys(hooks['wmux-session']).sort()).toEqual(['PreInvocation', 'SessionStart']);
  });

  // agy 1.4 hands a quoted argument to node with its quotes on, and runs a hook
  // from its hooks.json's folder: a bare relative command is the form that works.
  it('registers commands with no path and no quotes', () => {
    const hooks = JSON.parse(buildAgyHooks())['wmux-session'];
    for (const [event, handlers] of Object.entries<any[]>(hooks)) {
      expect(handlers).toEqual([{ type: 'command', command: `node wmux-agy-hook.cjs ${event}`, timeout: 5 }]);
    }
  });

  it('leaves a plugin the user called wmux alone, and never removes it', () => {
    agyInstalled();
    fs.mkdirSync(getAgyPluginDir(home), { recursive: true });
    fs.writeFileSync(pluginFile('plugin.json'), '{"name":"mine"}');
    ensureAgyPlugin(home, SCRIPT);
    removeAgyPlugin(home);
    expect(fs.readFileSync(pluginFile('plugin.json'), 'utf-8')).toBe('{"name":"mine"}');
    expect(fs.existsSync(pluginFile('wmux-agy-hook.cjs'))).toBe(false);
  });

  it('removes exactly what it installed', () => {
    agyInstalled();
    ensureAgyPlugin(home, SCRIPT);
    removeAgyPlugin(home);
    expect(fs.existsSync(getAgyPluginDir(home))).toBe(false);
    expect(fs.existsSync(path.join(home, '.gemini', 'antigravity-cli'))).toBe(true);
  });
});

describe('agy hook script', () => {
  it('reports a new conversation and the first model call of each turn', () => {
    expect(conversationToReport(JSON.stringify({ conversationId: ID }), 'SessionStart')).toBe(ID);
    expect(conversationToReport(JSON.stringify({ conversationId: ID, invocationNum: 0 }), 'PreInvocation')).toBe(ID);
    expect(conversationToReport(JSON.stringify({ conversationId: ID, invocationNum: 3 }), 'PreInvocation')).toBeNull();
  });

  it('refuses anything that is not a conversation id', () => {
    expect(conversationToReport(JSON.stringify({ conversationId: `${ID} & calc` }), 'SessionStart')).toBeNull();
    expect(conversationToReport('not json', 'SessionStart')).toBeNull();
    expect(conversationToReport('null', 'SessionStart')).toBeNull();
  });

  it('only acts in a pane of this wmux (#282)', () => {
    expect(inWmuxPane({ WMUX: '1', WMUX_SURFACE_ID: 'surf-1' })).toBe(true);
    expect(inWmuxPane({ WMUX_SURFACE_ID: 'surf-1' })).toBe(false);
    expect(inWmuxPane({ WMUX: '1' })).toBe(false);
  });

  /** Run the script the way agy does, against a stand-in for wmux's pipe. */
  async function runHook(event: string, payload: object, env: NodeJS.ProcessEnv) {
    const frames: any[] = [];
    const pipe = process.platform === 'win32'
      ? `\\\\.\\pipe\\wmux-agy-test-${process.pid}-${Date.now()}`
      : path.join(home, 'pipe.sock');
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        frames.push(JSON.parse(chunk.toString().trim()));
        socket.write(JSON.stringify({ id: 1, result: { accepted: true } }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      const child = spawn(process.execPath, [SCRIPT, event], {
        env: { PATH: process.env.PATH, WMUX_PIPE: pipe, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stdin.end(JSON.stringify(payload));
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      return { code, stdout, frames };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('reports the pane\'s conversation over the pipe and answers agy with {}', async () => {
    const { code, stdout, frames } = await runHook('SessionStart', { conversationId: ID },
      { WMUX: '1', WMUX_SURFACE_ID: 'surf-agy', WMUX_PIPE_TOKEN: 'tok' });
    expect(code).toBe(0);
    expect(stdout).toBe('{}');
    expect(frames).toEqual([{
      method: 'pane.report_agent_session',
      params: { surfaceId: 'surf-agy', sessionId: ID, provider: 'agy' },
      id: 1,
      token: 'tok',
    }]);
  });

  it('still answers {} outside wmux, without touching any pipe', async () => {
    const { code, stdout, frames } = await runHook('SessionStart', { conversationId: ID }, {});
    expect(code).toBe(0);
    expect(stdout).toBe('{}');
    expect(frames).toEqual([]);
  });
});
