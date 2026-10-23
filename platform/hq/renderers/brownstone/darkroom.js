// The photo studio's darkroom, there while the company runs a studio (world.studio; layout.js adds the room). At its near
// end a backdrop sweep with a product on it, a camera on a tripod and a softbox; then a bench with an enlarger and three
// trays; a line of prints drying above it, one per photo in the board's batch; a red safelight that's on while an edit is
// in the model; and the keeper's desk at the far end. rooms.js builds the things (darkroomThing), render.js draws what
// changes every frame (drawDarkroom), the safelight's red over the room (darkroomTint) and its glow (safelightGlow).
import { mix } from '../../util.js';
import { INK, F, SX, SY, sprite, silhouette, wallX, wallY } from './iso.js';
import { PRINT_W, PRINT_H, PITCH, sag, lineFlat, printFlat, safelightFlat } from './darkroomwall.js';

const PAPER = '#f6efe2',
  LINE_Z = 37;
const CYCLE = 4; // s: while editing, the enlarger exposes a sheet (the first second), then it develops in the tray

// The two things in the back row, by name (rooms.js's KINDS): what they take of it, in tiles, or 0 when they don't fit.
// ctx: rooms.js's room being built, a: where the thing starts along the wall, F_: the room's frame (rooms.js frame()).
export function darkroomThing(ctx, name, a, room, F_) {
  const st = (ctx.anchors.studio ??= { F: F_, z: room.z, since: -1e9, seen: null });
  if (name === 'sweep') return sweep(ctx, st, a, room, F_);
  if (name === 'darkbench') return bench(ctx, st, a, room, F_);
  return 0;
}

