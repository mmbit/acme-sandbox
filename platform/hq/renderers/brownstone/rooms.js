// Every room is drawn here, pixel by pixel: floors, sheared back walls with wall art, glass
// partitions and furniture that fits the room kind. Static parts are baked into one canvas per room,
// things people can walk behind become depth-sorted props, and animated bits become anchors.
import { rng, pick, mix, canvas } from '../../util.js';
import { toTile, FH, SLAB, WALL_H, INNER_WALL_H, PENT_H, CORE, CORE_X, ENTRANCE, SHAFT, STAIR, inWell, INK, F, disc, sprite, SX, SY, top, wallY, wallX, box, onWallY, onWallX, wallYCol, wallXCol, ellipse, text, textW, upright, namePlate } from './iso.js';
import { drawProp, DRINKS } from './sprites.js';
import { levelName, arcadeWall, wallHidden, clearOf, partitionDepth } from './layout.js';
import { today } from './env.js';
import { darkroomThing } from './darkroom.js';

const BOOKS = ['#e8505b', '#5b8def', '#f2c14e', '#7bd389', '#9b72cf', '#ff8fab', '#4fb5a5'];
const THEME = { // wall, trim, floor, desk
  office: ['#f3e3c3', '#d9b98c', '#b07a4f', '#cf9460'], boardroom: ['#3a4a7a', '#2c3862', '#8e3b2c', '#6e4029'],
  lab: ['#dff3ee', '#9fd6c8', '#e6e8f0', '#e6e8f0'], studio: ['#ffe1ea', '#f5a3b8', '#a8693f', '#f6f1e6'],
  mailroom: ['#fff0c9', '#e6c56e', '#9a6843', '#cf9460'], dock: ['#c9ccd8', '#f2c14e', '#8b8fa3', '#a8693f'],
  vault: ['#4f5a4a', '#3b4636', '#6d7560', '#6e4029'], archive: ['#e8dcc8', '#b8a07a', '#9a6a48', '#a8693f'],
  server: ['#2f3552', '#23283f', '#3b4160', '#565a70'], review: ['#e3dcf5', '#9b72cf', '#6b4c9a', '#cf9460'],
  lobby: ['#fdf3e1', '#e07a5f', '#f6f1e6', '#cf9460'], library: ['#8a5a44', '#5a3825', '#8e3b2c', '#a8693f'],
  lounge: ['#d8efe0', '#7bbf9a', '#c99a6b', '#cf9460'], nook: ['#eef3d6', '#a7c46a', '#b07a4f', '#cf9460'],
  core: ['#e9e4f2', '#b9b0d0', '#e3cfae', '#8b8fa3'], terrace: ['#c8553d', '#8e3b2c', '#b98a64', '#cf9460'],
  storage: ['#b9b3c9', '#8b8fa3', '#9a96ab', '#a8693f'],
  gym: ['#e1ebf5', '#5b8def', '#4a4f66', '#cf9460'], canteen: ['#fff0d6', '#f2a65a', '#e8dcc8', '#cf9460'],
  booth: ['#5a5078', '#e8505b', '#3e3c48', '#6e4029'], // (a charcoal carpet, not a second purple beside the review room's)
  darkroom: ['#4a4258', '#8e3b4a', '#5a5068', '#8a5a44'],
  engine: ['#d3dbe4', '#f08a3c', '#5a6378', '#8b8fa3'], arcade: ['#3a2d5c', '#ff5c8a', '#2b2440', '#565a70'],
  meeting: ['#6f8f78', '#3e5a4a', '#9a6a48', '#a8693f'],
  bar: ['#2f5560', '#c8963e', '#7a4a35', '#5a3825'],
};
export const theme = kind => THEME[kind] || THEME.office;

// ---- flat wall art: draw(g, x, y, r, glass), with y the top of the band ----
const WALL = {
  window: [15, (g, x, y, r, glass) => { F(g, x - 1, y - 1, 16, 17, '#f6f1e6'); g.clearRect(x, y, 14, 15); glass(x, y, 14, 15); F(g, x + 7, y, 1, 15, '#f6f1e6'); F(g, x, y + 7, 14, 1, '#f6f1e6'); F(g, x - 2, y + 15, 18, 2, '#d9b98c'); }],
  tall: [15, (g, x, y, r, glass) => { F(g, x - 1, y - 21, 16, 38, '#ffd966'); g.clearRect(x, y - 20, 14, 36); glass(x, y - 20, 14, 36); F(g, x + 7, y - 20, 1, 36, '#ffd966'); F(g, x, y - 4, 14, 1, '#ffd966'); }],
  poster: [10, (g, x, y, r) => { F(g, x, y + 1, 10, 12, pick(r, BOOKS)); F(g, x + 1, y + 2, 8, 10, '#fffaf0'); F(g, x + 3, y + 4, 4, 4, pick(r, BOOKS)); F(g, x + 2, y + 9, 6, 1, INK); }],
  shelf: [16, (g, x, y, r) => { F(g, x, y + 10, 16, 2, '#6e4029'); for (let i = 0; i < 14; i += 2) F(g, x + 1 + i, y + 4 + (r() * 3 | 0), 2, 6, pick(r, BOOKS)); }],
  board: [18, (g, x, y, r) => { F(g, x, y + 1, 18, 11, '#8b8fa3'); F(g, x + 1, y + 2, 16, 9, '#fffaf0'); for (let i = 0; i < 3; i++) F(g, x + 3, y + 4 + i * 2, 4 + (r() * 9 | 0), 1, pick(r, ['#5b8def', '#e8505b', '#3b3355'])); }],
  clock: [8, (g, x, y) => { disc(g, x + 4, y + 5, 3, '#fffaf0'); F(g, x + 1, y + 2, 1, 1, INK); }],
  chart: [14, (g, x, y) => { F(g, x, y + 1, 14, 11, '#fffaf0'); [3, 4, 6, 8].forEach((h, i) => F(g, x + 2 + i * 3, y + 11 - h, 2, h, '#5cc26a')); }],
  stickies: [16, (g, x, y, r) => { for (let i = 0; i < 12; i++) if (r() < 0.8) F(g, x + (i % 4) * 4, y + 1 + (i >> 2) * 4, 3, 3, pick(r, ['#fff3a0', '#ffc2d1', '#b8f0c8', '#bfe3ff'])); }],
  pegboard: [16, (g, x, y) => { F(g, x, y, 16, 12, '#cf9460'); F(g, x + 2, y + 2, 1, 7, '#8b8fa3'); F(g, x + 5, y + 2, 3, 3, '#e8505b'); F(g, x + 10, y + 3, 4, 1, '#565a70'); F(g, x + 11, y + 4, 2, 5, '#565a70'); }],
  pigeon: [20, (g, x, y, r) => { F(g, x, y, 20, 13, '#a8693f'); for (let i = 0; i < 10; i++) { const cx = x + 1 + (i % 5) * 4, cy = y + 1 + (i / 5 | 0) * 6; F(g, cx, cy, 3, 5, '#6e4029'); if (r() < 0.6) F(g, cx, cy + 2, 3, 2, '#fffaf0'); } }],
  hazard: [10, (g, x, y) => { for (let i = 0; i < 8; i++) F(g, x + 4 - (i >> 1), y + 2 + i, 2 + (i >> 1) * 2, 1, '#f2c14e'); F(g, x + 4, y + 5, 2, 3, INK); F(g, x + 4, y + 9, 2, 1, INK); }],
  deposit: [19, (g, x, y) => { F(g, x, y, 19, 13, '#8b8a60'); for (let i = 0; i < 12; i++) F(g, x + 1 + (i % 4) * 4.5 | 0, y + 1 + (i >> 2) * 4, 4, 3, '#c9b458'); }],
  binders: [18, (g, x, y, r) => { for (const sy of [5, 12]) { F(g, x, y + sy, 18, 1, '#6e4029'); for (let i = 0; i < 16; i += 2) F(g, x + 1 + i, y + sy - 5, 2, 5, pick(r, BOOKS)); } }],
  pinboard: [18, (g, x, y, r) => { F(g, x, y, 18, 12, '#cf9460'); const p = [0, 1, 2, 3].map(() => [x + 2 + (r() * 12 | 0), y + 2 + (r() * 7 | 0)]); p.forEach(([a, b]) => F(g, a, b, 3, 3, '#fffaf0')); for (let i = 1; i < 4; i++) { const [a, b] = p[i - 1], [c, d] = p[i], n = Math.max(Math.abs(c - a), Math.abs(d - b)); for (let k = 0; k <= n; k++) F(g, Math.round(a + 1 + (c - a) * k / n), Math.round(b + 1 + (d - b) * k / n), 1, 1, '#e8505b'); } }],
  art: [12, (g, x, y, r) => { F(g, x, y + 1, 12, 10, '#f2c14e'); F(g, x + 1, y + 2, 10, 8, '#fffaf0'); for (let i = 0; i < 6; i++) F(g, x + 2 + (r() * 7 | 0), y + 3 + (r() * 5 | 0), 2, 2, pick(r, BOOKS)); }],
  // the Overseer's portrait in the penthouse, a prompt whose caret blinks (render.js),
  // hung high, clear of the board's tall chair and screen
  overseer: [10, (g, x, y, r, glass, led) => {
    const screen = '#2b3148';
    y -= 16; F(g, x, y, 10, 12, '#d9a441'); F(g, x + 1, y + 1, 8, 10, screen);
    [0, 1, 0].forEach((u, v) => F(g, x + 2 + u, y + 4 + v, 1, 1, '#ffb35a')); led(x + 5, y + 6, { caret: 1, off: screen }); led(x + 6, y + 6, { caret: 1, off: screen });
  }],
  portrait: [10, (g, x, y) => { F(g, x, y, 10, 12, '#d9a441'); F(g, x + 1, y + 1, 8, 10, '#5a3825'); F(g, x + 3, y + 3, 4, 4, '#f5c49c'); F(g, x + 2, y + 8, 6, 3, '#2f3b63'); }],
  screen: [18, (g, x, y) => { F(g, x, y, 18, 11, '#141a2e'); for (let i = 0; i < 14; i++) F(g, x + 2 + i, y + 8 - Math.round(3 + 2 * Math.sin(i)), 1, 1, '#7bd389'); F(g, x + 2, y + 2, 5, 1, '#4fb5a5'); }],
  vent: [10, (g, x, y) => { F(g, x, y + 2, 10, 8, '#565a70'); for (let i = 0; i < 3; i++) F(g, x + 1, y + 3 + i * 2, 8, 1, '#23283f'); }],
  vacant: [22, (g, x, y) => { F(g, x, y + 2, 22, 9, '#fffaf0'); text(g, 'EMPTY', x + 2, y + 4, '#e8505b'); }],
  vaultdoor: [30, (g, x, y) => { disc(g, x + 15, y + 6, 13, '#8b8fa3'); disc(g, x + 15, y + 6, 10, '#c9ccd8'); disc(g, x + 15, y + 6, 3, '#565a70'); for (let a = 0; a < 6; a++) F(g, x + 15 + Math.round(Math.cos(a) * 7), y + 6 + Math.round(Math.sin(a) * 7), 1, 1, '#565a70'); F(g, x + 26, y + 3, 3, 6, '#565a70'); }],
  shutter: [28, (g, x, y) => { F(g, x, y - 12, 28, 30, '#565a70'); for (let i = 0; i < 14; i++) F(g, x + 1, y - 11 + i * 2, 26, 1, '#8b8fa3'); for (let i = 0; i < 7; i++) F(g, x + i * 4, y + 15, 2, 3, '#f2c14e'); }],
  // the booth's lightbox over the desk, 21 to 29 px up (the floor above can hide what's higher): dark until someone
  // records, then lit (its lit face goes on the room's on-air layer, which render.js shows while recording)
  onair: [29, (g, x, y, r, glass, led, lit) => {
    const sign = (f, face, ink) => { F(f, x, y + 1, 29, 9, '#2b2230'); F(f, x + 1, y + 2, 27, 7, face); text(f, 'ON AIR', x + 3, y + 3, ink); };
    sign(g, '#4a1a26', '#b8505e'); F(g, x + 6, y - 2, 1, 3, '#2b2230'); F(g, x + 22, y - 2, 1, 3, '#2b2230'); // (on two cords)
    lit?.(x + 14, y + 5, f => { sign(f, '#e8505b', '#fffaf0'); F(f, x + 1, y + 2, 27, 1, '#ff8f98'); });
  }],
  // the whole word on its board, in two lines: on one (27 px) it would push the lobby's art off a short wall
  plaque: [19, (g, x, y) => { F(g, x, y - 1, 19, 15, '#d9a441'); F(g, x + 1, y, 17, 13, '#6e4029'); text(g, 'WEL', x + 4, y + 1, '#ffd966'); text(g, 'COME', x + 2, y + 7, '#ffd966'); }],
  cctv: [20, (g, x, y) => { F(g, x, y, 20, 13, '#23283f'); for (let i = 0; i < 4; i++) F(g, x + 1 + (i % 2) * 10, y + 1 + (i >> 1) * 6, 8, 5, ['#34508f', '#3d6e70', '#4a3f8f', '#34508f'][i]); }],
  pixelart: [13, (g, x, y) => { F(g, x, y, 13, 12, '#f2c14e'); F(g, x + 1, y + 1, 11, 10, '#8fd3ff'); F(g, x + 1, y + 8, 11, 3, '#4fa3d5'); F(g, x + 4, y + 5, 5, 3, '#fffaf0'); F(g, x + 7, y + 3, 2, 3, '#fffaf0'); F(g, x + 9, y + 4, 2, 1, '#f2a65a'); F(g, x + 8, y + 3, 1, 1, INK); F(g, x + 2, y + 2, 2, 1, '#fffaf0'); }], // a framed duck
  doodles: [20, (g, x, y) => { F(g, x, y, 20, 13, '#cf9460'); F(g, x + 1, y + 1, 6, 6, '#fffaf0'); disc(g, x + 4, y + 4, 1, '#f2c14e'); F(g, x + 3, y + 1, 1, 1, '#f2c14e'); F(g, x + 1, y + 4, 1, 1, '#f2c14e'); F(g, x + 6, y + 4, 1, 1, '#f2c14e');
    F(g, x + 8, y + 2, 5, 5, '#fff3a0'); F(g, x + 9, y + 3, 1, 1, INK); F(g, x + 11, y + 3, 1, 1, INK); F(g, x + 9, y + 5, 3, 1, INK); F(g, x + 14, y + 1, 5, 6, '#bfe3ff'); F(g, x + 15, y + 3, 1, 1, '#ff5c8a'); F(g, x + 17, y + 3, 1, 1, '#ff5c8a'); F(g, x + 15, y + 4, 3, 1, '#ff5c8a'); F(g, x + 16, y + 5, 1, 1, '#ff5c8a');
    F(g, x + 3, y + 8, 8, 4, '#ffc2d1'); F(g, x + 4, y + 10, 6, 1, '#9b72cf'); F(g, x + 12, y + 8, 6, 4, '#b8f0c8'); F(g, x + 14, y + 9, 1, 2, '#3f9b5c'); F(g, x + 13, y + 10, 3, 1, '#3f9b5c'); }], // sun, smiley, heart, notes
  polaroids: [24, (g, x, y, r) => { for (let i = 0; i < 24; i++) F(g, x + i, y + 1 + Math.round(Math.sin(i / 23 * Math.PI) * 2), 1, 1, '#8b8fa3'); for (let k = 0; k < 4; k++) { const px = x + 1 + k * 6, py = y + 3 + Math.round(Math.sin((k * 6 + 3) / 23 * Math.PI) * 2); F(g, px, py, 5, 7, '#fffaf0'); F(g, px + 1, py + 1, 3, 4, pick(r, ['#ff8fab', '#8fd3ff', '#7bd389', '#f2c14e', '#9b72cf'])); F(g, px + 2, py - 1, 1, 2, '#e8505b'); } }], // photos pegged to a string
  cards: [18, (g, x, y, r) => { F(g, x, y + 10, 18, 2, '#6e4029'); for (let k = 0; k < 4; k++) { const c = pick(r, ['#ffc2d1', '#fff3a0', '#bfe3ff', '#b8f0c8']), px = x + 1 + k * 4 + (k > 1), o = k % 2; F(g, px, y + 4 - o, 4, 6 + o, c); F(g, px + 1, y + 6 - o, 1, 1, '#e8505b'); F(g, px + 3, y + 6 - o, 1, 1, '#e8505b'); F(g, px + 1, y + 7 - o, 3, 1, '#e8505b'); F(g, px + 2, y + 8 - o, 1, 1, '#e8505b'); } }], // thank-you cards on a shelf
  mirror: [20, (g, x, y) => { F(g, x, y - 6, 20, 19, '#c9ccd8'); F(g, x + 1, y - 5, 18, 17, '#d6ecfb'); for (let i = 0; i < 5; i++) { F(g, x + 4 + i, y - 3 + i, 1, 1, '#ffffff'); F(g, x + 11 + i, y + 2 + i, 1, 1, '#ffffff'); } }],
  menu: [12, (g, x, y) => { F(g, x, y, 12, 13, '#2b2230'); for (let i = 0; i < 4; i++) F(g, x + 2, y + 2 + i * 3, 4 + (i * 3) % 6, 1, '#fffaf0'); }],
  // the engine room's and the arcade's
  monitors: [49, (g, x, y) => { // a wall of four screens, a planet zooming in from space to a village on it
    F(g, x, y, 49, 13, '#2b2230'); F(g, x + 22, y + 13, 5, 2, '#565a70');
    const scr = (k, draw) => { const sx = x + 1 + k * 12; F(g, sx, y + 2, 11, 9, '#141a2e'); g.save(); g.beginPath(); g.rect(sx, y + 2, 11, 9); g.clip(); draw(sx, y + 2); g.restore(); };
    scr(0, (sx, sy) => { F(g, sx + 1, sy + 1, 1, 1, '#fffaf0'); F(g, sx + 9, sy + 6, 1, 1, '#fffaf0'); disc(g, sx + 5, sy + 4, 2, '#4fa3d5'); F(g, sx + 4, sy + 3, 2, 1, '#7bd389'); });
    scr(1, (sx, sy) => { F(g, sx + 9, sy + 1, 1, 1, '#fffaf0'); disc(g, sx + 5, sy + 4, 4, '#4fa3d5'); F(g, sx + 3, sy + 2, 3, 2, '#7bd389'); F(g, sx + 6, sy + 5, 2, 2, '#7bd389'); F(g, sx + 2, sy + 5, 2, 1, '#fffaf0'); });
    scr(2, (sx, sy) => { disc(g, sx + 5, sy + 15, 13, '#4fa3d5'); disc(g, sx + 3, sy + 13, 9, '#7bd389'); F(g, sx + 6, sy + 4, 3, 1, '#fffaf0'); F(g, sx + 1, sy + 6, 2, 1, '#5cc26a'); });
    scr(3, (sx, sy) => { F(g, sx, sy, 11, 9, '#7bd389'); F(g, sx, sy + 6, 11, 1, '#4fa3d5'); F(g, sx + 2, sy + 2, 4, 2, '#e8505b'); F(g, sx + 2, sy + 4, 4, 2, '#fffaf0'); F(g, sx + 3, sy + 4, 1, 2, '#6e4029'); disc(g, sx + 8, sy + 2, 1, '#3f9b5c'); F(g, sx + 8, sy + 3, 1, 2, '#6e4029'); });
  }],
  blueprint: [16, (g, x, y) => { F(g, x, y + 1, 16, 12, '#34508f'); for (let i = 3; i < 16; i += 4) F(g, x + i, y + 1, 1, 12, '#3f5fa0'); // a wireframe cube on blueprint paper
    for (let i = 0; i < 6; i++) { F(g, x + 3 + i, y + 5, 1, 1, '#fffaf0'); F(g, x + 3 + i, y + 11, 1, 1, '#fffaf0'); F(g, x + 6 + i, y + 3, 1, 1, '#bfe3ff'); } for (let i = 0; i < 7; i++) { F(g, x + 3, y + 5 + i, 1, 1, '#fffaf0'); F(g, x + 9, y + 5 + i, 1, 1, '#fffaf0'); F(g, x + 12, y + 3 + i, 1, 1, '#bfe3ff'); }
    F(g, x + 4, y + 4, 1, 1, '#fffaf0'); F(g, x + 5, y + 3, 1, 1, '#fffaf0'); F(g, x + 10, y + 4, 1, 1, '#fffaf0'); F(g, x + 11, y + 3, 1, 1, '#fffaf0'); F(g, x + 10, y + 10, 1, 1, '#fffaf0'); F(g, x + 11, y + 9, 1, 1, '#fffaf0'); }],
  cabletray: [24, (g, x, y) => { F(g, x, y - 1, 24, 2, '#8b8fa3'); F(g, x, y + 1, 24, 1, '#565a70'); // cables sagging from a tray
    for (const [c, sag, from, to] of [['#e8505b', 7, 1, 13], ['#5b8def', 10, 6, 22], ['#f2c14e', 5, 12, 23], ['#2b2230', 12, 2, 19]]) for (let i = from; i <= to; i++) F(g, x + i, y + 1 + Math.round(Math.sin((i - from) / (to - from) * Math.PI) * sag), 1, 1, c); }],
  // (three on end, narrow enough to hang beside the arcade's neon past its back row, and as high as it, clear of the
  // monitors under them.)
  laptops: [14, (g, x, y, r) => { F(g, x, y + 7, 14, 2, '#6e4029'); F(g, x + 2, y + 9, 1, 2, '#5a3825'); F(g, x + 11, y + 9, 1, 2, '#5a3825'); // a shelf of everyday laptops: closed ones on end, one open
    for (let i = 0; i < 3; i++) { const c = ['#c9ccd8', '#565a70', '#e6e8f0'][i], h = 6 + (i % 2); F(g, x + 1 + i * 2, y + 7 - h, 2, h, c); if (r() < 0.5) F(g, x + 1 + i * 2, y + 3, 1, 1, pick(r, ['#ff8fab', '#ffd966', '#7bd389'])); }
    F(g, x + 7, y + 6, 7, 1, '#c9ccd8'); F(g, x + 8, y, 5, 6, '#8b8fa3'); F(g, x + 9, y + 1, 3, 4, '#8fd3ff'); }],
  // (two rows higher than the rest, so its lower tube clears the monitor of a desk under it; its letters upright on the
  // wall's slant.)
  neon: [20, (g, x, y, r, glass, leds, lit, tops) => { for (const [a, b, w, h] of [[0, 0, 20, 1], [0, 9, 20, 1], [0, 0, 1, 10], [19, 0, 1, 10]]) F(g, x + a, y + b, w, h, '#5ef2ff'); upright(g, 'PLAY', x + 3, y + 2, '#ff8fab', tops); }],
  wreath: [13, (g, x, y) => { for (let k = 0; k < 20; k++) { const a = k / 20 * 6.283, px = x + 6 + Math.round(Math.cos(a) * 5), py = y + 6 + Math.round(Math.sin(a) * 5); F(g, px, py, 2, 2, k % 2 ? '#2f7a47' : '#3f9b5c'); if (k % 5 === 2) F(g, px, py, 1, 1, '#e8505b'); } F(g, x + 4, y + 11, 5, 2, '#e8505b'); F(g, x + 5, y + 13, 1, 2, '#b8404f'); F(g, x + 7, y + 13, 1, 2, '#b8404f'); }], // Christmas: on the stairwell's wall downstairs
};
const KINDS = { // wall art, back-row furniture (from the near end), floor
  office: [['window', 'pixelart', 'board', 'doodles', 'clock', 'window', 'shelf'], ['cabinet', 'cooler', 'copier'], 'wood'],
  boardroom: [['tall', 'portrait', 'tall', 'chart', 'tall'], ['trophy', 'globe'], 'carpet'],
  lab: [['window', 'pegboard', 'doodles', 'window', 'stickies'], ['bench', 'bench'], 'tile'],
  studio: [['window', 'art', 'polaroids', 'art', 'window'], ['speaker', 'easel'], 'wood'],
  mailroom: [['pigeon', 'window', 'cards', 'clock', 'pigeon'], ['sorter', 'parcels'], 'wood'],
  dock: [['hazard', 'window', 'clock'], ['conveyor', 'pallet'], 'concrete'],
  vault: [['vaultdoor', 'deposit', 'clock'], ['gold', 'piggy', 'sacks'], 'vault'],
  archive: [['binders', 'window', 'pixelart', 'clock', 'binders'], ['cabinet', 'cabinet'], 'wood'],
  server: [['screen', 'vent', 'pixelart', 'screen'], [], 'metal'],
  review: [['pinboard', 'window', 'cctv', 'doodles', 'board'], ['cabinet'], 'carpet'],
  lobby: [['window', 'plaque', 'clock', 'window', 'portrait'], [], 'check'],
  library: [['window', 'shelf', 'window'], ['bookcase', 'bookcase', 'bookcase'], 'wood'],
  lounge: [['window', 'menu', 'polaroids', 'window', 'poster'], ['coffee', 'record', 'fridge', 'vending'], 'tile'], // Coffee first: it fits beside the sofa in every lounge (people go there for a cup)
  nook: [['window', 'art', 'pixelart', 'window'], ['bookcase', 'cooler'], 'wood'],
  core: [[], [], 'core'],
  terrace: [[], [], 'deck'],
  storage: [['vent', 'hazard', 'clock', 'vent'], ['pallet', 'cabinet', 'sacks', 'pallet', 'parcels', 'cabinet'], 'concrete'],
  gym: [['window', 'mirror', 'clock', 'mirror', 'window', 'poster'], ['treadmill', 'weights', 'bike', 'treadmill', 'cooler'], 'rubber'],
  canteen: [['window', 'menu', 'clock', 'window', 'polaroids'], ['counter', 'coffee', 'fridge', 'counter', 'vending'], 'tile'],
  booth: [['onair'], ['airrack', 'micdesk'], 'plush'], // (the foam is its wall's paper)
  darkroom: [[], ['sweep', 'darkbench'], 'quarry'], // (the photo studio: darkroom.js draws its walls' things.)
  engine: [['monitors', 'blueprint', 'cabletray', 'window', 'clock'], ['renderfarm', 'testrig'], 'metal'],
  arcade: [['neon', 'laptops'], ['arcadecab', 'arcadecab', 'tvset', 'timeboard'], 'confetti'], // (in a row from the neon on, past the back row: layout.js arcadeWall.)
  meeting: [['window'], [], 'wood'], // (one, between its door sign and its board: buildRoom. Its table, board and door sign: meetingRoom.)
  bar: [[], ['record'], 'wood'], // (its wall's things are the back bar's and the sign: bar() draws them.)
};

