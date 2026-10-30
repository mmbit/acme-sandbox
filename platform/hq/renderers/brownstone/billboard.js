// The street-end screen: the company's promo loop, at 1 px per pixel
import { INK, text, textW, disc } from './iso.js';
import { canvas, mix, clamp, rng, picture } from '../../util.js';

export const BILLBOARD = { w: 36, h: 52 };
const W = BILLBOARD.w, H = BILLBOARD.h;

const CREAM = '#fffaf0', GOLD = '#ffd966', GOLD_LT = '#fff3b0', GOLD_DK = '#e8a33d', RED = '#e8505b', PINK = '#ff8fab';
const TEAL = '#4fb5a5', PURPLE = '#9b72cf', GREEN = '#7bd389', GREEN_DK = '#5cc26a', ORANGE = '#ff9b4a';
const CAT = '#3b3355', CAT2 = '#4f4670', PLUM = '#2a2352';

// ---------------------------------------------------------------- small cached pieces
const cache = new Map();
const once = (k, w, h, draw) => {
  let c = cache.get(k);
  if (!c) { c = canvas(w, h); const g = c.getContext('2d'); g.imageSmoothingEnabled = false; draw(g); cache.set(k, c); }
  return c;
};
const R = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
// pixel art from strings: one char per pixel, '.' is clear
const art = (k, rows, pal) => once(k, rows[0].length, rows.length, g => rows.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) R(g, x, y, 1, 1, pal[ch]); })));
const word = (s, c, k = 1) => once(`w|${s}|${c}|${k}`, Math.max(1, textW(s, k)), 5 * k, g => text(g, s, 0, 0, c, k));
const cx = (s, k = 1) => Math.floor((W - textW(s, k)) / 2);
const say = (g, s, y, c, k = 1, x = cx(s, k)) => g.drawImage(word(s, c, k), x, y);
const stripes = (k, cols) => once(k, W, H, g => cols.forEach((c, i) => R(g, 0, Math.round(H * i / cols.length), W, H, c)));

const ease = x => { x = clamp(x, 0, 1); return 1 - (1 - x) ** 3; };
const pop = x => { x = clamp(x, 0, 1); return 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2; }; // overshoots a little
const hop = (t, t0, d, hgt) => (t > t0 && t < t0 + d ? Math.round(Math.sin((t - t0) / d * Math.PI) * hgt) : 0);
const blink = (t, every, off = 0) => ((t + off) % every) < 0.14;

// ---------------------------------------------------------------- sprites
const TEE = ['..XX..XX..', '.XXXXXXXX.', 'XXXXXXXXXS', 'XXXXXXXXSS', '..XXXXXS..', '..XXXXXS..', '..XXXXXS..', '..XXXXXS..', '..SSSSSS..'];
const HEART = ['.R.R.', 'RRRRR', 'RRRRR', '.RRR.', '..R..'];
const PAW = ['W.W', '.W.', 'WWW'];
// the cat: plum fur, gold eyes, a red board-member collar with a gold tag
const CAT_PAL = { K: CAT, k: CAT2, Y: GOLD, R: RED, G: GOLD, P: PINK };
const WALK = [
  ['k...........K.K.', '.k..........KKK.', '.k.........KYKY.', '..k........KKPK.', '..KKKKKKKKKRRRR.', '..KKKKKKKKKKGK..', '..KKKKKKKKKKKK..', '..K.K.....K..K..', '..k.k.....k..k..'],
  ['k...........K.K.', '.k..........KKK.', '.k.........KYKY.', '..k........KKPK.', '..KKKKKKKKKRRRR.', '..KKKKKKKKKKGK..', '..KKKKKKKKKKKK..', '...K.K.....KK...', '...k.k.....kk...'],
];
const SIT = eyes => ['.K...K.....', '.KK.KK.....', '.KKKKK.....', `.${eyes}.....`, '.KKPKK.....', '.RRRRR.....', '.KKGKK.....', 'KKKKKKK....',
  'KKKKKKK....', 'KKKKKKK..k.', 'KKKKKKK..k.', 'KKKKKKK.k..', 'KKKKKKKkk..', 'kK.k.Kk....'];
const SIT_TAIL_UP = rows => rows.map((r, i) => (i === 8 ? 'KKKKKKK.k..' : i === 9 ? 'KKKKKKK..k.' : r));