// The backdrop: a roll of paper on two poles, hanging down the wall and curving out over the floor, with a product on
// it. In front, a camera on a tripod looks at it, and a softbox lights it from the near side.
function sweep(ctx, st, a, room, F_) {
  const { g, props, space: sp } = ctx,
    d1 = 1.05;
  if (!sp.free(a, 0, a + 1.4, d1)) return 0;
  // the poles and the roll across their tops
  for (const u of [a + 0.06, a + 1.3]) F_.box(g, u, 0.04, u + 0.05, 0.09, 0, 46, ['#8b8fa3', '#565a70', '#3b3355']);
  // the paper down the wall, its cove (two steps darker where it bends) and out over the floor
  F_.face(g, a + 0.12, a + 1.28, 0.06, 0, 43, PAPER);
  F_.top(g, a + 0.12, 0.06, a + 1.28, d1, 0.4, PAPER);
  F_.top(g, a + 0.12, 0.06, a + 1.28, 0.16, 0.4, mix(PAPER, INK, 0.1));
  F_.face(g, a + 0.12, a + 1.28, 0.16, 0, 3, mix(PAPER, INK, 0.06));
  F_.face(g, a + 0.12, a + 1.28, d1, 0, 0.6, mix(PAPER, INK, 0.18));
  F_.box(g, a + 0.04, 0.03, a + 1.36, 0.12, 42, 46, [
    mix(PAPER, '#ffffff', 0.4),
    mix(PAPER, INK, 0.08),
    mix(PAPER, INK, 0.25),
  ]);
  F_.box(g, a + 0.04, 0.03, a + 0.1, 0.12, 42, 46, '#3b3355');
  F_.box(g, a + 1.3, 0.03, a + 1.36, 0.12, 42, 46, '#3b3355'); // the roll's core
  // the product: a mug with a heart on it, its handle to the side, and its shadow
  const m = a + 0.66;
  F_.top(g, m - 0.06, 0.5, m + 0.16, 0.62, 0.5, mix(PAPER, INK, 0.12));
  F_.box(g, m - 0.07, 0.45, m + 0.07, 0.58, 0.5, 6, ['#ffc2c6', '#e8505b', '#b8404f']);
  F_.top(g, m - 0.05, 0.47, m + 0.05, 0.56, 6, '#8e3b2c');
  F_.box(g, m + 0.07, 0.49, m + 0.11, 0.54, 2, 5, '#b8404f');
  const [hx, hy] = F_.s(m, 0.58, 3);
  F(g, Math.round(hx) - 1, Math.round(hy) - 1, 1, 1, '#fffaf0');
  F(g, Math.round(hx) + 1, Math.round(hy) - 1, 1, 1, '#fffaf0');
  F(g, Math.round(hx) - 1, Math.round(hy), 3, 1, '#fffaf0');
  F(g, Math.round(hx), Math.round(hy) + 1, 1, 1, '#fffaf0'); // a heart on it
  sp.take(a, 0, a + 1.4, d1);
  // the softbox on its stand by the near pole, its white face turned to the product
  const sb = { a: a + 0.22, d: 1.3 };
  F_.prop(
    props,
    'softbox',
    sb.a - 0.1,
    sb.d - 0.55,
    sb.a + 0.26,
    sb.d + 0.12,
    36,
    g2 => {
      const foot = [
          [-0.1, 0.1],
          [0.12, 0.12],
          [0.02, -0.1],
        ].map(([da, dd]) => F_.s(sb.a + da, sb.d + dd)),
        top1 = F_.s(sb.a, sb.d, 6);
      for (const p of foot) line(g2, top1[0], top1[1], p[0], p[1], '#565a70');
      F_.box(g2, sb.a - 0.02, sb.d - 0.02, sb.a + 0.02, sb.d + 0.02, 6, 24, '#8b8fa3');
      F_.box(
        g2,
        sb.a - 0.06,
        sb.d - 0.5,
        sb.a + 0.04,
        sb.d + 0.06,
        20,
        34,
        F_.X ? ['#3b3355', '#2b2230', '#fffaf0'] : ['#3b3355', '#fffaf0', '#2b2230'],
      );
      F_.box(g2, sb.a - 0.06, sb.d - 0.5, sb.a + 0.04, sb.d + 0.06, 33, 34, '#565a70');
    },
    { foot: [sb.a - 0.08, sb.d - 0.1, sb.a + 0.12, sb.d + 0.1] },
  );
  sp.take(sb.a - 0.12, sb.d - 0.55, sb.a + 0.14, sb.d + 0.14);
  st.softbox = { ...F_.pt(sb.a + 0.04, sb.d - 0.22), z: room.z + 27, a: sb.a, d: sb.d };
  // the camera on its tripod, looking at the product
  const cm = { a: a + 0.74, d: 1.55 };
  F_.prop(
    props,
    'tripod',
    cm.a - 0.2,
    cm.d - 0.25,
    cm.a + 0.2,
    cm.d + 0.2,
    24,
    g2 => {
      const top1 = F_.s(cm.a, cm.d, 13),
        feet = [
          [-0.16, 0.14],
          [0.16, 0.12],
          [0, -0.17],
        ].map(([da, dd]) => F_.s(cm.a + da, cm.d + dd));
      for (const p of feet) line(g2, top1[0], top1[1], p[0], p[1], '#3b3355');
      F_.box(g2, cm.a - 0.03, cm.d - 0.03, cm.a + 0.03, cm.d + 0.03, 9, 14, '#565a70');
      F_.box(g2, cm.a - 0.05, cm.d - 0.22, cm.a + 0.05, cm.d - 0.07, 15, 19, ['#c9ccd8', '#565a70', '#3b3355']); // the lens, towards the sweep
      F_.box(g2, cm.a - 0.13, cm.d - 0.07, cm.a + 0.13, cm.d + 0.08, 14, 20, ['#8b8fa3', '#3b3355', '#2b2230']);
      F_.box(g2, cm.a - 0.05, cm.d - 0.04, cm.a + 0.05, cm.d + 0.04, 20, 22, ['#8b8fa3', '#3b3355', '#2b2230']); // the viewfinder's hump
      F_.box(g2, cm.a + 0.06, cm.d - 0.03, cm.a + 0.11, cm.d + 0.02, 20, 21, '#e8505b'); // the shutter button
      const [bx, by] = F_.s(cm.a - 0.04, cm.d + 0.08, 18);
      F(g2, Math.round(bx) - 1, Math.round(by), 3, 1, '#4fa3d5'); // its screen, on the back
    },
    { foot: [cm.a - 0.16, cm.d - 0.16, cm.a + 0.16, cm.d + 0.14] },
  );
  sp.take(cm.a - 0.2, cm.d - 0.22, cm.a + 0.2, cm.d + 0.18);
  st.tally = { ...F_.pt(cm.a + 0.1, cm.d + 0.08), z: room.z + 19 };
  return 1.4;
}

