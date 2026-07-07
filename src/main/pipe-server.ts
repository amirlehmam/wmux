import net from 'net';
import { EventEmitter } from 'events';
import { tokensMatch } from '../shared/instance';

export interface V1Command {
  command: string;
  surfaceId: string;
  args: string[];
}

export interface V2Request {
  method: string;
  params: Record<string, any>;
  id?: string | number;
  token?: string;
}

// V2 methods that are safe to call without authentication. These are strictly
// read-only and don't mutate any UI/agent state. Everything else — including
// telemetry-style writes like hook.event and agent.activity, which can spoof
// agent status / notifications / diff refreshes (issue #72) — requires a valid
// per-instance token. The legitimate telemetry clients (Claude Code hooks,
// agents, shell integration) all run inside wmux-spawned shells and carry
// WMUX_PIPE_TOKEN, so nothing tokenless has a reason to write state. Keeping
// an allowlist (rather than a blocklist) means any new privileged method is
// locked down by default.
const PUBLIC_V2_METHODS = new Set<string>([
  'system.identify',
  'system.capabilities',
]);

export interface V2Response {
  result?: any;
  error?: { code: number; message: string };
  id?: string | number;
}

export class PipeServer extends EventEmitter {
  private server: net.Server | null = null;
  private pipePath: string;
  private authToken: string;

  constructor(pipePath = '\\\\.\\pipe\\wmux', authToken = '') {
    super();
    this.pipePath = pipePath;
    this.authToken = authToken;
  }

  start(): void {
    this.server = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();

        // Process complete lines
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.substring(0, newlineIdx).trim();
          buffer = buffer.substring(newlineIdx + 1);

          if (!line) continue;

          // Try JSON-RPC (V2) first
          if (line.startsWith('{')) {
            try {
              const request = JSON.parse(line) as V2Request;
              this.handleV2(request, socket);
            } catch {
              socket.write(JSON.stringify({ error: { code: -32700, message: 'Parse error' } }) + '\n');
            }
          } else {
            // V1 text protocol
            this.handleV1(line, socket);
          }
        }
      });

      socket.on('error', () => {
        // Client disconnected, ignore
      });
    });

    this.server.listen(this.pipePath, () => {
      console.log(`wmux pipe server listening on ${this.pipePath}`);
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Pipe already exists, try to clean up and retry
        net.connect({ path: this.pipePath }, () => {}).on('error', () => {
          // No one is listening, safe to unlink and retry
          this.server?.close();
          // On Windows, just retry after a short delay
          setTimeout(() => this.start(), 500);
        });
      }
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private handleV1(line: string, socket: net.Socket): void {
    // V1 lines from wmux-spawned clients carry an "auth <token> " prefix
    // (WMUX_PIPE_TOKEN is injected into every wmux shell). All V1 commands
    // mutate UI state (notify, report_pwd, report_pr, shell state, …), so —
    // like privileged V2 methods — they require the per-instance token; an
    // unauthenticated local process must not be able to spoof them (issue
    // #72). Only `ping` (read-only liveness probe) stays public.
    let authed = false;
    if (line.startsWith('auth ')) {
      const rest = line.substring(5);
      const tokenEnd = rest.indexOf(' ');
      const token = tokenEnd === -1 ? rest : rest.substring(0, tokenEnd);
      authed = !!this.authToken && tokensMatch(token, this.authToken);
      line = tokenEnd === -1 ? '' : rest.substring(tokenEnd + 1).trim();
    }

    // Parse command and surfaceId from fixed positions, then handle args
    // per-command to avoid breaking paths that contain spaces (e.g. OneDrive).
    const firstSpace = line.indexOf(' ');
    const command = firstSpace === -1 ? line : line.substring(0, firstSpace);
    const rest = firstSpace === -1 ? '' : line.substring(firstSpace + 1);

    const secondSpace = rest.indexOf(' ');
    const surfaceId = secondSpace === -1 ? rest : rest.substring(0, secondSpace);
    const argsRaw = secondSpace === -1 ? '' : rest.substring(secondSpace + 1).trim();

    let args: string[];
    switch (command) {
      case 'report_pwd':
      case 'notify':
        // Single free-text argument — may contain spaces (issue #53).
        args = argsRaw ? [argsRaw] : [];
        break;
      case 'report_pr': {
        // format: <number> <state> <title...>  — title may contain spaces
        const prParts = argsRaw.split(/\s+/);
        args = prParts.length >= 3
          ? [prParts[0], prParts[1], prParts.slice(2).join(' ')]
          : prParts;
        break;
      }
      default:
        args = argsRaw ? argsRaw.split(/\s+/) : [];
        break;
    }

    if (command === 'ping') {
      socket.write('pong\n');
      return;
    }

    if (!authed) {
      socket.write('unauthorized\n');
      return;
    }

    const v1Command: V1Command = { command, surfaceId, args };
    this.emit('v1', v1Command);
    socket.write('ok\n');
  }

  private handleV2(request: V2Request, socket: net.Socket): void {
    const respond = (result: any) => {
      const response: V2Response = { result, id: request.id };
      socket.write(JSON.stringify(response) + '\n');
    };

    const respondError = (code: number, message: string) => {
      const response: V2Response = { error: { code, message }, id: request.id };
      socket.write(JSON.stringify(response) + '\n');
    };

    // Authenticate privileged methods. Only read-only discovery methods
    // (identify/capabilities) are exempt so instance detection keeps working
    // without a token. -32001 signals "unauthorized" to clients.
    if (!PUBLIC_V2_METHODS.has(request.method)) {
      if (!this.authToken) {
        respondError(-32001, 'Unauthorized: pipe auth token not initialized');
        return;
      }
      if (!tokensMatch(request.token || '', this.authToken)) {
        respondError(-32001, 'Unauthorized: missing or invalid token');
        return;
      }
    }

    // Emit the V2 request and let handlers respond
    const handled = this.emit('v2', request, respond, respondError);
    if (!handled) {
      respondError(-32601, `Method not found: ${request.method}`);
    }
  }
}