// ---- helpers: a room-local frame so furniture code works on either wing ----
// a: distance along the wing from the room's near end. d: distance from the back wall.
const foot = (p, q) => ({ x0: Math.min(p.x, q.x), y0: Math.min(p.y, q.y), x1: Math.max(p.x, q.x), y1: Math.max(p.y, q.y) });
function frame(room) {
  const X = room.wing !== 'y';
  const W = (a, d) => X ? [room.x0 + a, d] : [d, room.y0 + a];
  return {
    X, len: X ? room.x1 - room.x0 : room.y1 - room.y0, depth: X ? room.y1 : room.x1, z: room.z,
    pt: (a, d) => { const [x, y] = W(a, d); return { x, y }; },
    box(g, a0, d0, a1, d1, z0, z1, c) { const [x0, y0] = W(a0, d0), [x1, y1] = W(a1, d1); box(g, Math.min(x0, x1), Math.min(y0, y1), room.z + z0, Math.max(x0, x1), Math.max(y0, y1), room.z + z1, c); },
    top(g, a0, d0, a1, d1, z, c) { const [x0, y0] = W(a0, d0), [x1, y1] = W(a1, d1); top(g, Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), room.z + z, c); },
    // a face at depth d looking into the room
    face(g, a0, a1, d, z0, z1, c) { X ? wallY(g, room.x0 + a0, room.x0 + a1, d, room.z + z0, room.z + z1, c) : wallX(g, room.y0 + a0, room.y0 + a1, d, room.z + z0, room.z + z1, c); },
    // shear a flat drawing onto that face (flat column 0 = screen-left)
    flat(g, img, a0, a1, d, zb) { X ? onWallY(g, img, room.x0 + a0, d, room.z + zb) : onWallX(g, img, room.y0 + a1, d, room.z + zb); },
    // where each column of such a drawing, w × h px, lands on screen: [x, the y of its top row]
    cols: (a0, a1, d, zb, w, h) => Array.from({ length: w }, (_, u) => X ? wallYCol(room.x0 + a0, d, room.z + zb, h, u) : wallXCol(room.y0 + a1, d, room.z + zb, h, u)),
    // a screen point
    s: (a, d, z = 0) => { const [x, y] = W(a, d); return [SX(x, y), SY(x, y, room.z + z)]; },
    // a depth-sorted prop over [a0,a1]×[d0,d1], z1 px tall, drawn in world coordinates. at: the depth
    // (d) it sorts at, if not its middle. foot: the part people can't walk through ([a0,d0,a1,d1]), or false
    prop(props, name, a0, d0, a1, d1, z1, draw, { at, foot: ft } = {}) {
      const box2 = (p, q, r2, s2) => { const u = this.pt(p, q), v = this.pt(r2, s2); return foot(u, v); };
      const b = box2(a0, d0, a1, d1), s = sprite(b.x0, b.y0, b.x1, b.y1, room.z, room.z + z1, draw), c = this.pt((a0 + a1) / 2, at ?? (d0 + d1) / 2);
      props.push({ ...s, depth: c.x + c.y, name, foot: ft === false ? null : ft ? box2(...ft) : b });
    },
  };
}
// a depth-sorted prop in world coordinates (no footprint: people pass it, they don't walk through it)
function worldProp(props, name, depth, x0, y0, x1, y1, z0, z1, draw) { props.push({ ...sprite(x0, y0, x1, y1, z0, z1, draw), depth, name }); }
function flatCanvas(w, h, draw) { const c = canvas(Math.max(1, w), h); draw(c.getContext('2d'), c); return c; }

// the middle of the booth's desk along its wall, in tiles: after the rack (KINDS.booth: 0.1 + 0.7, then 1 more)
const BOOTH_DESK = 1.8;

// ---- floors ----
function floor(g, room, kind, wall, fl) {
  const { x0, y0, x1, y1, z } = room, r = rng(room.id + 'f');
  top(g, x0, y0, x1, y1, z, fl);
  const seam = mix(fl, INK, 0.16), hi = mix(fl, '#ffffff', 0.12);
  const tiles = (a, b) => { for (let x = Math.floor(x0); x < x1; x++) for (let y = Math.floor(y0); y < y1; y++) if ((x + y) % 2) top(g, x, y, x + 1, y + 1, z, a); else if (b) top(g, x, y, x + 1, y + 1, z, b); };
  if (kind === 'wood' || kind === 'deck') {
    const along = room.wing === 'y';
    for (let k = 0; k < (along ? x1 - x0 : y1 - y0) * 3; k++) {
      const u = k / 3;
      along ? top(g, x0 + u, y0, x0 + u + 1 / 32, y1, z, seam) : top(g, x0, y0 + u, x1, y0 + u + 1 / 32, z, seam);
      for (let v = (k % 2) * 0.7; v < (along ? y1 - y0 : x1 - x0); v += 1.4) along ? top(g, x0 + u, y0 + v, x0 + u + 1 / 3, y0 + v + 1 / 32, z, seam) : top(g, x0 + v, y0 + u, x0 + v + 1 / 32, y0 + u + 1 / 3, z, seam);
    }
    if (kind === 'wood') for (let i = 0; i < 12; i++) { const x = x0 + r() * (x1 - x0), y = y0 + r() * (y1 - y0); top(g, x, y, x + 0.12, y + 0.03, z, hi); }
  } else if (kind === 'tile') tiles(mix(fl, INK, 0.05));
  else if (kind === 'check') tiles('#c9ccd8', '#fffaf0');
  else if (kind === 'vault') tiles(mix(fl, INK, 0.12));
  else if (kind === 'core') {
    tiles(mix(fl, '#ffffff', 0.35));
    if (room.level === 0) { top(g, ENTRANCE - 0.45, CORE - 0.38, ENTRANCE + 0.45, CORE - 0.04, z, '#c9a27a'); top(g, ENTRANCE - 0.38, CORE - 0.32, ENTRANCE + 0.38, CORE - 0.1, z, '#a8693f'); } // the doormat, just inside the front door
  }
  else if (kind === 'carpet') { top(g, x0 + 0.3, y0 + 0.3, x1 - 0.3, y1 - 0.3, z, mix(fl, '#ffd966', 0.15)); top(g, x0 + 0.4, y0 + 0.4, x1 - 0.4, y1 - 0.4, z, fl); }
  // (plush and quarry)
  else if (kind === 'plush') { // the booth's carpet tiles, their pile laid crosswise on every other one, flecked
    tiles(mix(fl, '#ffffff', 0.05));
    for (let i = 0; i < (x1 - x0) * (y1 - y0) * 14; i++) { const x = x0 + r() * (x1 - x0), y = y0 + r() * (y1 - y0); F(g, Math.round(SX(x, y)), Math.round(SY(x, y, z)), 2, 1, r() < 0.6 ? seam : hi); }
  }
  else if (kind === 'quarry') { // the darkroom's: small glazed tiles in dark grout, a few a shade off, a drain in one
    top(g, x0, y0, x1, y1, z, mix(fl, INK, 0.2));
    // px: one pixel along a tile's edge, the grout's width. The drain's tile: the one under a spot past the middle of the room
    const F_ = frame(room), spot = F_.pt(F_.len * 0.55, F_.depth * 0.62), px = 1 / 16, drainX = x0 + Math.floor((spot.x - x0) * 2) / 2, drainY = y0 + Math.floor((spot.y - y0) * 2) / 2;
    for (let x = x0; x < x1 - 0.1; x += 0.5) for (let y = y0; y < y1 - 0.1; y += 0.5) {
      const c = r() < 0.12 ? mix(fl, '#ffffff', 0.05) : (Math.round((x + y) * 2) % 2 ? mix(fl, INK, 0.04) : fl), tileX1 = Math.min(x + 0.5, x1) - px, tileY1 = Math.min(y + 0.5, y1) - px;
      if (x === drainX && y === drainY) { // the drain: a square grate over the tile and its near grout, a dark frame round 5 px of grey, two slots across it with a bar between
        top(g, x, y, tileX1, tileY1, z, '#2b2740');
        top(g, x + px, y + px, tileX1 - px, tileY1 - px, z, '#565a70');
        for (const k of [2, 4]) top(g, x + k * px, y + 2 * px, x + (k + 1) * px, tileY1 - 2 * px, z, '#2b2740');
        continue;
      }
      top(g, x + px, y + px, tileX1, tileY1, z, c);
      top(g, x + px, y + px, tileX1, y + 2 * px, z, mix(c, '#ffffff', 0.06)); // its glaze catching the light
    }
  }
  else if (kind === 'confetti') { // arcade carpet: its bits muted into the floor, none at its edges
    const m = 0.2, cols = ['#5ef2ff', '#ff5c8a', '#ffd966', '#7bd389', '#9b72cf'].map(c => mix(c, fl, 0.4));
    for (let i = 0; i < (x1 - x0) * (y1 - y0) * 4; i++) { const x = x0 + m + r() * (x1 - x0 - 2 * m - 0.07), y = y0 + m + r() * (y1 - y0 - 2 * m - 0.07); top(g, x, y, x + 0.07, y + 0.07, z, pick(r, cols)); }
  }
  else if (kind === 'metal') { for (let x = Math.floor(x0); x < x1; x++) for (let y = Math.floor(y0); y < y1; y++) { top(g, x + 0.05, y + 0.05, x + 0.95, y + 0.95, z, mix(fl, '#ffffff', 0.06)); top(g, x + 0.45, y + 0.45, x + 0.55, y + 0.55, z, seam); } }
  else { for (let i = 0; i < 40; i++) { const x = x0 + r() * (x1 - x0), y = y0 + r() * (y1 - y0); top(g, x, y, x + 0.05, y + 0.05, z, r() < 0.5 ? seam : hi); } }
}

// ---- the back wall of a room, flat, then sheared into place ----
function backWall(g, gm, room, F_, H, spec) {
  const [wallC, trim] = theme(room.kind), w = Math.round(F_.len * 16), r = rng(room.id + 'w');
  const glassRects = [], litFlat = spec.lit && canvas(w, H), tops = Array.from({ length: w }, (_, u) => (F_.X ? wallYCol(room.x0, room.y0, room.z, H, u) : wallXCol(room.y1, room.x0, room.z, H, u))[1]);
  const flat = flatCanvas(w, H, (f) => {
    F(f, 0, 0, w, H, wallC);
    if (spec.paper === 'stripes') for (let i = 3; i < w; i += 6) F(f, i, 0, 2, H - 10, mix(wallC, '#ffffff', 0.08));
    if (spec.paper === 'panels') for (let i = 4; i < w; i += 8) F(f, i, 0, 1, H - 10, mix(wallC, INK, 0.15));
    if (spec.paper === 'foam') { // the booth's: wedge foam tiles, their ridges turned a quarter on every other one
      const base = mix(wallC, INK, 0.3), ridge = mix(wallC, '#ffffff', 0.06), groove = mix(wallC, INK, 0.5);
      for (let ty = 2; ty + 8 <= H - 11; ty += 9) for (let tx = 1, k = ty / 9 | 0; tx + 8 <= w; tx += 9, k++) {
        F(f, tx, ty, 8, 8, base);
        for (let q = 0; q < 8; q += 2) for (const [dq, c] of [[0, ridge], [1, groove]]) if (k % 2) F(f, tx + q + dq, ty, 1, 8, c); else F(f, tx, ty + q + dq, 8, 1, c);
      }
    }
    if (spec.paper === 'brick') for (let y = 0; y < H - 10; y += 4) { F(f, 0, y, w, 1, mix(wallC, INK, 0.12)); for (let x = (y / 4) % 2 ? 2 : 6; x < w; x += 8) F(f, x, y + 1, 1, 3, mix(wallC, INK, 0.12)); }
    if (!spec.parapet) { F(f, 0, H - 10, w, 10, trim); F(f, 0, H - 10, w, 1, mix(trim, INK, 0.25)); F(f, 0, H - 2, w, 2, mix(trim, INK, 0.35)); }
    else { F(f, 0, 0, w, 2, '#c9ccd8'); F(f, 0, H - 1, w, 1, mix(wallC, INK, 0.3)); }
    // wall art spread along the wall, an empty room's notice first. The notice keeps the floor in front of it clear of the
    // back row (space: furnish steps past it), and the row's depth on past its end, as what stands d out from the wall hides
    // it d nearer the room's start: no cabinet or plant stands in front of it. It
    // keeps clear of what stands further out (hidden: wallHidden)
    const items = spec.notice ? [spec.notice, ...spec.items] : spec.items.slice();
    let cx = spec.at ?? (spec.start ?? 6) + (r() * 6 | 0), i = 0, from = 2; // (at: exactly there. once: each item once, not round again. from: where the art so far ends)
    const band = H - 30 - (spec.high || 0);
    const put = (name, x) => WALL[name][1](f, x, band, r, (x, y, gw, gh) => glassRects.push([x, y, gw, gh]), spec.leds && ((x, y, o) => spec.leds.push({ ...F_.pt(x / 16, 0), z: room.z + H - y, c: '#ffb35a', ...o })), // (a light on flat pixel (x, y) of an X wall, once its screen point is rounded)
      litFlat && ((x, y, paint) => { paint(litFlat.getContext('2d')); spec.lit.glow = { ...F_.pt(F_.X ? x / 16 : F_.len - x / 16, 0), z: room.z + H - y }; }), // (what lights up on air, its glow at flat pixel (x, y))
      tops); // (the screen row each of the wall's columns lands on, for words upright on it.)
    for (const [name, x] of spec.pins ?? []) put(name, x); // (pins: [name, flat x], each exactly there.)
    while (items.length && i < (spec.once ? items.length : 30)) {
      const name = items[i % items.length];
      i++;
      const [iw] = WALL[name];
      if (name === spec.notice) { const at = spec.hidden.map(h => clearOf(h, F_, cx, iw, from, w - 4)).find(u => u !== null); if (at === undefined) throw new Error(`room ${room.id}: its ${F_.len}-tile back wall has nowhere for its notice`); cx = at; }
      if (cx + iw > w - 4) break;
      if (name === spec.notice) spec.space.take(F_.X ? cx / 16 : F_.len - (cx + iw) / 16, 0, (F_.X ? (cx + iw) / 16 : F_.len - cx / 16) + BACK, BACK);
      put(name, cx);
      from = cx + iw + 2;
      cx += iw + 6 + (r() * 8 | 0);
    }
    if (spec.string) wallString(f, room, F_, H, w, wallC, spec);
  });
  const mask = glassRects.length ? flatCanvas(w, H, f => glassRects.forEach(([x, y, gw, gh]) => F(f, x, y, gw, gh, '#fff'))) : null;
  if (F_.X) { onWallY(g, flat, room.x0, room.y0, room.z); if (mask) onWallY(gm, mask, room.x0, room.y0, room.z); }
  else { onWallX(g, flat, room.y1, room.x0, room.z); if (mask) onWallX(gm, mask, room.y1, room.x0, room.z); }
  if (spec.lit?.glow) { if (F_.X) onWallY(spec.lit.g, litFlat, room.x0, room.y0, room.z); else onWallX(spec.lit.g, litFlat, room.y1, room.x0, room.z); }
  return !!mask;
}

// a string just under the ceiling's edge of a back wall's flat f (all that shows above the art): flags, or little bulbs
// that glow after dark (out of backWall for its size)
function wallString(f, room, F_, H, w, wallC, spec) {
  const yb = H - 33, sag = i => yb + Math.round(Math.sin((i % 40) / 40 * Math.PI) * 3), cols = spec.string === 'bunting' ? ['#e8505b', '#ffd966', '#5b8def', '#7bd389', '#ff8fab'] : spec.christmas ? ['#e8505b', '#7bd389', '#ffd966', '#fffaf0'] : ['#fff3b0', '#ffc2d1', '#bfe3ff', '#ffd966'];
  for (let i = 0; i < w; i++) F(f, i, sag(i), 1, 1, mix(wallC, INK, 0.45));
  for (let i = 3, k = 0; i < w - 3; i += spec.string === 'bunting' ? 6 : 5, k++) {
    const y = sag(i) + 1, c = cols[k % cols.length];
    if (spec.string === 'bunting') { F(f, i - 1, y, 4, 1, c); F(f, i, y + 1, 2, 1, c); F(f, i, y + 2, 1, 1, c); }
    else { F(f, i, y, 1, 1, mix(wallC, INK, 0.45)); F(f, i, y + 1, 1, 2, c); spec.bulbs?.push({ ...F_.pt(F_.X ? (i + 0.5) / 16 : F_.len - (i + 0.5) / 16, 0.03), z: room.z + H - 2 - y }); }
  }
}

// glass partition on the room's near side, with a low sill and a doorway at the front
function partition(g, room, H, solid) {
  const X = room.wing !== 'y', d1 = partitionDepth(room), z = room.z, frameC = '#fdf3e1';
  const plane = (a0, a1, z0, z1, c) => X ? wallX(g, a0, a1, room.x0, z + z0, z + z1, c) : wallY(g, a0, a1, room.y0, z + z0, z + z1, c);
  if (solid) { plane(0, d1, 0, H, solid); return; }
  plane(0, d1, 0, 7, theme(room.kind)[1]);
  plane(0, d1, 6, 7, mix(theme(room.kind)[1], '#ffffff', 0.3));
  // towards the core only a low rail and a post: glass there would wash out the stair and the lift behind it
  if ((X ? room.x0 : room.y0) <= (X ? room.lv.Cx : room.lv.Cy)) { plane(d1 - 0.07, d1, 0, H, frameC); return; }
  g.globalAlpha = 0.22; plane(0, d1, 7, H, '#bfe6ff'); g.globalAlpha = 0.35;
  plane(d1 * 0.3, d1 * 0.3 + 0.12, 12, H, '#ffffff'); plane(d1 * 0.36, d1 * 0.36 + 0.05, 12, H, '#ffffff');
  g.globalAlpha = 1;
  plane(d1 - 0.07, d1, 0, H, frameC); plane(d1 / 2 - 0.03, d1 / 2 + 0.03, 7, H, frameC); plane(0, d1, 30, 31, frameC);
}

