#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.codexLaunchPlan = codexLaunchPlan;
exports.resumeTarget = resumeTarget;
exports.isTransientWmuxError = isTransientWmuxError;
exports.wmuxRequestPatiently = wmuxRequestPatiently;
exports.codexCapabilityKey = codexCapabilityKey;
exports.supportsRemote = supportsRemote;
exports.runWmuxCodex = runWmuxCodex;
/** Launched by wmux's private PATH shims using wmux's resolved Node runtime. */
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const net_1 = __importDefault(require("net"));
const os_1 = __importDefault(require("os"));
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
const YOLO_OPTIONS = new Set(['--yolo', '--dangerously-bypass-approvals-and-sandbox']);
const PERMISSION_OPTIONS = new Set([
    '-a', '--ask-for-approval', '-s', '--sandbox', '--approve-for-me', '--not-so-yolo',
    '--full-auto', '--add-dir',
]);
const PERMISSION_CONFIG = /^(?:approval_policy|approvals_reviewer|sandbox_mode|sandbox_workspace_write|default_permissions|permissions|network)(?:\.|\s*=)/;
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
    const plan = { interactive: true, serverArgs: ['app-server', '--stdio'], clientArgs: [], cwd, yolo: false };
    let positional = false;
    let otherPermissions = false;
    let i = 0;
    while (i < args.length && args[i] !== '--') {
        const arg = args[i];
        const key = arg.split('=')[0];
        if (NATIVE_ONLY_OPTIONS.has(key))
            plan.interactive = false;
        if (YOLO_OPTIONS.has(arg)) {
            // Do not hide duplicate-flag errors from Codex's own argument parser.
            if (plan.yolo)
                plan.interactive = false;
            plan.yolo = true;
            i++;
            continue;
        }
        if (PERMISSION_OPTIONS.has(key) || /^-[as].+/.test(arg))
            otherPermissions = true;
        if (key === '-c' || key === '--config' || /^-c.+/.test(arg)) {
            const value = key === '-c' || key === '--config'
                ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[i + 1])
                : arg.slice(2);
            // Quoted TOML keys and compound permission settings stay with the native
            // parser: the relay must not guess their precedence against --yolo.
            if (value && (PERMISSION_CONFIG.test(value.trim()) || /^["']/.test(value.trim())))
                otherPermissions = true;
        }
        if (key === '--strict-config')
            plan.serverArgs.push(arg);
        if (VALUE_OPTIONS.has(key)) {
            const consumed = applyValueOption(plan, key, arg, args[i + 1]);
            if (consumed === 0) {
                plan.interactive = false;
                break;
            }
            plan.clientArgs.push(...args.slice(i, i + consumed));
            i += consumed;
            continue;
        }
        // Only the FIRST positional is the subcommand; a prompt like `codex exec` as
        // text after it is not.
        if (!arg.startsWith('-') && !positional) {
            positional = true;
            plan.interactive &&= !NON_INTERACTIVE.has(arg);
        }
        plan.clientArgs.push(arg);
        i++;
    }
    plan.clientArgs.push(...args.slice(i));
    // Preserve native validation/precedence for mixed permission choices, instead
    // of silently removing an option that conflicts with --yolo.
    if (plan.yolo && otherPermissions)
        plan.interactive = false;
    return plan;
}
/** `codex resume <id>` → the id; anything else (a picker, a new chat) → undefined. */
function resumeTarget(clientArgs) {
    for (let i = 0; i < clientArgs.length; i++) {
        const arg = clientArgs[i];
        if (arg === '--')
            return undefined;
        if (arg.startsWith('-')) {
            if (VALUE_OPTIONS.has(arg))
                i++;
            continue;
        }
        if (arg !== 'resume')
            return undefined;
        const id = clientArgs[i + 1];
        return id && !id.startsWith('-') ? id : undefined;
    }
    return undefined;
}
/** wmux is there but did not answer in time, or dropped the connection. */
class WmuxBusyError extends Error {
}
/** Authenticated local pipe only; never send environment variables or transcripts. */
const wmuxRequest = (method, params, timeoutMs) => {
    return new Promise((resolve, reject) => {
        const pipe = process.env.WMUX_PIPE;
        const token = process.env.WMUX_PIPE_TOKEN;
        if (!pipe || !token) {
            reject(new Error('Outside wmux'));
            return;
        }
        const socket = net_1.default.connect(pipe);
        let data = '';
        const timer = setTimeout(() => finish(new WmuxBusyError('wmux did not respond')), timeoutMs);
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
        socket.on('end', () => finish(new WmuxBusyError('wmux disconnected')));
    });
};
/**
 * Worth asking again: wmux exists but was too busy to answer. Restoring a
 * session starts every saved Codex at once, beside every other pane, and
 * wmux's main process answers none of them until that burst is through.
 * ENOENT (no wmux at all), "Outside wmux" and an error REPLY (an older wmux
 * that does not know the method) are answers, and are never retried.
 */
function isTransientWmuxError(error) {
    if (error instanceof WmuxBusyError)
        return true;
    const code = error?.code;
    return code === 'EBUSY' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}
/**
 * The request, asked again while wmux is merely busy. A single 2 s attempt
 * used to decide each launch: during a restore, roughly half the Codex panes
 * timed out and started without session capture, so wmux lost track of
 * them — a `/new` or a quit there was never recorded.
 */
async function wmuxRequestPatiently(method, params, patience, request = wmuxRequest, now = Date.now) {
    const deadline = now() + patience.budgetMs;
    let attemptMs = patience.firstAttemptMs;
    for (let attempt = 0;; attempt++) {
        try {
            return await request(method, params, Math.max(1, Math.min(attemptMs, deadline - now())));
        }
        catch (error) {
            const pause = Math.min(250 * (attempt + 1), 1000);
            if (!isTransientWmuxError(error) || now() + pause >= deadline)
                throw error;
            if (attempt === 0)
                patience.onWait?.();
            await new Promise(resolve => setTimeout(resolve, pause));
            attemptMs *= 2;
        }
    }
}
/** Whether to record sessions: decides a restored pane's capture, so it waits for wmux. */
const CONFIG_PATIENCE = { budgetMs: 45_000, firstAttemptMs: 3_000 };
/** Session reports run beside the TUI, so they can afford to wait longer. */
const REPORT_PATIENCE = { budgetMs: 60_000, firstAttemptMs: 3_000 };
/** The release holds the prompt after Codex exits; a missed one only reopens it. */
const RELEASE_PATIENCE = { budgetMs: 10_000, firstAttemptMs: 2_000 };
/**
 * `codex --help` lists `--remote-auth-token-env` from the version that can be
 * relayed. It used to run with a 5 s limit on every launch, and a timeout read
 * as "this Codex is too old": a restore starts every saved Codex at once, so
 * the burst of `--help` processes was what ran out of time. The probe is now
 * given 30 s and its positive answer is remembered per executable (path, size,
 * mtime — an update invalidates it), so a restore runs it once, not per pane.
 */
const REMOTE_PROBE_TIMEOUT_MS = 30_000;
function capabilityCachePath() {
    return path_1.default.join(os_1.default.tmpdir(), 'wmux-codex-remote-support.json');
}
function codexCapabilityKey(executable) {
    try {
        const stat = fs_1.default.statSync(executable);
        return `${path_1.default.resolve(executable).toLowerCase()}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
    }
    catch {
        return null;
    }
}
function readCapabilityCache(file) {
    try {
        const parsed = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
/** Remember a supported executable. Best effort: a cache that cannot be written only costs a probe. */
function rememberSupport(file, key) {
    try {
        const next = { ...readCapabilityCache(file), [key]: true };
        const temp = `${file}.${process.pid}.tmp`;
        fs_1.default.writeFileSync(temp, JSON.stringify(next));
        fs_1.default.renameSync(temp, file);
    }
    catch { /* another launcher won the race, or tmp is read-only */ }
}
const probeRemoteSupport = (executable, env) => {
    return new Promise(resolve => {
        (0, child_process_1.execFile)(executable, ['--help'], { env, windowsHide: true, timeout: REMOTE_PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout) => {
            // Killed by the timeout: no answer, which is not a "no".
            if (error && error.killed) {
                resolve(null);
                return;
            }
            resolve(!error && stdout.includes('--remote-auth-token-env'));
        });
    });
};
/** true / false, or null when Codex never answered (not the same as "too old"). */
async function supportsRemote(executable, env, probe = probeRemoteSupport, cacheFile = capabilityCachePath()) {
    const key = codexCapabilityKey(executable);
    if (key && readCapabilityCache(cacheFile)[key] === true)
        return true;
    // One more try for a probe that ran out of time; a real "no" is not retried.
    let supported = await probe(executable, env);
    if (supported === null)
        supported = await probe(executable, env);
    if (supported && key)
        rememberSupport(cacheFile, key);
    return supported;
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
        enabled = (await wmuxRequestPatiently('pane.codex_restore_config', { surfaceId }, {
            ...CONFIG_PATIENCE,
            onWait: () => console.error('[wmux] wmux is busy; waiting for it before starting Codex with session restore...'),
        })).enabled === true;
    }
    catch (error) {
        // An older/offline wmux leaves the CLI usable. Say so when wmux was there
        // but never answered: that pane is about to run without session capture.
        if (isTransientWmuxError(error))
            console.error('[wmux] wmux did not answer; starting Codex without session restore.');
    }
    if (!enabled)
        return runCli(executable, args, env);
    const remote = await supportsRemote(executable, env);
    if (remote !== true) {
        console.error(remote === null
            ? '[wmux] Codex did not answer `codex --help` in time; starting it without session restore.'
            : '[wmux] This Codex version cannot record sessions for automatic restore. Starting Codex normally.');
        return runCli(executable, args, env);
    }
    // Serialize reports so a delayed response cannot stamp an older thread last.
    let reports = Promise.resolve();
    const report = (method, sessionId) => {
        reports = reports.then(async () => {
            try {
                await wmuxRequestPatiently(method, { surfaceId, sessionId }, REPORT_PATIENCE);
            }
            catch { /* A crashed wmux cannot receive a report; Codex still owns its history. */ }
        });
    };
    const target = resumeTarget(plan.clientArgs);
    const relay = await startRelay({
        executable, args: plan.serverArgs, cwd: plan.cwd, env, yolo: plan.yolo,
        onSession: sessionId => report('pane.report_codex_session', sessionId),
        // Only the conversation this launch was asked to reopen — what a restore
        // typed. wmux then forgets that saved id instead of retrying it forever.
        onMissing: sessionId => { if (sessionId === target)
            report('pane.codex_session_missing', sessionId); },
    });
    if (!relay)
        return runCli(executable, args, env);
    let exitCode;
    try {
        exitCode = await runCli(executable, [
            '--remote', relay.url, '--remote-auth-token-env', 'WMUX_CODEX_RELAY_TOKEN', ...plan.clientArgs,
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
            await wmuxRequestPatiently('pane.release_codex_session', { surfaceId, sessionId: relay.sessionId }, RELEASE_PATIENCE);
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
