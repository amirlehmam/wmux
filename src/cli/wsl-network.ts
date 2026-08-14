/**
 * Deciding what `wmux bridge` may bind to, and why, when it runs inside WSL2.
 *
 * `--wsl` exists so a container on the Windows host can reach a bridge running
 * inside the distro (issue #19): `127.0.0.1` in the distro is not an address the
 * container can dial, so the bridge has to listen on `0.0.0.0`. Whether that is
 * a modest thing to do or a genuinely bad one depends entirely on which
 * networking mode WSL2 is running, and the two differ more than the name
 * suggests:
 *
 *   NAT (the default)  The distro gets its own network namespace behind a
 *                      Hyper-V vSwitch. `0.0.0.0` there is the distro's loopback
 *                      plus an `eth0` on a private 172.x — reachable from
 *                      containers on the same host via the Docker host gateway,
 *                      not reachable from the LAN, and no Windows firewall rule
 *                      is involved either way.
 *
 *   Mirrored           `networkingMode=mirrored` in `.wslconfig` (WSL 2.0+ on
 *                      Windows 11). The distro no longer has its own namespace —
 *                      it SHARES the Windows host's interfaces, including the
 *                      physical LAN adapter and any VPN adapter. `0.0.0.0` in
 *                      that distro is a bind on the corporate network. Inbound
 *                      traffic is filtered by the Hyper-V firewall rather than
 *                      the ordinary Windows Firewall profile, and the
 *                      widely-copied "make WSL reachable" recipe is
 *                      `Set-NetFirewallHyperVVMSetting -Name
 *                      '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
 *                      -DefaultInboundAction Allow`. Mirrored mode plus that
 *                      setting puts wmux's control pipe on the LAN.
 *
 * The pipe token still authenticates every request in both cases, so mirrored
 * mode is exposure rather than an open door. It is still not something to pick
 * on the user's behalf from an inferred default, so the mode is read at runtime
 * and `--wsl` refuses to choose `0.0.0.0` unless it has confirmed NAT. An
 * explicit `--host 0.0.0.0` is always honoured — that is a stated choice.
 *
 * Everything here is pure so the decision can be tested off Windows entirely;
 * `readWslEnvironment()` in wmux.ts does the I/O.
 */

export type WslNetworkingMode = 'nat' | 'mirrored' | 'unknown';

export interface WslEnvironment {
  /** `/proc/sys/kernel/osrelease`, or null when it could not be read. */
  osRelease: string | null;
  /** Whether WSL_INTEROP or WSL_DISTRO_NAME is set in the environment. */
  hasInteropEnv: boolean;
}

/**
 * Whether this process is inside a WSL distro at all.
 *
 * Both signals are required, because each is weak alone: the kernel string is
 * whatever `/proc` says, which a container mounting its own `/proc` can differ
 * on, and the env vars are inherited by anything a WSL shell launches —
 * including a process that has since crossed into a container with its own
 * network stack, which is precisely the case `--wsl` must not fire in.
 *
 * It does not separate WSL2 from WSL1, and does not need to: WSL1 predates
 * `wslinfo` by years, so the mode comes back `unknown` there and the caller
 * refuses to guess. WSL1 shares the Windows network stack outright, so the
 * namespace argument `--wsl` rests on never applied to it anyway.
 */
export function isWsl2(env: WslEnvironment): boolean {
  const release = (env.osRelease || '').toLowerCase();
  const looksLikeWsl = release.includes('microsoft') || release.includes('wsl');
  return looksLikeWsl && env.hasInteropEnv;
}

/**
 * `wslinfo --networking-mode` prints one bare word. Anything else — the command
 * missing (WSL older than 2.0.5), a non-zero exit, an unrecognised word — is
 * `unknown`, which is treated as "not proven safe" rather than folded into the
 * NAT default. Silently assuming the safe case is how an assumption stops being
 * load-bearing and starts being a bug.
 */
export function parseNetworkingMode(output: string | null): WslNetworkingMode {
  const word = (output || '').trim().toLowerCase();
  if (word === 'nat') return 'nat';
  if (word === 'mirrored') return 'mirrored';
  return 'unknown';
}

export interface BindDecision {
  /** Address to listen on, or null when the bridge must not start. */
  host: string | null;
  /** Lines to print before listening. */
  notices: string[];
  /** Reason to refuse, printed to stderr. Set exactly when host is null. */
  error: string | null;
}

