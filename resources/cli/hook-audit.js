"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROBE_TOOLS = void 0;
exports.verdictFor = verdictFor;
exports.matcherMatches = matcherMatches;
exports.probeToolFor = probeToolFor;
exports.hooksFromConfig = hooksFromConfig;
exports.claudeConfigDir = claudeConfigDir;
exports.discoverHooks = discoverHooks;
exports.resolveHookShell = resolveHookShell;
exports.median = median;
exports.untimedReason = untimedReason;
exports.buildReport = buildReport;
exports.formatReport = formatReport;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
/** Tools a hook is probed with, in order. The first one its matcher accepts wins. */
exports.PROBE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'];
/** The tools whose total is printed: what an agent calls most. */
const SUMMARY_TOOLS = ['Bash', 'Read', 'Edit'];
/** A hook that takes longer than this per run is reported as a timeout. */
const RUN_TIMEOUT_MS = 15_000;
/**
 * How a measured hook is judged.
 *
 * The floor on Windows is one Git Bash start, about 30 ms, and a hook that
 * starts node on top of it lands near 60-70 ms. `slow` therefore starts above
 * what a well-behaved node hook costs, and `heavy` is where one hook alone is
 * felt on every call.
 */
function verdictFor(ms) {
    if (ms >= 300)
        return 'heavy';
    if (ms >= 100)
        return 'slow';
    return 'ok';
}
/** Does a hook group's matcher accept this tool? Empty and `*` accept all. */
function matcherMatches(matcher, tool) {
    if (matcher === '' || matcher === '*')
        return true;
    try {
        return new RegExp(`^(?:${matcher})$`).test(tool);
    }
    catch {
        // A matcher that is not a valid pattern matches nothing in Claude Code either.
        return false;
    }
}
/** The tool to probe a matcher with, or null when it only accepts tools we do not fake. */
function probeToolFor(matcher) {
    return exports.PROBE_TOOLS.find((tool) => matcherMatches(matcher, tool)) ?? null;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function hookFromRaw(raw, base) {
    const h = asRecord(raw);
    if (!h)
        return null;
    const type = typeof h.type === 'string' ? h.type : 'command';
    return {
        ...base,
        type,
        command: typeof h.command === 'string' ? h.command : '',
        async: h.async === true,
        ...(typeof h.timeout === 'number' ? { timeoutSec: h.timeout } : {}),
        ...(typeof h.shell === 'string' ? { shell: h.shell } : {}),
    };
}
/**
 * Pure: flatten a `hooks` block (`{ Event: [{ matcher, hooks: [...] }] }`) into
 * entries. Anything that is not that shape is skipped, since a settings file a
 * user broke by hand must not take the whole report down.
 */
function hooksFromConfig(hooksBlock, source, sourceKind, pluginRoot) {
    const block = asRecord(hooksBlock);
    if (!block)
        return [];
    const out = [];
    for (const [event, groups] of Object.entries(block)) {
        if (!Array.isArray(groups))
            continue;
        for (const group of groups) {
            out.push(...hooksFromGroup(group, { source, sourceKind, event, pluginRoot }));
        }
    }
    return out;
}
function hooksFromGroup(group, base) {
    const g = asRecord(group);
    if (!g || !Array.isArray(g.hooks))
        return [];
    const matcher = typeof g.matcher === 'string' ? g.matcher : '';
    return g.hooks
        .map((raw) => hookFromRaw(raw, { ...base, matcher }))
        .filter((entry) => entry !== null);
}
function readJson(file) {
    try {
        return asRecord(JSON.parse(fs_1.default.readFileSync(file, 'utf8')));
    }
    catch {
        return null;
    }
}
function claudeConfigDir(env = process.env) {
    return env.CLAUDE_CONFIG_DIR || path_1.default.join(os_1.default.homedir(), '.claude');
}
function pluginHooks(configDir, enabled) {
    const registry = readJson(path_1.default.join(configDir, 'plugins', 'installed_plugins.json'));
    const plugins = asRecord(registry?.plugins);
    if (!plugins)
        return [];
    const out = [];
    // A plugin installed at user and project scope lists the same path twice,
    // and Claude Code loads it once.
    const seen = new Set();
    for (const [name, installs] of Object.entries(plugins)) {
        if (enabled[name] !== true || !Array.isArray(installs))
            continue;
        for (const install of installs) {
            const root = asRecord(install)?.installPath;
            if (typeof root !== 'string' || seen.has(root))
                continue;
            seen.add(root);
            const file = readJson(path_1.default.join(root, 'hooks', 'hooks.json'));
            if (file)
                out.push(...hooksFromConfig(file.hooks ?? file, name, 'plugin', root));
        }
    }
    return out;
}
/** Every hook Claude Code would load for a session started in `cwd`. */
function discoverHooks(configDir, cwd) {
    const files = [
        path_1.default.join(configDir, 'settings.json'),
        path_1.default.join(configDir, 'settings.local.json'),
        path_1.default.join(cwd, '.claude', 'settings.json'),
        path_1.default.join(cwd, '.claude', 'settings.local.json'),
    ];
    const hooks = [];
    const enabled = {};
    let statuslineCommand = null;
    for (const file of files) {
        const json = readJson(file);
        if (!json)
            continue;
        hooks.push(...hooksFromConfig(json.hooks, file, 'settings'));
        // Later files are more specific, so their choice replaces an earlier one.
        Object.assign(enabled, asRecord(json.enabledPlugins) ?? {});
        const command = asRecord(json.statusLine)?.command;
        if (typeof command === 'string')
            statuslineCommand = command;
    }
    hooks.push(...pluginHooks(configDir, enabled));
    return { hooks, statuslineCommand };
}
/**
 * The shell Claude Code runs a hook in: Git Bash on Windows, bash elsewhere.
 *
 * Looked up by absolute path and never through PATH, so the number reported is
 * for the shell the agent really starts and not for whichever `bash` a PATH
 * entry put first (WSL's `bash.exe` in System32 is the usual one).
 */
function resolveHookShell(env = process.env, platform = process.platform, exists = fs_1.default.existsSync) {
    const candidates = [];
    if (platform === 'win32') {
        if (env.CLAUDE_CODE_GIT_BASH_PATH)
            candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
        const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path_1.default.win32.join(env.LOCALAPPDATA, 'Programs')];
        for (const root of roots) {
            if (root)
                candidates.push(path_1.default.win32.join(root, 'Git', 'bin', 'bash.exe'));
        }
    }
    else {
        candidates.push(path_1.default.posix.join('/bin', 'bash'), path_1.default.posix.join('/usr', 'bin', 'bash'), path_1.default.posix.join('/bin', 'sh'));
    }
    return candidates.find((file) => exists(file)) ?? null;
}
function probePayload(event, tool, cwd) {
    const toolInput = tool === 'Bash'
        ? { command: 'true', description: 'wmux perf probe' }
        : { file_path: path_1.default.join(cwd, 'wmux-perf-probe.missing') };
    return JSON.stringify({
        session_id: 'wmux-perf-probe',
        hook_event_name: event,
        cwd,
        tool_name: tool,
        tool_input: toolInput,
        ...(event === 'PostToolUse' ? { tool_response: {} } : {}),
    });
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}
/**
 * The hook command reaches bash in an environment variable and is `eval`ed,
 * never as the `-c` argument itself.
 *
 * Git Bash's runtime rewrites the arguments a native process hands it: an
 * argument with no space in it gets brace and glob expansion before bash sees
 * it. `${A:-${B}}/hooks/x.sh` arrived as `$A:-${B}/hooks/x.sh`, exited 127, and
 * was reported as a 36 ms hook that does nothing, when the real one starts jq
 * three times. Environment values are not rewritten.
 */
