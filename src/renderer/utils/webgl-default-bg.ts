import type { WebglAddon } from '@xterm/addon-webgl';

/**
 * Stop the WebGL renderer painting an opaque band behind dim, italic or
 * hyperlinked text that has the DEFAULT background (issue #425).
 *
 * `RectangleRenderer.updateBackgrounds` (addon-webgl 0.19.0, still on xterm.js
 * master) decides a cell needs a background rectangle with `bg !== 0`. The bg
 * word carries attribute flags as well as the colour: DIM, ITALIC,
 * HAS_EXTENDED (underline styles, OSC 8 links), OVERLINE, PROTECTED. So every
 * run of such cells gets a rectangle in the theme background's RGB, drawn with
 * alpha 1. Over an opaque theme that is invisible, because the CSS behind the
 * canvas is the same colour. Over a translucent terminal or a custom
 * background it is a solid band: Claude Code's thinking text is dim italic,
 * which is how it showed up.
 *
 * A default-colour, non-inverse span never needs a rectangle (the renderer's
 * first rectangle already fills the viewport with the theme background, alpha
 * included), so the patch gives those rectangles zero width. Everything else,
 * selection and inverse included, goes through untouched. The class is not
 * exported, so the patch goes on the prototype of the first instance seen; the
 * renderer replaces the instance on a context restore, the prototype stays.
 */

/** xterm `Attributes.CM_MASK` and `FgFlags.INVERSE`, common/buffer/Constants. */
const CM_MASK = 0x3000000;
const CM_DEFAULT = 0;
const FG_INVERSE = 0x4000000;
/** Index of a rectangle's width in its vertex attributes (x, y, w, h, r, g, b, a). */
const WIDTH_INDEX = 2;

export function isDefaultBackgroundSpan(fg: number, bg: number): boolean {
  return !(fg & FG_INVERSE) && (bg & CM_MASK) === CM_DEFAULT;
}

type UpdateRectangle = (
  vertices: { attributes: Float32Array },
  offset: number, fg: number, bg: number, startX: number, endX: number, y: number,
) => void;

interface RectangleRendererLike { _updateRectangle?: UpdateRectangle }

const PATCHED = Symbol.for('wmux.webglDefaultBg');

/** Patch the prototype behind `rectangleRenderer`. Idempotent; false when the shape is not the expected one. */
export function patchRectangleRenderer(rectangleRenderer: RectangleRendererLike | undefined): boolean {
  if (!rectangleRenderer) return false;
  const proto = Object.getPrototypeOf(rectangleRenderer) as RectangleRendererLike & { [PATCHED]?: true };
  if (proto[PATCHED]) return true;
  const original = proto._updateRectangle;
  if (typeof original !== 'function') return false;
  proto._updateRectangle = function (this: unknown, vertices, offset, fg, bg, startX, endX, y) {
    original.call(this, vertices, offset, fg, bg, startX, endX, y);
    if (isDefaultBackgroundSpan(fg, bg)) vertices.attributes[offset + WIDTH_INDEX] = 0;
  };
  proto[PATCHED] = true;
  return true;
}

/** Reach the addon's rectangle renderer (private fields) once it is loaded into a terminal. */
export function patchWebglDefaultBackground(addon: WebglAddon): void {
  try {
    const renderer = (addon as unknown as { _renderer?: { _rectangleRenderer?: { value?: RectangleRendererLike } } })._renderer;
    if (!patchRectangleRenderer(renderer?._rectangleRenderer?.value)) {
      console.warn('[wmux] WebGL default-background patch did not apply (addon internals changed?)');
    }
  } catch { /* never let a cosmetic patch break the renderer */ }
}
