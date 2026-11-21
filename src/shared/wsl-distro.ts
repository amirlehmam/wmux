/**
 * What a WSL distro name may be, in one place for the code that puts one in an argv or reads one out of a
 * `\\wsl.localhost\<distro>\...` path. A name is handed to `wsl.exe -d`, so it must not be able to read as an
 * option (no leading `-`) or carry whitespace, a separator or a control character.
 *
 * The CLI (src/cli/wmux.ts) is a standalone script that imports nothing from here, so it keeps a copy of the
 * same rule for `--wsl-distro`; tests/unit/wsl-distro.test.ts holds the two to the same samples.
 */

/** The longest distro name a target may name (`wslDistro`, `--wsl-distro`). */
export const MAX_WSL_DISTRO_LENGTH = 64;

const DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `name` has only the characters a distro name may have (the length is the caller's to limit). */
export function isWslDistroName(name: string): boolean {
  return DISTRO_NAME.test(name);
}
