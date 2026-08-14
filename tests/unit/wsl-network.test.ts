import { describe, it, expect } from 'vitest';
import {
  chooseBridgeHost,
  isWsl2,
  parseNetworkingMode,
  type BindRequest,
  type WslNetworkingMode,
} from '../../src/cli/wsl-network';

/**
 * `wmux bridge --wsl` used to pick `0.0.0.0` on the strength of a comment:
 *
 *     // WSL2's NAT gives the distro an address the container resolves as
 *     // host.docker.internal, but 127.0.0.1 inside the distro is not it.
 *
 * True under NAT, and NAT is the default — but under `networkingMode=mirrored`
 * the distro has no namespace of its own, it shares the Windows host's
 * interfaces. `0.0.0.0` there is the LAN and any VPN adapter, held back only by
 * the Hyper-V firewall's inbound policy, which the widely-copied "make WSL
 * reachable" recipe sets to Allow. That is a configuration people run, not a
 * hypothetical future WSL change, so the mode is checked rather than inferred.
 *
 * Pure functions, so the whole decision table runs on any platform — including
 * the mirrored branch, which cannot be exercised on a NAT host.
 */

const req = (over: Partial<BindRequest> = {}): BindRequest => ({
  wslMode: true,
  inWsl2: true,
  mode: 'nat',
  port: 9787,
  ...over,
});

describe('isWsl2', () => {
  it('needs the kernel string and interop together, not either alone', () => {
    const release = '5.15.167.4-microsoft-standard-WSL2';
    expect(isWsl2({ osRelease: release, hasInteropEnv: true })).toBe(true);
    // A container mounting its own /proc can carry the host's kernel string
    // while having a network stack of its own — the case --wsl must not fire in.
    expect(isWsl2({ osRelease: release, hasInteropEnv: false })).toBe(false);
    // And the env vars are inherited by anything a WSL shell launches, including
    // a process that has since crossed out of the distro.
    expect(isWsl2({ osRelease: '6.6.87.2-generic', hasInteropEnv: true })).toBe(false);
  });

  it('says no when /proc could not be read at all', () => {
    expect(isWsl2({ osRelease: null, hasInteropEnv: true })).toBe(false);
  });
});

describe('parseNetworkingMode', () => {
  it('reads the one word wslinfo prints, trailing newline and case included', () => {
    expect(parseNetworkingMode('nat\n')).toBe('nat');
    expect(parseNetworkingMode('  Mirrored  ')).toBe('mirrored');
  });

  it('calls anything it cannot read "unknown" rather than falling back to nat', () => {
    // wslinfo predates WSL 2.0.5, so null is the ordinary answer on older WSL.
    // Folding it into `nat` is exactly the assumption this module exists to stop
    // making: it would restore the old silent 0.0.0.0 on every host too old to
    // report, which is also every host most likely to be misconfigured.
    for (const bad of [null, '', 'nat mirrored', 'bridged', 'error: unknown option']) {
      expect(parseNetworkingMode(bad)).toBe('unknown');
    }
  });
});

describe('chooseBridgeHost', () => {
  it('binds loopback and says nothing when --wsl is absent', () => {
    const d = chooseBridgeHost(req({ wslMode: false, inWsl2: false, mode: 'unknown' }));
    expect(d).toEqual({ host: '127.0.0.1', notices: [], error: null });
  });

  it('binds 0.0.0.0 under confirmed NAT, and says why that is contained', () => {
    const d = chooseBridgeHost(req({ mode: 'nat' }));
    expect(d.host).toBe('0.0.0.0');
    expect(d.error).toBeNull();
    expect(d.notices.join(' ')).toMatch(/NAT networking/);
    expect(d.notices.join(' ')).toMatch(/not the LAN/);
    // The point of saying it out loud is that it is conditional.
    expect(d.notices.join(' ')).toMatch(/mirrored/);
  });

  it('refuses to pick 0.0.0.0 under mirrored networking', () => {
    const d = chooseBridgeHost(req({ mode: 'mirrored' }));
    expect(d.host).toBeNull();
    expect(d.error).toMatch(/mirrored/);
    // Name the mechanism, not just the verdict: someone reading this on a
    // machine they administer needs to know which firewall decides.
    expect(d.error).toMatch(/Hyper-V firewall/);
    expect(d.error).toMatch(/--host/);
  });

  it('refuses when the mode could not be determined', () => {
    const d = chooseBridgeHost(req({ mode: 'unknown' }));
    expect(d.host).toBeNull();
    expect(d.error).toMatch(/could not determine/);
    expect(d.error).toMatch(/2\.0\.5/);
  });

  it('refuses --wsl outside a WSL distro, naming what it looked for', () => {
    for (const mode of ['nat', 'mirrored', 'unknown'] as WslNetworkingMode[]) {
      const d = chooseBridgeHost(req({ inWsl2: false, mode }));
      expect(d.host).toBeNull();
      expect(d.error).toMatch(/osrelease/);
      expect(d.error).toMatch(/WSL_INTEROP/);
    }
  });

  it('honours an explicit --host in every mode, including 0.0.0.0 under mirrored', () => {
    // A stated choice, not an inherited default. Overruling it would just push
    // people to a shell wrapper, and they would lose the warning with it.
    for (const mode of ['nat', 'mirrored', 'unknown'] as WslNetworkingMode[]) {
      for (const wslMode of [true, false]) {
        const d = chooseBridgeHost(req({ explicitHost: '0.0.0.0', mode, wslMode }));
        expect(d.host).toBe('0.0.0.0');
        expect(d.error).toBeNull();
      }
    }
  });

  it('upgrades the exposure notice for an explicit bind under mirrored', () => {
    const generic = chooseBridgeHost(req({ explicitHost: '0.0.0.0', mode: 'unknown', wslMode: false, inWsl2: false }));
    expect(generic.notices.join(' ')).toMatch(/exposes the wmux pipe beyond localhost/);
    expect(generic.notices.join(' ')).not.toMatch(/mirrored/);

    const mirrored = chooseBridgeHost(req({ explicitHost: '0.0.0.0', mode: 'mirrored' }));
    expect(mirrored.notices.join(' ')).toMatch(/mirrored networking/);
    expect(mirrored.notices.join(' ')).toMatch(/Hyper-V firewall/);
    expect(mirrored.notices.join(' ')).toMatch(/VPN/);
  });

  it('stays quiet for an explicit loopback bind, however spelled', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      for (const mode of ['nat', 'mirrored', 'unknown'] as WslNetworkingMode[]) {
        const d = chooseBridgeHost(req({ explicitHost: host, mode }));
        expect(d).toEqual({ host, notices: [], error: null });
      }
    }
  });

  it('never returns both a host and an error', () => {
    for (const mode of ['nat', 'mirrored', 'unknown'] as WslNetworkingMode[]) {
      for (const inWsl2 of [true, false]) {
        for (const wslMode of [true, false]) {
          for (const explicitHost of [undefined, '0.0.0.0', '127.0.0.1']) {
            const d = chooseBridgeHost(req({ mode, inWsl2, wslMode, explicitHost }));
            expect(d.host === null).toBe(d.error !== null);
          }
        }
      }
    }
  });
});
