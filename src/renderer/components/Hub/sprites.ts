/**
 * Pixel sprites for the agent office hub — as code, not binary assets.
 *
 * Characters, furniture and tiles are string pixel maps rasterized once at
 * mount (see HubView). Keeping the art in TS means it ships inside the
 * renderer bundle (zero release-process changes), diffs in review, and a new
 * character variant is a string block. Original artwork, CC0-inspired.
 *
 * Format: each frame is `string[]` — one string per row, one char per pixel.
 * `.` is transparent; any other char is a palette role looked up in the
 * variant's palette. `validateFrame` (unit-tested) enforces the format.
 */

export interface SpriteMap {
  w: number;
  h: number;
  rows: string[];
}

export type BodyKind = 'human' | 'cat';

export type FrameName =
  | 'stand-down' | 'stand-up' | 'stand-side'
  | 'walk-down-0' | 'walk-down-1' | 'walk-up-0' | 'walk-up-1' | 'walk-side-0' | 'walk-side-1'
  | 'sit-up-0' | 'sit-up-1' | 'sit-still' | 'rest-0' | 'rest-1';

// ─── Human body (10 × 14) ─────────────────────────────────────────────────────
// Roles: s skin, h hair, e eye, t top, l legs, f feet.

const H_FRONT_TOP = [
  '...hhhh...',
  '..hhhhhh..',
  '..hssssh..',
  '..sesses..',
  '..ssssss..',
  '...ssss...',
  '..tttttt..',
  '.stttttts.',
  '.stttttts.',
  '..tttttt..',
];

const H_BACK_TOP = [
  '...hhhh...',
  '..hhhhhh..',
  '..hhhhhh..',
  '..hhhhhh..',
  '..shhhhs..',
  '...ssss...',
  '..tttttt..',
  '.stttttts.',
  '.stttttts.',
  '..tttttt..',
];

const H_SIDE_TOP = [
  '...hhhh...',
  '..hhhhhh..',
  '..shhhhh..',
  '..eshhhh..',
  '..ssshhh..',
  '...sss....',
  '..tttts...',
  '..stttt...',
  '..stttt...',
  '..tttts...',
];

const H_LEGS_STAND = ['...llll...', '...l..l...', '...l..l...', '..ff..ff..'];
const H_LEGS_WALK_0 = ['...llll...', '..l...l...', '..l...l...', '.ff....f..'];
const H_LEGS_WALK_1 = ['...llll...', '...l...l..', '...l...l..', '..f....ff.'];
const H_LEGS_SIDE_STAND = ['...lll....', '...ll.....', '...ll.....', '..ff......'];
const H_LEGS_SIDE_WALK_0 = ['...lll....', '..l..l....', '..l..l....', '.f....f...'];
const H_LEGS_SIDE_WALK_1 = ['...lll....', '...ll.....', '...ll.....', '...ff.....'];

const HUMAN_FRAMES: Record<FrameName, string[]> = {
  'stand-down': [...H_FRONT_TOP, ...H_LEGS_STAND],
  'stand-up': [...H_BACK_TOP, ...H_LEGS_STAND],
  'stand-side': [...H_SIDE_TOP, ...H_LEGS_SIDE_STAND],
  'walk-down-0': [...H_FRONT_TOP, ...H_LEGS_WALK_0],
  'walk-down-1': [...H_FRONT_TOP, ...H_LEGS_WALK_1],
  'walk-up-0': [...H_BACK_TOP, ...H_LEGS_WALK_0],
  'walk-up-1': [...H_BACK_TOP, ...H_LEGS_WALK_1],
  'walk-side-0': [...H_SIDE_TOP, ...H_LEGS_SIDE_WALK_0],
  'walk-side-1': [...H_SIDE_TOP, ...H_LEGS_SIDE_WALK_1],
  // At the desk, seen from behind — arms on the desk edge for the typing pair.
  'sit-up-0': [
    '...hhhh...',
    '..hhhhhh..',
    '..hhhhhh..',
    '..hhhhhh..',
    '..shhhhs..',
    '...ssss...',
    '.stttttts.',
    '.stttttts.',
    '..tttttt..',
    '..tttttt..',
    '...llll...',
    '...llll...',
    '..........',
    '..........',
  ],
  'sit-up-1': [
    '...hhhh...',
    '..hhhhhh..',
    '..hhhhhh..',
    '.shhhhhhs.',
    '.sshhhhss.',
    '...ssss...',
    '..tttttt..',
    '..tttttt..',
    '..tttttt..',
    '..tttttt..',
    '...llll...',
    '...llll...',
    '..........',
    '..........',
  ],
  'sit-still': [
    '...hhhh...',
    '..hhhhhh..',
    '..hhhhhh..',
    '..hhhhhh..',
    '..shhhhs..',
    '...ssss...',
    '..tttttt..',
    '..tttttt..',
    '..tttttt..',
    '..tttttt..',
    '...llll...',
    '...llll...',
    '..........',
    '..........',
  ],
  // Break room: seated front view, cup in hands / eyes closed.
  'rest-0': [
    '...hhhh...',
    '..hhhhhh..',
    '..hssssh..',
    '..sesses..',
    '..ssssss..',
    '...ssss...',
    '..tttttt..',
    '.stttttts.',
    '..ttssss..',
    '..tttttt..',
    '...llll...',
    '...llll...',
    '..........',
    '..........',
  ],
  'rest-1': [
    '...hhhh...',
    '..hhhhhh..',
    '..hssssh..',
    '..ssssss..',
    '..ssssss..',
    '...ssss...',
    '..tttttt..',
    '.stttttts.',
    '..tsssst..',
    '..tttttt..',
    '...llll...',
    '...llll...',
    '..........',
    '..........',
  ],
};