const COMMAND_VAR = 'WMUX_PERF_COMMAND';
const RUN_COMMAND_VAR = `eval "$${COMMAND_VAR}"`;
function timeCommand(shell, command, input, baseEnv, runs) {
    const times = [];
    let exitCode = null;
    const env = { ...baseEnv, [COMMAND_VAR]: command };
    for (let i = 0; i < runs; i++) {
        const started = process.hrtime.bigint();
        const result = (0, child_process_1.spawnSync)(shell, ['-c', RUN_COMMAND_VAR], {
            input,
            env,
            timeout: RUN_TIMEOUT_MS,
            windowsHide: true,
            stdio: ['pipe', 'ignore', 'ignore'],
        });
        times.push(Number(process.hrtime.bigint() - started) / 1e6);
        exitCode = result.status;
        // One timeout is the answer. Running it again only makes the report slower.
        if (result.error && result.error.code === 'ETIMEDOUT') {
            return { ms: RUN_TIMEOUT_MS, exitCode: null, timedOut: true };
        }
    }
    return { ms: median(times), exitCode, timedOut: false };
}
/** Why a sync tool-call hook cannot be timed, or null when it can. */
function untimedReason(hook, skip) {
    if (hook.type !== 'command')
        return `type "${hook.type}" is not a command`;
    if (!hook.command)
        return 'no command';
    if (hook.shell && hook.shell !== 'bash')
        return `runs in ${hook.shell}`;
    if (skip && hook.command.includes(skip))
        return 'skipped by --skip';
    if (!probeToolFor(hook.matcher))
        return 'matches none of the probed tools';
    return null;
}
function sumPerTool(timed) {
    return SUMMARY_TOOLS.map((tool) => {
        const matching = timed.filter((t) => matcherMatches(t.hook.matcher, tool));
        return { tool, ms: matching.reduce((sum, t) => sum + t.ms, 0), hooks: matching.length };
    });
}
function hookEnv(hook, cwd) {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
    // Plugin commands are written against a forward-slash root, which is what
    // Claude Code hands them on Windows too.
    if (hook.pluginRoot)
        env.CLAUDE_PLUGIN_ROOT = hook.pluginRoot.replace(/\\/g, '/');
    return env;
}
function buildReport(options) {
    const { hooks, statuslineCommand } = discoverHooks(options.configDir, options.cwd);
    const shell = options.run ? resolveHookShell() : null;
    const report = {
        shell,
        floorMs: null,
        runs: options.runs,
        timed: [],
        untimed: [],
        otherSync: {},
        asyncCount: hooks.filter((h) => h.async).length,
        perTool: [],
        statusline: null,
    };
    for (const hook of hooks) {
        if (hook.async)
            continue;
        if (!TOOL_EVENTS.has(hook.event)) {
            report.otherSync[hook.event] = (report.otherSync[hook.event] ?? 0) + 1;
            continue;
        }
        const reason = untimedReason(hook, options.skip) ?? (shell ? null : 'not run');
        if (reason || !shell) {
            report.untimed.push({ hook, reason: reason ?? 'not run' });
            continue;
        }
        const probeTool = probeToolFor(hook.matcher);
        const input = probePayload(hook.event, probeTool, options.cwd);
        const result = timeCommand(shell, hook.command, input, hookEnv(hook, options.cwd), options.runs);
        report.timed.push({ hook, probeTool, ...result, verdict: verdictFor(result.ms) });
    }
    if (shell) {
        report.floorMs = timeCommand(shell, 'true', '', process.env, options.runs).ms;
        if (statuslineCommand) {
            const input = JSON.stringify({
                session_id: 'wmux-perf-probe',
                cwd: options.cwd,
                model: { id: 'probe', display_name: 'probe' },
                workspace: { current_dir: options.cwd, project_dir: options.cwd },
            });
            const result = timeCommand(shell, statuslineCommand, input, process.env, options.runs);
            report.statusline = { command: statuslineCommand, ms: result.ms };
        }
    }
    report.timed.sort((a, b) => b.ms - a.ms);
    report.perTool = sumPerTool(report.timed);
    return report;
}
function sourceLabel(hook) {
    return hook.sourceKind === 'plugin' ? `plugin ${hook.source}` : hook.source;
}
function clip(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function exitNote(timed) {
    if (timed.timedOut)
        return `  (no answer after ${RUN_TIMEOUT_MS / 1000} s)`;
    if (timed.exitCode === 127)
        return '  (exit 127: the command was not found, so this hook does nothing but cost time)';
    return '';
}
function timedLines(timed) {
    const lines = [];
    for (const t of timed) {
        const ms = `${Math.round(t.ms)} ms`.padStart(8);
        lines.push(`${ms}  ${t.verdict.padEnd(5)}  ${t.hook.event} [${t.hook.matcher || '*'}]  ${sourceLabel(t.hook)}`);
        lines.push(`${' '.repeat(17)}${clip(t.hook.command, 100)}${exitNote(t)}`);
    }
    return lines;
}
function adviceLines(timed) {
    const flagged = timed.filter((t) => t.verdict !== 'ok' || t.exitCode === 127);
    if (flagged.length === 0)
        return ['Nothing to fix: no blocking hook is slow.'];
    const lines = ['What to do (wmux changes none of this for you):'];
    const plugins = new Set();
    const files = new Set();
    for (const t of flagged) {
        if (t.hook.sourceKind === 'plugin')
            plugins.add(t.hook.source);
        else
            files.add(t.hook.source);
    }
    for (const name of plugins) {
        lines.push(`  - plugin ${name}: disable it with /plugin if you do not use it.`);
    }
    if (plugins.size > 0) {
        lines.push('    Editing a plugin\'s hooks.json works until its next update puts the file back.');
    }
    for (const file of files) {
        lines.push(`  - ${file}: add "async": true to a flagged hook that only observes.`);
    }
    if (files.size > 0) {
        lines.push('    An async hook can no longer block a tool or send text to the agent, so leave a gate as it is.');
    }
    return lines;
}
function untimedLines(report) {
    const lines = [];
    if (report.untimed.length > 0) {
        lines.push('', 'Blocking tool-call hooks that were not timed:');
        for (const { hook, reason } of report.untimed) {
            lines.push(`  ${hook.event} [${hook.matcher || '*'}]  ${sourceLabel(hook)}  (${reason})`);
        }
    }
    const others = Object.entries(report.otherSync);
    if (others.length > 0) {
        const summary = others.map(([event, count]) => `${event} ${count}`).join(', ');
        lines.push('', `Blocking hooks on other events, counted and not run: ${summary}`);
    }
    return lines;
}
/** Pure: the text `wmux perf` prints. */
function formatReport(report) {
    const lines = ['wmux perf: what Claude Code\'s hooks add to every tool call', ''];
    if (report.shell) {
        lines.push(`Hook shell: ${report.shell}`, `Floor: ${Math.round(report.floorMs ?? 0)} ms for an empty hook (one shell start). Median of ${report.runs} runs each.`, '');
    }
    else {
        lines.push('No hook was run, so there are no timings below.', '');
    }
    if (report.timed.length > 0) {
        lines.push(...timedLines(report.timed), '', 'Blocking time added per call:');
        for (const t of report.perTool) {
            const count = t.hooks === 1 ? '1 hook' : `${t.hooks} hooks`;
            lines.push(`  ${t.tool.padEnd(5)} ${String(Math.round(t.ms)).padStart(5)} ms  (${count})`);
        }
    }
    else if (report.shell) {
        lines.push('No blocking hook runs on tool calls.');
    }
    if (report.statusline) {
        lines.push('', `Statusline: ${Math.round(report.statusline.ms)} ms per refresh (does not block tool calls).`);
    }
    lines.push(...untimedLines(report), '', `Async hooks (cost nothing here): ${report.asyncCount}`);
    if (report.shell)
        lines.push('', ...adviceLines(report.timed));
    return lines.join('\n');
}