// ---------------------------------------------------------------- scenes
// each: (g, t local seconds, d its length, env, loop index, its slide in brand.billboard, the logo)
function logo(g, t, d, env, loop, s, lg) {
  g.drawImage(stripes('logo-bg', ['#1d1a2f', '#221d3c', '#28214a', '#2e2656', '#342b61']), 0, 0);
  const STARS = [[3, 4], [31, 6], [7, 16], [29, 21], [2, 27], [33, 33], [15, 2], [23, 45], [5, 44]];
  STARS.forEach(([x, y], i) => R(g, x, y, 1, 1, ((t * 1.7 + i * 0.37) % 1) < 0.25 ? GOLD_LT : '#5a5290'));
  // seasonal weather on the screen: snow, petals, leaves, or summer fireflies
  const sea = env.season || 'autumn', col = { winter: CREAM, spring: PINK, autumn: ORANGE, summer: GOLD }[sea];
  for (let i = 0; i < 6; i++) {
    const sp = sea === 'summer' ? 3 : 7 + i % 3 * 2, y = sea === 'summer' ? 26 + ((i * 13) % 20) + Math.round(Math.sin(t * 2 + i) * 2) : Math.floor((t * sp + i * 9) % (H + 4)) - 2;
    const x = Math.floor((i * 6.3 + 2 + Math.sin(t * 1.3 + i * 2) * 2 + (sea === 'summer' ? t * 1.5 : 0)) % W);
    if (sea !== 'summer' || ((t + i * 0.3) % 1.2) < 0.8) R(g, x, y, sea === 'autumn' && i % 2 ? 2 : 1, 1, col);
  }
  // the logo, stacked into its lines to fit, drops in pixel by pixel; then its accent lights up
  const px = lockup(lg), lit = t > 1.86 || (t > 1.7 && t < 1.78), flash = t > 1.86 && t < 1.98;
  for (const p of px) if (t >= p.d + 0.3) R(g, p.x, p.y + 1, 1, 1, lg.colours.shadow); // the shadow, under what has landed
  for (const p of px) if (t > p.d) R(g, p.x, p.y - Math.round((1 - pop((t - p.d) / 0.3)) * 9), 1, 1, !p.one ? lg.colours.ink : !lit ? '#5a5290' : flash ? GOLD_LT : lg.colours.accent);
  if (t > 2.1 && (t % 1.1) < 0.5) { const [x, y] = (t % 2.2) < 1.1 ? [34, 21] : [1, 26]; R(g, x, y - 1, 1, 3, CREAM); R(g, x - 1, y, 3, 1, CREAM); }
  if (t > 2.1) { const k = Math.floor((t - 2.1) * 4); for (let i = 0; i < 3; i++) R(g, 13 + i * 4, 49, 2, 1, i === k % 3 ? PINK : '#5a5290'); }
}
// the logo's pixels in its lines (columns from..to), 14 rows apart, with a seeded moment each
const lockups = new WeakMap();
const lockup = lg => lockups.get(lg) ?? lockups.set(lg, lg.lines.flatMap(([a, b], line) => {
  const r = rng('logo' + line), x0 = Math.floor((W - (b - a)) / 2), y0 = 3 + line * 14, out = [];
  lg.pixels.forEach((row, v) => { for (let u = a; u < b; u++) if (row[u] !== '.') out.push({ x: x0 + u - a, y: y0 + v, one: row[u] === 'o', d: 0.1 + line * 0.25 + r() * 0.6 }); });
  return out;
})).get(lg);

