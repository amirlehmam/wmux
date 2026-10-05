"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BACKENDS = void 0;
exports.createCodexRelay = createCodexRelay;
/** Per-terminal, authenticated loopback transport. No transcript is logged or saved. */
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const readline_1 = require("readline");
const ws_1 = require("ws");
const codex_session_tracker_1 = require("./codex-session-tracker");
/** The TUI plus its auxiliary picker connections; Codex opens one or two. */
exports.MAX_BACKENDS = 8;
async function createCodexRelay(options) {
    const token = (0, crypto_1.randomBytes)(32).toString('hex');
    const expected = Buffer.from(`Bearer ${token}`);
    let closing = false;
    let sessionId;
    const backends = new Set();
    const stopping = new Map();
    // A picker has its own connection and may close before the main TUI does.
    // Retire only its backend, and bound shutdown even if stdin EOF is ignored.
    const stopBackend = (child) => {
        const pending = stopping.get(child);
        if (pending)
            return pending;
        if (!child.pid || child.exitCode !== null || child.signalCode !== null)
            return Promise.resolve();
        const done = new Promise(resolve => {
            const timeout = setTimeout(() => { child.kill(); resolve(); }, 1500);
            child.once('exit', () => { clearTimeout(timeout); resolve(); });
            child.stdin.end();
        });
        stopping.set(child, done);
        void done.then(() => { stopping.delete(child); });
        return done;
    };
    const server = new ws_1.WebSocketServer({
        host: '127.0.0.1', port: 0, maxPayload: 100 * 1024 * 1024,
        verifyClient: ({ req }, done) => {
            const supplied = Buffer.from(req.headers.authorization ?? '');
            const allowed = !closing && !req.headers.origin &&
                supplied.length === expected.length && (0, crypto_1.timingSafeEqual)(supplied, expected);
            if (!allowed)
                return done(false, 401);
            // Each connection is a whole `codex app-server`. The token already keeps
            // out everyone who could not spawn codex anyway; this bounds a client
            // stuck in a reconnect loop.
            if (backends.size >= exports.MAX_BACKENDS)
                return done(false, 503);
            done(true);
        },
    });
    server.on('connection', socket => {
        // A handshake verified just before close() still lands here, after close()
        // snapshotted `backends` — a child spawned now would outlive the relay.
        if (closing) {
            socket.terminate();
            return;
        }
        // Codex opens auxiliary clients for /resume and the startup picker.
        // Give each stdio client its own backend and request-ID namespace; simply
        // removing the one-client gate would cross-wire their JSON-RPC responses.
        const tracker = new codex_session_tracker_1.CodexSessionTracker(id => {
            if (id === sessionId)
                return;
            sessionId = id;
            options.onSession(id);
        });
        const child = (0, child_process_1.spawn)(options.executable, options.args, {
            cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        backends.add(child);
        // Codex writes diagnostics to its own logs. Do not mix backend stderr into
        // the terminal's TUI or retain potentially sensitive protocol content here.
        child.stderr.resume();
        child.stdin.on('error', () => socket.close(1011, 'Codex input closed'));
        child.stdout.on('error', () => socket.close(1011, 'Codex output closed'));
        child.on('error', () => { backends.delete(child); socket.close(1011, 'Could not start Codex app-server'); });
        child.on('exit', () => { backends.delete(child); socket.close(); });
        socket.on('message', raw => {
            const text = raw.toString();
            tracker.request(text);
            if (!child.stdin.write(text + '\n'))
                socket.pause();
        });
        child.stdin.on('drain', () => socket.resume());
        const lines = (0, readline_1.createInterface)({ input: child.stdout });
        lines.on('line', line => {
            tracker.response(line);
            if (socket.readyState !== ws_1.WebSocket.OPEN)
                return;
            child.stdout.pause();
            socket.send(line, () => child.stdout.resume());
        });
        socket.on('error', () => { void stopBackend(child); });
        socket.on('close', () => { void stopBackend(child); });
    });
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('No Codex relay address');
    return {
        url: `ws://127.0.0.1:${address.port}`, token,
        get sessionId() { return sessionId; },
        async close() {
            if (closing)
                return;
            closing = true;
            for (const socket of server.clients)
                socket.terminate();
            server.close();
            await Promise.all([...backends].map(stopBackend));
        },
    };
}