// ─── Cat body (12 × 10) ───────────────────────────────────────────────────────
// Roles: s fur, h ears/tail accent, e eye, t collar, l legs, f paws.

const C_FRONT_TOP = [
  '..h......h..',
  '..hh....hh..',
  '..ssssssss..',
  '..sesssses..',
  '..ssssssss..',
  '..tttttttt..',
  '..ssssssss..',
  '..ssssssss..',
];

const C_BACK_TOP = [
  '..h......h..',
  '..hh....hh..',
  '..ssssssss..',
  '..ssssssss..',
  '..ssssssss..',
  '..ssssssss..',
  '..ssssssss.h',
  '..ssssssssh.',
];

const C_LEGS_STAND = ['..l.l..l.l..', '..f.f..f.f..'];
const C_LEGS_WALK_0 = ['..l....l.l..', '..f....f.f..'];
const C_LEGS_WALK_1 = ['..l.l....l..', '..f.f....f..'];

const CAT_FRAMES: Record<FrameName, string[]> = {
  'stand-down': [...C_FRONT_TOP, ...C_LEGS_STAND],
  'stand-up': [...C_BACK_TOP, ...C_LEGS_STAND],
  'stand-side': [
    '..h.h.......',
    '..sss.......',
    '.essss......',
    '.sssss......',
    '.sssssssss..',
    '.ssssssssss.',
    '.sssssssssh.',
    '..........h.',
    '..ll....ll..',
    '..ff....ff..',
  ],
  'walk-down-0': [...C_FRONT_TOP, ...C_LEGS_WALK_0],
  'walk-down-1': [...C_FRONT_TOP, ...C_LEGS_WALK_1],
  'walk-up-0': [...C_BACK_TOP, ...C_LEGS_WALK_0],
  'walk-up-1': [...C_BACK_TOP, ...C_LEGS_WALK_1],
  'walk-side-0': [
    '..h.h.......',
    '..sss.......',
    '.essss......',
    '.sssss......',
    '.sssssssss..',
    '.ssssssssss.',
    '.sssssssssh.',
    '..........h.',
    '.l.l..l.l...',
    '.f.f..f.f...',
  ],
  'walk-side-1': [
    '..h.h.......',
    '..sss.......',
    '.essss......',
    '.sssss......',
    '.sssssssss..',
    '.ssssssssss.',
    '.sssssssssh.',
    '..........h.',
    '..ll....ll..',
    '..ff....ff..',
  ],
  // A loaf at the desk; the tail flick is the typing animation.
  'sit-up-0': [
    '..h......h..',
    '..hh....hh..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssssh.',
    '..ssssssss..',
    '..ffffffff..',
  ],
  'sit-up-1': [
    '..h......h..',
    '..hh....hh..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '.hssssssss..',
    '..ssssssss..',
    '..ffffffff..',
  ],
  'sit-still': [
    '..h......h..',
    '..hh....hh..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ssssssss..',
    '..ffffffff..',
  ],
  'rest-0': [
    '............',
    '............',
    '....ssss....',
    '..ssssssss..',
    '.ssssssssss.',
    '.ssshhsssss.',
    '.ssssssssss.',
    '..ssssssss..',
    '...ssssss...',
    '............',
  ],
  'rest-1': [
    '............',
    '............',
    '...hssss....',
    '..ssssssss..',
    '.ssssssssss.',
    '.ssshhsssss.',
    '.ssssssssss.',
    '..ssssssss..',
    '...ssssss...',
    '............',
  ],
};

