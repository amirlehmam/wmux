import { describe, expect, it } from 'vitest';
import { isWslDistroName, MAX_WSL_DISTRO_LENGTH } from '../../src/shared/wsl-distro';
import { validateWslDistro } from '../../src/main/ssh-targets';
import { parseWslUnc } from '../../src/main/git-view';
import { parseWslLocalInvocation } from '../../src/main/exec-worker-script';
import { sshTargetParams } from '../../src/cli/wmux';

/**
 * One rule for what a WSL distro name is. Main shares `isWslDistroName`; the CLI is a standalone
 * script that imports nothing from src/shared, so it keeps a copy, and the samples below hold the
 * copy to the same answer for `--wsl-distro`.
 */
const ACCEPTED = ['Ubuntu-24.04', 'Debian', 'a', 'x_y.z-1', 'A', '0day', 'Ubuntu.22_04-LTS'];
const REFUSED = ['', '-d', '-', ' Ubuntu', 'Ubuntu 24', 'Ubuntu\n', 'Ubu\tntu', 'a\0b', '.hidden', '_x', 'a/b', 'a\\b', 'café'];

describe('isWslDistroName', () => {
  it.each(ACCEPTED)('accepts %j', (name) => expect(isWslDistroName(name)).toBe(true));
  it.each(REFUSED)('refuses %j', (name) => expect(isWslDistroName(name)).toBe(false));
});

describe('every reader of a distro name agrees', () => {
  const tooLong = 'A'.repeat(MAX_WSL_DISTRO_LENGTH + 1);

  it('the target contract, with its length limit', () => {
    for (const name of ACCEPTED) expect(validateWslDistro(name)).toBeNull();
    for (const name of [...REFUSED, tooLong]) expect(validateWslDistro(name)).toEqual(expect.any(String));
    expect(validateWslDistro('A'.repeat(MAX_WSL_DISTRO_LENGTH))).toBeNull();
  });

  it('the CLI copy, for --wsl-distro', () => {
    const accepts = (name: string): boolean => !('error' in sshTargetParams(['--argv-json', '["ssh","box"]', '--path', '/w', '--wsl-distro', name]));
    for (const name of [...ACCEPTED, 'A'.repeat(MAX_WSL_DISTRO_LENGTH)]) expect(accepts(name), name).toBe(true);
    for (const name of [...REFUSED, tooLong]) expect(accepts(name), name).toBe(false);
  });

  it('a \\\\wsl.localhost path names a distro only when the name is one', () => {
    for (const name of ACCEPTED) expect(parseWslUnc(`\\\\wsl.localhost\\${name}\\home`)).toEqual({ distro: name, posix: '/home' });
    // A separator ends the name, so `a/b` is the distro `a` and a folder in it, never a distro `a/b`.
    for (const name of REFUSED.filter((n) => n !== '' && !/[\\/]/.test(n))) expect(parseWslUnc(`\\\\wsl.localhost\\${name}\\home`), name).toBeNull();
    expect(parseWslUnc('\\\\wsl.localhost\\')).toBeNull();
  });

  it('the worker only serves an argv whose distro is one', () => {
    const argv = (name: string): string[] => ['-d', name, '--exec', 'sh', '-c', 'set -f;IFS=;eval $(echo QUJD|base64 -d)'];
    for (const name of ACCEPTED) expect(parseWslLocalInvocation(argv(name))).toBeDefined();
    for (const name of REFUSED) expect(parseWslLocalInvocation(argv(name)), name).toBeUndefined();
  });
});
