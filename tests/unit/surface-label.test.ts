import { describe, expect, it } from 'vitest';
import type { SurfaceId, SurfaceRef } from '../../src/shared/types';
import { browserUrlLabel, getSurfaceLabel } from '../../src/renderer/components/SplitPane/surface-label';

function surface(id: string, patch: Partial<SurfaceRef> = {}): SurfaceRef {
  return {
    id: id as SurfaceId,
    type: 'terminal',
    ...patch,
  };
}

describe('surface labels', () => {
  it('labels from resolvedShell, so a spec with arguments stays readable', () => {
    // `shell` is the requested spec and may be a whole command line. Rendering
    // that as a tab caption produced "Ssh Fortuna@honoured Accident"; the
    // resolved executable is what the label wants.
    expect(
      getSurfaceLabel(surface('surf-1', {
        shell: 'ssh fortuna@honoured-accident',
        resolvedShell: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
      })),
    ).toBe('Ssh');
  });

  it('labels a pane started with no spec at all', () => {
    // The regression e5ec559 existed to prevent: with no requested spec there
    // is nothing to name the tab after except what actually spawned.
    expect(getSurfaceLabel(surface('surf-1', { resolvedShell: 'pwsh.exe' }))).toBe('PowerShell');
  });

  it('still falls back to the requested spec, then the workspace shell', () => {
    expect(getSurfaceLabel(surface('surf-1', { shell: 'cmd.exe' }))).toBe('Command Prompt');
    expect(getSurfaceLabel(surface('surf-1'), undefined, 'bash.exe')).toBe('Bash');
  });

  it('prefers custom titles over agent and shell labels', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { customTitle: 'API', shell: 'pwsh.exe' }),
        'Agent runner',
        'cmd.exe',
      ),
    ).toBe('API');
  });

  it('uses agent labels before terminal shell labels', () => {
    expect(getSurfaceLabel(surface('surf-1', { shell: 'pwsh.exe' }), 'Agent runner')).toBe('Agent runner');
  });

  it('uses the surface shell before the workspace shell for terminal labels', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }),
        undefined,
        'cmd.exe',
      ),
    ).toBe('PowerShell');
  });

  it('falls back to the workspace shell for terminal labels', () => {
    expect(getSurfaceLabel(surface('surf-1'), undefined, 'C:\\Windows\\System32\\cmd.exe')).toBe('Command Prompt');
  });

  it('uses stable labels for non-terminal surface types', () => {
    expect(getSurfaceLabel(surface('surf-browser', { type: 'browser' }))).toBe('Browser');
    expect(getSurfaceLabel(surface('surf-markdown', { type: 'markdown' }))).toBe('Markdown');
    expect(getSurfaceLabel(surface('surf-diff', { type: 'diff' }))).toBe('Diff');
  });

  it('shows the markdown file name when the surface was opened from a file', () => {
    expect(
      getSurfaceLabel(surface('surf-markdown', { type: 'markdown', markdownFileName: 'README.md' })),
    ).toBe('README.md');
  });

  it('falls back to "Markdown" for a markdown surface without a file name', () => {
    expect(getSurfaceLabel(surface('surf-markdown', { type: 'markdown', markdownContent: '# hi' }))).toBe(
      'Markdown',
    );
  });

  it('prefers a custom title over the markdown file name', () => {
    expect(
      getSurfaceLabel(
        surface('surf-markdown', { type: 'markdown', customTitle: 'Docs', markdownFileName: 'README.md' }),
      ),
    ).toBe('Docs');
  });

  it('shows the folder name from currentCwd for terminal labels', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { currentCwd: 'C:\\Users\\me\\coding\\wmux' }),
        undefined,
        'pwsh.exe',
      ),
    ).toBe('wmux');
  });

  it('falls back to shell name when currentCwd is empty', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { currentCwd: '' }),
        undefined,
        'pwsh.exe',
      ),
    ).toBe('PowerShell');
  });

  it('prefers custom title over currentCwd', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { customTitle: 'My Tab', currentCwd: 'C:\\Users\\me\\coding\\wmux' }),
      ),
    ).toBe('My Tab');
  });
});

describe('window titles as tab labels (issue #221)', () => {
  it('labels a terminal from the OSC title its program set', () => {
    expect(
      getSurfaceLabel(surface('surf-1', { currentCwd: 'C:\\repos\\wmux' }), undefined, undefined, undefined, 'Fix issue #221'),
    ).toBe('Fix issue #221');
  });

  it('keeps an explicit rename above the program', () => {
    // The whole reason the title was captured-but-dropped for so long: a tab's
    // name is the user's to set, and a program must not take it back.
    expect(
      getSurfaceLabel(surface('surf-1', { customTitle: 'API' }), undefined, undefined, undefined, 'Fix issue #221'),
    ).toBe('API');
  });

  it('keeps an agent spawn label above the program', () => {
    // `wmux agent spawn --label reviewer` is the orchestrator naming this
    // worker, which identifies the pane within a wave better than whatever the
    // agent's own TUI is announcing this second.
    expect(
      getSurfaceLabel(surface('surf-1'), 'reviewer', undefined, undefined, 'Fix issue #221'),
    ).toBe('reviewer');
  });

  it('falls back to the cwd when no title has been set', () => {
    expect(
      getSurfaceLabel(surface('surf-1', { currentCwd: 'C:\\repos\\wmux' }), undefined, undefined, undefined, undefined),
    ).toBe('wmux');
    expect(
      getSurfaceLabel(surface('surf-1', { currentCwd: 'C:\\repos\\wmux' }), undefined, undefined, undefined, ''),
    ).toBe('wmux');
  });

  it('ignores a title on a surface that is not a terminal', () => {
    // Only a terminal has a program that could have set one; a browser or
    // markdown tab reaching this code means something is confused, and the
    // static label is the answer that cannot be wrong.
    expect(
      getSurfaceLabel(surface('surf-b', { type: 'browser' }), undefined, undefined, undefined, 'evil'),
    ).toBe('Browser');
  });
});