function oneOfAKind(g, t, d, env, loop, { lines: [top, a, b, bottom] }) {
  g.drawImage(once('kind-bg', W, H, c => { R(c, 0, 0, W, H, '#fdf3e1'); R(c, 0, 38, W, 1, '#cf9460'); R(c, 0, 39, W, 2, '#a8693f'); R(c, 0, 41, W, H, '#f3e4c6'); }), 0, 0);
  const x = cx(`${a} ${b}`);
  say(g, top, 5, INK); say(g, a, 12, INK, 1, x); say(g, b, 12, RED, 1, x + (a.length + 1) * 4);
  const grey = art('tee-grey', TEE, { X: '#b9b3c9', S: '#8b8fa3' });
  const fancy = once('tee-fancy', 10, 9, c => { c.drawImage(art('tee-pink', TEE, { X: PINK, S: '#e0708e' }), 0, 0); c.drawImage(art('heart-s', ['XX.XX', 'XXXXX', '.XXX.', '..X..'], { X: RED }), 2, 3); R(c, 2, 3, 1, 1, '#ffc2d1'); });
  // the plain ones wait, and the middle one hops, becomes itself, and is very pleased about it
  g.drawImage(grey, 2, 29 - hop(t, 2.5, 0.3, 1)); g.drawImage(grey, 24, 29 - hop(t, 2.65, 0.3, 1));
  const y = hop(t, 0.8, 0.5, 7) || hop(t, 1.7, 0.35, 4) || hop(t, 2.2, 0.3, 3);
  const me = t > 1.05 ? fancy : grey;
  g.drawImage(me, 13, 29 - y);
  if (t > 1.05 && t < 1.6) { const r = Math.round((t - 1.05) * 14); for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) R(g, 18 + dx * (6 + r), 26 - y + dy * (5 + r), 1, 1, GOLD_DK); }
  if (t > 1.05) R(g, 14 + (y ? 1 : 0), 38, y ? 8 : 10, 1, '#b8693f'); // its shadow on the shelf
  if (t > 1.7) say(g, bottom, 44, INK);
}

function mug(g, t, d, env, loop, { lines: [top], names }) {
  g.drawImage(once('mug-bg', W, H, c => {
    R(c, 0, 0, W, H, '#bfe6ff'); R(c, 0, 12, W, 30, '#aee0ff'); R(c, 0, 42, W, 1, '#e0a970'); R(c, 0, 43, W, H, '#cf9460'); R(c, 0, 47, W, 1, '#b8693f');
    R(c, 5, 41, 22, 1, '#a8c8e0'); // the mug's shadow
  }), 0, 0);
  say(g, top, 5, INK);
  const m = once('mug', 26, 20, c => {
    R(c, 0, 0, 20, 20, CREAM); R(c, 0, 0, 20, 1, '#e6d2ac'); R(c, 1, 1, 18, 1, '#6e4029'); R(c, 17, 2, 3, 18, '#efe2c8'); R(c, 0, 19, 20, 1, '#e6d2ac');
    R(c, 20, 4, 5, 2, CREAM); R(c, 20, 13, 5, 2, CREAM); R(c, 23, 6, 2, 7, '#efe2c8'); R(c, 20, 6, 1, 7, '#e6d2ac');
  });
  g.drawImage(m, 6, 22);
  const name = names[loop % names.length], nx = 6 + Math.floor((17 - textW(name)) / 2);
  const per = 0.32, t0 = 0.7;
  const n = clamp(Math.floor((t - t0) / per) + 1, 0, name.length);
  if (n > 0) g.drawImage(word(name.slice(0, n), RED), nx, 30);
  if (n < name.length && t > t0 - 0.3 && (t % 0.3) < 0.2) R(g, nx + n * 4, 36, 3, 1, INK);          // the cursor, before the next letter
  if (n > 0 && n <= name.length && t < t0 + name.length * per + 0.2) {                               // a sparkle where the ink lands
    const sx = nx + n * 4 - 3, f = ((t - t0) % per) / per;
    if (f < 0.5) { R(g, sx + 1, 27, 1, 1, GOLD_DK); R(g, sx - 1, 28, 1, 1, GOLD_DK); R(g, sx + 3, 28, 1, 1, GOLD_DK); }
  }
  // steam, then a heart rises out of it
  for (let k = 0; k < 2; k++) for (let i = 0; i < 3; i++) {
    const y = 20 - ((t * 5 + i * 3 + k * 4) % 9 | 0), x = 12 + k * 7 + Math.round(Math.sin(t * 3 + i + k * 2) * 1);
    R(g, x, y, 1, 1, CREAM);
  }
  const hp = t - (t0 + name.length * per + 0.4);
  if (hp > 0) g.drawImage(art('heart', HEART, { R: RED }), 14 + Math.round(Math.sin(hp * 5)), Math.max(11, 18 - Math.round(hp * 9)));
}

