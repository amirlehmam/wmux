import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMarkdownFilePath } from '../../src/cli/wmux';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawnSync,
}));

const wsl = {
  cwd: '/home/user/work/project',
  platform: 'linux' as const,
  env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' },
};
const unc = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\work\\project\\docs\\review.md';

beforeEach(() => {
  spawnSync.mockReset();
  spawnSync.mockReturnValue({ status: 0, stdout: `${unc}\n`, stderr: '' });
});

describe('Markdown paths sent to the Windows host', () => {
  it.each([
    ['/home/user/work/project/docs/review.md', '/home/user/work/project/docs/review.md'],
    ['docs/review.md', '/home/user/work/project/docs/review.md'],
    ['../other/review notes.md', '/home/user/work/other/review notes.md'],
  ])('converts WSL path %s after resolving against the caller', (input, resolved) => {
    expect(resolveMarkdownFilePath(input, wsl)).toBe(unc);
    expect(spawnSync).toHaveBeenCalledWith('/usr/bin/wslpath', ['-w', resolved], {
      encoding: 'utf-8', timeout: 5000,
    });
  });

  it('lets wslpath map Windows-mounted drives instead of assuming a mount prefix', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: 'D:\\work\\review.md\n', stderr: '' });
    expect(resolveMarkdownFilePath('/mnt/d/work/review.md', wsl)).toBe('D:\\work\\review.md');
  });

  it.each([unc, 'C:\\work\\review.md', 'C:/work/review.md'])(
    'preserves an already Windows-readable path: %s', (input) => {
      expect(resolveMarkdownFilePath(input, wsl)).toBe(input);
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

  it('keeps native Windows resolution even with inherited WSL environment variables', () => {
    expect(resolveMarkdownFilePath('docs/review.md', {
      cwd: 'C:\\work', platform: 'win32', env: { WSLENV: 'WT_SESSION' },
    })).toBe('C:\\work\\docs\\review.md');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('does not invoke wslpath on ordinary Linux', () => {
    expect(resolveMarkdownFilePath('docs/review.md', { ...wsl, env: {} }))
      .toBe('/home/user/work/project/docs/review.md');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('leaves remote path resolution unchanged rather than naming a local WSL distro', () => {
    expect(resolveMarkdownFilePath('docs/review.md', { ...wsl, remote: true }))
      .toBe('/home/user/work/project/docs/review.md');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    { error: new Error('spawn ENOENT'), status: null, stdout: null, stderr: null },
    { status: 1, stdout: '', stderr: 'Invalid argument' },
    { status: 0, stdout: '\n', stderr: '' },
  ])('reports conversion failures instead of forwarding an unusable path', (result) => {
    spawnSync.mockReturnValue(result);
    expect(() => resolveMarkdownFilePath('docs/review.md', wsl))
      .toThrow(/Cannot convert WSL Markdown path/);
  });
});