// ---- reserved space: walkways and seats first, then furniture and decor only where it's free ----
// Rectangles in the room's (a, d) frame. Walkways (the lane, doorways, the way to a seat) may cross each
// other, and nothing may stand on them. Solid ones (furniture, the spot a person stands or sits on) exclude all.
function space() {
  const taken = [];
  const hit = (a0, d0, a1, d1, solidOnly) => taken.some(([p0, q0, p1, q1, solid]) => (solid || !solidOnly) && a0 < p1 && a1 > p0 && d0 < q1 && d1 > q0);
  return {
    take(a0, d0, a1, d1, walk = false) { taken.push([a0, d0, a1, d1, !walk]); },
    free: (a0, d0, a1, d1) => !hit(a0, d0, a1, d1, false),  // nothing reserved here at all
    clear: (a0, d0, a1, d1) => !hit(a0, d0, a1, d1, true),  // nothing solid in the way: fine to walk through
  };
}
const R_STAND = 0.22; // half the width of a standing or seated person, in tiles
// a spot someone stands or sits on, and the way to it from the lane
function reserveSpot(sp, room, a, d) { sp.take(a - R_STAND, d - R_STAND, a + R_STAND, d + R_STAND); sp.take(a - R_STAND, d, a + R_STAND, room.lv.lane, true); }
const spotFree = (sp, room, a, d) => sp.free(a - R_STAND, d - R_STAND, a + R_STAND, d + R_STAND) && sp.clear(a - R_STAND, d, a + R_STAND, room.lv.lane);
const BACK = 0.62; // how far back-row furniture comes out from the wall

// The rig's case by its size (world.js rigSize): half its width along the wall, its depth and its glass front in pixels
const RIG = {
  1: { half: 0.26, d0: 0.15, d1: 0.5, w: 9, h: 30 },
  2: { half: 0.34, d0: 0.08, d1: 0.55, w: 11, h: 38 },
  3: { half: 0.42, d0: 0.05, d1: 0.6, w: 13, h: 38 },
};
// ---- furniture (local coords): each returns how much of the back row it takes ----
function furniture(ctx, name, a, room, F_) {
  const { g, props, anchors } = ctx, [, trim] = theme(room.kind), r = rng(room.id + name + a);
  const face = (a0, a1, d, zb, w, h, drawFlat) => F_.flat(g, flatCanvas(w, h, drawFlat), a0, a1, d, zb);
  switch (name) {
    case 'cabinet': F_.box(g, a + 0.15, 0.05, a + 0.85, 0.5, 0, 26, '#8b8fa3');
      face(a + 0.15, a + 0.85, 0.5, 0, 11, 26, f => { for (let i = 0; i < 4; i++) { F(f, 1, 1 + i * 6, 9, 5, '#c9ccd8'); F(f, 4, 3 + i * 6, 3, 1, INK); } }); return 1;
    case 'cooler': F_.box(g, a + 0.3, 0.1, a + 0.7, 0.45, 0, 14, '#f6f1e6'); F_.box(g, a + 0.36, 0.16, a + 0.64, 0.4, 14, 22, '#8fd3ff'); return 1;
    case 'copier': F_.box(g, a + 0.12, 0.08, a + 0.88, 0.62, 0, 13, '#c9ccd8'); F_.box(g, a + 0.2, 0.12, a + 0.8, 0.5, 13, 15, '#8b8fa3'); anchors.leds.push({ ...F_.pt(a + 0.7, 0.62), z: room.z + 10, c: '#7bd389', slow: 1 }); return 1;
    case 'bookcase': F_.box(g, a + 0.06, 0.04, a + 0.94, 0.42, 0, 36, '#5a3825');
      face(a + 0.06, a + 0.94, 0.42, 0, 14, 36, f => { F(f, 0, 0, 14, 36, '#4a2c1c'); for (let s = 0; s < 4; s++) { F(f, 0, 8 + s * 9, 14, 1, '#6e4029'); for (let i = 1; i < 13; i += 2) if (r() < 0.9) F(f, i, 2 + s * 9 + (r() * 2 | 0), 1 + (r() < 0.3), 6 - (r() * 2 | 0), pick(r, BOOKS)); } }); return 1;
    case 'coffee': { // A narrow counter (0.7), so even a 3-tile lounge has room for it next to the sofa
      if (!spotFree(ctx.space, room, a + 0.3, 0.95)) return 0;
      F_.box(g, a + 0.05, 0.05, a + 0.65, 0.6, 0, 12, trim); F_.box(g, a + 0.08, 0.1, a + 0.41, 0.4, 12, 25, '#2b2230'); F_.box(g, a + 0.14, 0.4, a + 0.36, 0.46, 18, 20, '#e8505b');
      F_.box(g, a + 0.46, 0.14, a + 0.56, 0.24, 12, 15, '#f6f1e6'); F_.box(g, a + 0.48, 0.34, a + 0.58, 0.44, 12, 15, '#ffb86b');
      reserveSpot(ctx.space, room, a + 0.3, 0.95);
      anchors.coffee.push({ ...F_.pt(a + 0.3, 0.95), level: room.level, right: F_.X, steam: { ...F_.pt(a + 0.24, 0.3), z: room.z + 26 } }); return 0.7;
    }
    case 'fridge': F_.box(g, a + 0.12, 0.05, a + 0.88, 0.55, 0, 32, '#e6e8f0'); face(a + 0.12, a + 0.88, 0.55, 0, 12, 32, f => { F(f, 0, 11, 12, 1, '#8b8fa3'); F(f, 9, 3, 1, 5, '#8b8fa3'); F(f, 9, 14, 1, 6, '#8b8fa3'); F(f, 2, 4, 3, 3, '#ffd966'); }); return 1;
    case 'vending': F_.box(g, a + 0.1, 0.05, a + 0.9, 0.55, 0, 32, '#e8505b'); face(a + 0.1, a + 0.9, 0.55, 0, 13, 32, f => { F(f, 1, 3, 8, 22, '#bfe6ff'); for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) F(f, 2 + j * 2 + (j > 0), 5 + i * 4, 1, 2, pick(r, BOOKS)); F(f, 10, 8, 2, 4, '#2b2230'); F(f, 1, 27, 8, 3, '#2b2230'); });
      anchors.glows.push({ ...F_.pt(a + 0.5, 0.7), z: room.z + 16, c: '#8fd3ff', r: 14 }); return 1;
    case 'bench': F_.box(g, a + 0.05, 0.05, a + 0.95, 0.6, 0, 11, '#e6e8f0');
      for (let i = 0; i < 4; i++) { const c = pick(r, ['#7bd389', '#ff8fab', '#8fd3ff', '#f2c14e']), u = a + 0.15 + i * 0.2; F_.box(g, u, 0.2, u + 0.1, 0.3, 11, 17, '#e6f4ff'); F_.box(g, u, 0.2, u + 0.1, 0.3, 11, 14, c); } return 1;
    case 'speaker': F_.box(g, a + 0.25, 0.08, a + 0.65, 0.4, 0, 22, '#2b2230'); face(a + 0.25, a + 0.65, 0.4, 0, 7, 22, f => { disc(f, 3, 15, 2, '#565a70'); disc(f, 3, 6, 1, '#565a70'); }); anchors.notes.push({ ...F_.pt(a + 0.45, 0.3), z: room.z + 24 }); return 1;
    case 'easel': F_.prop(props, 'easel', a + 0.2, 0.3, a + 0.8, 0.5, 30, g2 => { F_.box(g2, a + 0.47, 0.34, a + 0.53, 0.4, 0, 28, '#6e4029'); F_.box(g2, a + 0.2, 0.42, a + 0.8, 0.46, 10, 26, '#fffaf0'); for (let i = 0; i < 5; i++) { const u = a + 0.25 + r() * 0.45; F_.box(g2, u, 0.46, u + 0.07, 0.47, 12 + r() * 12, 15 + r() * 10, pick(r, BOOKS)); } }); return 1;
    case 'sorter': F_.box(g, a + 0.05, 0.05, a + 0.95, 0.5, 0, 16, '#a8693f'); for (let i = 0; i < 4; i++) F_.box(g, a + 0.12 + i * 0.2, 0.15, a + 0.26 + i * 0.2, 0.35, 16, 19 + (i % 2) * 2, pick(r, ['#fffaf0', '#f6e7c1', '#bfe3ff'])); return 1;
    case 'parcels': case 'pallet': F_.box(g, a + 0.05, 0.05, a + 0.95, 0.75, 0, 3, '#a8693f');
      for (let i = 0; i < 4; i++) { const u = a + 0.1 + (i % 2) * 0.42, d = 0.1 + (i >> 1) * 0.3; F_.box(g, u, d, u + 0.38, d + 0.28, 3, 10, i % 3 ? '#cf9460' : '#b07a4f'); }
      F_.box(g, a + 0.3, 0.2, a + 0.65, 0.45, 10, 16, '#cf9460'); return 1;
    case 'conveyor': F_.box(g, a + 0.02, 0.15, a + 1.9, 0.6, 0, 9, '#565a70'); F_.top(g, a + 0.02, 0.2, a + 1.9, 0.55, 9, '#2b2230');
      for (let u = a + 0.1; u < a + 1.9; u += 0.25) F_.top(g, u, 0.2, u + 0.04, 0.55, 9, '#8b8fa3');
      anchors.belts.push({ a0: a + 0.05, a1: a + 1.85, d: 0.37, z: room.z + 9, F: F_ }); return 2;
    case 'gold': for (let i = 0; i < 6; i++) { const u = a + 0.12 + (i % 3) * 0.26, d = 0.15 + (i > 2) * 0.22; F_.box(g, u, d, u + 0.22, d + 0.14, (i === 5) * 5, 5 + (i === 5) * 5, ['#ffe89a', '#ffd966', '#d9a441']); } anchors.glints.push({ ...F_.pt(a + 0.5, 0.3), z: room.z + 8 }); return 1;
    case 'sacks': for (let i = 0; i < 3; i++) { const p = F_.s(a + 0.25 + i * 0.25, 0.3 + (i % 2) * 0.2); ellipse(g, p[0], p[1] - 4, 4, 4, '#b8a07a'); F(g, p[0] - 1, p[1] - 10, 2, 2, '#8b6a44'); text(g, '$', p[0] - 1, p[1] - 7, '#5a3825'); } return 1;
    case 'globe': F_.prop(props, 'globe', a + 0.3, 0.3, a + 0.7, 0.7, 20, g2 => { const p = F_.s(a + 0.5, 0.5); F(g2, p[0] - 1, p[1] - 10, 2, 10, '#6e4029'); F(g2, p[0] - 3, p[1] - 1, 6, 1, '#6e4029'); disc(g2, p[0], p[1] - 14, 4, '#5b8def'); F(g2, p[0] - 2, p[1] - 16, 3, 2, '#7bd389'); F(g2, p[0], p[1] - 13, 2, 2, '#7bd389'); }); return 1;
    case 'trophy': F_.box(g, a + 0.1, 0.05, a + 0.9, 0.45, 0, 28, '#6e4029'); face(a + 0.1, a + 0.9, 0.45, 0, 13, 28, f => { F(f, 1, 2, 11, 12, '#2c3862'); F(f, 5, 4, 3, 4, '#ffd966'); F(f, 6, 8, 1, 3, '#ffd966'); F(f, 5, 11, 3, 1, '#ffd966'); F(f, 1, 16, 11, 10, '#5a3825'); }); return 1;
    case 'record': { // a record player on a little cabinet, playing to the room
      F_.box(g, a + 0.05, 0.05, a + 0.65, 0.5, 0, 12, ['#cf9460', '#a8693f', '#6e4029']); F_.face(g, a + 0.12, a + 0.58, 0.5, 3, 4, '#5a3825');
      F_.box(g, a + 0.1, 0.1, a + 0.6, 0.45, 12, 14, '#3b3355'); const [sx, sy] = F_.s(a + 0.3, 0.27, 14); ellipse(g, sx, sy, 5, 2, '#1d1a2f'); F(g, sx - 1, sy - 1, 2, 1, '#e8505b'); F(g, sx + 4, sy - 4, 1, 3, '#c9ccd8'); F(g, sx + 2, sy - 1, 2, 1, '#c9ccd8');
      for (let i = 0; i < 3; i++) F_.box(g, a + 0.62 + i * 0.03, 0.12, a + 0.64 + i * 0.03, 0.42, 0, 9, ['#e8505b', '#5b8def', '#ffd966'][i]); // records leaning on it
      anchors.records.push({ ...F_.pt(a + 0.3, 0.27), z: room.z + 18 }); return 0.7;
    }
    case 'piggy': { // a piggy bank on a little plinth
      F_.box(g, a + 0.15, 0.15, a + 0.55, 0.5, 0, 8, ['#8b8a60', '#6d7560', '#4f5a4a']); const [sx, sy] = F_.s(a + 0.35, 0.32, 8);
      ellipse(g, sx, sy - 4, 5, 3, '#ff8fab'); F(g, sx - 3, sy - 6, 3, 1, '#ffb3c6'); F(g, sx + 4, sy - 5, 2, 2, '#ff6f96'); F(g, sx - 3, sy - 8, 2, 2, '#ff8fab'); F(g, sx + 1, sy - 5, 1, 1, INK); F(g, sx - 1, sy - 8, 3, 1, '#5a3825');
      F(g, sx - 3, sy - 1, 1, 1, '#ff6f96'); F(g, sx + 2, sy - 1, 1, 1, '#ff6f96'); anchors.glints.push({ ...F_.pt(a + 0.35, 0.32), z: room.z + 16 }); return 0.7;
    }
    case 'treadmill': { // the belt runs towards the room, its handlebars and console at the wall end
      F_.box(g, a + 0.2, 0.08, a + 0.8, 0.95, 0, 4, '#3b3355'); F_.top(g, a + 0.28, 0.2, a + 0.72, 0.92, 4, '#23283f');
      F_.box(g, a + 0.2, 0.08, a + 0.26, 0.16, 4, 20, '#8b8fa3'); F_.box(g, a + 0.74, 0.08, a + 0.8, 0.16, 4, 20, '#8b8fa3');
      F_.box(g, a + 0.24, 0.06, a + 0.76, 0.18, 20, 24, '#3b3355'); anchors.leds.push({ ...F_.pt(a + 0.5, 0.18), z: room.z + 22, c: '#7bd389', slow: 1 });
      return 1;
    }
    case 'weights': // a rack of dumbbells, small to big
      F_.box(g, a + 0.08, 0.08, a + 0.92, 0.45, 0, 12, '#565a70'); F_.box(g, a + 0.08, 0.08, a + 0.92, 0.2, 12, 20, '#565a70');
      for (let i = 0; i < 5; i++) { const u = a + 0.14 + i * 0.16, s = 0.04 + i * 0.008; F_.box(g, u, 0.24 - s, u + 0.1, 0.24 + s, 12, 14 + i * 0.6, '#2b2230'); F_.box(g, u, 0.1 - s, u + 0.1, 0.1 + s, 20, 22 + i * 0.6, '#2b2230'); }
      return 1;
    case 'bike': // an exercise bike: the flywheel at the front, the saddle over it
      F_.box(g, a + 0.3, 0.15, a + 0.7, 0.75, 0, 3, '#3b3355'); F_.box(g, a + 0.44, 0.18, a + 0.56, 0.34, 3, 13, '#e8505b');
      F_.box(g, a + 0.46, 0.5, a + 0.54, 0.58, 3, 14, '#8b8fa3'); F_.box(g, a + 0.4, 0.46, a + 0.6, 0.66, 14, 16, '#2b2230');
      F_.box(g, a + 0.36, 0.14, a + 0.64, 0.2, 18, 20, '#8b8fa3');
      return 1;
    case 'counter': { // the canteen's serving counter: trays of the day's food under a glass sneeze guard
      F_.box(g, a + 0.04, 0.05, a + 0.96, 0.6, 0, 12, [mix(trim, '#ffffff', 0.3), trim, mix(trim, INK, 0.3)]);
      for (let i = 0; i < 3; i++) F_.box(g, a + 0.1 + i * 0.28, 0.15, a + 0.34 + i * 0.28, 0.45, 12, 13, pick(r, ['#7bd389', '#e8505b', '#ffd966', '#c98a3e', '#ff8fab']));
      g.globalAlpha = 0.35; F_.box(g, a + 0.06, 0.4, a + 0.94, 0.46, 13, 22, '#bfe6ff'); g.globalAlpha = 1;
      return 1;
    }
    case 'rack': {
      const eng = ctx.engine, col = eng === 'codex' ? '#5cc26a' : '#ff9b4a';
      F_.box(g, a + 0.1, 0.05, a + 0.9, 0.5, 0, 38, '#141a2e');
      face(a + 0.1, a + 0.9, 0.5, 0, 13, 38, f => { F(f, 0, 0, 13, 38, '#1b2238'); F(f, 1, 2, 11, 5, col); text(f, eng.slice(0, 2), 2, 2, '#141a2e'); for (let i = 0; i < 6; i++) F(f, 1, 10 + i * 4, 11, 3, '#2b3148'); });
      for (let k = 0; k < 12; k++) anchors.leds.push({ ...F_.pt(a + 0.2 + (k % 2) * 0.45, 0.5), z: room.z + 27 - (k >> 1) * 4, eng, k, c: eng === 'codex' ? '#7bff9a' : '#ffb35a' });
      anchors.sparks.push({ ...F_.pt(a + 0.5, 0.55), z: room.z + 20 });
      return 1;
    }
    case 'micdesk': { // the booth's desk: two mics on stands behind pop filters, headphones, the script, mugs, a small mixer
      // (the stands, filters, script and mugs, all under the wall's ON AIR sign)
      F_.box(g, a + 0.05, 0.05, a + 1.95, 0.6, 0, 12, [mix(trim, '#ffffff', 0.2), '#6e4029', '#5a3825']);
      F_.face(g, a + 0.05, a + 1.95, 0.6, 10, 11, '#8e5a3a');
      F_.box(g, a + 0.85, 0.15, a + 1.15, 0.4, 12, 14, '#2b2740');
      for (let k = 0; k < 4; k++) F_.top(g, a + 0.88 + k * 0.07, 0.3, a + 0.91 + k * 0.07, 0.37, 14, '#c9ccd8'); // its faders
      const arm = '#565a70', filter = flatCanvas(7, 8, f => { F(f, 1, 0, 5, 8, '#2b2230'); F(f, 0, 1, 7, 6, '#2b2230'); F(f, 1, 1, 5, 6, 'rgba(120,112,150,.55)'); F(f, 2, 2, 1, 1, 'rgba(255,255,255,.35)'); });
      [0.5, 1.5].forEach((u, k) => {
        const m = a + u, out = k ? 1 : -1;
        F_.box(g, m - 0.07, 0.22, m + 0.07, 0.36, 12, 13, '#3b3355');                 // the stand's foot
        F_.box(g, m - 0.015, 0.28, m + 0.015, 0.31, 13, 16, arm);                     // its stem
        F_.box(g, m - 0.05, 0.25, m + 0.05, 0.35, 16, 22, ['#8b8fa3', '#3b3355', '#2b2740']);
        F_.face(g, m - 0.05, m + 0.05, 0.35, 19, 20, '#8b8fa3');                      // the mic's grille band
        F_.flat(g, filter, m - 0.22, m - 0.22 + 7 / 16, 0.46, 14);                    // a pop filter in front
        F_.top(g, m - 0.14, 0.44, m + 0.1, 0.58, 12, '#fffaf0');                      // the script
        for (let i = 0; i < 3; i++) F_.top(g, m - 0.11, 0.47 + i * 0.035, m + 0.02 - (i % 2) * 0.05, 0.48 + i * 0.035, 12, '#8b8fa3');
        const h = m + out * 0.24;                                                     // headphones on the outer side
        F_.box(g, h - 0.07, 0.18, h - 0.02, 0.3, 12, 15, '#2b2740'); F_.box(g, h + 0.02, 0.18, h + 0.07, 0.3, 12, 15, '#2b2740');
        F_.top(g, h - 0.07, 0.22, h + 0.07, 0.26, 15, '#e8505b');
        const c = m - out * 0.22;                                                     // a mug on the inner side
        F_.box(g, c - 0.04, 0.46, c + 0.04, 0.54, 12, 17, k ? ['#bfe3ff', '#5b8def', '#34508f'] : ['#fffaf0', '#f6f1e6', '#c9ccd8']);
        F_.top(g, c - 0.03, 0.47, c + 0.03, 0.53, 17, '#5a3825');
        chair(props, room, F_, m, 1.25, [0, 0.22], '#26242c'); // black
        (anchors.mics ??= []).push({ ...F_.pt(m, 1.25), front: false, right: F_.X, level: room.level, room, h: SEAT_H });
      });
      for (let k = 0; k < 3; k++) anchors.leds.push({ ...F_.pt(a + 0.9 + k * 0.1, 0.4), z: room.z + 15, onair: k, c: ['#7bd389', '#ffd966', '#e8505b'][k] });
      return 2;
    }
    case 'airrack': { // beside the booth's desk: a little rack, its recorder's level meter dancing while anyone records, a speaker on top
      F_.box(g, a + 0.08, 0.06, a + 0.62, 0.5, 0, 24, ['#3b3355', '#2b2740', '#1d1a2f']);
      face(a + 0.08, a + 0.62, 0.5, 0, 9, 24, f => {
        F(f, 0, 0, 9, 24, '#2b2740'); for (const y of [1, 9, 17]) F(f, 1, y, 7, 6, '#3b3355');
        F(f, 2, 3, 2, 2, '#8b8fa3'); F(f, 5, 3, 2, 2, '#8b8fa3'); F(f, 2, 11, 5, 2, '#141a2e'); for (const x of [2, 4, 6]) F(f, x, 19, 1, 1, '#c9ccd8');
      });
      F_.box(g, a + 0.16, 0.12, a + 0.54, 0.42, 24, 37, '#2b2230');
      face(a + 0.16, a + 0.54, 0.42, 24, 6, 13, f => { disc(f, 3, 9, 2, '#565a70'); disc(f, 3, 3, 1, '#565a70'); });
      for (let k = 0; k < 5; k++) anchors.leds.push({ ...F_.pt(a + 0.22 + k * 0.06, 0.5), z: room.z + 12, vu: k, c: k < 3 ? '#7bd389' : k < 4 ? '#ffd966' : '#e8505b' });
      return 0.7;
    }
    // the engine room's and the arcade's
    case 'renderfarm': // a render farm's rack of blades, their lights blinking
      F_.box(g, a + 0.1, 0.05, a + 0.9, 0.5, 0, 38, ['#3b4160', '#2b3148', '#1b2238']);
      face(a + 0.1, a + 0.9, 0.5, 0, 13, 38, f => { F(f, 0, 0, 13, 38, '#1b2238'); for (let i = 0; i < 8; i++) { F(f, 1, 2 + i * 4, 11, 3, '#2b3148'); F(f, 8, 3 + i * 4, 3, 1, '#565a70'); } F(f, 1, 34, 11, 3, '#565a70'); });
      for (let k = 0; k < 16; k++) anchors.leds.push({ ...F_.pt(a + 0.2 + (k % 4) * 0.08, 0.5), z: room.z + 34 - (k >> 2) * 8 - (k % 2) * 4, c: ['#7bd389', '#7bd389', '#ffd966', '#8fd3ff'][k % 4] });
      anchors.glows.push({ ...F_.pt(a + 0.5, 0.7), z: room.z + 20, c: '#7bd389', r: 10 });
      ctx.hot.push({ type: 'machine', room, ...F_.pt(a + 0.5, 0.28), z: room.z, w: 0.85, h: 40 }); // (tapped: the machines' settings)
      return 1;
    case 'testrig': { // a test bench: a scope with its trace, a dev board, a phone on a stand, cables down to the floor
      F_.box(g, a + 0.05, 0.05, a + 0.75, 0.6, 0, 11, ['#a9adbd', '#8b8fa3', '#565a70']);
      F_.box(g, a + 0.08, 0.1, a + 0.4, 0.4, 11, 21, ['#e6e8f0', '#c9ccd8', '#8b8fa3']);
      face(a + 0.08, a + 0.4, 0.4, 12, 5, 8, f => { F(f, 0, 0, 5, 8, '#141a2e'); for (let i = 0; i < 5; i++) F(f, i, 4 + Math.round(Math.sin(i * 1.6) * 2), 1, 1, '#7bd389'); });
      F_.box(g, a + 0.44, 0.24, a + 0.7, 0.5, 11, 12, '#3f9b5c'); F_.box(g, a + 0.52, 0.32, a + 0.62, 0.42, 12, 13, '#2b2230');
      F_.box(g, a + 0.58, 0.1, a + 0.7, 0.16, 11, 22, '#2b2230'); F_.face(g, a + 0.59, a + 0.69, 0.16, 14, 21, '#8fd3ff');
      for (let k = 0; k < 8; k++) { const s2 = F_.s(a + 0.1 + k * 0.08, 0.64, 0); F(g, s2[0], s2[1] - (k % 3 ? 0 : 1), 1, 1, BOOKS[k % 4]); }
      anchors.leds.push({ ...F_.pt(a + 0.66, 0.36), z: room.z + 13, c: '#e8505b' });
      anchors.glows.push({ ...F_.pt(a + 0.25, 0.55), z: room.z + 16, c: '#7bd389', r: 8 });
      return 0.8;
    }
    case 'arcadecab': { // an arcade cabinet: its lit marquee, a game on the screen, a stick and buttons, the coin door
      ctx.cabs = (ctx.cabs ?? -1) + 1;
      const body = ['#e8505b', '#5b8def', '#9b72cf', '#f2a65a'][ctx.cabs % 4]; // each cabinet its own colour
      F_.box(g, a + 0.1, 0.05, a + 0.7, 0.55, 0, 36, [mix(body, '#ffffff', 0.18), body, mix(body, INK, 0.3)]);
      F_.box(g, a + 0.1, 0.55, a + 0.7, 0.75, 12, 15, [mix(body, '#ffffff', 0.3), mix(body, INK, 0.15), mix(body, INK, 0.4)]);
      face(a + 0.1, a + 0.7, 0.55, 0, 10, 36, f => {
        F(f, 1, 30, 8, 5, mix(body, INK, 0.45)); F(f, 3, 31, 1, 2, '#ffd966'); F(f, 6, 31, 1, 2, '#ffd966');
        F(f, 0, 2, 10, 4, '#ffd966'); F(f, 1, 3, 8, 2, '#fff3b0'); F(f, 3, 3, 4, 1, body);
        F(f, 1, 8, 8, 10, '#141a2e'); F(f, 1, 16, 8, 2, '#3f9b5c'); F(f, 3, 13, 2, 3, '#ff8fab'); F(f, 3, 12, 2, 1, '#2b2230'); F(f, 6, 11, 1, 1, '#ffd966'); F(f, 2, 9, 1, 1, '#fffaf0'); F(f, 7, 9, 1, 1, '#fffaf0');
      });
      F_.box(g, a + 0.23, 0.62, a + 0.28, 0.67, 15, 19, '#2b2230'); F_.box(g, a + 0.21, 0.6, a + 0.3, 0.69, 19, 21, '#e8505b');
      for (let k = 0; k < 2; k++) anchors.leds.push({ ...F_.pt(a + 0.45 + k * 0.12, 0.66), z: room.z + 15, c: ['#ffd966', '#5ef2ff'][k] });
      anchors.glows.push({ ...F_.pt(a + 0.4, 0.7), z: room.z + 24, c: '#8fd3ff', r: 12 });
      return 0.8;
    }
    case 'timeboard': { // a whiteboard on wheels: a stopwatch, the frame times it took, the line they should stay under
      for (const u of [0.12, 0.62]) { F_.box(g, a + u, 0.3, a + u + 0.05, 0.36, 0, 14, '#565a70'); F_.box(g, a + u - 0.04, 0.26, a + u + 0.09, 0.4, 0, 1, '#2b2230'); }
      F_.box(g, a + 0.06, 0.28, a + 0.74, 0.34, 13, 33, ['#e6e8f0', '#c9ccd8', '#8b8fa3']);
      face(a + 0.06, a + 0.74, 0.34, 13, 11, 20, f => {
        F(f, 0, 0, 11, 20, '#c9ccd8'); F(f, 1, 1, 9, 18, '#fffaf0');
        disc(f, 5, 6, 3, '#565a70'); disc(f, 5, 6, 2, '#fffaf0'); F(f, 4, 1, 3, 2, '#565a70'); F(f, 5, 4, 1, 2, INK); F(f, 5, 6, 2, 1, '#e8505b');
        [3, 4, 3, 6, 3, 4].forEach((h, i) => F(f, 2 + i * 1.4 | 0, 18 - h, 1, h, h > 4 ? '#e8505b' : '#5cc26a')); for (let i = 1; i < 10; i += 2) F(f, i, 13, 1, 1, '#f2a65a');
      });
      return 0.8;
    }
    case 'tvset': { // a TV on a low unit with a console under it, split-screen; and a couch facing it in the middle row
      F_.box(g, a + 0.08, 0.05, a + 0.92, 0.45, 0, 8, ['#cf9460', '#a8693f', '#6e4029']);
      F_.box(g, a + 0.55, 0.15, a + 0.8, 0.35, 8, 10, '#e6e8f0'); anchors.leds.push({ ...F_.pt(a + 0.6, 0.35), z: room.z + 9, c: '#5ef2ff' });
      F_.box(g, a + 0.12, 0.12, a + 0.88, 0.2, 10, 25, '#2b2230'); F_.box(g, a + 0.45, 0.14, a + 0.55, 0.2, 8, 10, '#2b2230');
      face(a + 0.15, a + 0.85, 0.2, 11, 11, 13, f => { // two players racing, one half of the screen each
        for (const y of [0, 7]) { F(f, 0, y, 11, 6, '#8fd3ff'); F(f, 0, y + 3, 11, 3, '#5cc26a'); F(f, 3, y + 3, 5, 3, '#565a70'); F(f, 5, y + 3, 1, 1, '#fffaf0'); F(f, 4, y + 4, 3, 2, y ? '#5b8def' : '#e8505b'); }
        F(f, 0, 6, 11, 1, '#2b2230');
      });
      anchors.glows.push({ ...F_.pt(a + 0.5, 0.5), z: room.z + 18, c: '#bfe6ff', r: 12 });
      const c0 = a - 0.05, c1 = a + 1.05, us = [0.25, 0.75];
      if (!ctx.space.free(c0, 1.2, c1, 1.75) || !us.every(u => spotFree(ctx.space, room, a + u, 1.42))) return 1;
      const col = '#4fb5a5', z0 = room.z, P = (u, d) => F_.pt(u, d), q0 = P(c0, 1.22), q1 = P(c1, 1.72);
      const bb = [Math.min(q0.x, q1.x), Math.min(q0.y, q1.y), Math.max(q0.x, q1.x), Math.max(q0.y, q1.y)], mid = P(a + 0.5, 1.4);
      worldProp(props, 'couch', mid.x + mid.y - 0.05, ...bb, z0, z0 + SOFA_H + 4, g2 => {
        F_.box(g2, c0, 1.22, c1, 1.56, 0, SOFA_H, [mix(col, '#ffffff', 0.18), col, mix(col, INK, 0.3)]);
        F_.box(g2, c0, 1.22, c0 + 0.14, 1.56, SOFA_H, SOFA_H + 3, col); F_.box(g2, c1 - 0.14, 1.22, c1, 1.56, SOFA_H, SOFA_H + 3, col);
      });
      const back = P(a + 0.5, 1.64);
      worldProp(props, 'couchback', back.x + back.y + 0.02, ...bb, z0, z0 + SOFA_H + 8, g2 => F_.box(g2, c0, 1.56, c1, 1.72, 0, SOFA_H + 7, [mix(col, '#ffffff', 0.1), mix(col, INK, 0.1), mix(col, INK, 0.35)]));
      ctx.space.take(c0, 1.2, c1, 1.75);
      for (const u of us) reserveSpot(ctx.space, room, a + u, 1.42);
      (anchors.sofas ??= []).push(...us.map(u => ({ ...P(a + u, 1.42), via: P(a + u, 1.95), front: false, right: F_.X, level: room.level, room, h: SOFA_H })));
      return 1;
    }
    case 'rig': { // the lent machine (world.machine): a cabinet in the board's colours (layout.js rigLook), its lights drawn per frame by render.js drawRig.
      const { size, gpuCount, body, glow } = ctx.rigLook, b = RIG[size];
      const [a0, a1] = [a + 0.5 - b.half, a + 0.5 + b.half], { w, h } = b, cards = size === 3 ? Math.min(gpuCount, 2) : 0;
      const frame = body ? mix(body, '#0b0b10', 0.25) : '#30364a', glass = body ? mix(body, '#0b0b10', 0.8) : '#1c2030', slot = mix(glass, '#000000', 0.45);
      const c = glow ?? '#a78bfa', bar = h - 5 - cards * 3; // (the bar low down, where the floor above never hides it: under it the cards and the button)
      F_.box(g, a0, b.d0, a1, b.d1, 0, h, body ? [mix(body, '#ffffff', 0.18), body, mix(body, '#0b0b10', 0.3)] : ['#5a6178', '#3d4357', '#2a2f40']);
      const xs = []; for (let x = 2; x < w - 2; x += 2) xs.push(x); // a channel every other pixel column
      face(a0, a1, b.d1, 0, w, h, f => { // its front: the channels' slots, the bar's, the GPUs' cards with a light strip, and the power button
        F(f, 0, 0, w, h, frame); F(f, 1, 1, w - 2, h - 2, glass);
        for (const x of xs) F(f, x, 2, 1, bar - 3, slot);
        F(f, 1, bar, w - 2, 1, slot);
        for (let k = 0; k < cards; k++) { F(f, 2, bar + 2 + k * 3, w - 4, 2, frame); F(f, 2, bar + 2 + k * 3, w - 4, 1, c); }
        F(f, w >> 1, h - 3, 1, 1, '#2b3148');
      });
      const at = F_.cols(a0, a1, b.d1, 0, w, h), trail = n => Array.from({ length: n }, (_, k) => mix(c, slot, (k + 1) / (n + 1)));
      anchors.rig = {
        ...F_.pt(a + 0.5, 0.5), z: room.z + h / 2, glow: glow ? mix(glow, '#000000', 0.7) : '#3a2470',   // (its light at night, at work)
        bar: at.slice(1, w - 1).map(([x, y]) => [x, y + bar]), channels: xs.map(x => [at[x][0], at[x][1] + 2, bar - 3]),
        power: [at[w >> 1][0], at[w >> 1][1] + h - 3], // (its power light, at the button: on while it's there)
        c, hi: glow ? mix(glow, '#ffffff', 0.75) : '#ede9fe', dim: mix(c, slot, 0.8), trail: trail(5), sweep: trail(3),
      };
      for (let k = 0; k < 3; k++) anchors.leds.push({ ...F_.pt(a1, b.d1 - 0.08), z: room.z + h - 10 - k * Math.min(5, (h - 12) / 2), rig: 3, k, c: glow });   // its lights down its side's front edge: RGB slowly cycling, or the board's colour pulsing
      ctx.hot.push({ type: 'machine', rig: true, room, ...F_.pt(a + 0.5, (b.d0 + b.d1) / 2), z: room.z, w: (2 * b.half + b.d1 - b.d0) * 8 / 12, h: h + 2 }); // (tapped: its own settings)
      return 1;
    }
    case 'sweep': case 'darkbench': return darkroomThing(ctx, name, a, room, F_);
  }
  return 0;
}

