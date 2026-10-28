/**
 * clipboard-image.ts — turn a pasted screenshot into a PNG file fast (#381).
 *
 * `NativeImage.toPNG()` ran Chromium's encoder at the default zlib level on the
 * main thread, then `writeFileSync`: a 3500×2004 screenshot froze the window for
 * ~0.8 s, ~780 ms of it in `toPNG` alone. Two things fix it, and this module
 * holds the parts that can be tested without Electron.
 *
 * (1) **Fewer pixels.** Claude Code resizes every image to the model's limit
 * (long edge 2576 px and at most 4784 tiles of 28×28) before sending it, so
 * anything above that is encoded, written and uploaded only to be thrown away.
 * `fitImageSize` is the largest same-aspect size inside that limit. It is a
 * default, not a law — `[paste] downscale-images = false` keeps every pixel for
 * whatever else reads the file.
 *
 * (2) **Encode for latency, off the main thread.** No filtering (every row is
 * filter type 0) and zlib level 1: a paste is read once, so a bigger file costs
 * far less than a frozen window. The deflate runs on libuv's threadpool through
 * the async `zlib.deflate`; only the byte shuffle from Skia's bitmap stays on
 * the main thread, which is a single linear pass.
 *
 * The bitmap is Skia's N32 layout as `NativeImage.toBitmap()` returns it on
 * Windows: BGRA, PREMULTIPLIED alpha. A PNG wants straight alpha, so a
 * translucent pixel is un-premultiplied; an opaque image (every screenshot) is
 * written as RGB, a quarter less to deflate.
 *
 * The Electron half lives in remote-insert.ts. `readClipboardSource` still
 * copies the bitmap SYNCHRONOUSLY, before the paste queue, so the snapshot
 * semantics hold; `materializeClipboard` encodes and writes with
 * `fs.promises`. A bitmap whose length does not match its size falls back to
 * `toPNG()`.
 */

import * as zlib from 'zlib';
import { promisify } from 'util';

const deflateAsync = promisify(zlib.deflate);

/** Long edge, in px, that Claude Code resizes an image down to. */
export const MAX_IMAGE_EDGE = 2576;
/** Side of one vision tile, in px. */
export const IMAGE_TILE_PX = 28;
/** Most tiles an image may cover after Claude Code's resize. */
export const MAX_IMAGE_TILES = 4784;

export interface ImageSize {
  width: number;
  height: number;
}

/** Tiles of `IMAGE_TILE_PX` an image covers — a partial tile counts whole. */
export function imageTiles(width: number, height: number): number {
  return Math.ceil(width / IMAGE_TILE_PX) * Math.ceil(height / IMAGE_TILE_PX);
}

function fits(width: number, height: number): boolean {
  return Math.max(width, height) <= MAX_IMAGE_EDGE && imageTiles(width, height) <= MAX_IMAGE_TILES;
}

/**
 * The largest same-aspect size within the model's limit, or the size itself
 * when it already fits.
 *
 * "Same aspect" means the short edge is the long edge scaled by the original
 * ratio and rounded (never below 1 px). The search walks the long edge down
 * from the edge cap, so the first size that fits is the largest one: tile
 * rounding (`ceil`) means the area bound alone can overshoot — 3500×2004 scaled
 * to the area limit is 2559×1465, which still covers 92×53 = 4876 tiles.
 */
export function fitImageSize(width: number, height: number): ImageSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { width, height };
  }
  if (fits(width, height)) return { width, height };

  const landscape = width >= height;
  const long = landscape ? width : height;
  const short = landscape ? height : width;
  for (let edge = Math.min(long, MAX_IMAGE_EDGE); edge >= 1; edge--) {
    const other = Math.max(1, Math.round((edge * short) / long));
    const w = landscape ? edge : other;
    const h = landscape ? other : edge;
    if (fits(w, h)) return { width: w, height: h };
  }
  // Unreachable: 1×1 always fits. Kept so the return type needs no assertion.
  return { width: 1, height: 1 };
}

/**
 * Skia BGRA (premultiplied) → PNG scanlines: one filter byte (0, None) then the
 * row's pixels, RGB when `opaque`, RGBA otherwise.
 */
export function bgraToScanlines(bitmap: Buffer, width: number, height: number, opaque: boolean): Buffer {
  const channels = opaque ? 3 : 4;
  const stride = width * channels + 1;
  const out = Buffer.allocUnsafe(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    let dst = y * stride;
    out[dst++] = 0;
    for (let x = 0; x < width; x++, src += 4) {
      const a = bitmap[src + 3];
      if (opaque) {
        out[dst++] = bitmap[src + 2];
        out[dst++] = bitmap[src + 1];
        out[dst++] = bitmap[src];
      } else {
        out[dst++] = unpremultiply(bitmap[src + 2], a);
        out[dst++] = unpremultiply(bitmap[src + 1], a);
        out[dst++] = unpremultiply(bitmap[src], a);
        out[dst++] = a;
      }
    }
  }
  return out;
}

function unpremultiply(channel: number, alpha: number): number {
  if (alpha === 255) return channel;
  if (alpha === 0) return 0;
  return Math.min(255, Math.round((channel * 255) / alpha));
}

/** Is every pixel's alpha 255? */
export function isOpaque(bitmap: Buffer): boolean {
  for (let i = 3; i < bitmap.length; i += 4) {
    if (bitmap[i] !== 255) return false;
  }
  return true;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  typeBytes.copy(head, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(typeBytes)) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Wrap an already-deflated IDAT stream into a complete PNG file. */
export function assemblePng(width: number, height: number, opaque: boolean, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type: truecolour / truecolour + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (every row uses type 0)
  ihdr[12] = 0; // no interlace
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Encode a Skia BGRA bitmap as a PNG. The deflate — nearly all of the cost —
 * runs off the main thread.
 */
export async function encodeBgraPng(bitmap: Buffer, width: number, height: number): Promise<Buffer> {
  if (bitmap.length !== width * height * 4) {
    throw new Error(`bitmap is ${bitmap.length} bytes, expected ${width * height * 4} for ${width}x${height}`);
  }
  const opaque = isOpaque(bitmap);
  const scanlines = bgraToScanlines(bitmap, width, height, opaque);
  const idat = await deflateAsync(scanlines, { level: 1 });
  return assemblePng(width, height, opaque, idat);
}
