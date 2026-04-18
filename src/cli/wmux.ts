#!/usr/bin/env node

import net from 'net';

const PIPE_PATH = '\\\\.\\pipe\\wmux';

function sendV1(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: PIPE_PATH }, () => {
      client.write(command + '\n');
    });
    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });
    client.on('end', () => resolve(data.trim()));
    client.on('error', (err) => reject(err));
    setTimeout(() => { client.end(); resolve(data.trim()); }, 5000);
  });
}

function sendV2(method: string, params: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: PIPE_PATH }, () => {
      const request = JSON.stringify({ method, params, id: 1 });
      client.write(request + '\n');
    });
    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        client.end();
        try {
          const response = JSON.parse(data.trim());
          if (response.error) reject(new Error(response.error.message));
          else resolve(response.result);
        } catch { resolve(data.trim()); }
      }
    });
    client.on('error', (err) => reject(err));
    setTimeout(() => { client.end(); reject(new Error('timeout')); }, 5000);
  });
}

// Simple flag helpers shared across commands.
function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i === args.length - 1) return undefined;
  return args[i + 1];
}
function stripFlag(args: string[], name: string): string[] {
  const i = args.indexOf(name);
  if (i < 0) return args;
  const copy = args.slice();
  copy.splice(i, i === args.length - 1 ? 1 : 2);
  return copy;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(0);
  }

  try {
    switch (command) {
      // System
      case 'ping': console.log(await sendV1('ping')); break;
      case 'identify': console.log(JSON.stringify(await sendV2('system.identify'), null, 2)); break;
      case 'capabilities': console.log(JSON.stringify(await sendV2('system.capabilities'), null, 2)); break;
      case 'list-windows': console.log(JSON.stringify(await sendV2('window.list'), null, 2)); break;
      case 'focus-window': console.log(JSON.stringify(await sendV2('window.focus', { id: args[1] }), null, 2)); break;

      // Workspace
      case 'new-workspace': {
        const params: any = {};
        for (let i = 1; i < args.length; i += 2) {
          if (args[i] === '--title') params.title = args[i + 1];
          if (args[i] === '--shell') params.shell = args[i + 1];
          if (args[i] === '--cwd') params.cwd = args[i + 1];
        }
        console.log(JSON.stringify(await sendV2('workspace.create', params), null, 2));
        break;
      }
      case 'close-workspace': console.log(JSON.stringify(await sendV2('workspace.close', { id: args[1] }), null, 2)); break;
      case 'select-workspace': console.log(JSON.stringify(await sendV2('workspace.select', { id: args[1] }), null, 2)); break;
      case 'rename-workspace': console.log(JSON.stringify(await sendV2('workspace.rename', { id: args[1], title: args[2] }), null, 2)); break;
      case 'list-workspaces': console.log(JSON.stringify(await sendV2('workspace.list'), null, 2)); break;

      // Surface
      case 'new-surface': {
        const type = getFlag(args, '--type') || 'terminal';
        const colorScheme = getFlag(args, '--color-scheme');
        console.log(JSON.stringify(await sendV2('surface.create', { type, ...(colorScheme ? { colorScheme } : {}) }), null, 2));
        break;
      }
      case 'close-surface': console.log(JSON.stringify(await sendV2('surface.close', { id: args[1] }), null, 2)); break;
      case 'focus-surface': console.log(JSON.stringify(await sendV2('surface.focus', { id: args[1] }), null, 2)); break;
      case 'list-surfaces': console.log(JSON.stringify(await sendV2('surface.list', { paneId: getFlag(args, '--pane') }), null, 2)); break;

      // Surface: per-pane color scheme override (issue #4)
      case 'set-color-scheme': {
        // Two forms:
        //   wmux set-color-scheme <scheme>            → apply to current surface
        //   wmux set-color-scheme <surfaceId> <scheme> → apply to a specific surface
        let surfaceId = args[1];
        let scheme = args[2];
        if (!scheme) {
          scheme = surfaceId;
          surfaceId = process.env.WMUX_SURFACE_ID || '';
        }
        if (!surfaceId) { console.error('No surface id. Pass one as argument or run inside a wmux pane.'); process.exit(1); }
        if (!scheme)    { console.error('Usage: wmux set-color-scheme [surfaceId] <scheme>'); process.exit(1); }
        console.log(JSON.stringify(await sendV2('surface.set_color_scheme', { surfaceId, colorScheme: scheme }), null, 2));
        break;
      }
      case 'clear-color-scheme': {
        const surfaceId = args[1] || process.env.WMUX_SURFACE_ID || '';
        if (!surfaceId) { console.error('No surface id. Pass one as argument or run inside a wmux pane.'); process.exit(1); }
        console.log(JSON.stringify(await sendV2('surface.set_color_scheme', { surfaceId, colorScheme: null }), null, 2));
        break;
      }
      case 'list-themes':
      case 'themes': {
        // Discovery for users writing scripts: what names are valid for --color-scheme?
        console.log(JSON.stringify(await sendV2('theme.list'), null, 2));
        break;
      }

      // Pane
      case 'split': {
        const direction = args.includes('--down') ? 'down' : 'right';
        const type = getFlag(args, '--type') || 'terminal';
        const colorScheme = getFlag(args, '--color-scheme');
        console.log(JSON.stringify(await sendV2('pane.split', { direction, type, ...(colorScheme ? { colorScheme } : {}) }), null, 2));
        break;
      }
      // "pane <sub>" verb form — mirrors the syntax from the issue example.
      case 'pane': {
        const sub = args[1];
        if (sub === 'new' || sub === 'split') {
          const rest = args.slice(2);
          const direction = rest.includes('--down') ? 'down' : 'right';
          const type = getFlag(rest, '--type') || 'terminal';
          const colorScheme = getFlag(rest, '--color-scheme');
          console.log(JSON.stringify(await sendV2('pane.split', { direction, type, ...(colorScheme ? { colorScheme } : {}) }), null, 2));
        } else if (sub === 'close') {
          console.log(JSON.stringify(await sendV2('pane.close', { id: args[2] }), null, 2));
        } else if (sub === 'focus') {
          console.log(JSON.stringify(await sendV2('pane.focus', { id: args[2] }), null, 2));
        } else if (sub === 'list') {
          console.log(JSON.stringify(await sendV2('pane.list', { workspaceId: getFlag(args, '--workspace') }), null, 2));
        } else {
          console.error(`Unknown pane subcommand: ${sub}`);
          process.exit(1);
        }
        break;
      }
      case 'close-pane': console.log(JSON.stringify(await sendV2('pane.close', { id: args[1] }), null, 2)); break;
      case 'focus-pane': console.log(JSON.stringify(await sendV2('pane.focus', { id: args[1] }), null, 2)); break;
      case 'zoom-pane': console.log(JSON.stringify(await sendV2('pane.zoom', { id: args[1] }), null, 2)); break;
      case 'list-panes': console.log(JSON.stringify(await sendV2('pane.list', { workspaceId: getFlag(args, '--workspace') }), null, 2)); break;
      case 'tree': console.log(JSON.stringify(await sendV2('system.tree'), null, 2)); break;

      // Layout
      case 'layout': {
        const sub = args[1];
        if (sub === 'grid') {
          const params: any = {};
          for (let i = 2; i < args.length; i += 2) {
            if (args[i] === '--count') params.count = parseInt(args[i + 1], 10);
            if (args[i] === '--type') params.type = args[i + 1];
            if (args[i] === '--anchor-surface') params.anchorSurfaceId = args[i + 1];
            if (args[i] === '--anchor-pane') params.anchorPaneId = args[i + 1];
            if (args[i] === '--workspace') params.workspaceId = args[i + 1];
          }
          if (!params.count || params.count < 1) { console.error('--count <N> is required and must be >= 1'); process.exit(1); }
          // If no explicit anchor, fall back to the current shell's surface so the command "just works" from inside a pane.
          if (!params.anchorSurfaceId && !params.anchorPaneId && process.env.WMUX_SURFACE_ID) {
            params.anchorSurfaceId = process.env.WMUX_SURFACE_ID;
          }
          console.log(JSON.stringify(await sendV2('layout.grid', params), null, 2));
        } else {
          console.error(`Unknown layout command: ${sub}`); process.exit(1);
        }
        break;
      }

      // Terminal interaction
      case 'send': {
        // Drop --surface <id> (and its value) from the free-form text args.
        const surfaceId = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
        const textArgs = stripFlag(args.slice(1), '--surface');
        const payload: Record<string, any> = { text: textArgs.join(' ') };
        if (surfaceId) payload.surfaceId = surfaceId;
        console.log(JSON.stringify(await sendV2('surface.send_text', payload), null, 2));
        break;
      }
      case 'send-key': {
        const key = args[1];
        const modifiers: string[] = [];
        if (args.includes('--ctrl')) modifiers.push('ctrl');
        if (args.includes('--shift')) modifiers.push('shift');
        if (args.includes('--alt')) modifiers.push('alt');
        const surfaceId = getFlag(args, '--surface') || process.env.WMUX_SURFACE_ID;
        const payload: Record<string, any> = { key, modifiers };
        if (surfaceId) payload.surfaceId = surfaceId;
        console.log(JSON.stringify(await sendV2('surface.send_key', payload), null, 2));
        break;
      }
      case 'read-screen': {
        const lines = args.find((a, i) => args[i - 1] === '--lines');
        console.log(JSON.stringify(await sendV2('surface.read_text', { lines: lines ? parseInt(lines) : 50 }), null, 2));
        break;
      }
      case 'trigger-flash': console.log(JSON.stringify(await sendV2('surface.trigger_flash', { id: args[1] }), null, 2)); break;

      // Browser
      case 'browser': {
        const sub = args[1];
        switch (sub) {
          case 'open': console.log(JSON.stringify(await sendV2('browser.navigate', { url: args[2] }), null, 2)); break;
          case 'snapshot': console.log(JSON.stringify(await sendV2('browser.snapshot'), null, 2)); break;
          case 'click': console.log(JSON.stringify(await sendV2('browser.click', { ref: args[2] }), null, 2)); break;
          case 'type': console.log(JSON.stringify(await sendV2('browser.type', { ref: args[2], text: args.slice(3).join(' ') }), null, 2)); break;
          case 'fill': console.log(JSON.stringify(await sendV2('browser.fill', { ref: args[2], value: args.slice(3).join(' ') }), null, 2)); break;
          case 'screenshot': console.log(JSON.stringify(await sendV2('browser.screenshot', { fullPage: args.includes('--full') }), null, 2)); break;
          case 'get-text': console.log(JSON.stringify(await sendV2('browser.get_text', { ref: args[2] }), null, 2)); break;
          case 'eval': console.log(JSON.stringify(await sendV2('browser.eval', { js: args.slice(2).join(' ') }), null, 2)); break;
          case 'wait': console.log(JSON.stringify(await sendV2('browser.wait', { ref: args[2], timeout: parseInt(args[3]) || undefined }), null, 2)); break;
          case 'back': console.log(JSON.stringify(await sendV2('browser.back'), null, 2)); break;
          case 'forward': console.log(JSON.stringify(await sendV2('browser.forward'), null, 2)); break;
          case 'reload': console.log(JSON.stringify(await sendV2('browser.reload'), null, 2)); break;
          default: console.error(`Unknown browser command: ${sub}`); process.exit(1);
        }
        break;
      }

      // Agent
      case 'agent': {
        const sub = args[1];
        switch (sub) {
          case 'spawn': {
            const params: any = {};
            for (let i = 2; i < args.length; i += 2) {
              if (args[i] === '--cmd') params.cmd = args[i + 1];
              if (args[i] === '--label') params.label = args[i + 1];
              if (args[i] === '--cwd') params.cwd = args[i + 1];
              if (args[i] === '--pane') params.paneId = args[i + 1];
              if (args[i] === '--workspace') params.workspaceId = args[i + 1];
            }
            if (!params.cmd) { console.error('--cmd is required'); process.exit(1); }
            if (!params.label) params.label = params.cmd.split(/\s+/)[0];
            console.log(JSON.stringify(await sendV2('agent.spawn', params), null, 2));
            break;
          }
          case 'spawn-batch': {
            const jsonIdx = args.indexOf('--json');
            if (jsonIdx === -1) { console.error('Usage: wmux agent spawn-batch --json \'[...]\''); process.exit(1); }
            const json = args[jsonIdx + 1];
            const parsed = JSON.parse(json);
            const strategy = args.find((a, i) => args[i - 1] === '--strategy') || 'distribute';
            console.log(JSON.stringify(await sendV2('agent.spawn_batch', { agents: parsed, strategy }), null, 2));
            break;
          }
          case 'status': console.log(JSON.stringify(await sendV2('agent.status', { agentId: args[2] }), null, 2)); break;
          case 'list': console.log(JSON.stringify(await sendV2('agent.list', { workspaceId: args.find((a, i) => args[i - 1] === '--workspace') }), null, 2)); break;
          case 'kill': console.log(JSON.stringify(await sendV2('agent.kill', { agentId: args[2] }), null, 2)); break;
          default: console.error(`Unknown agent command: ${sub}`); process.exit(1);
        }
        break;
      }

      // Markdown
      case 'markdown': {
        const sub = args[1];
        if (sub === 'set') {
          const surfaceId = args[2];
          const contentFlag = args.indexOf('--content');
          const fileFlag = args.indexOf('--file');
          if (contentFlag !== -1) {
            console.log(JSON.stringify(await sendV2('markdown.set_content', { surfaceId, markdown: args.slice(contentFlag + 1).join(' ') }), null, 2));
          } else if (fileFlag !== -1) {
            console.log(JSON.stringify(await sendV2('markdown.load_file', { surfaceId, filePath: args[fileFlag + 1] }), null, 2));
          }
        }
        break;
      }

      // Notifications
      case 'notify': {
        const titleIdx = args.indexOf('--title');
        const bodyIdx = args.indexOf('--body');
        const title = titleIdx !== -1 ? args[titleIdx + 1] : undefined;
        const body = bodyIdx !== -1 ? args[bodyIdx + 1] : undefined;
        const text = args.filter((_, i) => i > 0 && ![titleIdx, titleIdx + 1, bodyIdx, bodyIdx + 1].includes(i)).join(' ') || body || '';
        await sendV1(`notify ${process.env.WMUX_SURFACE_ID || ''} ${text}`);
        console.log('Notification sent');
        break;
      }
      case 'list-notifications': console.log(JSON.stringify(await sendV2('notification.list'), null, 2)); break;
      case 'clear-notifications': console.log(JSON.stringify(await sendV2('notification.clear', { id: args[1] }), null, 2)); break;

      // Sidebar
      case 'set-status': console.log(JSON.stringify(await sendV2('sidebar.set_status', { key: args[1], value: args[2] }), null, 2)); break;
      case 'set-progress': {
        const label = args.find((a, i) => args[i - 1] === '--label');
        console.log(JSON.stringify(await sendV2('sidebar.set_progress', { value: parseFloat(args[1]), label }), null, 2));
        break;
      }
      case 'log': console.log(JSON.stringify(await sendV2('sidebar.log', { level: args[1], message: args.slice(2).join(' ') }), null, 2)); break;
      case 'sidebar-state': console.log(JSON.stringify(await sendV2('sidebar.get_state'), null, 2)); break;

      case 'diff': {
        const file = args.find((a, i) => args[i - 1] === '--file') || '';
        console.log(JSON.stringify(await sendV2('diff.refresh', { file }), null, 2));
        break;
      }

      case 'hook': {
        const params: Record<string, string> = {};
        for (let i = 1; i < args.length; i += 2) {
          if (args[i] === '--event') params.event = args[i + 1];
          if (args[i] === '--tool') params.tool = args[i + 1];
          if (args[i] === '--agent') params.agentId = args[i + 1];
        }
        await sendV2('hook.event', params);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      console.error('wmux is not running (could not connect to pipe)');
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

function printUsage() {
  console.log(`wmux CLI — Windows terminal multiplexer

Usage: wmux <command> [options]

System:     ping, identify, capabilities, list-windows, focus-window <id>
Workspace:  new-workspace, close-workspace, select-workspace, rename-workspace, list-workspaces
Surface:    new-surface [--type T] [--color-scheme NAME], close-surface, focus-surface, list-surfaces
            set-color-scheme [surfaceId] <scheme>, clear-color-scheme [surfaceId], list-themes
Pane:       split [--down] [--type T] [--color-scheme NAME], close-pane, focus-pane, zoom-pane, list-panes, tree
            pane new|close|focus|list   (verb form, mirrors issue #4 example)
Layout:     layout grid --count <N> [--type terminal] [--anchor-surface <id>]
Terminal:   send <text>, send-key <key>, read-screen, trigger-flash
Browser:    browser open|snapshot|click|type|fill|screenshot|get-text|eval|wait|back|forward|reload
Agent:      agent spawn|spawn-batch|status|list|kill
Markdown:   markdown set <id> --content <text> | --file <path>
Diff:       diff [--file <path>]
Notify:     notify <text>, list-notifications, clear-notifications
Sidebar:    set-status, set-progress, log, sidebar-state
Hook:       hook --event <type> --tool <name> [--agent <id>]
`);
}

main();
