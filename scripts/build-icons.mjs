/**
 * build-icons.mjs — rasterize the icon SVGs into the PNG/ICO the app ships.
 *
 *   npm run build:icons
 *
 * Why Electron and not sharp/resvg: this repo lives under a path with a space
 * ("OneDrive - Pulsa"), which breaks node-gyp — every native image dependency
 * is off the table (see the build gotcha in CLAUDE.md). Electron is already a
 * devDependency and rasterizes SVG exactly, so this costs zero new packages and
 * zero native builds.
 *
 * It rasterizes through a <canvas> in the renderer rather than capturePage():
 * capturing a transparent, never-shown window is unreliable on Windows (it
 * either hangs waiting for a paint that never comes, or fails outright with
 * UnknownVizError), while drawImage into a canvas needs no compositor, honours
 * alpha, and produces exactly the requested pixel size.
 *
 * Scale-aware by design (issue #122), in three tiers: icon.svg (four panes,
 * prompts, W hub) feeds 48px and up; icon-small.svg (cross + W, no prompts)
 * feeds 32px; icon-tiny.svg (frame + W only) feeds 16/20/24. Downsampling the
 * detailed art to 16px is what produced the grey mush the issue is about, and
 * no amount of resampling fixes it — the art itself has to get simpler.
 *
 * The ICO is assembled by hand (PNG-compressed entries, supported since Vista)
 * rather than through a library, for the same "no new dependency" reason.
 */
import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'resources', 'icons');

const DETAILED = 'icon.svg';
const SMALL = 'icon-small.svg';
const TINY = 'icon-tiny.svg';

/** Which SVG renders each ICO entry. */
const ICO_SIZES = [
  { size: 16, art: TINY },
  { size: 20, art: TINY },
  { size: 24, art: TINY },
  { size: 32, art: SMALL },
  { size: 48, art: DETAILED },
  { size: 64, art: DETAILED },
  { size: 128, art: DETAILED },
  { size: 256, art: DETAILED },
];

/**
 * Rasterize an SVG to a PNG buffer at an exact size, in the renderer.
 *
 * The SVG goes in as a data: URI on an <img> so the browser's own rasterizer
 * renders it at canvas resolution — vector-sharp at every size, rather than
 * scaling one bitmap down.
 */
async function renderPng(win, svg, size) {
  const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf-8').toString('base64');
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const img = new Image();
      img.width = ${size};
      img.height = ${size};
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('svg failed to decode'));
        img.src = ${JSON.stringify(dataUri)};
      });
      const canvas = document.createElement('canvas');
      canvas.width = ${size};
      canvas.height = ${size};
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, ${size}, ${size});
      return canvas.toDataURL('image/png');
    })()
  `);
  return Buffer.from(String(result).split(',')[1], 'base64');
}

/**
 * Assemble an .ico from PNG buffers: a 6-byte header, one 16-byte directory
 * entry per image, then the image data. 256px is encoded as 0 in the
 * single-byte width/height fields — the format's way of saying "256".
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((entry, i) => {
    const at = i * 16;
    const dim = entry.size >= 256 ? 0 : entry.size;
    dir.writeUInt8(dim, at);
    dir.writeUInt8(dim, at + 1);
    dir.writeUInt8(0, at + 2); // palette colours (0 = not paletted)
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(entry.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// Mirrored to a log file: Electron on Windows is a GUI-subsystem binary, so its
// console output does not reliably reach the parent shell.
const logLines = [];
function log(line) {
  logLines.push(line);
  console.log(line);
}

async function main() {
  app.disableHardwareAcceleration();
  await app.whenReady();

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icon stage</title>');

  const art = Object.fromEntries(
    [DETAILED, SMALL, TINY].map((name) => [name, fs.readFileSync(path.join(ICONS, name), 'utf-8')]),
  );

  const entries = [];
  for (const { size, art: which } of ICO_SIZES) {
    entries.push({ size, png: await renderPng(win, art[which], size) });
    log(`  ${size}px from ${which}`);
  }

  fs.writeFileSync(path.join(ICONS, 'icon.ico'), buildIco(entries));
  log(`  wrote icon.ico (${entries.length} sizes)`);

  // The Linux/Electron window icon, and the source for anything wanting a big
  // raster (store listings, the site).
  const master = await renderPng(win, art[DETAILED], 512);
  fs.writeFileSync(path.join(ICONS, 'icon.png'), master);
  fs.writeFileSync(path.join(ROOT, 'resources', 'icon.png'), master);
  log('  wrote icon.png (512px)');

  // Site favicon — small art, since a browser tab is a 16px slot.
  const favicon = await renderPng(win, art[SMALL], 256);
  fs.writeFileSync(path.join(ROOT, 'site', 'assets', 'favicon.png'), favicon);
  log('  wrote site/assets/favicon.png');

  win.destroy();
  fs.writeFileSync(path.join(ROOT, 'build-icons.log'), logLines.join('\n') + '\n');
  app.quit();
}

main().catch((err) => {
  fs.writeFileSync(path.join(ROOT, 'build-icons.log'), `FAILED: ${err.stack}\n`);
  console.error(err);
  app.exit(1);
});
