import net from 'net';
import { EventEmitter } from 'events';

export interface V1Command {
  command: string;
  surfaceId: string;
  args: string[];
}

export interface V2Request {
  method: string;
  params: Record<string, any>;
  id?: string | number;
}

export interface V2Response {
  result?: any;
  error?: { code: number; message: string };
  id?: string | number;
}

export class PipeServer extends EventEmitter {
  private server: net.Server | null = null;
  private pipePath: string;

  constructor(pipePath = '\\\\.\\pipe\\wmux') {
    super();
    this.pipePath = pipePath;
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
        // Single path argument — may contain spaces
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

    const v1Command: V1Command = { command, surfaceId, args };
    this.emit('v1', v1Command);

    // Respond with OK for simple commands
    if (command === 'ping') {
      socket.write('pong\n');
    } else {
      socket.write('ok\n');
    }
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

    // Emit the V2 request and let handlers respond
    const handled = this.emit('v2', request, respond, respondError);
    if (!handled) {
      respondError(-32601, `Method not found: ${request.method}`);
    }
  }
}
