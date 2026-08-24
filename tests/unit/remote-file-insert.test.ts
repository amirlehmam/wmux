import { describe, it, expect, vi } from 'vitest';
import {
  resolveFileInsertion,
  localInsertionText,
  remoteInsertionText,
  type FileInsertionDeps,
  type RemoteTarget,
} from '../../src/renderer/utils/remote-file-insert';

/**
 * The branch table for "what does a paste or a drop actually type".
 *
 * Three of these paths end in the local Windows path and look identical from
 * the outside, but they are reached for different reasons (no remote, upload
 * disabled, Shift held) and each has broken independently in cmux's issue
 * history. The one that matters most is the failure case: inserting the local
 * path after a failed upload would read as success while handing the remote
 * shell a path it cannot open.
 */

const remote = (over: Partial<RemoteTarget> = {}): RemoteTarget => ({
  destination: 'fortuna@honoured-accident',
  uploadOnPaste: true,
  uploadOnDrop: true,
  ...over,
});

function deps(over: Partial<FileInsertionDeps> = {}): FileInsertionDeps {
  return {
    detect: vi.fn(async () => null),
    upload: vi.fn(async () => ({ ok: true, remotePaths: [] })),
    notify: vi.fn(),
    ...over,
  };
}

const req = (over: Partial<Parameters<typeof resolveFileInsertion>[0]> = {}) => ({
  surfaceId: 'surf-1',
  localPaths: ['C:\\Temp\\shot.png'],
  mode: 'paste' as const,
  ...over,
});

describe('insertion text', () => {
  it('quotes a local path only when it has whitespace', () => {
    expect(localInsertionText(['C:\\Temp\\a.png'])).toBe('C:\\Temp\\a.png');
    expect(localInsertionText(['C:\\My Temp\\a.png'])).toBe('"C:\\My Temp\\a.png"');
  });

  it('joins several local paths with a space', () => {
    expect(localInsertionText(['a.png', 'b.png'])).toBe('a.png b.png');
  });

  it('always single-quotes a remote path', () => {
    expect(remoteInsertionText(['/tmp/wmux-drop-1.png'])).toBe("'/tmp/wmux-drop-1.png'");
  });
});

describe('resolveFileInsertion — local outcomes', () => {
  it('inserts the local path when the pane is not remote', async () => {
    const d = deps();
    expect(await resolveFileInsertion(req(), d)).toBe('C:\\Temp\\shot.png');
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('inserts the local path when paste upload is disabled', async () => {
    const d = deps({ detect: vi.fn(async () => remote({ uploadOnPaste: false })) });
    expect(await resolveFileInsertion(req({ mode: 'paste' }), d)).toBe('C:\\Temp\\shot.png');
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('still uploads on drop when only paste upload is disabled', async () => {
    // The two toggles are independent; disabling one must not disable the other.
    const d = deps({
      detect: vi.fn(async () => remote({ uploadOnPaste: false })),
      upload: vi.fn(async () => ({ ok: true, remotePaths: ['/tmp/wmux-drop-1.png'] })),
    });
    expect(await resolveFileInsertion(req({ mode: 'drop' }), d)).toBe("'/tmp/wmux-drop-1.png'");
  });

  it('inserts the local path when the user holds Shift', async () => {
    const d = deps({ detect: vi.fn(async () => remote()) });
    expect(await resolveFileInsertion(req({ mode: 'drop', invert: true }), d))
      .toBe('C:\\Temp\\shot.png');
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('does not even ask about the remote when Shift is held', async () => {
    // Shift is an explicit "give me the local path". Detection cannot change
    // that answer, so paying for it would be pure latency on the drop path.
    const d = deps({ detect: vi.fn(async () => remote()) });
    await resolveFileInsertion(req({ invert: true }), d);
    expect(d.detect).not.toHaveBeenCalled();
  });

  it('falls back to the local path when detection throws', async () => {
    // Detection is an improvement over the old behaviour, never a gate on it.
    const d = deps({ detect: vi.fn(async () => { throw new Error('ipc gone'); }) });
    expect(await resolveFileInsertion(req(), d)).toBe('C:\\Temp\\shot.png');
  });

  it('inserts nothing when there are no paths', async () => {
    expect(await resolveFileInsertion(req({ localPaths: [] }), deps())).toBeNull();
  });
});

describe('resolveFileInsertion — remote outcomes', () => {
  it('uploads and inserts the remote path', async () => {
    const d = deps({
      detect: vi.fn(async () => remote()),
      upload: vi.fn(async () => ({ ok: true, remotePaths: ['/tmp/wmux-drop-abc.png'] })),
    });
    expect(await resolveFileInsertion(req(), d)).toBe("'/tmp/wmux-drop-abc.png'");
    expect(d.upload).toHaveBeenCalledWith('surf-1', ['C:\\Temp\\shot.png']);
  });

  it('inserts every remote path for a multi-file drop', async () => {
    const d = deps({
      detect: vi.fn(async () => remote()),
      upload: vi.fn(async () => ({ ok: true, remotePaths: ['/tmp/a.png', '/tmp/b.png'] })),
    });
    const text = await resolveFileInsertion(
      req({ mode: 'drop', localPaths: ['C:\\a.png', 'C:\\b.png'] }),
      d
    );
    expect(text).toBe("'/tmp/a.png' '/tmp/b.png'");
  });

  it('inserts nothing and notifies when the upload fails', async () => {
    const d = deps({
      detect: vi.fn(async () => remote()),
      upload: vi.fn(async () => ({ ok: false, remotePaths: [], error: 'Permission denied (publickey).' })),
    });
    expect(await resolveFileInsertion(req(), d)).toBeNull();
    expect(d.notify).toHaveBeenCalledWith(
      expect.stringContaining('Permission denied (publickey).')
    );
  });

  it('names the host in the failure message', async () => {
    const d = deps({
      detect: vi.fn(async () => remote()),
      upload: vi.fn(async () => ({ ok: false, remotePaths: [], error: 'nope' })),
    });
    await resolveFileInsertion(req(), d);
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining('fortuna@honoured-accident'));
  });

  it('inserts nothing and notifies when the upload throws', async () => {
    const d = deps({
      detect: vi.fn(async () => remote()),
      upload: vi.fn(async () => { throw new Error('ipc gone'); }),
    });
    expect(await resolveFileInsertion(req(), d)).toBeNull();
    expect(d.notify).toHaveBeenCalled();
  });

  it('treats a short result as a failure rather than inserting a partial batch', async () => {
    // Two files in, one path back. Inserting the one that worked would silently
    // drop the other, and the user has no way to see which.
    const d = deps({
      detect: vi.fn(async () => remote()),
      upload: vi.fn(async () => ({ ok: true, remotePaths: ['/tmp/a.png'] })),
    });
    const text = await resolveFileInsertion(
      req({ localPaths: ['C:\\a.png', 'C:\\b.png'] }),
      d
    );
    expect(text).toBeNull();
    expect(d.notify).toHaveBeenCalled();
  });
});
