#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.codexLaunchPlan = codexLaunchPlan;
exports.runWmuxCodex = runWmuxCodex;
/** Launched by wmux's private PATH shims using wmux's resolved Node runtime. */
const child_process_1 = require("child_process");
const net_1 = __importDefault(require("net"));
const path_1 = __importDefault(require("path"));
const NON_INTERACTIVE = new Set([
    'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server',
    'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug',
    'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive',
    'cloud', 'exec-server', 'features', 'help',
]);
const VALUE_OPTIONS = new Set([
    '-c', '--config', '--enable', '--disable', '--code-mode-host', '-m', '--model',
    '-i', '--image', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir',
    '-a', '--ask-for-approval', '--local-provider', '--remote', '--remote-auth-token-env',
]);
const SERVER_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--code-mode-host']);
/** Options that keep an invocation native. The second half: a remote TUI cannot
 *  apply local profile/worktree/provider bootstrapping, so these run unwrapped
 *  instead of silently changing their meaning. */
const NATIVE_ONLY_OPTIONS = new Set([
    '-h', '--help', '-V', '--version', '--remote', '--remote-auth-token-env',
    '-p', '--profile', '--worktree', '--oss', '--local-provider',
]);
/** Apply one value-taking option. Returns how many argv entries it consumed, or
 *  0 when its value is missing (which ends the scan as non-interactive). */
