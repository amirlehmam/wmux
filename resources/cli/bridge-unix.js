"use strict";
/**
 * Deciding whether `wmux bridge --unix <path>` may listen where it was asked to.
 *
 * `--unix` is the bridge without a network address at all: it listens on a Unix
 * domain socket instead of a TCP port, so the thing that reaches it is whatever
 * can open that file, not whatever can route to an address. That matters inside
 * WSL2 because the answer to "who can reach `0.0.0.0` here" depends on the
 * networking mode (see wsl-network.ts), and some modes (`consomme`, which the
 * WSL docs say used to be called `virtioproxy`) are not documented well enough
 * to say. A socket sidesteps the question. The pipe token still authenticates
 * every request; the file's permissions are a second gate in front of it.
 *
 * The socket has to live on the distro's own filesystem, created by a process
 * inside the distro, and be handed to the container by bind-mounting its
 * directory. That is not the "cross-boundary Unix socket" docs/DEVCONTAINER.md
 * says was tried first and dropped: that was a socket on the Windows side
 * reached over 9P, which does not forward AF_UNIX. Here the listener and the
 * client share one kernel, so nothing has to cross 9P — and a path on a 9P
 * mount (`/mnt/c/...`) is refused, because there the bind would either fail or
 * produce a file nothing can connect to.
 *
 * Everything here is pure so the rules can be tested off Windows entirely; the
 * I/O (reading the directory's mode, probing a stale socket, listening) is in
 * wmux.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_UNIX_SOCKET_PATH_BYTES = void 0;
exports.checkUnixBridgeRequest = checkUnixBridgeRequest;
exports.checkSocketDir = checkSocketDir;
exports.decideSocketPath = decideSocketPath;
/** `sockaddr_un.sun_path` is 108 bytes on Linux, one of which is the terminating NUL. */
exports.MAX_UNIX_SOCKET_PATH_BYTES = 107;
/**
 * The flag-combination and path-shape rules, in one place. Returns the reason
 * to refuse, or null when the request may go on to the directory checks.
 *
 * Mutually exclusive with `--host`, `--wsl` and `--port` rather than quietly
 * preferring one: each of those describes a TCP listener, so passing one next to
 * `--unix` means the user believes a port is being opened, and a bridge that
 * silently opened a socket instead would leave them pointing a client at it.
 */
function checkUnixBridgeRequest(req) {
    const tcpFlags = [
        req.host !== undefined ? '--host' : '',
        req.wsl ? '--wsl' : '',
        req.portGiven ? '--port' : '',
    ].filter(Boolean);
    if (tcpFlags.length > 0) {
        return (`--unix listens on a socket, not an address, so it cannot be combined with ${tcpFlags.join(' or ')}. ` +
            'Drop the TCP flag, or drop --unix to get a TCP listener.');
    }
    if (req.platform === 'win32') {
        return ('--unix is for a bridge running inside WSL or on Linux. On Windows Node turns a socket path into a ' +
            'named pipe, which is not what the container-side clients dial.');
    }
    if (req.unixPath === undefined || req.unixPath === '') {
        return '--unix takes the path of the socket to create, for example --unix "$HOME/.cache/wmux/sock/wmux.sock".';
    }
    const p = req.unixPath;
    if (!p.startsWith('/')) {
        return (`--unix needs an absolute path, got "${p}". A relative path would name a different file ` +
            'depending on where the bridge was started, and the container mount has to name one directory.');
    }
    if (/^\/mnt\/[a-zA-Z](\/|$)/.test(p)) {
        return (`--unix path "${p}" is on a Windows drive mounted into WSL (9P). 9P does not forward AF_UNIX, ` +
            'so a socket there cannot be dialled. Put it on the distro\'s own filesystem, for example under ' +
            '$HOME/.cache, and bind-mount that directory into the container.');
    }
    const bytes = Buffer.byteLength(p, 'utf8');
    if (bytes > exports.MAX_UNIX_SOCKET_PATH_BYTES) {
        return (`--unix path is ${bytes} bytes; a Unix socket path can be at most ${exports.MAX_UNIX_SOCKET_PATH_BYTES}. ` +
            'Use a shorter directory.');
    }
    if (p === req.upstreamPath) {
        return (`--unix path "${p}" is also where this bridge would connect to wmux (WMUX_PIPE), so it would relay to ` +
            'itself. Unset WMUX_PIPE or pick another path.');
    }
    return null;
}
/**
 * The directory rules. A socket's own mode only stops other users connecting; a
 * directory that others can write to lets them replace the socket (or the
 * bind-mount source) with their own before the container starts, so group- or
 * world-writable parents are refused, sticky bit or not.
 */
function checkSocketDir(dir, facts) {
    if (!facts.exists) {
        return `--unix directory ${dir} does not exist. Create it first, for example: mkdir -p -m 700 ${dir}`;
    }
    if (!facts.isDirectory) {
        return `--unix parent ${dir} is not a directory.`;
    }
    if ((facts.mode & 0o022) !== 0) {
        return (`--unix directory ${dir} is writable by group or others (mode ${(facts.mode & 0o777).toString(8)}), ` +
            'which would let another user swap the socket for their own. Use a directory only you can write to, ' +
            `for example: chmod 700 ${dir}`);
    }
    return null;
}
/**
 * Whether the bridge may take the path, and whether a leftover file has to be
 * removed first. Only a socket nobody is listening on (`ECONNREFUSED`) is ever
 * deleted: a regular file is the user's, a live listener is another bridge, and
 * a probe that failed any other way proves nothing.
 */
function decideSocketPath(p, state) {
    switch (state.kind) {
        case 'absent':
            return { action: 'listen', error: null };
        case 'not-a-socket':
            return {
                action: 'refuse',
                error: `${p} exists and is not a socket, so it is not removed. Move it away or pick another path.`,
            };
        case 'socket':
            if (state.probe === 'refused')
                return { action: 'unlink-then-listen', error: null };
            if (state.probe === 'listening') {
                return {
                    action: 'refuse',
                    error: `${p} already has a listener (another wmux bridge?). Stop it or pick another path.`,
                };
            }
            return {
                action: 'refuse',
                error: `${p} is a socket, but whether anything listens on it could not be determined` +
                    `${state.probeError ? ` (${state.probeError})` : ''}, so it is not removed.`,
            };
    }
}