export const BODY_FRAMES: Record<BodyKind, Record<FrameName, string[]>> = {
  human: HUMAN_FRAMES,
  cat: CAT_FRAMES,
};

// ─── Variants ─────────────────────────────────────────────────────────────────
// Palette per variant; `variantFor` hashes a surfaceId onto this array so an
// agent keeps its face across hub openings.

export const VARIANTS: Array<{ body: BodyKind; palette: Record<string, string> }> = [
  { body: 'human', palette: { s: '#e8b98f', h: '#4a3221', t: '#3f7fb8', l: '#39424e', f: '#2a2622', e: '#20242c' } },
  { body: 'human', palette: { s: '#c98e62', h: '#161314', t: '#c25555', l: '#33383f', f: '#241f1c', e: '#181a20' } },
  { body: 'human', palette: { s: '#f0c9a0', h: '#c7862d', t: '#4ba06c', l: '#41546b', f: '#302b26', e: '#1e222a' } },
  { body: 'human', palette: { s: '#8f5f3f', h: '#2c2320', t: '#8e6bc1', l: '#2f3a45', f: '#211d1a', e: '#15181e' } },
  { body: 'human', palette: { s: '#eec39a', h: '#b8443a', t: '#d8963c', l: '#3d4854', f: '#2b2724', e: '#20242c' } },
  { body: 'human', palette: { s: '#b57a50', h: '#5d5165', t: '#4fb3ad', l: '#374049', f: '#26221f', e: '#191c22' } },
  { body: 'cat', palette: { s: '#e0993f', h: '#a86a24', t: '#cc4444', l: '#c98a35', f: '#8f5e1f', e: '#213026' } },
  { body: 'cat', palette: { s: '#8d9099', h: '#5e6169', t: '#3f7fb8', l: '#7c7f88', f: '#55585f', e: '#2a3138' } },
];

// ─── Furniture (16 px tall, width a multiple of 16) ──────────────────────────
// Roles: w wood, d wood-dark, m metal, c cushion, x accent, g glass, k dark.

export const FURNITURE_PALETTE: Record<string, string> = {
  w: '#8a6b48',
  d: '#6e5237',
  m: '#7a8087',
  c: '#b0563e',
  x: '#4caf6e',
  g: '#bcd6e4',
  k: '#2a2320',
};

export const FURNITURE: Record<
  'desk' | 'chair' | 'couch' | 'coffee' | 'door' | 'plant' | 'bookshelf' | 'cooler' | 'window' | 'painting',
  string[]