function printer(g, t, d, env, loop, { lines: [a, b] }) {
  g.drawImage(once('print-bg', W, H, c => { R(c, 0, 0, W, H, '#ffe3c7'); R(c, 0, 36, W, H, '#ffd2ae'); }), 0, 0);
  // the picture it prints: the old street mural, in miniature (sun, balloon, hills)
  const pic = once('pic', 18, 20, c => {
    R(c, 0, 0, 18, 20, CREAM); R(c, 1, 1, 16, 15, '#8fd3ff'); R(c, 1, 1, 16, 4, '#bfe6ff');
    disc(c, 13, 5, 2, GOLD); R(c, 1, 12, 16, 4, GREEN); R(c, 1, 11, 6, 1, GREEN); R(c, 9, 13, 8, 3, GREEN_DK);
    R(c, 5, 4, 5, 5, RED); R(c, 6, 3, 3, 1, RED); R(c, 7, 4, 1, 5, CREAM); R(c, 6, 9, 3, 1, RED); R(c, 7, 10, 1, 1, '#6e4029'); R(c, 6, 11, 3, 1, '#a8693f');
  });
  const out = clamp(Math.floor((t - 0.5) / 1.8 * 20), 0, 20), done = t > 2.3;
  // the sheet slides down out of the slot, picture first-printed-first
  if (out > 0) g.drawImage(pic, 0, 20 - out, 18, out, 9, 15 + (done ? Math.round(ease((t - 2.3) / 0.25) * 2) : 0), 18, out);
  g.drawImage(once('printer', 30, 13, c => {
    R(c, 5, 0, 20, 3, CREAM); R(c, 5, 0, 20, 1, '#efe2c8');                 // paper waiting in the tray
    R(c, 0, 3, 30, 10, '#b9b3c9'); R(c, 0, 3, 30, 1, '#d6d0e4'); R(c, 0, 12, 30, 1, '#8b8fa3');
    R(c, 3, 10, 24, 2, INK); R(c, 22, 6, 5, 2, '#8b8fa3');
  }), 3, 3);
  const busy = t > 0.4 && !done;
  R(g, 5, 8, 2, 2, busy ? ((t * 6 | 0) % 2 ? GREEN : GREEN_DK) : GREEN_DK);
  if (busy) R(g, 7 + Math.round((Math.sin(t * 14) + 1) * 10), 13, 2, 1, TEAL);   // the head, zipping
  if (done && t < 3.2) { const k = Math.round((t - 2.3) * 10); R(g, 29 + (k % 2), 19, 1, 1, GOLD_DK); R(g, 6 - (k % 2), 30, 1, 1, GOLD_DK); }
  if (t > 1.0) say(g, a, 39, INK);
  if (t > 1.6) say(g, b, 46, RED);
}

function warmer(g, t, d, env, loop, { lines: [a, b] }) {
  // a cool morning warms up as the sun comes over the hill
  g.drawImage(stripes('warm-a', ['#a8c8f0', '#b4cff0', '#c2d6ef', '#d0dcee']), 0, 0);
  g.globalAlpha = ease(t / 2.2);
  g.drawImage(stripes('warm-b', ['#ffd9b3', '#ffc9a8', '#ffb59c', '#ff9f8f']), 0, 0);
  g.globalAlpha = 1;
  const sy = 50 - Math.round(ease((t - 0.2) / 1.8) * 17);
  disc(g, 18, sy, 7, GOLD);
  R(g, 13, sy - 5, 3, 1, GOLD_LT);
  if (t > 1.9) { // it has a face, and it's glad to be here
    const bl = blink(t, 1.6, 0.8);
    R(g, 15, sy - 1, 1, bl ? 1 : 2, INK); R(g, 20, sy - 1, 1, bl ? 1 : 2, INK);
    R(g, 16, sy + 2, 4, 1, INK); R(g, 15, sy + 1, 1, 1, INK); R(g, 20, sy + 1, 1, 1, INK);
    R(g, 13, sy + 1, 1, 1, PINK); R(g, 22, sy + 1, 1, 1, PINK);
  }
  if (t > 1.2) for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2 + t * 0.8, r = 10 + ((t * 3 + i) % 2 | 0);
    R(g, 18 + Math.round(Math.cos(a) * r), sy + Math.round(Math.sin(a) * r), 1, 1, GOLD_DK);
  }
  g.drawImage(once('hills', W, 12, c => {
    for (let x = 0; x < W; x++) { const h1 = 6 + Math.round(Math.sin(x / 7 + 1) * 2), h2 = 3 + Math.round(Math.sin(x / 5 + 3) * 1.5); R(c, x, 12 - h1, 1, h1, GREEN); R(c, x, 12 - h2, 1, h2, GREEN_DK); }
    R(c, 6, 3, 1, 3, '#6e4029'); R(c, 5, 1, 3, 2, '#3f9b5c'); R(c, 29, 4, 1, 3, '#6e4029'); R(c, 28, 2, 3, 2, '#3f9b5c');
  }), 0, H - 12);
  say(g, a, 5, INK);
  if (t > 0.6) say(g, b, 12, '#c8553d');
}

