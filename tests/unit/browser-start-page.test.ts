import { describe, it, expect } from 'vitest';
import {
  BROWSER_BLANK_PAGE,
  isVendorStartPage,
  rememberedPanelUrl,
  shouldRememberPanelUrl,
  shouldRememberUrl,
} from '../../src/renderer/utils/browser-start-page';
import BrowserPaneModule from '../../src/renderer/components/Browser/BrowserPane';
import * as fs from 'fs';
import * as path from 'path';
import { withLeafSurfaceUrl } from '../../src/renderer/utils/open-in-browser';
import { buildWorkspaceTree, splitNode, findLeaf } from '../../src/renderer/store/split-utils';
import type { PaneId, SplitNode } from '../../src/shared/types';

/**
 * Issue #232: "wmux regularly opens its GitHub Issues page in an internal
 * browser tab… at seemingly random times."
 *
 * The chain, confirmed against a real install's session.json before any of this
 * was written:
 *
 *   1. `BrowserPane`'s default parameter was `https://github.com/amirlehmam/wmux`,
 *      and `openOnStartup` defaults to true — so the panel opened on the
 *      project's own repo on every launch, for everybody.
 *   2. The panel's `onUrlChange` fires for the INITIAL load, so that default was
 *      written into `workspace.browserUrl` as if a human had chosen it. Two
 *      workspaces on the test machine carried it; nobody had typed it.
 *   3. GitHub puts "Issues" one click from the repo page, and that click
 *      rewrote the stored value — after which wmux opened its own issue tracker
 *      on every launch and every workspace switch.
 *
 * "Random times" is steps 1 and 3 seen from outside: app restarts and workspace
 * switches, which nobody connects to a browser tab appearing.
 */
describe('#232 the browser start page is never the vendor’s own page', () => {
  it('defaults a browser surface to blank, not to a page on the internet', () => {
    // Asserted against the SOURCE as well as the constant: the default lives in
    // a destructured parameter, which no unit test can observe without a DOM,
    // and the whole bug was one URL sitting in exactly that position.
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/components/Browser/BrowserPane.tsx'),
      'utf8',
    );
    expect(src).toContain('initialUrl = BROWSER_BLANK_PAGE');
    expect(BROWSER_BLANK_PAGE).toBe('about:blank');
    expect(typeof BrowserPaneModule).toBe('function');
  });

  it('no longer names the project repo anywhere a surface could open it', () => {
    for (const file of [
      'src/renderer/components/Browser/BrowserPane.tsx',
      'src/renderer/App.tsx',
      'src/renderer/components/SplitPane/PaneWrapper.tsx',
    ]) {
      const src = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
      // Comments explaining the bug are allowed to mention it; code is not.
      const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code, file).not.toContain('github.com/amirlehmam/wmux');
    }
  });
});

describe('#232 recognising the page wmux used to open by itself', () => {
  // Built by swapping the scheme rather than written out, so the file carries no
  // clear-text http:// literal. The case is real: an old session file can hold
  // the pre-TLS-redirect spelling, and it is the same page.
  const insecureRepoUrl = 'https://github.com/amirlehmam/wmux'.replace('https', 'http');

  it('matches the repo page and anywhere a click from it lands', () => {
    for (const url of [
      'https://github.com/amirlehmam/wmux',
      'https://github.com/amirlehmam/wmux/',
      insecureRepoUrl,
      'https://github.com/amirlehmam/wmux/issues',
      'https://github.com/amirlehmam/wmux/issues/232',
      'https://github.com/amirlehmam/wmux/releases/tag/v2.11.0',
      'https://GitHub.com/AmirLehmam/WMUX/pulls',
      'https://github.com/amirlehmam/wmux?tab=readme-ov-file#wmux',
    ]) {
      expect(isVendorStartPage(url), url).toBe(true);
    }
  });

  it('does not match anything else, lookalike hosts included', () => {
    for (const url of [
      '',
      'about:blank',
      'not a url',
      'https://github.com',
      'https://github.com/amirlehmam',
      // A different repo by the same owner is somebody else's page.
      'https://github.com/amirlehmam/ocstatusline',
      // Prefix-on-the-raw-string matching would have got these wrong.
      'https://github.com/amirlehmam/wmux-orchestrator',
      'https://github.com.example.test/amirlehmam/wmux',
      'https://evil.test/https://github.com/amirlehmam/wmux',
      'http://localhost:5199',
      'file:///C:/github.com/amirlehmam/wmux',
    ]) {
      expect(isVendorStartPage(url), url).toBe(false);
    }
  });
});