// A potted plant (a prop people can walk behind), with a spot beside it to water it from: to its left
// on screen, so the can and the stream of water are in plain view.
const PLANT_R = 0.16, WATER_AT = [-0.45, 0.45]; // the pot's half-width; the watering spot relative to the plant
function plantFits(sp, room, a, d) {
  const [wa, wd] = WATER_AT;
  return sp.free(a - PLANT_R, d - PLANT_R, a + PLANT_R, d + PLANT_R) && spotFree(sp, room, a + wa, d + wd);
}
function plantProp(ctx, room, F_, a, d, big) {
  const { props, anchors } = ctx, c = F_.pt(a, d), r = rng(room.id + a);
  const kind = pick(r, big ? ['monstera', 'palm'] : ['fern', 'cactus', 'bush']), POT = 8;
  F_.prop(props, 'plant', a - PLANT_R, d - PLANT_R, a + PLANT_R, d + PLANT_R, 30, g => {
    box(g, c.x - 0.14, c.y - 0.14, room.z, c.x + 0.14, c.y + 0.14, room.z + POT, ['#e07a5f', '#c8553d', '#8e3b2c']);
    top(g, c.x - 0.1, c.y - 0.1, c.x + 0.1, c.y + 0.1, room.z + POT, '#5a3825');
    const sx = SX(c.x, c.y), sy = SY(c.x, c.y, room.z + POT); // the middle of the soil
    const leaf = ['#5cc26a', '#3f9b5c', '#7bd389'];
    if (kind === 'cactus') { F(g, sx - 2, sy - 12, 4, 12, '#3f9b5c'); F(g, sx - 5, sy - 9, 3, 2, '#3f9b5c'); F(g, sx - 5, sy - 11, 2, 2, '#3f9b5c'); F(g, sx + 2, sy - 7, 3, 2, '#3f9b5c'); F(g, sx - 1, sy - 13, 1, 1, '#ff8fab'); return; }
    // stems from the soil, then leaves from the rim upwards, so the plant sits in its pot
    const h = big ? 20 : 9, n = big ? 16 : 9;
    for (const dx of big ? [-2, 0, 2] : [0]) F(g, sx + dx, sy - h + 3, 1, h - 2, '#3f9b5c');
    for (let i = 0; i < n; i++) {
      const k = i / n, ang = r() * Math.PI * 2, rad = (big ? 6 : 3) * (0.4 + k * 0.6) * r() + 1, y = 2 + k * h;
      disc(g, Math.round(sx + Math.cos(ang) * rad), Math.round(sy - y + Math.sin(ang) * rad * 0.4), big ? 3 : 2, leaf[i % 3]);
    }
  });
  const [wa, wd] = WATER_AT;
  ctx.space?.take(a - PLANT_R, d - PLANT_R, a + PLANT_R, d + PLANT_R);
  if (ctx.space) reserveSpot(ctx.space, room, a + wa, d + wd);
  anchors.plants.push({ ...F_.pt(a + wa, d + wd), px: c.x, py: c.y, pz: POT, level: room.level, room });
}
// The Christmas tree: a fir in a tub, baubles, lights that twinkle after dark and a star on top. The gifts
// under it pile up from one on 1 December to nine on the 25th. It's watered like the plant it stands in for.
const GIFTS = [[0, 0.3], [-0.3, 0.14], [0.18, 0.14], [-0.16, 0.44], [0.12, 0.44], [-0.4, 0.4], [-0.02, 0.6], [-0.3, 0.64], [0.14, 0.7]]; // (a, d) from the trunk, first come first placed
const WRAP = [['#e8505b', '#ffd966'], ['#5b8def', '#fffaf0'], ['#7bd389', '#e8505b'], ['#9b72cf', '#ffd966'], ['#fffaf0', '#e8505b'], ['#ffd966', '#5b8def']];
function christmasTree(ctx, room, F_, a, d) {
  const { props, anchors } = ctx, c = F_.pt(a, d), r = rng('tree' + today().getFullYear()), TUB = 5, H = 32;
  const gifts = GIFTS.slice(0, 1 + Math.floor((Math.min(today().getDate(), 25) - 1) / 3)).map(([ga, gd], k) => ({ ...F_.pt(a + ga, d + gd), w: 0.07 + (k % 3) * 0.025, h: 4 + (k * 5) % 4, wrap: WRAP[k % WRAP.length] })).sort((p, q) => p.x + p.y - q.x - q.y);
  const sx = Math.round(SX(c.x, c.y)), sy = Math.round(SY(c.x, c.y, room.z + TUB)), bulbAt = (dx, up) => ({ x: c.x + dx / 32, y: c.y - dx / 32, z: room.z + TUB + up }); // (dx, up: screen px from the trunk's foot)
  const lights = Array.from({ length: 15 }, (_, k) => { const up = 4 + k * 2.3; return { dx: Math.round(Math.sin(k * 2.2) * (H - up) * 0.3), up: Math.round(up), c: ['#ffd966', '#e8505b', '#8fd3ff', '#fffaf0'][k % 4] }; });
  F_.prop(props, 'tree', a - 0.45, d - 0.4, a + 0.45, d + 0.85, H + TUB + 6, g => {
    box(g, c.x - 0.13, c.y - 0.13, room.z, c.x + 0.13, c.y + 0.13, room.z + TUB, ['#e8505b', '#c8404b', '#8e3b2c']);
    F(g, sx - 1, sy - 3, 2, 3, '#6e4029');
    // three tiers, each wider at the bottom, darker on the right, with a lighter fringe along its lower edge
    for (const [top, bottom, w0, w1] of [[H, H - 12, 1, 6], [H - 8, H - 21, 3, 9], [H - 17, 2, 5, 12]]) {
      for (let y = top; y >= bottom; y--) {
        const hw = Math.round(w0 + (w1 - w0) * (top - y) / (top - bottom));
        F(g, sx - hw, sy - y, hw * 2 + 1, 1, '#3f9b5c'); F(g, sx + 1, sy - y, hw, 1, '#2f7a47');
        if (y === bottom) for (let x = -hw; x <= hw; x += 2) F(g, sx + x, sy - y + 1, 1, 1, x < 0 ? '#5cc26a' : '#3f9b5c');
      }
    }
    for (let k = 0; k < 9; k++) { const up = 6 + r() * (H - 12), hw = Math.max(1, (H - up) * 0.3 - 1), x = Math.round((r() * 2 - 1) * hw); F(g, sx + x, sy - Math.round(up), 2, 2, ['#e8505b', '#ffd966', '#5b8def'][k % 3]); F(g, sx + x, sy - Math.round(up), 1, 1, '#fffaf0'); }
    for (const l of lights) F(g, sx + l.dx, sy - l.up, 1, 1, l.c);
    F(g, sx - 1, sy - H - 4, 3, 3, '#ffd966'); F(g, sx, sy - H - 6, 1, 7, '#ffd966'); F(g, sx - 3, sy - H - 3, 7, 1, '#ffd966'); F(g, sx, sy - H - 3, 1, 1, '#fffaf0'); // the star
    for (const p of gifts) {
      box(g, p.x - p.w, p.y - p.w, room.z, p.x + p.w, p.y + p.w, room.z + p.h, [p.wrap[0], mix(p.wrap[0], INK, 0.12), mix(p.wrap[0], INK, 0.28)]);
      const gx = Math.round(SX(p.x, p.y)), gy = Math.round(SY(p.x, p.y, room.z + p.h));
      F(g, gx, gy - 2, 1, p.h + 3, p.wrap[1]); F(g, gx - 1, gy - 1, 3, 1, p.wrap[1]); // ribbon and bow
    }
  }, { foot: [a - 0.2, d - 0.2, a + 0.2, d + 0.2] });
  ctx.space.take(a - 0.2, d - 0.2, a + 0.2, d + 0.2);
  const [wa, wd] = WATER_AT;
  reserveSpot(ctx.space, room, a + wa, d + wd);
  anchors.plants.push({ ...F_.pt(a + wa, d + wd), px: c.x, py: c.y, pz: TUB, level: room.level, room });
  for (const l of lights.filter((_, k) => k % 3 === 1)) anchors.bulbs.push(bulbAt(l.dx, l.up)); // (a few glow after dark: all of them would wash the tree out)
  anchors.glows.push({ ...bulbAt(0, H + 2), c: '#ffd966', r: 6 });
}

