import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveInsertion,
  uploadEnabled,
  localInsertionText,
  remoteInsertionText,
  type PasteSource,
} from '../../src/main/remote-insert';
import * as remoteUpload from '../../src/main/remote-upload';
import type { DetectedSsh } from '../../src/main/ssh-argv';

/**
 * The branch table for "what does a paste or a drop actually type".
 *
 * Three of these paths end in the local Windows path and look identical from
 * the outside, but they are reached for different reasons (no remote, upload
 * disabled, Shift held) and each has broken independently in cmux's issue
 * history. The one that matters most is the failure case: inserting the local
 * path after a failed upload would read as success while handing the remote
 * shell a path it cannot open.
 *
 * `uploadFiles` is stubbed; everything else is the real decision code. Since
 * this moved into main it needs no `window.wmux` shims at all.
 */

const session = (over: Partial<DetectedSsh> = {}): DetectedSsh => ({
  destination: 'fortuna@honoured-accident',
  forwardAgent: false,
  compression: false,
  sshOptions: [],
  ...over,
});

// Real files, because resolveInsertion refuses to upload anything that is not a
// regular file — a directory or a vanished path falls back to the local text.
const fs = await import('fs');
const os = await import('os');
const path = await import('path');
const FILE_A = path.join(os.tmpdir(), 'wmux-insert-a.png');
const FILE_B = path.join(os.tmpdir(), 'wmux-insert-b.png');

beforeEach(() => {
  fs.writeFileSync(FILE_A, 'a');
  fs.writeFileSync(FILE_B, 'b');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubUpload(result: remoteUpload.UploadResult | Error) {
  return vi.spyOn(remoteUpload, 'uploadFiles').mockImplementation(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

const files = (...paths: string[]): PasteSource => ({ kind: 'files', localPaths: paths });

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

describe('resolveInsertion — local outcomes', () => {
  it('inserts the local path when the pane is not remote', async () => {
    const upload = stubUpload({ ok: true, remotePaths: [] });
    const r = await resolveInsertion(files(FILE_A), null, true);
    expect(r.text).toBe(localInsertionText([FILE_A]));
    expect(upload).not.toHaveBeenCalled();
  });

  it('inserts the local path when upload is not permitted', async () => {
    // One boolean covers three reasons — the config toggle is off, or Shift
    // inverted the drop. The caller folds them together because nothing here
    // can tell them apart or needs to; see uploadEnabled for the config half.
    const upload = stubUpload({ ok: true, remotePaths: [] });
    const r = await resolveInsertion(files(FILE_A), session(), false);
    expect(r.text).toBe(localInsertionText([FILE_A]));
    expect(upload).not.toHaveBeenCalled();
  });


  it('inserts the local path for something that is not a regular file', async () => {
    // A directory, or a clipboard entry that outlived its file. Uploading is not
    // possible; the old behaviour still is.
    const upload = stubUpload({ ok: true, remotePaths: [] });
    const r = await resolveInsertion(files(os.tmpdir()), session(), true);
    expect(r.text).toBe(localInsertionText([os.tmpdir()]));
    expect(upload).not.toHaveBeenCalled();
  });

  it('types clipboard text as-is, with no upload', async () => {
    const upload = stubUpload({ ok: true, remotePaths: [] });
    const r = await resolveInsertion({ kind: 'text', text: 'hello world' }, session(), true);
    expect(r.text).toBe('hello world');
    expect(upload).not.toHaveBeenCalled();
  });

  it('inserts nothing for an empty clipboard', async () => {
    expect((await resolveInsertion({ kind: 'none' }, session(), true)).text).toBeNull();
  });

  it('inserts nothing when there are no paths', async () => {
    expect((await resolveInsertion(files(), session(), true)).text).toBeNull();
  });
});

describe('uploadEnabled', () => {
  it('defaults to on for both gestures when the section is absent', () => {
    expect(uploadEnabled(undefined, 'paste')).toBe(true);
    expect(uploadEnabled(undefined, 'drop')).toBe(true);
    expect(uploadEnabled({}, 'paste')).toBe(true);
  });

  it('keeps the two toggles independent', () => {
    // Disabling paste must not disable drop. This is the property the old
    // policy object carried; it lives here now.
    expect(uploadEnabled({ uploadOnPaste: false }, 'paste')).toBe(false);
    expect(uploadEnabled({ uploadOnPaste: false }, 'drop')).toBe(true);
    expect(uploadEnabled({ uploadOnDrop: false }, 'drop')).toBe(false);
    expect(uploadEnabled({ uploadOnDrop: false }, 'paste')).toBe(true);
  });

  it('only `false` disables it, so a malformed value stays on', () => {
    // The config mapper drops non-booleans, so an undefined here means the
    // user wrote something wrong — falling back to the documented default is
    // friendlier than silently turning the feature off.
    expect(uploadEnabled({ uploadOnPaste: undefined }, 'paste')).toBe(true);
  });
});

describe('resolveInsertion — remote outcomes', () => {
  it('uploads and inserts the remote path', async () => {
    const upload = stubUpload({ ok: true, remotePaths: ['/tmp/wmux-drop-abc.png'] });
    const r = await resolveInsertion(files(FILE_A), session(), true);
    expect(r.text).toBe("'/tmp/wmux-drop-abc.png'");
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ destination: 'fortuna@honoured-accident' }), [FILE_A]);
  });

  it('inserts every remote path for a multi-file drop', async () => {
    stubUpload({ ok: true, remotePaths: ['/tmp/a.png', '/tmp/b.png'] });
    const r = await resolveInsertion(files(FILE_A, FILE_B), session(), true);
    expect(r.text).toBe("'/tmp/a.png' '/tmp/b.png'");
  });

  it('inserts nothing and reports the host when the upload fails', async () => {
    stubUpload({ ok: false, remotePaths: [], error: 'Permission denied (publickey).' });
    const r = await resolveInsertion(files(FILE_A), session(), true);
    expect(r.text).toBeNull();
    expect(r.failure).toEqual({
      destination: 'fortuna@honoured-accident',
      detail: 'Permission denied (publickey).',
    });
  });

  it('treats a short result as a failure rather than a partial batch', async () => {
    // Two files in, one path back. Inserting the one that worked would silently
    // drop the other, and the user has no way to see which.
    stubUpload({ ok: true, remotePaths: ['/tmp/a.png'] });
    const r = await resolveInsertion(files(FILE_A, FILE_B), session(), true);
    expect(r.text).toBeNull();
    expect(r.failure?.destination).toBe('fortuna@honoured-accident');
  });
});