function whimsical(g, t, d, env, loop, { lines: [a, b, s] }) {
  g.drawImage(once('whim-bg', W, H, c => {
    R(c, 0, 0, W, H, '#a8dcff'); R(c, 0, 26, W, H, '#b8e3ff');
    R(c, 2, 31, 8, 2, CREAM); R(c, 4, 30, 4, 1, CREAM); R(c, 24, 40, 9, 2, CREAM); R(c, 26, 39, 4, 1, CREAM);
  }), 0, 0);
  // balloons drift up behind the words
  const BAL = [[RED, 5, 7, 0], [GOLD, 16, 5, 1.7], [TEAL, 27, 6, 0.8], [PURPLE, 11, 6, 3.1]];
  for (const [c, x0, sp, ph] of BAL) {
    const y = H + 2 - Math.floor(((t + ph) * sp) % (H + 14)), x = x0 + Math.round(Math.sin(t * 1.5 + ph) * 1.5);
    g.drawImage(art(`bal|${c}`, ['.XX.', 'XWXX', 'XXXX', 'XXXX', '.XX.', '..S.', '..S.', '.S..'], { X: c, W: mix(c, '#ffffff', 0.5), S: '#6d6a80' }), x, y);
  }
  say(g, a, 5, INK);
  if (t > 0.4) say(g, b, 12, INK);
  // the last word can't sit still
  const RB = [RED, ORANGE, GOLD_DK, GREEN_DK, TEAL, PURPLE, PINK, RED, ORANGE], x = cx(s);
  if (t > 0.8) for (let i = 0; i < s.length; i++) g.drawImage(word(s[i], RB[(i + Math.floor(t * 4)) % RB.length]), x + i * 4, 20 + Math.round(Math.sin(t * 6 - i * 0.8) * 1.4));
}

// a mascot of a kind drawn here (PETS): walks along the parapet and sits for a pat, under its name and two words
function mascot(g, t, d, env, loop, { lines: [name, a, b] }) {
  g.drawImage(once('cat-bg', W, H, c => {
    ['#3a3266', '#4a3f7a', '#6b4f8a', '#a8618f', '#e07a7a', '#ff9f7f', '#ffb98f'].forEach((col, i) => R(c, 0, Math.round(i * 44 / 7), W, H, col));
    R(c, 3, 2, 1, 1, GOLD_LT); R(c, 33, 11, 1, 1, GOLD_LT); R(c, 2, 26, 1, 1, '#ffd9b3'); R(c, 32, 28, 1, 1, '#ffd9b3');
    R(c, 0, 44, W, 1, '#fffaf0'); R(c, 0, 45, W, 2, '#fdf3e1'); R(c, 0, 47, W, 1, '#e6d2ac'); R(c, 0, 48, W, H, '#c0593f');
    for (let x = 0; x < W; x += 8) R(c, x, 48, 1, 4, '#9e4632'); R(c, 0, 50, W, 1, '#9e4632');
  }), 0, 0);
  const sitAt = 2.1, x = t < sitAt ? Math.round(-16 + (t / sitAt) * 28) : 12;
  // paw prints along the parapet, fading behind
  const paw = art('paw', PAW, { W: '#b89468' });
  for (let px = -14, i = 0; px + 3 <= x + 3 && px < 13; px += 5, i++) {
    const when = (px + 14) / 28 * sitAt;                                    // when the back feet were here
    g.globalAlpha = clamp(1.3 - (t - when) * 0.3, 0.35, 1); g.drawImage(paw, px, 45 + (i % 2));
  }
  g.globalAlpha = 1;
  if (t < sitAt) g.drawImage(art(`walk${(t * 6 | 0) % 2}`, WALK[(t * 6 | 0) % 2], CAT_PAL), x, 35);
  else {
    const wink = t > 3.3 && t < 3.8, bl = !wink && blink(t, 1.3, 0.5);
    const eyes = wink ? 'KYKkK' : bl ? 'KkKkK' : 'KYKYK', tail = ((t * 2.5) | 0) % 2;
    const rows = SIT(eyes);
    g.drawImage(art(`sit|${eyes}|${tail}`, tail ? SIT_TAIL_UP(rows) : rows, CAT_PAL), 13, 31);
    if (t > 3.3) { const hy = 32 - Math.min(4, Math.round((t - 3.3) * 6)); if (t < 4.1) g.drawImage(art('heart-cat', ['R.R', 'RRR', '.R.'], { R: CREAM }), 20, hy); }
  }
  say(g, name, 5, GOLD);
  if (t > sitAt + 0.2) say(g, a, 13, CREAM);
  if (t > sitAt + 0.5) say(g, b, 20, CREAM);
}

