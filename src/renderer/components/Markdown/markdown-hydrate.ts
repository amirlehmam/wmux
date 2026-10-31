// ─── Filling the markdown pane's placeholders (#380) ────────────────────────
// markdown-document.ts emits inert, sanitized placeholders; this fills them in
// AFTER sanitization, which is the whole security shape (see that file).
// Every payload is read back as textContent — never innerHTML — so what
// reaches KaTeX, mermaid or main is exactly the text the author wrote.
//
// Cost: KaTeX (~270 KB + fonts) and mermaid (well over 1 MB) are loaded by
// dynamic import() only when a document HAS math or a mermaid block. A plain
// document pays one querySelectorAll per placeholder kind and nothing else, and
// neither library is in the desktop entry chunk or the phone closure. KaTeX is
// pinned to the 0.18 line mermaid depends on, so the build carries one copy.

export type UiThemeName = 'dark' | 'light';

/** Whether this run's DOM has been replaced (new html, mode switch, unmount). */
type IsStale = () => boolean;

// The placeholder's ORIGINAL payload, captured the first time it is seen. A
// filled element no longer holds its source (KaTeX and the diagram replace
// the children), and a theme switch re-renders mermaid on the same element.
const sources = new WeakMap<Element, string>();

function sourceOf(el: Element): string {
  let source = sources.get(el);
  if (source === undefined) {
    source = el.textContent ?? '';
    sources.set(el, source);
  }
  return source;
}

// ─── Math ───────────────────────────────────────────────────────────────────

export async function hydrateMath(host: HTMLElement, isStale: IsStale): Promise<void> {
  const nodes = [...host.querySelectorAll<HTMLElement>('[data-math]')];
  if (nodes.length === 0) return;
  nodes.forEach(sourceOf);
  const { renderMath } = await import('./markdown-math');
  if (isStale()) return;
  for (const el of nodes) renderMath(el, sourceOf(el), el.dataset.math === 'display');
}

// ─── Mermaid ────────────────────────────────────────────────────────────────

export type MermaidResult = { dataUrl: string } | { error: string };

/**
 * Size an SVG for `<img>` use. Mermaid emits `width="100%"` plus a
 * `max-width` style, which as an image has no intrinsic size — the img would
 * collapse to 300×150. The viewBox carries the real dimensions.
 */
export function svgForImage(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg') return svg;
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    root.setAttribute('width', String(Math.ceil(box[2])));
    root.setAttribute('height', String(Math.ceil(box[3])));
    root.removeAttribute('style');
  }
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(root);
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgForImage(svg))}`;
}

/**
 * Rendered diagrams keyed by (theme, source). The pane re-renders its HTML on
 * every content change — an agent rewriting the file, a reload — and a
 * mermaid render is tens to hundreds of milliseconds, so an unchanged diagram
 * must come from here. A small LRU; the promise is cached, so two panes
 * showing the same diagram share one render.
 */
export function createMermaidCache(
  render: (source: string, theme: UiThemeName) => Promise<string>,
  max = 64,
) {
  const entries = new Map<string, Promise<MermaidResult>>();
  return (source: string, theme: UiThemeName): Promise<MermaidResult> => {
    const key = `${theme}\u0000${source}`;
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    }
    const pending = render(source, theme).then(
      (svg): MermaidResult => ({ dataUrl: svgDataUrl(svg) }),
      (err: unknown): MermaidResult => ({ error: (err as Error)?.message || String(err) }),
    );
    entries.set(key, pending);
    while (entries.size > max) entries.delete(entries.keys().next().value as string);
    return pending;
  };
}

let mermaidCache: ReturnType<typeof createMermaidCache> | null = null;

async function renderDiagram(source: string, theme: UiThemeName): Promise<MermaidResult> {
  if (!mermaidCache) {
    const { renderMermaidSvg } = await import('./markdown-mermaid');
    mermaidCache ??= createMermaidCache(renderMermaidSvg);
  }
  return mermaidCache(source, theme);
}

export function showMermaid(el: HTMLElement, source: string, result: MermaidResult): void {
  el.replaceChildren();
  if ('dataUrl' in result) {
    el.classList.remove('markdown-pane__mermaid--error');
    const img = document.createElement('img');
    img.className = 'markdown-pane__mermaid-img';
    img.alt = 'Mermaid diagram';
    img.src = result.dataUrl;
    el.appendChild(img);
    return;
  }
  // The source stays visible under the error, so a typo is fixable from here.
  el.classList.add('markdown-pane__mermaid--error');
  const message = document.createElement('div');
  message.className = 'markdown-pane__mermaid-message';
  message.textContent = result.error;
  const pre = document.createElement('pre');
  pre.textContent = source;
  el.append(message, pre);
}

export async function hydrateMermaid(host: HTMLElement, theme: UiThemeName, isStale: IsStale): Promise<void> {
  const nodes = [...host.querySelectorAll<HTMLElement>('[data-mermaid]')];
  for (const el of nodes) {
    const source = sourceOf(el);
    const result = await renderDiagram(source, theme);
    if (isStale()) return;
    showMermaid(el, source, result);
  }
}

// ─── Local images ───────────────────────────────────────────────────────────

/** Past this, a document's remaining local images stay unloaded. Each is up to
 *  10 MB through IPC, and a generated report can name thousands. */
export const MAX_IMAGES_PER_DOCUMENT = 200;

const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|svg\+xml);base64,/;

export type ReadImage = (
  documentPath: string | null,
  src: string,
) => Promise<{ dataUrl?: string; error?: string } | null | undefined>;

export async function hydrateImages(
  host: HTMLElement,
  documentPath: string | null,
  readImage: ReadImage | undefined,
  isStale: IsStale,
): Promise<void> {
  const nodes = [...host.querySelectorAll<HTMLImageElement>('img[data-local-src]')].slice(0, MAX_IMAGES_PER_DOCUMENT);
  if (nodes.length === 0 || !readImage) return;
  await Promise.all(nodes.map(async (img) => {
    const src = img.dataset.localSrc ?? '';
    let res: Awaited<ReturnType<ReadImage>>;
    try {
      res = await readImage(documentPath, src);
    } catch {
      res = { error: 'Could not read the image' };
    }
    if (isStale()) return;
    // Belt and braces: main only ever answers with these types, but this is
    // the one attribute here that bypasses DOMPurify, so it is checked anyway.
    if (res?.dataUrl && DATA_IMAGE.test(res.dataUrl)) {
      img.src = res.dataUrl;
      img.classList.remove('markdown-pane__image--failed');
    } else {
      img.classList.add('markdown-pane__image--failed');
      img.title = `${src}: ${res?.error ?? 'Could not read the image'}`;
    }
  }));
}