// Chairs: the seat, then the backrest as its own prop. Seen from behind (at a desk), the backrest
// is in front of the sitter and stops below the shoulders, so they sit on the chair, not in it. The back stands [da, dd]
// tiles from the seat (along the wall, out from it) and height px above the cushion; a back nearer us than the seat
// (da + dd > 0) sorts just after whoever sits in it, one further off well before them.
export const SEAT_H = 9; // the cushion's top, px above the floor
function chair(props, room, F_, a, d, [da, dd], color, height = 6) {
  const c = F_.pt(a, d), z = room.z;
  worldProp(props, 'seat', c.x + c.y - 0.05, c.x - 0.25, c.y - 0.25, c.x + 0.25, c.y + 0.25, z, z + SEAT_H + 1, g => {
    ellipse(g, SX(c.x, c.y), SY(c.x, c.y, z) - 1, 5, 2, '#3b3355'); F(g, SX(c.x, c.y), SY(c.x, c.y, z) - SEAT_H + 2, 1, SEAT_H - 3, '#565a70');
    box(g, c.x - 0.18, c.y - 0.18, z + SEAT_H - 2, c.x + 0.18, c.y + 0.18, z + SEAT_H, color);
  });
  const b = F_.pt(a + da, d + dd), top1 = z + SEAT_H + height;
  const along = da !== 0, thinX = F_.X === along, [u, v] = thinX ? [0.03, 0.18] : [0.18, 0.03];
  worldProp(props, 'chairback', b.x + b.y + (da + dd > 0 ? 0.02 : -0.4), b.x - 0.25, b.y - 0.25, b.x + 0.25, b.y + 0.25, z, top1 + 1, g => {
    box(g, b.x - u, b.y - v, z + SEAT_H, b.x + u, b.y + v, top1, color);
  });
}

// A workstation along the back wall: desk, monitor (screen animated later), keyboard, props, chair.
function desk(ctx, room, F_, a, agent, look) {
  const { g, props, anchors } = ctx, [, , , deskC] = theme(room.kind);
  F_.box(g, a + 0.08, 0.06, a + 0.92, 0.7, 0, 10, [mix(deskC, '#ffffff', 0.15), mix(deskC, INK, 0.12), mix(deskC, INK, 0.3)]);
  F_.face(g, a + 0.08, a + 0.92, 0.7, 7, 8, mix(deskC, INK, 0.4));
  F_.box(g, a + 0.14, 0.2, a + 0.86, 0.28, 11, 23, '#2b2230'); F_.box(g, a + 0.46, 0.22, a + 0.54, 0.3, 10, 11, '#3b3355');
  F_.box(g, a + 0.34, 0.42, a + 0.66, 0.54, 10, 11, '#c9ccd8');
  const tr = rng(agent.id + 'trinket'), propsList = (look?.props || []).filter(p => p !== 'cables' && p !== 'stickies').slice(0, 2);
  if (propsList.length < 2 && tr() < 0.6) propsList.push(pick(tr, room.kind === 'review' ? ['duck', 'duck', 'cactus'] : ['duck', 'cactus', 'photo'])); // something of their own
  propsList.forEach((p, k) => { const u = k ? a + 0.2 : a + 0.8, s = F_.s(u, 0.45, 10); drawProp(g, p, Math.round(s[0]) - 1, Math.round(s[1])); if (['mug', 'bigmug', 'tea'].includes(p)) anchors.mugs.push({ ...F_.pt(u, 0.45), z: room.z + 15, id: agent.id }); });
  if (look?.props.includes('cables')) for (let k = 0; k < 10; k++) { const s = F_.s(a + 0.1 + k * 0.08, 0.72, 0); F(g, s[0], s[1] - (k % 3 ? 0 : 1), 1, 1, BOOKS[k % 4]); }
  if (look?.props.includes('lamp')) anchors.glows.push({ ...F_.pt(a + 0.2, 0.4), z: room.z + 14, c: '#ffd966', r: 10, desk: agent.id });
  anchors.screens.push({ id: agent.id, X: F_.X, d: 0.28, a0: (F_.X ? room.x0 : room.y0) + a + 0.18, a1: (F_.X ? room.x0 : room.y0) + a + 0.82, z0: room.z + 12, z1: room.z + 22, ...F_.pt(a + 0.5, 0.3) });
  const seat = F_.pt(a + 0.5, 1.25);
  chair(props, room, F_, a + 0.5, 1.25, [0, 0.22], mix(theme(room.kind)[3], '#3b3355', 0.45));
  return { x: seat.x, y: seat.y, front: false, right: F_.X, level: room.level, h: SEAT_H };
}

// Features declared in org.yaml become interactive furniture.
function feature(ctx, room, F_, a, f) {
  const { g, props, anchors } = ctx;
  if (f === 'gazette-newsstand') {
    F_.box(g, a + 0.1, 0.1, a + 1.4, 0.65, 0, 12, ['#8fb2ff', '#5b8def', '#34508f']);
    for (let i = 0; i < 4; i++) { const u = a + 0.18 + i * 0.3; F_.box(g, u, 0.2, u + 0.24, 0.55, 12, 13, '#fffaf0'); F_.top(g, u + 0.04, 0.3, u + 0.2, 0.45, 13, BOOKS[i]); }
    F_.box(g, a + 0.1, 0.08, a + 0.16, 0.14, 12, 34, '#565a70'); F_.box(g, a + 1.34, 0.08, a + 1.4, 0.14, 12, 34, '#565a70');
    F_.face(g, a + 0.05, a + 1.45, 0.14, 26, 35, INK);
    F_.flat(g, flatCanvas(22, 9, f2 => { F(f2, 0, 0, 22, 9, INK); text(f2, 'NEWS', 3, 2, '#ffd966'); }), a + 0.05, a + 1.45, 0.14, 26);
    for (let i = 0; i < 7; i++) F_.box(g, a + i * 0.21, 0.14, a + i * 0.21 + 0.21, 0.4, 34, 36, i % 2 ? '#fffaf0' : '#e8505b');
    ctx.hot.push({ type: 'gazette', room, ...F_.pt(a + 0.75, 0.4), z: room.z, w: 1.5, h: 38 });
    // three places to stand and pick up a copy, so a new post draws a small crowd, not a pile
    const spots = [0.3, 0.75, 1.2].filter(u => spotFree(ctx.space, room, a + u, 1.0));
    spots.forEach(u => reserveSpot(ctx.space, room, a + u, 1.0));
    anchors.news = { spots: spots.map(u => ({ ...F_.pt(a + u, 1.0), level: room.level, right: F_.X })), spark: { ...F_.pt(a + 0.75, 0.4), z: room.z + 30 } };
    return 1.6;
  }
  if (f === 'reception') {
    if (!ctx.space.free(a + 0.1, 0.85, a + 1.9, 1.55)) return 0;
    const c = F_.pt(a + 1.5, 1.2);
    F_.prop(props, 'reception', a + 0.1, 0.9, a + 1.9, 1.5, 20, g2 => {
      F_.box(g2, a + 0.1, 0.9, a + 1.9, 1.5, 0, 13, ['#f6d9c8', '#e07a5f', '#c8553d']);
      F_.box(g2, a + 0.05, 0.85, a + 1.95, 1.55, 13, 14, '#fdf3e1');
      F_.face(g2, a + 0.1, a + 1.9, 1.5, 5, 6, '#fdf3e1');
      F_.box(g2, a + 1.45, 1.1, a + 1.65, 1.3, 14, 16, '#ffd966'); F_.box(g2, a + 1.53, 1.18, a + 1.57, 1.22, 16, 17, '#ffd966');
      F_.box(g2, a + 0.3, 1.0, a + 0.7, 1.3, 14, 15, '#fffaf0');
      if (ctx.holidays.has('halloween')) { // a bowl of candy for anyone passing the desk
        F_.box(g2, a + 0.95, 1.05, a + 1.25, 1.3, 14, 16, '#e8505b');
        F_.box(g2, a + 0.98, 1.08, a + 1.22, 1.22, 16, 19, ['#ffd966', '#5b8def', '#7bd389']);
      }
    }, { at: 1.5 });
    ctx.space.take(a + 0.05, 0.85, a + 1.95, 1.55);
    ctx.hot.push({ type: 'bell', room, ...c, z: room.z, w: 1, h: 22 });
    return 2;
  }
  if (f === 'knowledge-search') {
    F_.box(g, a + 0.35, 0.2, a + 0.65, 0.5, 0, 12, '#565a70'); F_.box(g, a + 0.2, 0.15, a + 0.8, 0.35, 12, 28, '#3b3355');
    F_.face(g, a + 0.26, a + 0.74, 0.35, 15, 26, '#8fd3ff');
    F_.flat(g, flatCanvas(8, 11, f2 => { disc(f2, 3, 4, 2, '#fffaf0'); F(f2, 3, 4, 1, 1, '#8fd3ff'); F(f2, 5, 7, 2, 1, '#fffaf0'); }), a + 0.26, a + 0.74, 0.35, 15);
    ctx.hot.push({ type: 'search', room, ...F_.pt(a + 0.5, 0.3), z: room.z, w: 1, h: 30 });
    anchors.glows.push({ ...F_.pt(a + 0.5, 0.5), z: room.z + 20, c: '#8fd3ff', r: 12 });
    return 1;
  }
  return 0;
}

// A wisp of cobweb tucked where the back wall meets the near end, close to the ceiling.
function cobweb(g, sx, sy) {
  const col = 'rgba(230,225,245,.6)', col2 = 'rgba(230,225,245,.35)';
  const line = (x1, y1, x2, y2, c) => { const n = Math.max(1, Math.round(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)))); for (let k = 0; k <= n; k++) F(g, Math.round(x1 + (x2 - x1) * k / n), Math.round(y1 + (y2 - y1) * k / n), 1, 1, c); };
  const rays = [[9, 2], [9, 5], [7, 8], [4, 9], [1, 9]].map(([rx, ry]) => [sx + rx, sy + ry]);
  for (const [rx, ry] of rays) line(sx, sy, rx, ry, col);
  for (const f of [0.4, 0.75]) { let prev = null; for (const [rx, ry] of rays) { const px = sx + (rx - sx) * f, py = sy + (ry - sy) * f; if (prev) line(prev[0], prev[1], px, py, col2); prev = [px, py]; } }
}

// ---- the whole room ----
export function buildRoom(room, L, looks) {
  const F_ = frame(room), pent = room.pent, terrace = room.kind === 'terrace', christmas = L.holidays.has('christmas');
  const { x0, y0, x1, y1, z } = room, same = room.lv.rooms.filter(r => r.wing === room.wing), last = same[same.length - 1] === room;
  // walls only need the height that shows: the floor above hides the rest, except at a wing's open end
  const H = pent ? PENT_H : terrace ? 10 : last || room.wing === 'core' ? WALL_H : INNER_WALL_H, [wallC, , fl] = theme(room.kind);
  const prev = same[same.indexOf(room) - 1];
  let seen = null; // a terrace beside the penthouse: its art just after the penthouse's glass end wall went on
  const bx = Math.floor(SX(x0, y1)) - 8, by = Math.floor(SY(x0, y0, z + H)) - 70, bw = Math.ceil(SX(x1, y0)) + 8 - bx, bh = Math.ceil(SY(x1, y1, z - SLAB)) + 8 - by;
  const c = canvas(bw, bh), g = c.getContext('2d'), m = canvas(bw, bh), gm = m.getContext('2d');
  g.translate(-bx, -by); gm.translate(-bx, -by);
  const anchors = { screens: [], plants: [], coffee: [], leds: [], sparks: [], glows: [], notes: [], belts: [], glints: [], lights: [], seats: [], gaze: [], bulbs: [], mugs: [], records: [], news: null, rig: null };
  const ctx = { g, props: [], anchors, hot: [], space: space(), holidays: L.holidays, rigLook: L.rigLook, last };
  const [kWall, , kFloor] = KINDS[room.kind] || KINDS.office;
  // floor slab faces: front and far end (the diorama cut), drawn first so the floor sits on them
  const sect = '#3b3355', sectHi = '#565a70';
  if (room.level > 0) {
    F_.X ? wallY(g, x0, x1, y1, z - SLAB, z, sect) : wallX(g, y0, y1, x1, z - SLAB, z, sect);
    if (last) F_.X ? wallX(g, y0 - 0.25, y1, x1, z - SLAB, z, sectHi) : wallY(g, x0 - 0.25, x1, y1, z - SLAB, z, sectHi);
  }
  if (room.level >= 0 && last) { // brick end of the back wall
    const zb = room.level ? z - SLAB : z; // the ground floor's stands on the ground, not a slab
    F_.X ? wallX(g, -0.25, 0, x1, zb, z + H, '#a8452f') : wallY(g, -0.25, 0, y1, zb, z + H, '#a8452f');
    F_.X ? wallX(g, -0.25, 0, x1, z + H - 2, z + H, '#c8553d') : wallY(g, -0.25, 0, y1, z + H - 2, z + H, '#c8553d');
  }
  floor(g, room, kFloor, wallC, terrace ? '#b98a64' : fl);
  // in the penthouse the core keeps its own floor: the red carpet starts past the elevator and stairs
  if (pent) floor(g, { ...room, x0: 0, y0: 0, x1: CORE_X, y1: CORE }, 'core', wallC, theme('core')[2]);
  if (room.kind === 'lobby' || room.kind === 'library' || room.kind === 'boardroom' || room.kind === 'nook') { // rug
    const ru = room.kind === 'lobby' ? '#e8505b' : room.kind === 'boardroom' ? '#b8404f' : '#9b72cf';
    const a0 = pent ? CORE_X + 0.3 : 0.6;
    F_.top(g, a0, 1.1, F_.len - 0.6, F_.depth - 0.35, 0, mix(ru, '#ffd966', 0.25)); F_.top(g, a0 + 0.1, 1.2, F_.len - 0.7, F_.depth - 0.45, 0, ru);
  }
  // a cosy rug in the middle row (round in the lounge), in colours of its own
  const rugK = !pent && room.level >= 0 && ['office', 'lounge', 'archive', 'mailroom', 'lab', 'studio'].includes(room.kind) && F_.len >= 3;
  if (rugK) {
    const RUGS = [['#c8553d', '#f2c14e'], ['#3d8f86', '#fdf3e1'], ['#7a5aa6', '#ffc2d1'], ['#4a6fc0', '#bfe3ff'], ['#5e9e7c', '#fff3b0'], ['#b8404f', '#fdf3e1']];
    const [c1, c2] = RUGS[[...room.id].reduce((h, ch) => h * 31 + ch.charCodeAt(0) >>> 0, 7) % RUGS.length];
    if (room.kind === 'lounge') { const [sx, sy] = F_.s(Math.min(1.6, F_.len / 2), F_.depth * 0.62); ellipse(g, sx, sy, 22, 11, c2); ellipse(g, sx, sy, 20, 10, c1); for (let k = 0; k < 20; k++) { const t = k / 20 * 6.283; F(g, Math.round(sx + Math.cos(t) * 14), Math.round(sy + Math.sin(t) * 6.5), 2, 1, c2); } for (const [dx, dy] of [[-3, 0], [2, 0], [0, -1], [0, 1]]) F(g, sx + dx - 1, sy + dy, 3, 1, '#ffd966'); F(g, sx - 1, sy, 2, 1, c2); }
    else {
      const a0 = 0.7, a1 = Math.min(F_.len - 0.8, a0 + 2.2), d0 = 1.05, d1 = F_.depth - 0.45;
      F_.top(g, a0, d0, a1, d1, 0, c2); F_.top(g, a0 + 0.06, d0 + 0.06, a1 - 0.06, d1 - 0.06, 0, c1);
      F_.top(g, a0 + 0.18, d0 + 0.18, a1 - 0.18, d1 - 0.18, 0, mix(c1, c2, 0.5)); F_.top(g, a0 + 0.22, d0 + 0.22, a1 - 0.22, d1 - 0.22, 0, c1);
      const am = (a0 + a1) / 2, dm = (d0 + d1) / 2; F_.top(g, am - 0.15, dm - 0.15, am + 0.15, dm + 0.15, 0, c2); F_.top(g, am - 0.07, dm - 0.07, am + 0.07, dm + 0.07, 0, c1); // a little medallion
      for (const d of [d0, d1 - 0.04]) for (let u = a0 + 0.05; u < a1 - 0.05; u += 0.12) F_.top(g, u, d - (d === d0 ? 0.06 : -0.02), u + 0.05, d + (d === d0 ? 0 : 0.06), 0, c2); // fringes
    }
  }
  if (room.kind === 'booth') { // a round rug under the hosts' chairs, in rings like a sound wave
    const [sx, sy] = F_.s(BOOTH_DESK, 1.35);
    [[19, 9, '#8e3b4a'], [18, 9, '#d9a441'], [15, 7, '#c8553d'], [13, 6, '#d9a441'], [9, 4, '#c8553d'], [7, 3, '#d9a441']].forEach(([rx, ry, c]) => ellipse(g, sx, sy, rx, ry, c));
  }
  // walls
  const paper = { booth: 'foam', library: 'stripes', studio: 'stripes', server: 'panels', vault: 'panels', engine: 'panels', dock: 'brick', terrace: 'brick' }[room.kind]; // (engine, arcade)
  const notice = room.dept && !room.agents.length && 'vacant', items = !notice && room.level < 0 ? kWall.filter(n => n !== 'window') : kWall;
  let win = false;
  if (room.wing === 'core' || pent) {
    // two exterior walls meeting in the corner
    const wx = { ...room, wing: 'x', x0: 0, y0: 0, x1: x1, y1: 0 }, wy = { ...room, wing: 'y', x0: 0, y0: 0, x1: 0, y1: y1 };
    // beyond the spiral, the stairwell gets a little art (a different pair on each floor)
    const hall = [['art', 'pixelart'], ['polaroids'], ['poster', 'art'], ['doodles', 'pixelart']][(room.level + 8) % 4];
    if (room.level === 0 && christmas) hall.unshift('wreath');
    win = backWall(g, gm, wx, frame(wx), H, pent ? { items: ['tall', 'chart', 'tall', 'tall', 'tall', 'overseer'], paper, high: -1, leds: anchors.leds } : { items: hall, paper, start: 64 }); // (the Overseer's portrait ends the penthouse wall)
    win = backWall(g, gm, wy, frame(wy), H, { items: pent ? ['tall', 'portrait', 'tall', 'tall'] : [], paper, high: pent ? -1 : 0 }) || win;
    if (!pent) { // big level number on the wall by the elevator
      const lvName = levelName(room.lv), n = flatCanvas(20, 14, f => { F(f, 0, 0, 20, 14, '#3b3355'); text(f, lvName, 10 - textW(lvName, 2) / 2 | 0, 2, '#ffd966', 2); });
      onWallX(g, n, 2.9, 0, z + 22);
    }
  } else {
    // (at Christmas the library gets fairy lights too, and all of them turn red, green and gold. The lobby's would hide under the floor above)
    const string = room.level >= 0 && { studio: 'bunting', mailroom: 'bunting', canteen: 'bunting', lounge: 'fairy', nook: 'fairy', lab: 'fairy', bar: 'fairy', ...christmas && { library: 'fairy' } }[room.kind]; // (bar)
    // (the booth's wall has a layer of its own for what lights up while recording)
    const onAir = room.kind === 'booth' && { img: canvas(bw, bh), x: bx, y: by };
    if (onAir) { onAir.g = onAir.img.getContext('2d'); onAir.g.translate(-bx, -by); }
    // (its sign hangs over the middle of the desk, BOOTH_DESK along the wall)
    // (and the meeting room's window between its door sign and its board, so neither hangs over it.)
    // (and the arcade's things, an empty one's EMPTY sign among them, in a row from its neon on: arcadeWall.)
    const wallPosition = (u, name) => Math.round((F_.X ? u : F_.len - u) * 16 - WALL[name][0] / 2);
    const meeting = room.kind === 'meeting', arcade = room.kind === 'arcade';
    let at;
    if (onAir) at = wallPosition(BOOTH_DESK, 'onair');
    else if (meeting) at = wallPosition((MEET.sign[1] + MEET.board[0]) / 2, 'window');
    const pins = arcade ? arcadeWall(F_.len, (notice ? [notice, ...items] : items).map(name => [name, WALL[name][0]])).map(([name, u]) => [name, wallPosition(u, name)]) : [];
    win = backWall(g, gm, room, F_, H, terrace ? { items: [], paper: 'brick', parapet: true } : { items: arcade ? [] : items, notice: !arcade && notice, hidden: wallHidden(room, L), space: ctx.space, paper, string, christmas, bulbs: anchors.bulbs, lit: onAir, at, once: meeting, pins });
    if (onAir?.glow) anchors.onair = { img: onAir.img, x: bx, y: by, glow: onAir.glow };
    if (!(terrace && room.wing === 'y' && !L.pent)) partition(g, room, terrace ? (prev?.pent || room.wing === 'y' ? PENT_H : 10) : WALL_H - 12, terrace && !(prev?.pent || room.wing === 'y') ? '#a8452f' : null);
    if (terrace && prev?.pent) { seen = canvas(bw, bh); seen.getContext('2d').drawImage(c, 0, 0); } // (the room as it stands now, for the glass below)
  }
  if (room.wing === 'core' || pent) core(ctx, room, L);
  if (pent) { // the board's office is glassed off from the stairwell, with a doorway at the front
    const X = CORE_X, d1 = CORE - 1, H = PENT_H, frameC = '#fdf3e1', plane = (a0, a1, z0, z1, c) => wallX(g, a0, a1, X, z + z0, z + z1, c);
    plane(0, d1, 0, 7, theme(room.kind)[1]); plane(0, d1, 6, 7, mix(theme(room.kind)[1], '#ffffff', 0.3));
    g.globalAlpha = 0.22; plane(0, d1, 7, H, '#bfe6ff'); g.globalAlpha = 0.35; plane(d1 * 0.3, d1 * 0.3 + 0.12, 12, H, '#ffffff'); plane(d1 * 0.36, d1 * 0.36 + 0.05, 12, H, '#ffffff'); g.globalAlpha = 1;
    plane(d1 - 0.07, d1, 0, H, frameC); plane(d1 / 2 - 0.03, d1 / 2 + 0.03, 7, H, frameC); plane(0, d1, 30, 31, frameC); plane(0, d1, H - 1, H, frameC);
  }
  // a plant in the stairwell's back corner, every other floor. At Christmas the one by the front door is a tree
  if (room.wing === 'core' && !pent && room.level === 0 && christmas) christmasTree(ctx, room, F_, 6.25, 0.55);
  else if (room.wing === 'core' && !pent && room.level >= 0 && room.level % 2 === 0) plantProp(ctx, room, F_, 6.45, 0.45, true);
  if (terrace) terraceProps(ctx, room, F_, L);
  else if (room.wing !== 'core') furnish(ctx, room, F_, L, looks);
  // ceiling lights (pools on the floor)
  if (!terrace) for (let u = 1.2; u < F_.len; u += 2.4) { const p = F_.pt(u, F_.depth * 0.55); if (!((room.wing === 'core' || pent) && inWell(p.x, p.y, 0.3))) anchors.lights.push({ ...p, z }); } // (none over the stairwell)
  // name sign at the room's front edge, standing on the floor over the slab, so the slab's dark face parts it from the
  // room below's wall, where the meeting room's board comes up close under the slab (meetingWall), and it clears the
  // elevator's level sign by the core (level 0 and the basement get theirs on the island's edge). A prop sorted at the
  // room's front far corner, so it stands in front of everyone in the room
  if (room.level > 0 && !terrace && room.wing !== 'core') {
    const p = F_.pt(0, F_.depth), q = F_.pt(F_.len, F_.depth);
    worldProp(ctx.props, 'nameplate', room.x1 + room.y1, p.x, p.y, q.x, q.y, room.z, room.z + 7, g2 => namePlate(g2, room, F_.depth, room.z));
  }
  // a wisp of cobweb in a few corners, through Halloween week
  if (!pent && !terrace && ['lobby', 'library', 'archive'].includes(room.kind) && L.holidays.has('halloween')) {
    const [sx, sy] = F_.s(0.05, 0.05, H - 4);
    cobweb(g, sx, sy);
  }
  ctx.props.sort((p, q) => p.depth - q.depth);
  // a terrace beside the penthouse carries the penthouse's glass end wall (its partition): where it shows, past the
  // terrace's things in front of it, it's lit from inside at night (render.js nightShade)
  let glass = null;
  if (terrace && prev?.pent) {
    glass = canvas(bw, bh);
    const gg = glass.getContext('2d');
    gg.translate(-bx, -by); partition(gg, room, PENT_H, null);
    gg.globalCompositeOperation = 'source-in'; gg.globalAlpha = 1; gg.fillStyle = '#000'; gg.fillRect(bx, by, bw, bh);
    gg.globalCompositeOperation = 'destination-out'; for (const p of ctx.props) gg.drawImage(p.img, p.x, p.y);
    // and not where the terrace drew over it afterwards (the jacuzzi, drawn straight into its art)
    const now = g.getImageData(0, 0, bw, bh).data, then = seen.getContext('2d').getImageData(0, 0, bw, bh).data, mask = gg.getImageData(0, 0, bw, bh);
    for (let k = 0; k < now.length; k += 4) if (now[k] !== then[k] || now[k + 1] !== then[k + 1] || now[k + 2] !== then[k + 2] || now[k + 3] !== then[k + 3]) mask.data[k + 3] = 0;
    gg.putImageData(mask, 0, 0);
  }
  return { c, m: win ? m : null, bx, by, props: ctx.props, anchors, hot: ctx.hot, plug: ctx.plug, space: ctx.space, glass }; // (space: where things stand)
}