function aiRun(g, t, d, env, loop, { lines: [a, b, c] }) {
  g.drawImage(once('ai-bg', W, H, c => { R(c, 0, 0, W, H, '#1d1a2f'); for (let y = 1; y < H; y += 3) R(c, 0, y, W, 1, '#221e3a'); }), 0, 0);
  // a friendly monitor face with an antenna
  g.drawImage(once('bot', 22, 22, c => {
    R(c, 10, 0, 2, 5, '#8b8fa3'); R(c, 1, 5, 20, 16, '#8b8fa3'); R(c, 0, 6, 22, 14, '#8b8fa3'); R(c, 1, 5, 20, 1, '#b9b3c9');
    R(c, 3, 8, 16, 10, PLUM); R(c, 9, 21, 4, 1, '#565a70');
  }), 7, 5);
  R(g, 17, 3, 2, 2, (t * 2 | 0) % 2 ? RED : '#8e2c35');
  const wink = t > 2.2 && t < 3.0, bl = !wink && blink(t, 1.5, 0.6);
  R(g, 13, 16, 2, bl ? 1 : 3, GREEN);
  if (wink) R(g, 20, 17, 3, 1, GREEN); else R(g, 21, 16, 2, bl ? 1 : 3, GREEN);
  R(g, 15, 20, 6, 1, GREEN); R(g, 14, 19, 1, 1, GREEN); R(g, 21, 19, 1, 1, GREEN);
  if (wink) { R(g, 11, 19, 2, 1, PINK); R(g, 23, 19, 2, 1, PINK); }
  // typed out, terminal style
  const k = a.length, n = clamp(Math.floor((t - 0.4) / 0.12), 0, k + b.length), line1 = a.slice(0, n), line2 = n > k ? b.slice(0, n - k) : '';
  if (line1) say(g, line1, 30, CREAM, 1, cx(a));
  if (line2) say(g, line2, 37, GREEN, 1, cx(b));
  if (n < k + b.length || (t % 0.6) < 0.3) { const onTwo = n >= k; R(g, onTwo ? cx(b) + (n - k) * 4 : cx(a) + n * 4, onTwo ? 42 : 35, 3, 1, GREEN); }
  // the last line beside a paw print while it fits ('+ A CAT'); a longer one alone and centred, '+ A ' cut to '+' if it
  // still doesn't fit the screen ('+PENGUIN')
  if (c && t > 1.7) {
    if (2 + textW(c) + 2 + 3 <= W) { say(g, c, 45, GOLD, 1, 2); g.drawImage(art('paw-g', PAW, { W: GOLD }), 31, 46 - (((t * 3) | 0) % 2)); }
    else say(g, textW(c) <= W ? c : c.replace(/^\+ A /, '+'), 45, GOLD);
  }
}

// the company's own film ({ slide: 'film', src: a .png in HQ's files, fps, seconds }): its frames W × H side by side,
// held on the last if seconds runs past them. The logo stands in until the strip has loaded, or if it can't.
function film(g, t, d, env, loop, s, lg) {
  const { strip, fps } = s;
  if (!strip.complete || strip.naturalWidth < W) return logo(g, t, d, env, loop, s, lg);
  const last = Math.floor(strip.naturalWidth / W) - 1;
  g.drawImage(strip, Math.min(Math.floor(t * fps), last) * W, 0, W, H, 0, 0, W, H);
}