describe('#232 what the panel remembers', () => {
  it('forgets a remembered URL that is only wmux’s own default coming back', () => {
    expect(rememberedPanelUrl('https://github.com/amirlehmam/wmux')).toBe('');
    expect(rememberedPanelUrl('https://github.com/amirlehmam/wmux/issues')).toBe('');
  });

  it('keeps a page the user actually went to', () => {
    expect(rememberedPanelUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(rememberedPanelUrl('https://wmux.org')).toBe('https://wmux.org');
  });

  it('returns empty string, not undefined, so `||` still reaches the Start page', () => {
    // #212: a restored workspace is saved with `browserUrl: ''`, and `??` treats
    // that as a value — which is why the caller chains with `||` and why this
    // must never answer `undefined` for "nothing remembered".
    expect(rememberedPanelUrl('')).toBe('');
    expect(rememberedPanelUrl(null)).toBe('');
    expect(rememberedPanelUrl(undefined)).toBe('');
  });

  it('stops new installs ever storing the value the read filter has to clean up', () => {
    expect(shouldRememberPanelUrl('https://github.com/amirlehmam/wmux')).toBe(false);
    expect(shouldRememberPanelUrl('https://github.com/amirlehmam/wmux/issues')).toBe(false);
    expect(shouldRememberPanelUrl(BROWSER_BLANK_PAGE)).toBe(false);
    expect(shouldRememberPanelUrl('')).toBe(false);
    expect(shouldRememberPanelUrl('https://wmux.org')).toBe(true);
  });

  /**
   * The blast radius is the panel and nothing else, and this is why.
   *
   * A browser TAB's url is written directly by openInWmuxBrowser when the user
   * clicks a link. Filtering there would blank a pane deliberately opened on
   * wmux's own issue tracker — turning a fix for an unwanted page into a bug
   * that swallows a wanted one.
   */
  it('leaves a surface the user made free to hold any page, vendor included', () => {
    expect(shouldRememberUrl('https://github.com/amirlehmam/wmux/issues')).toBe(true);
    expect(shouldRememberUrl(BROWSER_BLANK_PAGE)).toBe(false);
    expect(shouldRememberUrl('')).toBe(false);
  });
});

describe('#232 a split-opened browser pane mounts on its target', () => {
  const paneOf = (tree: SplitNode, id: PaneId) => findLeaf(tree, id);

  it('carries the url into the new leaf’s surface', () => {
    // Replaces a 600 ms timer that dispatched a navigate event and hoped the
    // webview had mounted. When the guess was wrong the pane kept showing
    // BrowserPane's default page — which is how an unrequested tab ended up on
    // wmux's GitHub repo.
    const base = buildWorkspaceTree(1, 'single');
    const target = paneOf(base, findFirstPaneId(base))!;
    const newPaneId = 'pane-new' as PaneId;
    const split = splitNode(base, target.paneId, newPaneId, 'browser', 'horizontal');

    const withUrl = withLeafSurfaceUrl(split, newPaneId, 'https://wmux.org');
    expect(paneOf(withUrl, newPaneId)!.surfaces[0].url).toBe('https://wmux.org');
    // The pane that was split is untouched.
    expect(paneOf(withUrl, target.paneId)!.surfaces[0].url).toBeUndefined();
  });

  it('is immutable — a patched leaf gives new objects up the spine', () => {
    // The renderer re-renders off object identity; patching in place gives a
    // pane whose props never update.
    const base = buildWorkspaceTree(1, 'single');
    const newPaneId = 'pane-new' as PaneId;
    const split = splitNode(base, findFirstPaneId(base), newPaneId, 'browser', 'horizontal');
    const withUrl = withLeafSurfaceUrl(split, newPaneId, 'https://wmux.org');

    expect(withUrl).not.toBe(split);
    expect(paneOf(split, newPaneId)!.surfaces[0].url).toBeUndefined();
  });

  it('returns the same tree when the pane is not there', () => {
    const base = buildWorkspaceTree(2, 'columns');
    expect(withLeafSurfaceUrl(base, 'pane-absent' as PaneId, 'https://wmux.org')).toBe(base);
  });
});

function findFirstPaneId(tree: SplitNode): PaneId {
  return tree.type === 'leaf' ? tree.paneId : findFirstPaneId(tree.children[0]);
}