// where the back row's next w tiles from a stand clear, stepping past what's taken on the way (an empty room's notice,
// backWall); null when the row is full by end
function backRowFrom(sp, a, w, end) {
  for (let b = a; b + w <= end + 0.05; b += 0.05) if (sp.free(b, 0, b + w, BACK)) return b;
  return null;
}

// Walkable space comes first: the lane in front, the doorways at both ends and the way to every seat.
// Then features and furniture fill the back row from the near end, a table may go in the middle row,
// and plants and window spots take whatever is left.
function furnish(ctx, room, F_, L, looks) {
  const { anchors } = ctx, sp = ctx.space, pent = room.pent, len = F_.len, D = F_.depth, lane = room.lv.lane;
  const [, kBack] = KINDS[room.kind] || KINDS.office;
  sp.take(-1, lane - 0.35, len + 1, D + 1, true);                        // the lane
  sp.take(-1, D - 1.1, 0.6, D + 1, true); sp.take(len - 0.6, D - 1.1, len + 1, D + 1, true); // doorways
  if (pent) sp.take(-1, -1, CORE_X + 0.2, D + 1);                           // the core inside the penthouse
  // desks at the far end, except in the dock, where that end is the loading door: there they go by the near end
  // and the conveyor runs on towards the door. end: where the rest of the back row stops
  const n = room.agents.length, first = room.kind === 'dock' && n, deskStart = pent ? Math.max(CORE_X + 0.4, len - 2.6 - (n - 1) * EXEC_W) : first ? 0.1 : len - n, end = first ? len - 0.1 : deskStart;
  // seats: desks at the far end, and the board's desk faces the room
  const seats = pent ? execDesk(ctx, room, F_, deskStart) : room.agents.map((ag, k) => {
    sp.take(deskStart + k, 0, deskStart + k + 1, 0.75);
    reserveSpot(sp, room, deskStart + k + 0.5, 1.25); sp.take(deskStart + k + 0.2, 1.0, deskStart + k + 0.8, 1.55); // the chair
    return desk(ctx, room, F_, deskStart + k, ag, looks.get(ag.id));
  });
  anchors.seats = seats;
  let a = pent ? CORE_X + 0.2 : first ? deskStart + n + 0.1 : 0.1;
  for (const f of room.features) a += feature(ctx, room, F_, a, f);
  if (room.kind === 'meeting') a = meetingRoom(ctx, room, F_, a);
  if (['lobby', 'lounge', 'nook'].includes(room.kind)) a = sofa(ctx, room, F_, a + 0.1, end) ?? a;
  if (room.kind === 'bar') bar(ctx, room, F_);
  const fits = w => { const b = backRowFrom(sp, a, w, end); if (b !== null) a = b; return b !== null; };
  // (the rig first: at a row's end the room's glass corner would stand in front of it)
  if (L.rig && room.src === L.rig && !L.rigPut && fits(1)) { L.rigPut = true; sp.take(a, 0, a + 1, BACK); a += furniture(ctx, 'rig', a, room, F_); }
  if (room.kind === 'server') for (const eng of L.engines) { if (!fits(1)) break; ctx.engine = eng; sp.take(a, 0, a + 1, BACK); a += furniture(ctx, 'rack', a, room, F_); }
  for (const name of kBack) {
    const w = { conveyor: 2, micdesk: 2, airrack: 0.7, record: 0.7, piggy: 0.7, coffee: 0.7, sweep: 1.4, darkbench: 2, testrig: 0.8, arcadecab: 0.8, timeboard: 0.8 }[name] || 1; // (sweep, darkbench; engine, arcade)
    if (!fits(w)) break;
    const used = furniture(ctx, name, a, room, F_);
    if (used) sp.take(a, 0, a + used, BACK);
    a += used || w;
  }
  // a meeting table in the middle row
  const tw = room.kind === 'review' ? 2.2 : 1.4, ta = Math.min(end - tw - 0.3, 1.2);
  if ((room.kind === 'library' || room.kind === 'review') && ta >= 0.6 && sp.free(ta, 1.3, ta + tw, 1.9)) { table(ctx, room, F_, ta, room.kind === 'review'); sp.take(ta, 1.3, ta + tw, 1.9); }
  // the canteen: a table every couple of tiles along the middle row; the gym: a mat or two to stretch on
  if (room.kind === 'canteen') for (let u = 0.7; u + 1.4 <= len - 0.6; u += 2.2) if (sp.free(u, 1.3, u + 1.4, 1.9)) { table(ctx, room, F_, u, false); sp.take(u, 1.3, u + 1.4, 1.9); }
  if (room.kind === 'gym') for (let u = 0.8, k = 0; u + 1.1 <= len - 0.6; u += 1.8, k++) { const c = ['#9b72cf', '#4fb5a5', '#e8505b'][k % 3]; F_.top(ctx.g, u, 1.35, u + 1.1, 1.75, 0, mix(c, INK, 0.2)); F_.top(ctx.g, u + 0.03, 1.38, u + 1.07, 1.72, 0, c); }
  // plants: one in the first free stretch of the back row, a big one at its far end if it's long (none in the dark: the
  // darkroom's is)
  const plant = (from, to, big) => { for (let u = from; u <= to; u += 0.05) if (plantFits(sp, room, u, 0.4)) { plantProp(ctx, room, F_, u, 0.4, big); return u; } return null; };
  const p1 = ['storage', 'server', 'darkroom', 'arcade', 'bar'].includes(room.kind) ? null : plant(a + PLANT_R, end - PLANT_R, end - a >= 1.1); // (arcade)
  if (p1 != null && end - p1 >= 2) plant(end - 0.3, end - 0.3, true);
  // spots to stand and look out of the window: the middle row, wherever it's free
  for (let u = pent ? CORE_X + 0.4 : 0.6; u < end - 0.3; u += 0.5) if (spotFree(sp, room, u, 1.05)) { reserveSpot(sp, room, u, 1.05); anchors.gaze.push({ ...F_.pt(u, 1.05), level: room.level }); }
}

// The meeting room: a long table with ten chairs round it, four behind it facing the
// room, one at each end and four in front of it with their backs to us, the meetings' board on the back wall
// past the table and the door sign by the near doorway. Who sits where, and what the board and the sign say, come from the
// meetings (sim.js decide, render.js drawMeeting). The way to the chairs behind the table is in past its far end, then
// between them and the table. Someone d tiles out from the wall hides it d tiles nearer the room's start and 16·d px lower
// than they are, so the chairs behind the table end where the board starts, and the sign hangs above where the first one
// hides. They stand far enough out that their backs clear the wall's skirting, with floor between, and the ones in front
// stand just inside the lane. The room's window hangs on the wall between the sign and the board (buildRoom).
const MEET = { t0: 1.1, t1: 4.45, d0: 1.38, d1: 1.82, back: 1.16, near: 2.06, behind: [2.03, 2.66, 1.4, 3.29], front: [2.4, 3.2, 1.6, 4.0], aisle: 1.3, way: 5.25, board: [2.5, 6.2], sign: [0.1, 1.2] };
// Past the far end, the places to stand (a, d) in the order they fill, the nearest the table first: two 1.31 out from the
// wall (where a standing head, 21 px, hides none of it), three at the lane's edge between them on screen, so their heads
// come just below the back ones', and the last in the doorway, beside the lane, clear of the end wall's edge. Six is all
// that floor holds with every head clear of everyone else's pixels, the seated ones' too (checked on the sprites, on
// both wings).
const STAND = [[5.125, 1.3125], [4.875, 2.125], [5.75, 1.3125], [5.5, 2.125], [6.125, 2.125], [6.5625, 1.9375]];
const CHAIR = '#8e3b4a'; // the meeting chairs' leather: apart from the room's green skirting and rug
function meetingRoom(ctx, room, F_, a) {
  const { g, props, anchors } = ctx, sp = ctx.space, M = MEET, [, trim, , deskC] = theme(room.kind), level = room.level, P = F_.pt;
  const { t0, t1, d0, d1 } = M, dm = (d0 + d1) / 2;
  if (a > 0.2 || F_.len < M.board[1] + 0.1) return a; // (a feature before it, or a room too short: no table)
  F_.top(g, t0 - 0.75, M.back - 0.4, t1 + 0.75, M.near + 0.28, 0, mix(trim, '#ffd966', 0.3)); F_.top(g, t0 - 0.67, M.back - 0.32, t1 + 0.67, M.near + 0.2, 0, trim); // a rug
  const wood = [mix(deskC, '#ffffff', 0.15), mix(deskC, INK, 0.15), mix(deskC, INK, 0.35)];
  F_.prop(props, 'table', t0, d0, t1, d1, 12, g2 => {
    const pad = (u0, v0, u1, v1) => F_.box(g2, u0, v0, u1, v1, 11, 12, '#fffaf0');
    for (const u of [t0 + 0.45, (t0 + t1) / 2, t1 - 0.45]) F_.box(g2, u - 0.07, dm - 0.07, u + 0.07, dm + 0.07, 0, 9, mix(deskC, INK, 0.4));
    F_.box(g2, t0 + 0.12, d0, t1 - 0.12, d1, 9, 11, wood);
    F_.box(g2, t0, d0 + 0.1, t0 + 0.12, d1 - 0.1, 9, 11, wood); F_.box(g2, t1 - 0.12, d0 + 0.1, t1, d1 - 0.1, 9, 11, wood); // the rounded ends
    for (const u of M.behind) pad(u - 0.14, d0 + 0.06, u + 0.14, d0 + 0.2);
    for (const u of M.front) pad(u - 0.14, d1 - 0.2, u + 0.14, d1 - 0.06); // a pad at every place
    pad(t0 + 0.08, dm - 0.08, t0 + 0.22, dm + 0.08); pad(t1 - 0.22, dm - 0.08, t1 - 0.08, dm + 0.08);
    const j = (t0 + t1) / 2 + 0.33; F_.box(g2, j, dm - 0.06, j + 0.12, dm + 0.06, 11, 17, '#bfe6ff'); F_.box(g2, j, dm - 0.06, j + 0.12, dm + 0.06, 15, 17, '#8fd3ff'); // a water jug
  });
  sp.take(t0, d0, t1, d1);
  sp.take(0, 0, M.way - 0.25, M.near + 0.3); // the chairs round it, with nothing behind them
  anchors.meet = [];
  // the seats in the order they fill: behind the table (the middle two first), the near end, the far end, then in front
  const chairColor = [mix(CHAIR, '#ffffff', 0.2), CHAIR, mix(CHAIR, INK, 0.35)];
  const seat = (u, d, back, o) => { chair(props, room, F_, u, d, back, chairColor, 5); anchors.meet.push({ ...P(u, d), meet: true, pose: 'sit', level, room, h: SEAT_H, ...o }); };
  for (const u of M.behind) seat(u, M.back, [0, -0.18], { via: [P(M.way, M.aisle), P(u, M.aisle)], front: true, right: !F_.X });
  seat(t0 - 0.33, dm, [-0.18, 0], { via: [], front: true, right: F_.X });
  seat(t1 + 0.33, dm, [0.18, 0], { via: [], front: false, right: !F_.X });
  for (const u of M.front) seat(u, M.near, [0, 0.18], { via: [], front: false, right: F_.X });
  // more than the chairs hold stand past the far end, facing the table (STAND). stand() adds the next place (sim.js
  // decide, when every place is taken), so however many come have one: past the last, the places again, a step nearer
  // the table each time round
  const chairs = anchors.meet.length;
  for (const [u, d] of STAND) sp.take(u - R_STAND, d - R_STAND, u + R_STAND, d + R_STAND);
  anchors.stand = () => {
    const k = anchors.meet.length - chairs, [u, d] = STAND[k % STAND.length], off = (Math.floor(k / STAND.length) * 0.15) % 0.45;
    const spot = { ...P(u - off, d), via: [], meet: true, pose: 'stand', front: false, right: !F_.X, level, room };
    anchors.meet.push(spot);
    return spot;
  };
  sp.take(0.3, M.near - 0.25, F_.len - 0.3, room.lv.lane, true); // (and nothing else stands there)
  sp.take(M.board[0], 0, M.board[1], STAND[0][1], true); // nor between the board and the places to stand
  sp.take(M.way - 0.25, M.aisle - 0.25, M.way + 0.25, room.lv.lane, true); // the way in
  meetingWall(ctx, room, F_);
  return M.board[1] + 0.05;
}
// the meeting room's back wall: the board, which shows the meeting's topic and the projects whose plans it changed, and
// the door sign, which runs the next meetings across it (meeting.js draws both every frame). Seen across the room, the
// slab above comes down to 32 px up the back wall (FH - SLAB - 16 * depth) and the board stops two rows of wall short of
// it. The room above's name stands on that floor's edge, the slab's dark face between, so it never reads as the board's
// first line (namePlate).
function meetingWall(ctx, room, F_) {
  const { g, anchors } = ctx, sp = ctx.space, M = MEET;
  const [b0, b1] = M.board, bw = Math.round((b1 - b0) * 16), zb = 1, bh = FH - SLAB - 16 * F_.depth - 2 - zb;
  F_.flat(g, flatCanvas(bw, bh, f => {
    F(f, 0, 0, bw, bh, '#8b8fa3'); F(f, 1, 1, bw - 2, bh - 2, '#f6f1e6'); F(f, 0, bh - 2, bw, 2, '#565a70');
    F(f, bw - 9, bh - 3, 3, 1, '#e8505b'); F(f, bw - 5, bh - 3, 3, 1, '#5b8def'); // markers on its ledge
  }), b0, b1, 0, zb);
  sp.take(b0, 0, b1, 0.2);
  // its words keep inside its frame, and to the part of it the next room's glass doesn't stand in front of: seen across
  // the room, that glass covers this wall from the next room's front post on, as far short of the room's end as the
  // partition runs out from the wall. So they end there, unless the room ends its wing.
  const glass = ctx.last ? b1 : F_.len - partitionDepth(room);
  const w0 = b0 + 2 / 16, w1 = Math.min(b1 - 2 / 16, glass - 1 / 16);
  anchors.board = { F: F_, a0: w0, a1: w1, zb: zb + 3, w: Math.floor((w1 - w0) * 16), h: bh - 6, ledge: zb };
  // the door sign: a little screen on the wall by the near doorway, the next meetings running across it
  const [s0, s1] = M.sign, sw = Math.round((s1 - s0) * 16);
  F_.flat(g, flatCanvas(sw, 14, f => { F(f, 0, 0, sw, 14, '#3b3355'); F(f, 1, 1, sw - 2, 12, '#141a2e'); }), s0, s1, 0, 19);
  sp.take(s0, 0, s1, 0.2);
  anchors.door = { F: F_, a0: s0 + 1 / 16, a1: s1 - 1 / 16, d: 0, zb: 20, w: sw - 2, h: 12 };
}