// the slide kinds the brownstone draws
const SCENES = { logo, tee: oneOfAKind, mug, printer, heater: warmer, balloons: whimsical, mascot, typewriter: aiRun, film };
const PETS = ['cat']; // the mascot kinds the mascot slide draws
// each kind's words when a slide leaves them out ({NAME}, {KIND}: its mascot's)
const SLIDES = [
  { slide: 'logo', seconds: 3.6 },
  { slide: 'tee', seconds: 3.4, lines: ['ONE OF', 'A', 'KIND', 'LIKE YOU'] },
  { slide: 'mug', seconds: 4.0, lines: ['MADE FOR'], names: ['ADA', 'NOOR', 'SAM', 'YUKI', 'LEO', 'MAYA', 'OMAR', 'ZOE'] },
  { slide: 'printer', seconds: 3.8, lines: ['PRINTED', 'TO ORDER'] },
  // (the picture's words, no company's)
  { slide: 'heater', seconds: 3.2, lines: ['STAY', 'WARM'] },
  { slide: 'balloons', seconds: 3.2, lines: ['UP', 'UP AND', 'AWAY'] },
  { slide: 'mascot', seconds: 4.4, lines: ['{NAME}', 'OUR', '{KIND}'] },
  { slide: 'typewriter', seconds: 3.6, lines: ['RUN BY', 'AI', '+ A {KIND}'] },
  { slide: 'film', seconds: 10, fps: 12 },
];
const STRIP = /^[\w-]+\.png$/; // a film's src: a file in HQ's folder (or the company's theme/hq/), never a path or another site
// the loop when brand.yaml has none: the logo, the mascot and who runs the place, nothing about any one company's products
const LOOP = SLIDES.filter(s => ['logo', 'mascot', 'typewriter'].includes(s.slide));
const TR = 0.22; // each half of a transition
// brand.yaml's billboard as drawBillboard reads it: the slides of kinds it has, with their words (at least the logo).
// A slide's mascot is the one it names, else the company's first (mascots: the world's). Without one, a line that
// names it goes, and so does the mascot slide, as it does for a kind it has no art for. A film without a plain file
// name or a frame rate goes too, and one that has them starts loading its strip. House rules: it shows what the company
// is and how it means to work, never products, prices or offers.
export function slides(list = LOOP, mascots = []) {
  const known = list.filter(s => SCENES[s.slide]).flatMap(s => {
    const m = s.mascot ? mascots.find(x => x.id === s.mascot) : mascots[0], d = { ...SLIDES.find(x => x.slide === s.slide), ...s };
    if (s.slide === 'mascot' && !PETS.includes(m?.kind)) return [];
    if (s.slide === 'film') return STRIP.test(d.src) && d.fps > 0 ? [{ ...d, strip: picture(`/${d.src}`) }] : [];
    const lines = d.lines?.filter(l => m || !/{NAME}|{KIND}/.test(l)).map(l => m ? l.replace('{NAME}', m.name.toUpperCase()).replace('{KIND}', m.kind?.toUpperCase() ?? '') : l);
    return [{ ...d, lines }];
  });
  return known.length ? known : SLIDES.slice(0, 1);
}

// Frame t (seconds) at (0, 0): whoever mounts it shears it onto the wall. brand: as scene.js dresses it
export function drawBillboard(g, t, brand, env) {
  const list = brand.billboard, LOOP = list.reduce((s, { seconds }) => s + seconds, 0);
  g.save();
  g.imageSmoothingEnabled = false;
  g.beginPath(); g.rect(0, 0, W, H); g.clip();
  const loop = Math.floor(t / LOOP);
  let lt = ((t % LOOP) + LOOP) % LOOP, i = 0;
  while (lt >= list[i].seconds) { lt -= list[i].seconds; i++; }
  const d = list[i].seconds;
  SCENES[list[i].slide](g, lt, d, env, loop, list[i], brand.logo);
  // blinds close at a scene's end and open on the next. Every other change is a wipe with a gold edge
  const p = lt > d - TR ? (lt - (d - TR)) / TR : lt < TR ? 1 - lt / TR : 0;
  if (p > 0) {
    const closing = lt > d - TR, k = closing ? i : (i + list.length - 1) % list.length;
    g.fillStyle = INK;
    if (k % 2 === 0) { const bh = H / 4; for (let b = 0; b < 4; b++) g.fillRect(0, Math.round(b * bh), W, Math.ceil(bh * p)); }
    else {
      const e = Math.round(p * W);
      if (closing) { g.fillRect(0, 0, e, H); R(g, e, 0, 1, H, GOLD); } else { g.fillRect(W - e, 0, e, H); R(g, W - e - 1, 0, 1, H, GOLD); }
    }
  }
  // at night the screen glows softer, so it doesn't glare in the dark street
  if (env.night) { g.fillStyle = 'rgba(29,26,47,0.22)'; g.fillRect(0, 0, W, H); }
  g.restore();
}
