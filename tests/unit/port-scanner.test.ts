import { describe, it, expect } from 'vitest';
import { PortScanner } from '../../src/main/port-scanner';

describe('PortScanner', () => {
  it('parses netstat LISTENING lines', () => {
    const scanner = new PortScanner();
    const output = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12345
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       12345
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       67890
  TCP    0.0.0.0:443            0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:9229         0.0.0.0:0              LISTENING       12345
  TCP    0.0.0.0:80             0.0.0.0:0              ESTABLISHED     99999
`;
    const result = scanner.parseNetstat(output);
    expect(result.get(12345)?.sort()).toEqual([3000, 8080, 9229].sort());
    expect(result.get(67890)).toEqual([5173]);
    expect(result.has(4)).toBe(false); // port 443 < 1024
    expect(result.has(99999)).toBe(false); // ESTABLISHED, not LISTENING
  });

  it('handles empty output', () => {
    const scanner = new PortScanner();
    const result = scanner.parseNetstat('');
    expect(result.size).toBe(0);
  });
});