// The bench: a counter with cupboards, the enlarger on it, three trays (developer, stop, fix) and a stack of paper; on
// the wall the safelight, and the line the prints dry on, running on over the desk to the room's far end.
function bench(ctx, st, a, room, F_) {
  const { g } = ctx;
  splashback(g, a, F_);
  F_.box(g, a + 0.04, 0.04, a + 1.96, 0.62, 0, 11, ['#4a4560', '#3b3355', '#2b2740']);
  F_.box(g, a + 0.02, 0.02, a + 1.98, 0.64, 11, 12, ['#8b8fa3', '#565a70', '#3b3355']);
  for (let k = 0; k < 4; k++) {
    const u = a + 0.12 + k * 0.47;
    F_.face(g, u, u + 0.4, 0.62, 2, 9, '#45405a');
    F_.face(g, u + 0.17, u + 0.23, 0.62, 7, 8, '#8b8fa3');
  } // cupboard doors
  // a ribbed rubber mat to stand on in front of it
  F_.top(g, a + 0.3, 0.72, a + 1.9, 1.08, 0, '#2b2740');
  for (let u = a + 0.36; u < a + 1.86; u += 0.12) F_.top(g, u, 0.76, u + 0.05, 1.04, 0, '#3b3355');
  // the enlarger: a baseboard with its easel, the column, and the head with its bellows and lens
  const e = a + 0.42;
  F_.box(g, e, 0.1, e + 0.48, 0.56, 12, 13, '#2b2230');
  F_.top(g, e + 0.08, 0.2, e + 0.4, 0.5, 13, '#d9d4c8');
  F_.top(g, e + 0.12, 0.24, e + 0.36, 0.46, 13, '#fffaf0');
  F_.box(g, e + 0.2, 0.06, e + 0.28, 0.13, 13, 44, ['#c9ccd8', '#8b8fa3', '#565a70']);
  F_.box(g, e + 0.1, 0.14, e + 0.38, 0.4, 32, 39, ['#fffaf0', '#e6e8f0', '#b9bccb']);
  F_.box(g, e + 0.14, 0.18, e + 0.34, 0.36, 39, 42, ['#c9ccd8', '#a3a7b8', '#8b8fa3']);
  F_.face(g, e + 0.12, e + 0.36, 0.4, 35, 36, '#e8505b'); // a red band round the head
  F_.box(g, e + 0.16, 0.2, e + 0.32, 0.34, 26, 32, ['#3b3355', '#2b2230', '#1d1a2f']);
  for (let z = 27; z < 32; z += 2) F_.face(g, e + 0.16, e + 0.32, 0.34, z, z + 1, '#45405a'); // the bellows' folds
  F_.box(g, e + 0.2, 0.23, e + 0.28, 0.31, 23, 26, ['#c9ccd8', '#8b8fa3', '#565a70']);
  st.enlarger = { a: e + 0.24, d: 0.27, lens: 23, easel: [e + 0.12, 0.24, e + 0.36, 0.46] };
  // three trays, each with a dark liquid: the first (the developer) is where a print comes up
  st.trays = [0, 1, 2].map(k => {
    const u = a + 0.94 + k * 0.33,
      rim = ['#e8505b', '#fffaf0', '#8b8fa3'][k];
    F_.box(g, u, 0.16, u + 0.3, 0.54, 12, 14, [mix(rim, '#ffffff', 0.25), rim, mix(rim, INK, 0.3)]);
    F_.top(g, u + 0.03, 0.19, u + 0.27, 0.51, 13.5, ['#6b5a3a', '#4f5a6b', '#5a4f6b'][k]);
    return { a0: u + 0.03, a1: u + 0.27, d0: 0.19, d1: 0.51 };
  });
  // brown bottles of chemistry along the back, and tongs over the stop bath
  for (const [k, u] of [a + 0.08, a + 0.2, a + 1.62].entries()) {
    F_.box(g, u, 0.05, u + 0.08, 0.13, 12, 19 + (k % 2) * 2, ['#b07a4f', '#8e5a2b', '#6e4029']);
    F_.box(g, u + 0.02, 0.07, u + 0.06, 0.11, 19 + (k % 2) * 2, 21 + (k % 2) * 2, '#2b2230');
  }
  F_.box(g, a + 1.33, 0.3, a + 1.49, 0.33, 14, 15, '#c9ccd8');
  // past the bench, a low cabinet for the paper, its yellow boxes and a film canister on top (kept low: the prints dry over it)
  const c = a + 2.06;
  if (c + 0.8 <= F_.len - 1) {
    F_.box(g, c, 0.06, c + 0.8, 0.5, 0, 14, ['#6e4029', '#5a3825', '#4a2c1c']);
    F_.face(g, c + 0.06, c + 0.74, 0.5, 2, 12, '#5a3825');
    F_.face(g, c + 0.38, c + 0.42, 0.5, 2, 12, '#4a2c1c');
    F_.box(g, c + 0.08, 0.12, c + 0.46, 0.42, 14, 18, ['#ffe08a', '#f2c14e', '#c99a2e']);
    F_.box(g, c + 0.12, 0.16, c + 0.42, 0.38, 18, 21, ['#ffe08a', '#e8505b', '#b8404f']);
    F_.box(g, c + 0.56, 0.2, c + 0.66, 0.3, 14, 19, ['#565a70', '#2b2230', '#1d1a2f']);
    F_.box(g, c + 0.56, 0.2, c + 0.66, 0.3, 19, 20, '#c9ccd8');
  }
  st.stack = { a: a + 0.1, d: 0.3 }; // (the sheets with the keeper, by the enlarger: drawDarkroom)
  // the safelight on the wall, just past the enlarger; the drying line from over the trays to the far end
  st.safelight = { a: a + 0.86, d: 0.02, z: 25 }; // (where nothing stands in front of it)
  const a0 = a + 1.42,
    a1 = F_.len - 0.15;
  st.line = { a0, a1, w: Math.round((a1 - a0) * 16) };
  st.line.fits = Math.max(0, Math.floor((st.line.w - 2) / PITCH));
  return 2;
}
// the glazed tiles on the wall behind the bench, in grout, every other row offset half a tile
const SPLASH_TILE = 0.375,
  SPLASH_GROUT = 1 / 16,
  SPLASH_SHADES = ['#6b6478', '#655d72', '#72697f'];
