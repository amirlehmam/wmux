import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBrowserTitleSlice,
  type BrowserTitleSlice,
} from '../../src/renderer/store/browser-title-slice';
import { MAX_OSC_TITLE_SURFACES } from '../../src/renderer/store/osc-title-slice';
import { explicitPageTitle } from '../../src/renderer/components/Browser/BrowserPane';

describe('explicitPageTitle', () => {
  it('keeps a title the page set', () => {
    expect(explicitPageTitle('Page A', 'http://127.0.0.1:5208/a')).toBe('Page A');
  });

  it("drops the title Chromium makes up from an untitled page's URL", () => {
    expect(explicitPageTitle('127.0.0.1:5208/b', 'http://127.0.0.1:5208/b')).toBe('');
    expect(explicitPageTitle('example.com', 'https://example.com/')).toBe('');
    expect(explicitPageTitle('about:blank', 'about:blank')).toBe('');
  });
});

function harness() {
  let state = { browserTitles: {} } as BrowserTitleSlice;
  let writes = 0;
  const set = (update: (s: BrowserTitleSlice) => Partial<BrowserTitleSlice> | BrowserTitleSlice) => {
    const next = update(state);
    if (next !== state) writes++;
    state = { ...state, ...next };
  };
  const slice = createBrowserTitleSlice(set as never, (() => state) as never, {} as never);
  return {
    slice,
    titles: () => state.browserTitles,
    writes: () => writes,
  };
}

describe('browser title slice', () => {
  it('stores a title per surface', () => {
    const h = harness();
    h.slice.setBrowserTitle('surf-1', 'Page A');
    h.slice.setBrowserTitle('surf-2', 'Page B');
    expect(h.titles()['surf-1'].title).toBe('Page A');
    expect(h.titles()['surf-2'].title).toBe('Page B');
  });

  it('does not write when the title is unchanged', () => {
    const h = harness();
    h.slice.setBrowserTitle('surf-1', 'Page A');
    h.slice.setBrowserTitle('surf-1', '  Page A ');
    expect(h.writes()).toBe(1);
  });

  it('clears on an empty title, so the label falls back to the URL', () => {
    const h = harness();
    h.slice.setBrowserTitle('surf-1', 'Page A');
    h.slice.setBrowserTitle('surf-1', '');
    expect(h.titles()['surf-1']).toBeUndefined();
  });

  it('does not write when clearing a surface with no title', () => {
    const h = harness();
    h.slice.setBrowserTitle('surf-1', '');
    h.slice.clearBrowserTitle('surf-1');
    expect(h.writes()).toBe(0);
  });

  it('forgets a closed surface', () => {
    const h = harness();
    h.slice.setBrowserTitle('surf-1', 'Page A');
    h.slice.clearBrowserTitle('surf-1');
    expect(h.titles()['surf-1']).toBeUndefined();
  });

  it('strips what a page could use to rewrite the layout of the tab strip', () => {
    const h = harness();
    h.slice.setBrowserTitle('surf-1', 'safe‮evil\n  title');
    expect(h.titles()['surf-1'].title).toBe('safeevil title');
  });

  it('stays bounded', () => {
    const h = harness();
    for (let i = 0; i < MAX_OSC_TITLE_SURFACES + 5; i++) h.slice.setBrowserTitle(`surf-${i}`, `Page ${i}`);
    expect(Object.keys(h.titles())).toHaveLength(MAX_OSC_TITLE_SURFACES);
  });
});

/** Wiring in components too large to mount here; the behaviour is in browser-title-pane.test.ts. */
describe('browser title wiring', () => {
  const root = join(__dirname, '../../src/renderer');
  const WRAPPER = readFileSync(join(root, 'components/SplitPane/PaneWrapper.tsx'), 'utf8');
  const APP = readFileSync(join(root, 'App.tsx'), 'utf8');

  it('is published by tabs only, so the side panel leaves no entry behind', () => {
    expect(WRAPPER).toContain('onTitleChange={(title) => setBrowserTitle(surface.id, title)}');
    expect(APP).not.toContain('onTitleChange=');
  });

  it('is forgotten when the tab closes', () => {
    expect(APP).toContain('clearBrowserTitle(surfaceId)');
  });
});