describe('browser tabs are labelled by their page', () => {
  const browser = (patch: Partial<SurfaceRef> = {}) => surface('surf-b', { type: 'browser', ...patch });
  const label = (tab: SurfaceRef, agentLabel?: string, pageTitle?: string) =>
    getSurfaceLabel(tab, agentLabel, undefined, undefined, undefined, pageTitle);

  it('reads the page title first', () => {
    expect(label(browser({ url: 'https://github.com/a/b' }), undefined, 'a/b: the repo')).toBe('a/b: the repo');
  });

  it('falls back to the URL until the page has a title, as it does after a restart', () => {
    expect(label(browser({ url: 'https://github.com/a/b' }))).toBe('github.com');
    expect(label(browser({ url: 'https://github.com/a/b' }), undefined, '')).toBe('github.com');
  });

  it('keeps the type name for a tab with no page', () => {
    expect(label(browser())).toBe('Browser');
    expect(label(browser({ url: 'about:blank' }))).toBe('Browser');
  });

  it('ranks every name somebody chose above the page', () => {
    const tab = browser({ url: 'https://github.com/', customTitle: 'Mine', defaultTitle: 'Docs' });
    expect(label(tab, 'reviewer', 'Page')).toBe('Mine');
    expect(label(browser({ defaultTitle: 'Docs' }), 'reviewer', 'Page')).toBe('reviewer');
    expect(label(browser({ defaultTitle: 'Docs' }), undefined, 'Page')).toBe('Docs');
  });

  it('gives a page title only to a browser tab', () => {
    expect(label(surface('surf-1', { shell: 'pwsh.exe' }), undefined, 'Page')).toBe('PowerShell');
    expect(label(surface('surf-m', { type: 'markdown' }), undefined, 'Page')).toBe('Markdown');
  });
});

describe('browserUrlLabel', () => {
  it('names a web page by its host, without the www', () => {
    expect(browserUrlLabel('https://github.com/a/b?q=1#x')).toBe('github.com');
    expect(browserUrlLabel('https://www.example.org/')).toBe('example.org');
    expect(browserUrlLabel('http://WWW.Example.org/')).toBe('example.org');
  });

  it('keeps the port, which is what tells two dev servers apart', () => {
    expect(browserUrlLabel('http://localhost:5173/')).toBe('localhost:5173');
  });

  it('keeps a look-alike host in its ASCII form', () => {
    expect(browserUrlLabel('https://gіthub.com/')).toBe('xn--gthub-n2e.com');
  });

  it('names a local file by its file name', () => {
    expect(browserUrlLabel('file:///C:/Users/me/report.html')).toBe('report.html');
    expect(browserUrlLabel('file:///C:/Users/me/my%20report.html?x=1#y')).toBe('my report.html');
    expect(browserUrlLabel('file:///C:/Users/me/')).toBe('me');
  });

  it('survives a file name that is not valid percent-encoding', () => {
    expect(browserUrlLabel('file:///C:/100%zz.html')).toBe('100%zz.html');
  });

  it('strips bidi overrides from a decoded file name', () => {
    expect(browserUrlLabel('file:///C:/a%E2%80%AEb.html')).toBe('ab.html');
  });

  it('has no label for anything without a place to name', () => {
    for (const url of [undefined, '', 'about:blank', 'about:blank#wmux-history=x', 'data:text/html,x', 'not a url', 'file:///']) {
      expect(browserUrlLabel(url)).toBeNull();
    }
  });
});

describe('template names yield to the program (issue #291)', () => {
  it('lets the OSC title take over a quick-launch profile name', () => {
    // The reporter's case: a profile named `opencode`, and opencode writing
    // `OC | <session title>` the moment it opens a session.
    const tab = surface('surf-1', { defaultTitle: 'opencode', currentCwd: 'C:\repos\wmux' });
    expect(getSurfaceLabel(tab, undefined, undefined, undefined, 'OC | Fix the tab labels')).toBe('OC | Fix the tab labels');
  });

  it('shows the profile name, not the folder, until the program sets a title', () => {
    const tab = surface('surf-1', { defaultTitle: 'opencode', currentCwd: 'C:\repos\wmux' });
    expect(getSurfaceLabel(tab, undefined, undefined, undefined, undefined)).toBe('opencode');
  });

  it('still ranks an explicit rename and an agent label above both', () => {
    const tab = surface('surf-1', { defaultTitle: 'opencode', customTitle: 'mine' });
    expect(getSurfaceLabel(tab, undefined, undefined, undefined, 'OC | x')).toBe('mine');
    expect(getSurfaceLabel(surface('surf-1', { defaultTitle: 'opencode' }), 'reviewer', undefined, undefined, 'OC | x')).toBe('reviewer');
  });

  it('keeps a profile name on a non-terminal tab', () => {
    expect(getSurfaceLabel(surface('surf-b', { type: 'browser', defaultTitle: 'Docs' }))).toBe('Docs');
  });
});