function splashback(g, a, F_) {
  F_.face(g, a, a + 2, 0.01, 11, 24, '#3b3355');
  for (let row = 0; row < 3; row++)
    for (let u = a - (row % 2) * (SPLASH_TILE / 2); u < a + 2; u += SPLASH_TILE)
      F_.face(
        g,
        Math.max(a, u + SPLASH_GROUT),
        Math.min(a + 2, u + SPLASH_TILE),
        0.01,
        12 + row * 4,
        15 + row * 4,
        SPLASH_SHADES[(row + Math.round(u * 8)) % 3],
      );
}

// ---------------------------------------------------------------- every frame (render.js)
// What changes: the prints on the line (a new one swings in, and the softbox flashes as it does), the safelight, the
// enlarger exposing and a sheet coming up in the developer while an edit is in the model, the sheets waiting by the
// enlarger. studio: world.studio. t: seconds.
export function drawDarkroom(g, st, studio, t) {
  const F_ = st.F,
    z0 = st.z,
    on = !!studio?.editing;
  // a new photo in the board's batch: the newest print swings in and the softbox flashes
  const n = Math.min(studio?.waiting ?? 0, st.line.fits);
  if (st.seen != null && n > st.seen) st.since = t;
  st.seen = n;
  const age = t - st.since,
    swing = age < 2.2 ? Math.round(Math.sin(age * 9) * 1.6 * Math.exp(-age * 1.8)) : 0;
  // the safelight, then the line
  wallSprite(g, st, `lamp${on}`, () => safelightFlat(on), st.safelight.a, st.safelight.z);
  const L = st.line;
  wallSprite(g, st, `line${swing ? n - 1 : n}`, () => lineFlat(st, swing ? n - 1 : n), L.a0, LINE_Z - 11);
  if (swing && n) {
    const x = 1 + (n - 1) * PITCH + swing;
    wallSprite(
      g,
      st,
      `print${n - 1}|${x}`,
      () => printFlat(n - 1),
      F_.X ? L.a0 + x / 16 : L.a0 + (L.w - x - PRINT_W) / 16,
      LINE_Z + 1 - (sag(x + 3, L.w) - 1) - (PRINT_H + 2),
    );
  }
  if (age < 0.25) {
    // the flash: the softbox's face white
    const p = st.softbox,
      q0 = F_.pt(p.a + 0.04, p.d - 0.5),
      q1 = F_.pt(p.a + 0.04, p.d + 0.06);
    g.globalAlpha = 1 - age * 4;
    if (F_.X) wallX(g, q0.y, q1.y, q0.x, z0 + 20, z0 + 34, '#ffffff');
    else wallY(g, Math.min(q0.x, q1.x), Math.max(q0.x, q1.x), q0.y, z0 + 20, z0 + 34, '#ffffff');
    g.globalAlpha = 1;
  }
  // the camera's tally light blinks while the keeper's at it
  const tl = st.tally;
  F(g, Math.round(SX(tl.x, tl.y)), Math.round(SY(tl.x, tl.y, tl.z)), 1, 1, on && t % 1.2 < 0.6 ? '#ff3b4a' : '#5a1f2a');
  // the sheets with the keeper, stacked by the trays (up to six)
  const k = Math.min(studio?.developing ?? 0, 6);
  for (let i = 0; i < k; i++)
    F_.box(
      g,
      st.stack.a,
      st.stack.d,
      st.stack.a + 0.22,
      st.stack.d + 0.2,
      12 + i,
      13 + i,
      i % 2 ? '#f6efe2' : '#fffaf0',
    );
  if (!on) return;
  // while an edit is in the model: the enlarger exposes a sheet, then it comes up in the developer, the liquid rippling
  const c = (t % CYCLE) / CYCLE,
    e = st.enlarger;
  if (c < 0.25) {
    const [lx, ly] = F_.s(e.a, e.d, e.lens),
      [, ey] = F_.s(e.a, e.d, 13);
    g.globalAlpha = 0.35;
    for (let y = Math.round(ly) + 1; y < ey; y++) {
      const w = 1 + Math.round((y - ly) / 4);
      F(g, Math.round(lx) - w, y, w * 2 + 1, 1, '#fff3b0');
    }
    g.globalAlpha = 1;
    F_.top(g, ...e.easel, 13, '#fff7d6');
    F(g, Math.round(lx) - 1, Math.round(ly), 3, 1, '#fff3b0');
  }
  const tr = st.trays[0],
    pa = (tr.a0 + tr.a1) / 2,
    pd = (tr.d0 + tr.d1) / 2;
  if (c >= 0.25) {
    F_.top(g, pa - 0.08, pd - 0.1, pa + 0.08, pd + 0.1, 13.6, '#fffaf0');
    const up = Math.min(3, Math.floor(((c - 0.25) / 0.75) * 4)); // stepped: the picture comes up in three bands, never a fade
    if (up) {
      g.globalAlpha = up / 3;
      F_.top(g, pa - 0.06, pd - 0.08, pa + 0.06, pd + 0.02, 13.7, '#bfe3ff');
      F_.top(g, pa - 0.03, pd + 0.0, pa + 0.03, pd + 0.06, 13.7, '#e8505b');
      g.globalAlpha = 1;
    }
  }
  // a ring spreading over the developer, and one over the fixer, out of step
  for (const [i, off] of [
    [0, 0],
    [2, 0.5],
  ]) {
    const r = st.trays[i],
      ra = (r.a0 + r.a1) / 2,
      rd = (r.d0 + r.d1) / 2,
      p = (t / 1.4 + off) % 1,
      rad = 0.04 + p * 0.1;
    const [sx, sy] = F_.s(ra, rd, 13.5);
    g.globalAlpha = 1 - p;
    ring(g, Math.round(sx), Math.round(sy), Math.round(rad * 32), Math.max(1, Math.round(rad * 16)), '#c9b98c');
    g.globalAlpha = 1;
  }
}
// The safelight's red over the whole room while it's on (drawn over the room and the people in it, 'multiply')
export function darkroomTint(g, art, blit) {
  art.tint ??= silhouette(art.c, '#f2a2a6');
  g.globalCompositeOperation = 'multiply';
  blit(art.tint, art.cx, art.cy);
  g.globalCompositeOperation = 'source-over';
}
// Where the safelight's glow goes (render.js's room glows), in screen px
export const safelightGlow = st => {
  const p = st.F.pt(st.safelight.a + 0.47, 0.02);
  return [SX(p.x, p.y), SY(p.x, p.y, st.z + st.safelight.z + 2)];
};