function applyValueOption(plan, key, arg, next) {
    const inline = arg.includes('=');
    const value = inline ? arg.slice(arg.indexOf('=') + 1) : next;
    if (value === undefined)
        return 0;
    if (SERVER_OPTIONS.has(key))
        plan.serverArgs.push(key, value);
    if (key === '-C' || key === '--cd')
        plan.cwd = path_1.default.resolve(plan.cwd, value);
    return inline ? 1 : 2;
}
function codexLaunchPlan(args, cwd) {
    const plan = { interactive: true, serverArgs: ['app-server', '--stdio'], cwd };
    let positional = false;
    let i = 0;
    while (i < args.length && args[i] !== '--') {
        const arg = args[i];
        const key = arg.split('=')[0];
        if (NATIVE_ONLY_OPTIONS.has(key))
            plan.interactive = false;
        if (key === '--strict-config')
            plan.serverArgs.push(arg);
        if (VALUE_OPTIONS.has(key)) {
            const consumed = applyValueOption(plan, key, arg, args[i + 1]);
            if (consumed === 0) {
                plan.interactive = false;
                break;
            }
            i += consumed;
            continue;
        }
        // Only the FIRST positional is the subcommand; a prompt like `codex exec` as
        // text after it is not.
        if (!arg.startsWith('-') && !positional) {
            positional = true;
            plan.interactive &&= !NON_INTERACTIVE.has(arg);
        }
        i++;
    }
    return plan;
}
/** Authenticated local pipe only; never send environment variables or transcripts. */
function wmuxRequest(method, params) {
    return new Promise((resolve, reject) => {
        const pipe = process.env.WMUX_PIPE;
        const token = process.env.WMUX_PIPE_TOKEN;
        if (!pipe || !token) {
            reject(new Error('Outside wmux'));
            return;
        }
        const socket = net_1.default.connect(pipe);
        let data = '';
        const timer = setTimeout(() => finish(new Error('wmux did not respond')), 2000);
        const finish = (error, result) => {
            clearTimeout(timer);
            socket.destroy();
            if (error)
                reject(error);
            else
                resolve(result);
        };
        socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params, token }) + '\n'));
        socket.on('data', chunk => {
            data += chunk.toString();
            if (data.length > 64 * 1024) {
                finish(new Error('Invalid wmux response'));
                return;
            }
            const line = data.split('\n')[0];
            if (!data.includes('\n'))
                return;
            try {
                const response = JSON.parse(line);
                if (response.error)
                    finish(new Error(response.error.message));
                else
                    finish(undefined, response.result);
            }
            catch {
                finish(new Error('Invalid wmux response'));
            }
        });
        socket.on('error', error => finish(error));
        socket.on('end', () => finish(new Error('wmux disconnected')));
    });
}
function supportsRemote(executable, env) {
    return new Promise(resolve => {
        (0, child_process_1.execFile)(executable, ['--help'], { env, windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => {
            resolve(!error && stdout.includes('--remote-auth-token-env'));
        });
    });
}
function runCli(executable, args, env) {
    return new Promise((resolve, reject) => {
        // Codex shares this console, so Ctrl+C / Ctrl+Break reach both processes.
        // Codex decides what they mean; the wrapper must not die first and hand the
        // prompt back while Codex is still writing to the same console.
        const ignore = () => { };
        process.on('SIGINT', ignore);
        process.on('SIGBREAK', ignore);
        const done = () => { process.off('SIGINT', ignore); process.off('SIGBREAK', ignore); };
        const child = (0, child_process_1.spawn)(executable, args, { env, stdio: 'inherit' });
        child.once('error', error => { done(); reject(error); });
        child.once('exit', code => { done(); resolve(code ?? 1); });
    });
}
/**
 * The relay, or null when it cannot start. Loaded lazily: it pulls in `ws`,
 * which ships beside this file in `cli/node_modules`, and a packaging miss
 * there must cost the restore feature — never every `codex` in every pane.
 */
async function startRelay(options) {
    try {
        const { createCodexRelay } = require('./codex-relay');
        return await createCodexRelay(options);
    }
    catch (error) {
        console.error(`[wmux] Codex session restore is unavailable (${error.message}). Starting Codex normally.`);
        return null;
    }
}
async function runWmuxCodex(args = process.argv.slice(2)) {
    const executable = process.env.WMUX_CODEX_EXE;
    if (!executable || !path_1.default.isAbsolute(executable))
        throw new Error('wmux could not locate the native Codex executable');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const surfaceId = process.env.WMUX_SURFACE_ID;
    const plan = codexLaunchPlan(args, process.cwd());
    if (!plan.interactive || !surfaceId)
        return runCli(executable, args, env);
    let enabled = false;
    try {
        enabled = (await wmuxRequest('pane.codex_restore_config', { surfaceId })).enabled === true;
    }
    catch { /* An older/offline wmux leaves the CLI usable. */ }
    if (!enabled)
        return runCli(executable, args, env);
    if (!await supportsRemote(executable, env)) {
        console.error('[wmux] This Codex version cannot record sessions for automatic restore. Starting Codex normally.');
        return runCli(executable, args, env);
    }
    // Serialize reports so a delayed response cannot stamp an older thread last.
    let reports = Promise.resolve();
    const relay = await startRelay({
        executable, args: plan.serverArgs, cwd: plan.cwd, env,
        onSession: sessionId => {
            reports = reports.then(async () => {
                try {
                    await wmuxRequest('pane.report_codex_session', { surfaceId, sessionId });
                }
                catch { /* A crashed wmux cannot receive a report; Codex still owns its history. */ }
            });
        },
    });
    if (!relay)
        return runCli(executable, args, env);
    let exitCode;
    try {
        exitCode = await runCli(executable, [
            '--remote', relay.url, '--remote-auth-token-env', 'WMUX_CODEX_RELAY_TOKEN', ...args,
        ], { ...env, WMUX_CODEX_RELAY_TOKEN: relay.token });
    }
    finally {
        await relay.close();
    }
    await reports;
    if (exitCode === 0 && relay.sessionId) {
        // Only an orderly CLI exit forgets the handle. A crash, socket failure or
        // wmux shutdown retains it. Main also guards this RPC while quitting.
        try {
            await wmuxRequest('pane.release_codex_session', { surfaceId, sessionId: relay.sessionId });
        }
        catch { /* wmux has already closed */ }
        console.log(`To resume later: codex resume ${relay.sessionId}`);
    }
    return exitCode;
}
if (require.main === module) {
    runWmuxCodex().then(code => { process.exitCode = code; }).catch(error => {
        console.error('[wmux] Could not launch Codex:', error.message);
        process.exitCode = 1;
    });
}