const SOFA_H = 7; // the cushion's top
function sofa(ctx, room, F_, a, deskStart) {
  const sp = ctx.space, us = [0.5, 1.3];
  if (a + 1.9 > deskStart || !sp.free(a, 0, a + 1.8, 0.75) || !us.every(u => spotFree(sp, room, a + u, 1.05))) return;
  const col = { lobby: '#e07a5f', lounge: '#4fb5a5', nook: '#9b72cf' }[room.kind] || '#e07a5f', g = ctx.g, d0 = 0.08, d1 = 0.7;
  // the back comes up to a sitter's shoulders, the arms to their elbows
  F_.box(g, a, d0, a + 1.8, d1, 0, SOFA_H, col); F_.box(g, a, d0, a + 1.8, d0 + 0.16, SOFA_H, SOFA_H + 6, mix(col, INK, 0.1));
  F_.box(g, a, d0, a + 0.16, d1, SOFA_H, SOFA_H + 3, col); F_.box(g, a + 1.64, d0, a + 1.8, d1, SOFA_H, SOFA_H + 3, col);
  F_.box(g, a + 0.2, d0 + 0.18, a + 0.34, d0 + 0.3, SOFA_H, SOFA_H + 5, '#ffd966');
  const treat = room.kind === 'lounge' && (ctx.holidays.has('sinterklaas') ? 'pepernoten' : ctx.holidays.has('newYear') ? 'oliebollen' : null);
  if (treat) snackBowl(g, ...F_.s(a + 0.9, 0.42, SOFA_H), treat);
  sp.take(a, 0, a + 1.8, 0.75);
  for (const u of us) reserveSpot(sp, room, a + u, 0.45);
  ctx.anchors.sofas = us.map(u => ({ ...F_.pt(a + u, 0.45), via: F_.pt(a + u, 1.05), front: true, right: !F_.X, level: room.level, room, h: SOFA_H }));
  return a + 2;
}
// The cocktail bar, from just past the near end to the far one: a back bar of bottles on shelves lit from below, a neon
// glass over its near end that glows after dark, the counter with a shaker and glasses on it, and red stools in front
// where people take a drink (sim.js 'bar': each stool serves its own). A room of 4 tiles or more has the record player too.
// Under 3 tiles it's a compact one: a short counter with the shaker and two glasses, two stools, and one shelf of bottles
// under a smaller glass.
export const STOOL_H = 11; // the seat's top
const BOTTLES = ['#3f9b5c', '#c98a3e', '#8e3b2c', '#bfe6ff', '#9b72cf', '#e8505b', '#f2c14e', '#4fb5a5'];
const LIMES = [[-2, -2, 5, 2, '#fffaf0'], [-1, -3, 1, 1, '#9fd65a'], [1, -3, 1, 1, '#7bd389'], [0, -4, 1, 1, '#c5e86c']]; // a bowl of them
export const SHAKER = [[-1, -6, 3, 6, '#c9ccd8'], [-1, -6, 1, 6, '#fffaf0'], [1, -6, 1, 6, '#8b8fa3'], [-1, -7, 3, 1, '#8b8fa3'], [0, -9, 1, 2, '#c9ccd8']];
// A round, the bar tapped (hit.js): the shaker up and shaken, a pour into a glass by it, the glass slid along the
// counter to a free place with a sparkle where it stops, and there it stands a while (s). Each round is the next drink.
export const ROUND = { shake: 1.1, pour: 0.35, slide: 0.55, stay: 7, fade: 0.5 };
function bar(ctx, room, F_) {
  const { g, props, anchors } = ctx, len = F_.len, z = room.z;
  const small = len < 3, c0 = small ? 0.25 : len < 4 ? 0.6 : 1, c1 = len - (small ? 0.25 : 0.4), d0 = 0.85, d1 = 1.22, TOP = 14, SD = 1.68; // the counter, its top's height, where the stools stand
  backBar(ctx, room, F_, c0, c1, small);
  // the counter: wood panelled, a dark top with a brass edge, a brass foot rail; on it the shaker, the glasses and the limes
  F_.box(g, c0, d0, c1, d1, 0, TOP - 2, ['#8e5a3a', '#8e5a3a', '#6e4029']);
  for (let u = c0 + 0.3; u < c1 - 0.1; u += 0.5) F_.face(g, u, u + 0.05, d1, 3, TOP - 4, '#6e4029');
  F_.box(g, c0 - 0.05, d0 - 0.05, c1 + 0.05, d1 + 0.06, TOP - 2, TOP, ['#3b2418', '#d9a441', '#a8693f']);
  F_.box(g, c0, d1 + 0.05, c1, d1 + 0.09, 2, 3, '#d9a441');
  const things = small ? [SHAKER, DRINKS.blue, DRINKS.mojito] : [SHAKER, ...Object.values(DRINKS), LIMES], step = (c1 - c0 - 0.5) / (things.length - 1);
  things.forEach((px, k) => {
    if (px === SHAKER) return; // (it moves: render.js drawBar draws it)
    const [x, y] = F_.s(c0 + 0.25 + k * step, 1.0, TOP).map(Math.round);
    for (const [dx, dy, pw, ph, c] of px) F(g, x + dx, y + dy, pw, ph, c);
  });
  // a round's way (ROUND): from the shaker along the counter's front, to one of three places from the far end
  const slid = small ? 0.25 : 0.32;
  anchors.bar = { F: F_, shaker: c0 + 0.25, d: 1.0, front: 1.17, top: TOP, stops: [0, 1, 2].map(k => c1 - 0.3 - k * slid) };
  ctx.hot.push({ type: 'bar', room, ...F_.pt((c0 + c1) / 2, 1.0), z, w: (c1 - c0 + 0.4) * 8 / 12, h: TOP + 12 + (c1 - c0) * 4 });
  anchors.glints.push({ ...F_.pt(c0 + 0.25, 1.0), z: z + TOP + 8 }); // (on the shaker)
  ctx.space.take(c0 - 0.1, 0, c1 + 0.1, d1 + 0.12);
  // the stools
  const glasses = Object.keys(DRINKS);
  anchors.stools = [];
  const us = [];
  if (small) us.push(c0 + 0.4, c1 - 0.4);
  else for (let u = c0 + 0.45; u <= c1 - 0.3; u += 0.75) us.push(u);
  for (const [k, u] of us.entries()) {
    const c = F_.pt(u, SD), sx = Math.round(SX(c.x, c.y)), sy = Math.round(SY(c.x, c.y, z));
    worldProp(props, 'stool', c.x + c.y - 0.05, c.x - 0.25, c.y - 0.25, c.x + 0.25, c.y + 0.25, z, z + STOOL_H + 1, g2 => {
      ellipse(g2, sx, sy - 1, 4, 2, '#3b3355'); F(g2, sx, sy - STOOL_H + 2, 1, STOOL_H - 3, '#c9ccd8'); F(g2, sx - 2, sy - 5, 5, 1, '#d9a441');
      box(g2, c.x - 0.16, c.y - 0.16, z + STOOL_H - 2, c.x + 0.16, c.y + 0.16, z + STOOL_H, ['#e8505b', '#c8404b', '#8e3b2c']);
    });
    reserveSpot(ctx.space, room, u, SD);
    anchors.stools.push({ ...c, front: false, right: F_.X, level: room.level, room, h: STOOL_H, drink: glasses[k % glasses.length] });
  }
}
// the back bar between its ends: a cabinet along the wall, and on the wall over it the sign and the shelves of bottles
// (small: one shelf the cabinet's length, the sign over its middle)
function backBar(ctx, room, F_, c0, c1, small) {
  const { g, anchors } = ctx, r = rng(room.id + 'bar'), z = room.z;
  F_.box(g, c0 + 0.1, 0.05, c1 - 0.1, 0.4, 0, 11, ['#6e4029', '#5a3825', '#3b2418']);
  // the sign: a pink cocktail glass in neon, its olive green; h: half the rim, past its middle
  const h = small ? 4 : 6, S = 2 * h + 3, sa = small ? (c0 + c1 - S / 16) / 2 : c0 + 0.1, sz = small ? 20 : 12;
  F_.flat(g, flatCanvas(S, h + 9, f => {
    const tube = (c, halo) => { // the rim, the bowl's sides, the stem and the foot; the halo a pixel wider all round
      const R = (x, y, w, ht) => halo ? F(f, x - 1, y - 1, w + 2, ht + 2, c) : F(f, x, y, w, ht, c);
      R(1, 2, 2 * h + 1, 1); for (let k = 1; k <= h; k++) { R(1 + k, 2 + k, 1, 1); R(2 * h + 1 - k, 2 + k, 1, 1); } R(h + 1, h + 3, 1, 3); R(h + 1 - (h >> 1), h + 6, (h >> 1) * 2 + 1, 1);
    };
    tube(mix(theme('bar')[0], '#ff5c8a', 0.3), true); tube('#ff5c8a'); F(f, 1, 2, 2 * h + 1, 1, '#ffc2d1'); F(f, h + 1 - (h >> 1), h + 6, (h >> 1) * 2 + 1, 1, '#ffc2d1');
    F(f, h + 4, 0, 1, 2, '#ffd966'); F(f, h + 3, 2, 1, 1, '#ffd966'); F(f, h + 1, 3, 2, 2, '#7bd389'); F(f, h + 1, 3, 1, 1, '#b8f0c8'); // the olive on its pick
  }), sa, sa + S / 16, 0, sz);
  anchors.glows.push({ ...F_.pt(sa + S / 32, 0.15), z: z + sz + 8, c: '#ff5c8a', r: small ? 14 : 18 });
  // and past it two shelves of bottles: a strip on each lights them and the wall from below
  const s0 = small ? c0 + 0.15 : c0 + 1.1, w = Math.round((c1 - 0.15 - s0) * 16), back = '#24323a', H = small ? 8 : 15;
  F_.flat(g, flatCanvas(w, H, f => {
    F(f, 0, 0, w, H, back); F(f, 0, 0, w, 1, '#5a3825');
    for (const y of small ? [7] : [7, 14]) {
      for (let k = 1; k <= 3; k++) F(f, 0, y - k, w, 1, mix(back, '#ffb35a', 0.5 - k * 0.13));
      for (let x = 1; x + 2 < w; x += 3) {
        const c = pick(r, BOTTLES), h = 3 + (r() * 3 | 0);
        F(f, x, y - h, 2, h, c); F(f, x + (r() < 0.5), y - h - 1, 1, 1, mix(c, INK, 0.3)); F(f, x, y - 1, 2, 1, mix(c, '#fff3b0', 0.6));
      }
      F(f, 0, y, w, 1, '#d9a441');
    }
  }), s0, s0 + w / 16, 0, 11);
  for (let u = s0 + 0.4; u < c1 - 0.3; u += 1.1) anchors.glows.push({ ...F_.pt(u, 0.1), z: z + 16, c: '#ffd966', r: 10 });
}
// A bowl on the lounge sofa, between the two seats: pepernoten for Sinterklaas, oliebollen dusted with sugar on New Year's Eve
function snackBowl(g, x, y, treat) {
  x = Math.round(x); y = Math.round(y);
  F(g, x - 4, y - 3, 9, 1, '#34508f'); F(g, x - 3, y - 2, 7, 1, '#fffaf0'); F(g, x - 2, y - 1, 5, 1, '#c9ccd8'); F(g, x - 2, y - 2, 1, 1, '#5b8def'); F(g, x + 1, y - 2, 1, 1, '#5b8def'); // a Delft blue bowl
  if (treat === 'pepernoten') for (const [dy, w] of [[-4, 7], [-5, 5], [-6, 2]]) for (let k = 0; k < w; k++) F(g, x - (w >> 1) + k, y + dy, 1, 1, (k - (w >> 1) + dy) & 1 ? '#c98a4e' : '#8e5a2b'); // a heap of them
  else for (const [dx, dy] of [[-4, -5], [-1, -5], [2, -5], [-2, -7], [1, -7]]) { F(g, x + dx, y + dy, 3, 2, '#c98a3e'); F(g, x + dx + 2, y + dy + 1, 1, 1, '#8e5a2b'); F(g, x + dx, y + dy, 2, 1, '#fffaf0'); } // sugar on top
}
function table(ctx, room, F_, a, review) {
  const d0 = 1.3, d1 = 1.9, w = review ? 2.2 : 1.4;
  F_.prop(ctx.props, 'table', a, d0, a + w, d1, 14, g => {
    for (const [u, v] of [[a + 0.08, d0 + 0.08], [a + w - 0.08, d0 + 0.08], [a + 0.08, d1 - 0.08], [a + w - 0.08, d1 - 0.08]]) F_.box(g, u - 0.05, v - 0.05, u + 0.05, v + 0.05, 0, 9, review ? '#3b2418' : '#6e4029');
    F_.box(g, a, d0, a + w, d1, 9, 11, review ? '#5a3825' : '#a8693f');
    F_.box(g, a + 0.3, d0 + 0.2, a + 0.6, d0 + 0.4, 11, 12, '#fffaf0'); F_.box(g, a + w - 0.6, d0 + 0.2, a + w - 0.35, d0 + 0.45, 11, 14, review ? '#e8505b' : '#5b8def');
  });
}

// The board's desk faces the room, so the penthouse is the one place you see a face at work. The
// executive chair has a real seat under the board, and nothing else may stand where it is.
const EXEC_W = 2; // each board member's desk, chair and the way round them
function execDesk(ctx, room, F_, a) {
  const { props, anchors } = ctx, sp = ctx.space, seats = [];
  room.agents.forEach((ag, k) => {
    const u = a + k * EXEC_W, seat = F_.pt(u + 0.6, 0.75), via = F_.pt(u + 1.55, 0.75);
    sp.take(u + 0.25, 0, u + 1.8, 1.0); sp.take(u + 1.3, 0.5, u + 1.8, room.lv.lane, true); sp.take(u, 1.0, u + 1.35, 1.65); // chair, the way round the desk, the desk
    F_.prop(props, 'throne', u + 0.3, 0.4, u + 0.9, 0.98, 30, g2 => {
      F_.box(g2, u + 0.35, 0.42, u + 0.85, 0.52, 6, 28, ['#8e3a4c', '#6e2c3a', '#4e1f2a']);     // tall back
      F_.box(g2, u + 0.35, 0.5, u + 0.85, 0.95, 5, SEAT_H, ['#9e4658', '#6e2c3a', '#4e1f2a']); // cushion
      F_.box(g2, u + 0.57, 0.66, u + 0.63, 0.72, 0, 5, '#3b3355');                              // pedestal
    }, { at: 0.47, foot: false });
    F_.prop(props, 'execdesk', u, 1.05, u + 1.3, 1.6, 26, g2 => {
      F_.box(g2, u, 1.05, u + 1.3, 1.6, 0, 12, ['#8a5a44', '#6e4029', '#4a2c1c']); F_.face(g2, u + 0.1, u + 1.2, 1.6, 9, 10, '#ffd966');
      F_.box(g2, u + 0.05, 1.1, u + 0.12, 1.5, 12, 22, '#2b2230'); F_.box(g2, u + 0.08, 1.12, u + 0.1, 1.2, 12, 13, '#3b3355');
      F_.box(g2, u + 0.95, 1.3, u + 1.15, 1.45, 12, 15, '#e8505b'); F_.box(g2, u + 0.3, 1.28, u + 0.46, 1.42, 12, 16, '#c9ccd8'); F_.box(g2, u + 0.34, 1.31, u + 0.42, 1.39, 16, 17, '#e8505b');
    }, { at: 1.6 });
    ctx.hot.push({ type: 'phone', room, ...F_.pt(u + 1.05, 1.35), z: room.z + 10, w: 0.35, h: 12 }, { type: 'intercom', room, ...F_.pt(u + 0.38, 1.35), z: room.z + 10, w: 0.3, h: 12 }, { type: 'computer', room, ...F_.pt(u + 0.08, 1.3), z: room.z + 10, w: 0.3, h: 16 });
    anchors.leds.push({ ...F_.pt(u + 1.1, 1.45), z: room.z + 15, c: '#ffd966', phone: 1 });
    seats.push({ x: seat.x, y: seat.y, front: true, right: !F_.X, level: room.level, via, h: SEAT_H });
  });
  return seats;
}

// ---- the core: the elevator and the stairs, in the back corner of every level ----
// Elevator: a dark shaft (so the lit cab stands out) with guide rails, steel corner posts and a sill. The cab,
// the door frame with its floor indicator and the call button are drawn every frame (render.js).
// Stairs: the spiral in its open well (see stairwell below).
const SHAFT_WALL = ['#3f4360', '#343852'], SHAFT_RAIL = '#9aa0bd', STEEL = '#c9ccd8';
function core(ctx, room, L) {
  const { g, props } = ctx, z = room.z, roof = room.lv.roof, lowest = room.level === -L.nDown, sh = roof ? PENT_H : FH, [s0, s1] = SHAFT, lv = room.lv;
  if (room.level > 0 && lv.Cx > lv.D) wallY(g, lv.D, lv.Cx, lv.Cy, z - SLAB, z, '#3b3355'); // the slab's cut edge where the core meets the plaza
  if (!lowest) hole(g, s0, s0, s1, s1, z); // the shaft comes up through this floor
  wallY(g, s0 - 0.08, s1 + 0.05, 0.03, z, z + sh, SHAFT_WALL[0]); wallX(g, 0.03, s1 + 0.05, 0.03, z, z + sh, SHAFT_WALL[1]);
  for (const u of [0.35, 1.0]) { wallY(g, u, u + 0.05, 0.04, z, z + sh, SHAFT_RAIL); wallX(g, u, u + 0.05, 0.04, z, z + sh, SHAFT_RAIL); }
  top(g, s0, s1, s1, s1 + 0.12, z, '#8b8fa3'); // the sill in front of the doors
  for (const [px, py] of [[s1, s0 - 0.05], [s0 - 0.05, s1], [s1, s1]]) worldProp(props, 'post', px + py + 0.2, px - 0.06, py - 0.06, px + 0.06, py + 0.06, z, z + sh, g2 => box(g2, px - 0.05, py - 0.05, z, px + 0.05, py + 0.05, z + sh, STEEL));
  ctx.hot.push({ type: 'elevator', room, x: 0.7, y: 0.7, z, w: 1.4, h: 60 });
  stairwell(ctx, room, z, lowest, roof);
  if (!lowest) ctx.plug = below(z);
}
// What the shaft and the stairwell show of the floor below when that floor isn't drawn (its outside walls are shut):
// the shaft going on down, and the floor below with the flight coming up to this one, cut to the two openings
function below(z) {
  const { cx, cy, x0, x1, RW, n } = STAIR, [s0, s1] = SHAFT, zb = z - FH, X = x1 + 0.5, at = [0, 0, X, CORE, zb, z];
  const [wall, , fl] = theme('core'), floorC = mix(fl, INK, 0.2); // (a floor further down: a little darker)
  const view = sprite(...at, g => {
    // (a line of sight through an opening lands further back on the floor below: all of the core's corner, to its walls)
    wallY(g, 0, X, 0.03, zb, z, mix(wall, INK, 0.25)); wallX(g, 0.03, CORE, 0.03, zb, z, mix(wall, INK, 0.35));
    top(g, s1 + 0.05, 0.03, X, CORE, zb, floorC); top(g, 0.03, s1 + 0.05, s1 + 0.05, CORE, zb, floorC);
    wallY(g, s0 - 0.08, s1 + 0.05, 0.03, zb, z, SHAFT_WALL[0]); wallX(g, 0.03, s1 + 0.05, 0.03, zb, z, SHAFT_WALL[1]);
    const pole = () => box(g, cx - 0.07, cy - 0.07, zb, cx + 0.07, cy + 0.07, z, STEEL_RED);
    [...Array(n).keys(), 'pole'].sort((a, b) => (a === 'pole' ? cx + cy : treadDepth(a)) - (b === 'pole' ? cx + cy : treadDepth(b)))
      .forEach(k => (k === 'pole' ? pole() : tread(g, zb, k)));
  });
  const cut = sprite(...at, g => {
    top(g, s0, s0, s1, s1, z, '#000'); top(g, x0, cy, x1, CORE, z, '#000');
    wedge(g, Math.PI - 0.01, 2 * Math.PI + 0.01, 0, RW, z, '#000'); wallY(g, x0, x1, CORE, z - SLAB - 1, z + 1, '#000');
  });
  const g = view.img.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-in'; g.drawImage(cut.img, 0, 0);
  return view;
}
// cut a horizontal rectangle out of the floor
function hole(g, x0, y0, x1, y1, z) { g.save(); g.globalCompositeOperation = 'destination-out'; top(g, x0, y0, x1, y1, z, '#000'); g.restore(); }
// The spiral stair: oak wedge treads round a red steel pole, a brass handrail on the outside, all one helix in
// an open well. Each floor above the lowest has its well cut out of the front of its slab (see STAIR), with a
// low parapet round it, open where the stair meets the floor. Every tread is its own depth-sorted prop, so
// people on the stair go behind the treads in front of them and in front of the ones behind.
const OAK = ['#e2ad72', '#b87a48', '#9a6238', '#f0c48e'], STEEL_RED = ['#f07a82', '#e8505b', '#b8404f'], RISE = FH / STAIR.n, M = (STAIR.r + STAIR.R) / 2;
export const treadDepth = k => { const a = STAIR.a0 + (k + 0.5) * STAIR.da; return STAIR.cx + STAIR.cy + M * (Math.cos(a) + Math.sin(a)); };
const railDepth = k => { const a = STAIR.a0 + (k + 0.5) * STAIR.da; return STAIR.cx + STAIR.cy + (STAIR.R - 0.05) * (Math.cos(a) + Math.sin(a)); };
function wedge(g, a0, a1, r0, r1, h, c) {
  const { cx, cy } = STAIR;
  let l = Math.floor(SX(cx, cy + r1)) - 1, rr = Math.ceil(SX(cx + r1, cy)) + 1, t = Math.floor(SY(cx - r1, cy - r1, h)) - 1, b = Math.ceil(SY(cx + r1, cy + r1, h)) + 1;
  if (a1 - a0 < 1) { // a thin wedge (a tread): only scan round it
    const ps = [r0, r1].flatMap(rr2 => [0, 0.5, 1].map(u => ({ x: cx + rr2 * Math.cos(a0 + (a1 - a0) * u), y: cy + rr2 * Math.sin(a0 + (a1 - a0) * u) })));
    l = Math.floor(Math.min(...ps.map(p => SX(p.x, p.y)))) - 1; rr = Math.ceil(Math.max(...ps.map(p => SX(p.x, p.y)))) + 1;
    t = Math.floor(Math.min(...ps.map(p => SY(p.x, p.y, h)))) - 1; b = Math.ceil(Math.max(...ps.map(p => SY(p.x, p.y, h)))) + 1;
  }
  g.fillStyle = c;
  for (let py = t; py < b; py++) for (let px = l; px < rr; px++) {
    const p = toTile(px + 0.5, py + 0.5, h), dx = p.x - cx, dy = p.y - cy, r = Math.hypot(dx, dy);
    if (r < r0 || r > r1) continue;
    let a = Math.atan2(dy, dx); while (a < a0) a += 2 * Math.PI;
    if (a <= a1) g.fillRect(px, py, 1, 1);
  }
}
const onRing = (a, rr) => ({ x: STAIR.cx + rr * Math.cos(a), y: STAIR.cy + rr * Math.sin(a) });
const dot = (g, p, h, c, w = 1, hh = 1) => F(g, Math.round(SX(p.x, p.y)), Math.round(SY(p.x, p.y, h)), w, hh, c);
// tread k of the flight that leaves height z: its slab and nosing, then (treadRail) a baluster and its piece of
// the handrail (none on the first and last, where people step on and off; a newel post at each end instead)
function tread(g, z, k) { treadSlab(g, z, k); treadRail(g, z, k); }
function treadSlab(g, z, k) {
  const { r, R, da } = STAIR, a = STAIR.a0 + k * da, h = z + (k + 1) * RISE;
  wedge(g, a, a + da, r, R, h - 2, OAK[2]); wedge(g, a, a + da, r, R, h - 1, OAK[1]); wedge(g, a, a + da, r, R, h, OAK[0]); wedge(g, a, a + 0.07, r, R, h, OAK[3]);
}
function treadRail(g, z, k) {
  const { R, n, da } = STAIR, a = STAIR.a0 + k * da, h = z + (k + 1) * RISE;
  const rail = k > 0 && k < n - 1, post = k === 1 || k === n - 2;
  if ((rail && k % 2) || post) dot(g, onRing(a + da / 2, R - 0.05), h + (post ? 16 : 14), post ? STEEL_RED[2] : STEEL_RED[1], 1, post ? 16 : 14);
  if (post) dot(g, onRing(a + da / 2, R - 0.05), h + 17, '#ffd966', 1, 2);
  if (rail) for (let u = k === 1 ? 0.5 : 0; u <= (k === n - 2 ? 0.5 : 1); u += 0.04) dot(g, onRing(a + u * da, R - 0.05), h + u * RISE + 14, '#e8c170', 1, 2);
}
function treadBox(k, z) {
  const { r, R, da } = STAIR, a = STAIR.a0 + k * da, pts = [r, R].flatMap(rr => [a, a + da / 2, a + da].map(t => onRing(t, rr)));
  return [Math.min(...pts.map(p => p.x)), Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.x)), Math.max(...pts.map(p => p.y)), z + (k + 1) * RISE - 4, z + (k + 1) * RISE + 18];
}
// everything a flight leaving height z draws, as one silhouette: rails on the floor above mustn't cover it
function flightMask(z) {
  const { cx, cy, R, n } = STAIR;
  return sprite(cx - R, cy - R, cx + R, cy + R, z, z + FH + 20, g => { for (let k = 0; k < n; k++) tread(g, z, k); box(g, cx - 0.07, cy - 0.07, z, cx + 0.07, cy + 0.07, z + FH, '#000'); });
}
function stairwell(ctx, room, z, lowest, roof) {
  const { g, props } = ctx, { cx, cy, R, RW, n, x0, x1 } = STAIR;
  if (!lowest) {
    // the well: out of the floor and the slab's front face
    g.save(); g.globalCompositeOperation = 'destination-out';
    top(g, x0, cy, x1, CORE, z, '#000'); wedge(g, Math.PI - 0.01, 2 * Math.PI + 0.01, 0, RW, z, '#000'); wallY(g, x0, x1, CORE, z - SLAB - 1, z + 1, '#000');
    g.restore();
    // a low, round-backed parapet with a brass cap round it, in pieces that sort on their own. The flight from
    // below rises in front of its back and left side, so those let it show through; the right side is in front.
    const below = flightMask(z - FH), H = 7, T = 0.07, cap = '#f6eee0', face = ['#e6d9c3', '#cdbd9f'], brass = '#e8c170';
    const ends = CORE - 0.04, gap = cy + 0.42, back0 = Math.PI + 0.45;
    const piece = (name, bx, depth, draw, see = true) => worldProp(props, name, depth, ...bx, z, z + H + 2, g2 => {
      draw(g2);
      if (see) { g2.globalCompositeOperation = 'destination-out'; g2.drawImage(below.img, below.x, below.y); }
    });
    piece('parapet', [x0 - T, gap, x0, ends], x0 + ends, g2 => {
      wallX(g2, gap, ends, x0, z, z + H, face[0]); wallY(g2, x0 - T, x0, ends, z, z + H, face[1]);
      top(g2, x0 - T, gap, x0, ends, z + H, cap); wallX(g2, gap, ends, x0, z + H - 1, z + H, brass);
    });
    for (let i = 0; i < 4; i++) {
      const t0 = back0 + (2 * Math.PI - back0) * i / 4, t1 = back0 + (2 * Math.PI - back0) * (i + 1) / 4, m = onRing((t0 + t1) / 2, RW);
      const ps = [t0, (t0 + t1) / 2, t1].flatMap(t => [onRing(t, RW), onRing(t, RW + T)]);
      piece('parapet', [Math.min(...ps.map(p => p.x)), Math.min(...ps.map(p => p.y)), Math.max(...ps.map(p => p.x)), Math.max(...ps.map(p => p.y))], m.x + m.y, g2 => {
        for (let t = t0; t <= t1 + 1e-6; t += 0.01) { const k = Math.max(0, -Math.cos(t)); dot(g2, onRing(t, RW), z + H, k > 0.55 ? face[1] : face[0], 1, H); }
        wedge(g2, t0, t1, RW, RW + T, z + H, cap);
        for (let t = t0; t <= t1 + 1e-6; t += 0.01) dot(g2, onRing(t, RW), z + H, brass);
        if (i === 0) { const p = onRing(t0, RW), q = onRing(t0, RW + T); for (let u = 0; u <= 1; u += 0.2) dot(g2, { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u }, z + H, face[1], 1, H); }
      });
    }
    piece('parapet', [x1, cy, x1 + T, ends], x1 + T + cy, g2 => {
      wallX(g2, cy, ends, x1 + T, z, z + H, face[1]); wallY(g2, x1, x1 + T, ends, z, z + H, face[0]);
      top(g2, x1, cy, x1 + T, ends, z + H, cap); wallX(g2, cy, ends, x1 + T, z + H - 1, z + H, brass);
    }, false);
    if (room.level === 0) piece('rail', [x0 - T, ends - 0.02, x1 + T, ends + 0.02], x1 + CORE, g2 => {
      for (let u = x0; u <= x1 + 1e-6; u += 0.02) { const p = { x: u, y: ends }; dot(g2, p, z + H + 3, brass); if (Math.abs((u - x0) / 0.36 - Math.round((u - x0) / 0.36)) < 0.03) dot(g2, p, z + H + 2, '#565a70', 1, H + 2); }
    }, false);
  }
  if (roof) { // the pole's top: a brass ball
    worldProp(props, 'pole', cx + cy, cx - 0.1, cy - 0.1, cx + 0.1, cy + 0.1, z, z + 24, g2 => {
      box(g2, cx - 0.07, cy - 0.07, z, cx + 0.07, cy + 0.07, z + 16, STEEL_RED);
      const sx = Math.round(SX(cx, cy)), sy = Math.round(SY(cx, cy, z + 19));
      disc(g2, sx, sy, 3, '#c9912e'); F(g2, sx - 2, sy - 2, 3, 2, '#ffd966'); F(g2, sx - 1, sy - 2, 1, 1, '#fff3b0');
      // and a robin who has made it her spot
      F(g2, sx - 2, sy - 5, 4, 2, '#8e5a34'); F(g2, sx + 1, sy - 6, 2, 2, '#8e5a34'); F(g2, sx + 1, sy - 4, 2, 1, '#e8505b'); F(g2, sx + 3, sy - 5, 1, 1, '#ffd966'); F(g2, sx + 2, sy - 6, 1, 1, INK); F(g2, sx - 3, sy - 5, 1, 1, '#6e4029');
    });
    return;
  }
  // the cut face of the well in the floor above, behind every tread that overlaps it
  const zt = z + FH;
  for (let t = Math.PI * 0.75; t <= Math.PI * 1.75; t += 0.005) { const p = onRing(t, RW + 0.01); dot(g, p, zt - 1, '#3b3355', 1, SLAB - 1); dot(g, p, zt, '#565a70'); }
  wallX(g, cy, CORE, x0, zt - SLAB, zt, '#3b3355'); wallX(g, cy, CORE, x0, zt - 1, zt, '#565a70');
  // the pole, and the treads round it
  worldProp(props, 'pole', cx + cy, cx - 0.1, cy - 0.1, cx + 0.1, cy + 0.1, z, zt + 2, g2 => {
    box(g2, cx - 0.07, cy - 0.07, z, cx + 0.07, cy + 0.07, zt, STEEL_RED);
  });
  // the railing sorts by the outer edge, where it stands: on the near side in front of anyone on the stair,
  // on the far side behind them
  for (let k = 0; k < n; k++) {
    const [a, b, c2, d2, z0, z1] = treadBox(k, z);
    worldProp(props, 'tread', treadDepth(k), a, b, c2, d2, z0, z1, g2 => treadSlab(g2, z, k));
    worldProp(props, 'rail', railDepth(k), a, b, c2, d2, z0, z1, g2 => treadRail(g2, z, k));
  }
  // fairy lights wound along the handrail on the near side, lit after dark
  // (only where they show: not behind the pole, nor under the floor above, whose glow would come through it)
  for (let k = 2; k < n - 2; k += 2) {
    const a = STAIR.a0 + (k + 0.5) * STAIR.da, p = onRing(a, R - 0.05), h = (k + 1.5) * RISE + 15, d = (FH - h) / 16;
    if (Math.cos(a) + Math.sin(a) > 0.2 && (d <= 0 || p.y + d >= CORE || inWell(p.x + d, p.y + d))) ctx.anchors.bulbs.push({ ...p, z: z + h });
  }
}