// a flat drawing on the back wall from a0 along it, its foot zb px up the wall: sheared once, then drawn as a picture
function wallSprite(g, st, key, draw, a0, zb) {
  let sp = (st.sprites ??= new Map()).get(key);
  if (!sp) {
    const F_ = st.F,
      img = draw(),
      a1 = a0 + img.width / 16,
      p = F_.pt(a0, 0),
      q = F_.pt(a1, 0.05);
    sp = sprite(
      Math.min(p.x, q.x),
      Math.min(p.y, q.y),
      Math.max(p.x, q.x),
      Math.max(p.y, q.y),
      st.z + zb - 2,
      st.z + zb + img.height + 2,
      g2 => F_.flat(g2, img, a0, a1, 0.02, zb),
      4,
    );
    st.sprites.set(key, sp);
  }
  g.drawImage(sp.img, sp.x, sp.y);
}
// a 1 px ring (an ellipse outline) and a 1 px line
function ring(g, cx, cy, rx, ry, c) {
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    F(g, cx + Math.round(Math.cos(a) * rx), cy + Math.round(Math.sin(a) * ry), 1, 1, c);
  }
}
function line(g, x1, y1, x2, y2, c) {
  const n = Math.max(1, Math.round(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))));
  for (let k = 0; k <= n; k++)
    F(g, Math.round(x1 + ((x2 - x1) * k) / n), Math.round(y1 + ((y2 - y1) * k) / n), 1, 1, c);
}