export interface BindRequest {
  /** Value of --host, if the user passed one. */
  explicitHost?: string;
  /** Whether --wsl was passed. */
  wslMode: boolean;
  /** Whether this process is actually running under WSL2. */
  inWsl2: boolean;
  /** Networking mode as reported by wslinfo. */
  mode: WslNetworkingMode;
  /** Port, for the SSH-tunnel suggestion. */
  port: number;
}

const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1';

/** How a bind beyond loopback is described, given what we know about the mode. */
function exposureNotice(host: string, req: BindRequest): string[] {
  if (req.inWsl2 && req.mode === 'mirrored') {
    return [
      `WARNING: mirrored networking — ${host} here is the Windows host's real interfaces, including the LAN`,
      "and any VPN adapter, because a mirrored distro shares them instead of having its own namespace.",
      "What stands between this bind and the LAN is the Hyper-V firewall's inbound policy, not the ordinary",
      'Windows Firewall profile. The pipe token still authenticates every request, so this is exposure',
      'rather than an open door — but bind the specific address the container needs, not 0.0.0.0, if you can.',
    ];
  }
  if (req.inWsl2 && req.mode === 'nat') {
    return [
      `NAT networking: ${host} is the WSL2 network namespace, not the LAN — an eth0 on a private 172.x plus`,
      "this distro's loopback, reachable from containers on this host and from nothing else, with no Windows",
      'firewall rule involved. That stops being true under mirrored networking, which is why the mode is checked.',
    ];
  }
  return [
    `WARNING: binding ${host} exposes the wmux pipe beyond localhost.`,
    `Prefer the default 127.0.0.1 + an SSH tunnel: ssh -L ${req.port}:127.0.0.1:${req.port} user@host`,
  ];
}

/**
 * The whole `--wsl` / `--host` decision in one place.
 *
 * An explicit `--host` always wins, including `--host 0.0.0.0` under mirrored
 * mode: the user named the address, so the job here is to describe what they
 * chose, not to overrule it. Only the implicit `0.0.0.0` that `--wsl` used to
 * pick unconditionally is gated.
 */
export function chooseBridgeHost(req: BindRequest): BindDecision {
  if (req.wslMode && !req.inWsl2) {
    return {
      host: null,
      notices: [],
      error:
        '--wsl is for a bridge running inside a WSL2 distro, and this process is not in one ' +
        '(looked for "microsoft"/"WSL2" in /proc/sys/kernel/osrelease and for WSL_INTEROP or ' +
        'WSL_DISTRO_NAME in the environment). Drop --wsl for the 127.0.0.1 default, or name the ' +
        'address you want with --host <addr>.',
    };
  }

  if (req.explicitHost) {
    return {
      host: req.explicitHost,
      notices: isLoopback(req.explicitHost) ? [] : exposureNotice(req.explicitHost, req),
      error: null,
    };
  }

  if (!req.wslMode) return { host: '127.0.0.1', notices: [], error: null };

  if (req.mode === 'nat') {
    return { host: '0.0.0.0', notices: exposureNotice('0.0.0.0', req), error: null };
  }

  if (req.mode === 'mirrored') {
    return {
      host: null,
      notices: [],
      error:
        'refusing to pick 0.0.0.0 for you: this distro runs mirrored networking ' +
        '(wslinfo --networking-mode reports "mirrored"), so it shares the Windows host\'s network ' +
        'interfaces instead of having its own namespace. 0.0.0.0 here is a bind on the LAN and any ' +
        'VPN adapter, gated only by the Hyper-V firewall\'s inbound policy — not the private 172.x ' +
        'that --wsl assumes under NAT. Pass --host <addr> with the address the container actually ' +
        'reaches, or --host 0.0.0.0 if you have weighed that and want it anyway.',
    };
  }

  return {
    host: null,
    notices: [],
    error:
      'could not determine this distro\'s networking mode (wslinfo --networking-mode gave no usable ' +
      'answer; it needs WSL 2.0.5 or newer). --wsl only picks 0.0.0.0 once it has confirmed NAT, ' +
      'because under mirrored networking that address is the Windows host\'s real interfaces rather ' +
      'than an isolated namespace. Check with `wslinfo --networking-mode`, then pass --host <addr> ' +
      'explicitly.',
  };
}