// A wooden water tower on splayed legs: a hooped barrel of staves under a conical roof with a pennant.
const line = (g, x1, y1, x2, y2, c) => { const n = Math.max(1, Math.round(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)))); for (let k = 0; k <= n; k++) F(g, Math.round(x1 + (x2 - x1) * k / n), Math.round(y1 + (y2 - y1) * k / n), 1, 1, c); };
function waterTower(g, c, z) {
  const sx = SX(c.x, c.y), sy = SY(c.x, c.y, z), R = 10, LEG = 14, BODY = 17, CONE = 10, yb = sy - LEG, yt = yb - BODY, ry = x => Math.round(R / 2 * Math.sqrt(Math.max(0, 1 - (x / R) ** 2)));
  ellipse(g, sx, sy, 15, 6, 'rgba(29,26,47,.16)');
  const at = (ox, oy, t) => [sx + Math.round(ox * (1 - 0.3 * t)), Math.round(sy + oy * (1 - 0.3 * t) - (sy - yb) * t)];
  const legs = [[0, -6, '#5a3825'], [-13, 0, '#6e4029'], [13, 0, '#5a3825'], [0, 6, '#7a4a2c']];
  for (const [ox, oy, col] of legs) { line(g, ...at(ox, oy, 0), ...at(ox, oy, 1), col); if (oy >= 0) line(g, ...at(ox, oy, 0).map((v, i) => v + (i ? 0 : 1)), ...at(ox, oy, 1).map((v, i) => v + (i ? 0 : 1)), mix(col, INK, 0.2)); }
  for (const [i, j] of [[0, 1], [0, 2], [1, 3], [2, 3]]) line(g, ...at(legs[i][0], legs[i][1], 0.5), ...at(legs[j][0], legs[j][1], 0.5), j === 3 ? '#8a5a3a' : '#5a3825'); // a brace round the legs
  for (let x = -R; x < R; x++) {
    const e = ry(x + 0.5), k = (x + R) / (2 * R), base = k < 0.3 ? '#c98a52' : k < 0.72 ? '#a8693f' : '#7a4a2c';
    F(g, sx + x, yt + e, 1, BODY, (x + R) % 4 === 3 ? mix(base, INK, 0.2) : base);
    for (const h of [3, 12]) F(g, sx + x, yb + e - h, 1, 1, '#3b3355');
  }
  { const y = yb - 12, P = '#ff8fab'; F(g, sx - 5, y, 2, 1, P); F(g, sx - 2, y, 2, 1, P); F(g, sx - 5, y + 1, 5, 1, P); F(g, sx - 4, y + 2, 3, 1, P); F(g, sx - 3, y + 3, 1, 1, P); } // a little painted heart
  for (let k = 0; k <= CONE; k++) { const w = Math.round((R + 2) * (1 - k / CONE)); if (w < 1) break; ellipse(g, sx, yt - k, w, Math.max(1, w >> 1), k ? '#8e3b2c' : '#6e2c2a'); if (w > 2) ellipse(g, sx - 2, yt - k - 1, w - 3, Math.max(1, (w - 3) >> 1), k ? '#c8553d' : '#8e3b2c'); }
  F(g, sx, yt - CONE - 5, 1, 5, '#3b3355'); F(g, sx + 1, yt - CONE - 5, 3, 1, '#ffd966'); F(g, sx + 1, yt - CONE - 4, 2, 1, '#ffd966');
}

// ---- roof terrace: the board's garden, the mascots' domain ----
function terraceProps(ctx, room, F_, L) {
  const { g, props, anchors, hot } = ctx, n = F_.len, z = room.z, sp = ctx.space;
  // a glass railing along the open edge and across the wing's far end, a prop a tile at a time, so whoever is up here
  // stands behind it (one long one would sort as a single depth: someone at its far end would stand in front)
  const d = F_.depth, rail = (g2, face) => { g2.globalAlpha = 0.3; face(0, 9, '#bfe6ff'); g2.globalAlpha = 1; face(9, 10, '#fdf3e1'); };
  for (let u = 0; u < n; u++) {
    const u1 = Math.min(n, u + 1);
    F_.prop(props, 'railing', u, d - 0.02, u1, d, 10, g2 => rail(g2, (z0, z1, c) => F_.face(g2, u, u1, d, z0, z1, c)), { at: d, foot: false });
  }
  if (room.x1 === L.X1 || room.y1 === L.Y1) for (let k = 0; k < d; k++) {
    const k1 = Math.min(d, k + 1);
    F_.prop(props, 'railing', n - 0.02, k, n, k1, 10, g2 => rail(g2, (z0, z1, c) => F_.X ? wallX(g2, k, k1, room.x1, z + z0, z + z1, c) : wallY(g2, k, k1, room.y1, z + z0, z + z1, c)), { at: k + 0.5, foot: false });
  }
  sp.take(-1, room.lv.lane - 0.35, n + 1, d + 1, true);
  // string lights on posts along the back parapet, sagging between them and lit at night (first: all else stands in front)
  anchors.lights = []; anchors.bulbs = [];
  const BACK = 0.12, POST = 26, hang = u => z + POST - 2 - Math.round(Math.sin((u % 2) / 2 * Math.PI) * 5);
  for (let u = 0; u <= n; u += 2) { const p = F_.pt(Math.min(u, n - 0.05), BACK), sx = SX(p.x, p.y), sy = SY(p.x, p.y, z); F(g, sx, sy - POST, 1, POST, '#3b3355'); F(g, sx - 1, sy - POST - 1, 3, 1, '#3b3355'); }
  for (let u = 0; u < n; u += 1 / 16) { const p = F_.pt(u, BACK); F(g, SX(p.x, p.y), SY(p.x, p.y, hang(u)), 1, 1, '#3b3355'); }
  for (let u = 0.25; u < n; u += 0.5) { const p = F_.pt(u, BACK); anchors.bulbs.push({ ...p, z: hang(u) - 1 }); F(g, SX(p.x, p.y), SY(p.x, p.y, hang(u)) + 1, 1, 2, '#c9a27a'); }
  // the first mascot that sleeps up here: a basket, and a bowl with its initial (mascots.js beds the others)
  const pet = L.pets.find(m => m.rules.night === 'sleep');
  const put = (a, name) => {
    if (a + 1 > n) return false;
    const p = (a0, d0, a1, d1, zz, draw, at) => { F_.prop(props, name, a0, d0, a1, d1, zz, draw, { at }); sp.take(a0, d0, a1, d1); };
    if (name === 'jacuzzi') {
      F_.box(g, a + 0.1, 0.2, a + 1.9, 1.9, 0, 8, ['#fdf3e1', '#e6e8f0', '#c9ccd8']);
      F_.top(g, a + 0.25, 0.35, a + 1.75, 1.75, 8, '#4fb5d5');
      anchors.jacuzzi = { a0: a + 0.25, a1: a + 1.75, d0: 0.35, d1: 1.75, z: z + 8, F: F_, ...F_.pt(a + 1, 1) };
      hot.push({ type: 'jacuzzi', room, ...F_.pt(a + 1, 1), z, w: 2, h: 14 });
      sp.take(a + 0.1, 0.2, a + 1.9, 1.9);
      return 2.2;
    }
    if (name === 'loungers') {
      for (let k = 0; k < 2; k++) { const u = a + 0.15 + k * 0.6; p(u, 0.4, u + 0.45, 1.6, 10, g2 => { F_.box(g2, u, 0.7, u + 0.45, 1.6, 2, 5, '#fffaf0'); F_.box(g2, u, 0.4, u + 0.45, 0.72, 2, 11, '#fffaf0'); F_.top(g2, u + 0.05, 0.9, u + 0.4, 1.5, 5, k ? '#5b8def' : '#e8505b'); }); }
      return 1.4;
    }
    if (name === 'parasol') { F_.prop(props, name, a + 0.1, 0.6, a + 1.1, 1.6, 34, g2 => { const c = F_.pt(a + 0.6, 1.1), sx = SX(c.x, c.y), sy = SY(c.x, c.y, z); F(g2, sx, sy - 28, 1, 28, '#fdf3e1'); for (let i = 0; i < 8; i++) F(g2, sx - 14 + i * 2, sy - 26 - Math.min(i, 7 - i), 4, 2 + Math.min(i, 7 - i), i % 2 ? '#fffaf0' : '#e8505b'); ellipse(g2, sx, sy, 6, 3, 'rgba(29,26,47,.2)'); }, { foot: [a + 0.5, 1.0, a + 0.7, 1.2] }); sp.take(a + 0.5, 1.0, a + 0.7, 1.2); return 1.2; }
    if (name === 'telescope') { p(a + 0.3, 0.3, a + 0.8, 0.8, 22, g2 => { const c = F_.pt(a + 0.5, 0.5), sx = SX(c.x, c.y), sy = SY(c.x, c.y, z); F(g2, sx - 3, sy - 1, 1, 1, '#3b3355'); F(g2, sx + 3, sy - 1, 1, 1, '#3b3355'); F(g2, sx, sy - 12, 1, 12, '#3b3355'); for (let i = 0; i < 6; i++) F(g2, sx - 4 + i, sy - 14 - i, 3, 2, '#ffd966'); }); hot.push({ type: 'telescope', room, ...F_.pt(a + 0.5, 0.5), z, w: 0.8, h: 24 }); return 1; }
    if (name === 'basket') { const c = F_.pt(a + 0.5, 0.5); ellipse(g, SX(c.x, c.y), SY(c.x, c.y, z) - 2, 8, 4, '#a8693f'); ellipse(g, SX(c.x, c.y), SY(c.x, c.y, z) - 3, 6, 3, '#e8505b'); anchors.basket = c; return 1; }
    if (name === 'bowl') { const c = F_.pt(a + 0.4, 0.4); ellipse(g, SX(c.x, c.y), SY(c.x, c.y, z) - 1, 3, 2, '#5b8def'); F(g, SX(c.x, c.y) - 1, SY(c.x, c.y, z) - 2, 3, 1, '#a8693f'); text(g, pet.name[0].toUpperCase(), SX(c.x, c.y) - 1, SY(c.x, c.y, z) - 8, '#ffd966'); return 0.7; }
    if (name === 'tower') { p(a + 0.1, 0.1, a + 1.3, 1.3, 50, g2 => waterTower(g2, F_.pt(a + 0.7, 0.7), z)); hot.push({ type: 'weather', room, ...F_.pt(a + 0.7, 0.7), z, w: 1.2, h: 50 }); return 1.5; }
    if (name === 'beds') { // a raised bed of flowers
      const r = rng(room.id + 'beds'); F_.box(g, a + 0.1, 0.15, a + 1.2, 0.7, 0, 7, ['#c98a52', '#a8693f', '#6e4029']); F_.top(g, a + 0.16, 0.2, a + 1.14, 0.64, 7, '#5a3825');
      for (let i = 0; i < 16; i++) { const [sx, sy] = F_.s(a + 0.2 + r() * 0.9, 0.25 + r() * 0.35, 7); const h = 2 + (r() * 3 | 0); F(g, sx, sy - h, 1, h, '#3f9b5c'); F(g, sx - (i % 2), sy - h - 1, 1 + (i % 2), 1 + (i % 2), pick(r, ['#ff8fab', '#ffd966', '#fffaf0', '#e8505b', '#9b72cf'])); }
      sp.take(a + 0.1, 0.15, a + 1.2, 0.7); return 1.3;
    }
    if (name === 'bench') { // a garden bench with a cushion, looking out over the rooftops
      if (a + 1.05 > n) return false;
      for (const u of [a + 0.15, a + 0.9]) F_.box(g, u, 0.35, u + 0.06, 0.6, 0, 5, '#3b3355');
      F_.box(g, a + 0.1, 0.33, a + 1.0, 0.62, 5, 7, ['#cf9460', '#a8693f', '#6e4029']); F_.box(g, a + 0.1, 0.28, a + 1.0, 0.34, 7, 15, ['#cf9460', '#a8693f', '#6e4029']);
      F_.box(g, a + 0.2, 0.36, a + 0.45, 0.58, 7, 9, '#ff8fab'); sp.take(a + 0.1, 0.28, a + 1.0, 0.62); return 1.1;
    }
    if (name === 'solar') { for (let k = 0; k < 2; k++) { const u = a + 0.1 + k * 0.9; F_.box(g, u, 0.2, u + 0.8, 1.4, 4, 6, ['#5b8def', '#34508f', '#23283f']); F_.top(g, u + 0.05, 0.25, u + 0.4, 0.8, 6, '#8fb2ff'); } sp.take(a + 0.1, 0.2, a + 1.8, 1.4); return 1.9; }
    // the AC unit sorts with the other props; its fan spins just in front of it (render.js)
    if (name === 'ac') { const s = F_.s(a + 0.5, 0.45, 14); p(a + 0.1, 0.1, a + 0.9, 0.8, 14, g2 => { F_.box(g2, a + 0.1, 0.1, a + 0.9, 0.8, 0, 14, '#c9ccd8'); ellipse(g2, s[0], s[1], 7, 3, '#565a70'); }); const c = F_.pt(a + 0.5, 0.45); anchors.fans.push({ x: s[0], y: s[1], d: c.x + c.y + 0.001 }); sp.take(a + 0.1, 0.1, a + 0.9, 0.8); return 1; }
    if (name === 'antenna') { const c = F_.pt(a + 0.5, 0.5), sx = SX(c.x, c.y), sy = SY(c.x, c.y, z); F(g, sx, sy - 60, 1, 60, '#565a70'); F(g, sx - 4, sy - 44, 9, 1, '#565a70'); F(g, sx - 3, sy - 52, 7, 1, '#565a70'); anchors.leds.push({ ...c, z: z + 62, c: '#ff4d5e', antenna: 1 }); ellipse(g, sx + 8, sy - 2, 7, 4, '#e6e8f0'); F(g, sx + 7, sy - 6, 2, 4, '#8b8fa3'); return 1; }
    if (name === 'planters') { for (let k = 0; k < 3; k++) { const u = a + 0.3 + k * 0.45; if (plantFits(sp, room, u, 0.3)) plantProp(ctx, room, F_, u, 0.3, k === 1); } return 1.4; }
    if (name === 'grill') { F_.box(g, a + 0.25, 0.2, a + 0.75, 0.6, 8, 13, '#2b2230'); F_.box(g, a + 0.45, 0.35, a + 0.55, 0.45, 0, 8, '#565a70'); sp.take(a + 0.25, 0.2, a + 0.75, 0.6); return 1; }
    return 1;
  };
  const list = room.garden ? ['planters', 'tower', ...pet ? ['basket', 'bowl'] : [], 'beds', 'bench', 'planters', 'solar', 'ac', 'grill'] : L.pent ? ['jacuzzi', 'loungers', 'parasol', 'telescope', 'planters', 'ac', 'antenna'] : ['ac', 'antenna', 'solar'];
  anchors.fans = [];
  let a = 0.2;
  for (const name of list) { const w = put(a, name); if (w === false) break; a += w + 0.15; }
  // bulbs behind something tall (the water tower, a big plant) stay hidden, glow and all
  const probe = canvas(1, 1).getContext('2d', { willReadFrequently: true }), covers = (q, x, y) => { probe.clearRect(0, 0, 1, 1); probe.drawImage(q.img, x - q.x, y - q.y, 1, 1, 0, 0, 1, 1); return probe.getImageData(0, 0, 1, 1).data[3] > 0; };
  for (const b of anchors.bulbs) { const x = Math.round(SX(b.x, b.y)), y = Math.round(SY(b.x, b.y, b.z)); b.hid = props.some(q => x >= q.x && y >= q.y && x < q.x + q.img.width && y < q.y + q.img.height && covers(q, x, y)); }
}