> = {
  desk: [
    'wwwwwwwwwwwwwwww',
    'wddddddddddddddw',
    'wd....kkkk....dw',
    'wd...kggggk...dw',
    'wd...kggggk...dw',
    'wd....kkkk....dw',
    'wd.....kk.....dw',
    'wd...kkkkkk...dw',
    'wddddddddddddddw',
    'wwwwwwwwwwwwwwww',
    '.dd..........dd.',
    '.dd..........dd.',
    '.dd..........dd.',
    '.dd..........dd.',
    '.dd..........dd.',
    '.dd..........dd.',
  ],
  chair: [
    '................',
    '................',
    '................',
    '....dddddddd....',
    '....d......d....',
    '....d......d....',
    '....cccccccc....',
    '....cccccccc....',
    '....dddddddd....',
    '.....d....d.....',
    '.....d....d.....',
    '....dd....dd....',
    '................',
    '................',
    '................',
    '................',
  ],
  couch: [
    '................................',
    '................................',
    '................................',
    '.cc..........................cc.',
    '.cc..........................cc.',
    '.cccccccccccccccccccccccccccccc.',
    '.cccccccccccccccccccccccccccccc.',
    '.cccccccccccccccccccccccccccccc.',
    '.cccccccccccccccccccccccccccccc.',
    '.cccccccccccccccccccccccccccccc.',
    '.dddddddddddddddddddddddddddddd.',
    '.dd..........................dd.',
    '.dd..........................dd.',
    '................................',
    '................................',
    '................................',
  ],
  coffee: [
    '................',
    '....kkkkkkkk....',
    '....kmmmmmmk....',
    '....kmxmmmmk....',
    '....kkkkkkkk....',
    '....km....mk....',
    '....kmggggmk....',
    '....kmggggmk....',
    '....kmggggmk....',
    '....kkkkkkkk....',
    '....mmmmmmmm....',
    '....mmmmmmmm....',
    '................',
    '................',
    '................',
    '................',
  ],
  door: [
    'kkkkkkkkkkkkkkkk',
    'kwwwwwwkkwwwwwwk',
    'kwwwwwwkkwwwwwwk',
    'kwddddwkkwddddwk',
    'kwddddwkkwddddwk',
    'kwwwwwwkkwwwwwwk',
    'kwwwwwwkkwwwwwwk',
    'kwwwwmwkkwmwwwwk',
    'kwwwwmwkkwmwwwwk',
    'kwwwwwwkkwwwwwwk',
    'kwddddwkkwddddwk',
    'kwddddwkkwddddwk',
    'kwwwwwwkkwwwwwwk',
    'kwwwwwwkkwwwwwwk',
    'kwwwwwwkkwwwwwwk',
    'kkkkkkkkkkkkkkkk',
  ],
  bookshelf: [
    '.wwwwwwwwwwwwww.',
    '.wcxmccxmccxmcw.',
    '.wcxmccxmccxmcw.',
    '.wwwwwwwwwwwwww.',
    '.wmxccmxccmxccw.',
    '.wmxccmxccmxccw.',
    '.wwwwwwwwwwwwww.',
    '.wccmxccmxccmxw.',
    '.wccmxccmxccmxw.',
    '.wwwwwwwwwwwwww.',
    '.wddddddddddddw.',
    '.wddddddddddddw.',
    '.wwwwwwwwwwwwww.',
    '................',
    '................',
    '................',
  ],
  cooler: [
    '................',
    '.....gggggg.....',
    '.....gggggg.....',
    '.....gggggg.....',
    '....mmmmmmmm....',
    '....mmmmmmmm....',
    '....mmxmxmmm....',
    '....mmmmmmmm....',
    '....mmmmmmmm....',
    '....mmmmmmmm....',
    '....mmmmmmmm....',
    '.....m....m.....',
    '.....m....m.....',
    '................',
    '................',
    '................',
  ],
  window: [
    '................',
    '................',
    '..kkkkkkkkkkkk..',
    '..kggggggggggk..',
    '..kggggggggggk..',
    '..kggggkkggggk..',
    '..kggggkkggggk..',
    '..kkkkkkkkkkkk..',
    '..kggggkkggggk..',
    '..kggggkkggggk..',
    '..kggggggggggk..',
    '..kggggggggggk..',
    '..kkkkkkkkkkkk..',
    '................',
    '................',
    '................',
  ],
  painting: [
    '................',
    '................',
    '................',
    '...wwwwwwwwww...',
    '...wccccggggw...',
    '...wccxxggggw...',
    '...wcxxxxgggw...',
    '...wxxxxxxggw...',
    '...wwwwwwwwww...',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  plant: [
    '................',
    '......xx........',
    '....xxxxxx......',
    '...xxxxxxxx.....',
    '...xxxxxxxxx....',
    '....xxxxxxxx....',
    '.....xxxxxx.....',
    '......xxxx......',
    '.......xx.......',
    '......dddd......',
    '.....dddddd.....',
    '.....dddddd.....',
    '.....dddddd.....',
    '......dddd......',
    '................',
    '................',
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function frameSize(rows: string[]): { w: number; h: number } {
  return { w: rows[0]?.length ?? 0, h: rows.length };
}

/** Returns an error message, or null when the frame is well-formed. */
export function validateFrame(rows: string[], palette: Record<string, string>): string | null {
  if (!rows.length || !rows[0].length) return 'empty frame';
  const w = rows[0].length;
  for (let y = 0; y < rows.length; y++) {
    if (rows[y].length !== w) return `row ${y} width ${rows[y].length} != ${w}`;
    for (const ch of rows[y]) {
      if (ch !== '.' && !(ch in palette)) return `unknown role '${ch}' in row ${y}`;
    }
  }
  return null;
}

/** FNV-1a over the surfaceId, so an agent keeps its appearance across sessions. */
export function variantFor(surfaceId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < surfaceId.length; i++) {
    h ^= surfaceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % VARIANTS.length;
}

/**
 * Pixel map → offscreen canvas, 1 canvas px per pixel. The ONLY function in
 * this module that touches the DOM — never import it from a unit test.
 */
export function rasterize(rows: string[], palette: Record<string, string>): HTMLCanvasElement {
  const { w, h } = frameSize(rows);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      if (ch === '.') continue;
      ctx.fillStyle = palette[ch];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}
