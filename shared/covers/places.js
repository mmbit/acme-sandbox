// The cover kit's places: backdrops that fill the frame, drawn without outlines. Each one is a different set,
// so a cover can be somewhere else than the last one. Guideline: README.md.
// (street, roof, printFloor, sky, above, cutaway, wall)
import { rng } from '../../platform/hq/util.js';
import { W, H, FLOOR, C, lite, dark, R, P } from './paint.js';

// Indoors: a wall with a skirting board and a floor of boards or tiles.
export function room(g, { wall = C.paper, floor = C.woodL, tiles = false } = {}) {
  R(g, 0, 0, W, FLOOR, wall); R(g, 0, 0, W, 2, dark(wall, 0.12));
  for (let x = 6; x < W; x += 16) R(g, x, 2, 1, FLOOR - 6, lite(wall, 0.25)); // panel seams
  R(g, 0, FLOOR - 4, W, 3, dark(wall, 0.35)); R(g, 0, FLOOR - 4, W, 1, dark(wall, 0.2));
  R(g, 0, FLOOR - 1, W, H - FLOOR + 1, floor);
  for (let y = FLOOR + 3, i = 0; y < H; y += 5, i++) {
    R(g, 0, y, W, 1, dark(floor, 0.15));
    for (let x = (tiles ? 0 : i * 11) % 24; x < W; x += 24) R(g, x, y - 4, 1, 4, dark(floor, 0.12));
  }
}

// Outdoors: a stepped sky (day, dusk or night), soft clouds or stars, and a pavement.
export function outdoors(g, { time = 'day', ground = C.pave, seed = 'sky' } = {}) {
  const r = rng(seed);
  skyBands(g, time, r, FLOOR);
  R(g, 0, FLOOR - 1, W, H - FLOOR + 1, ground); R(g, 0, FLOOR - 1, W, 1, lite(ground, 0.4));
  for (let x = (r() * 20) | 0; x < W; x += 20) R(g, x, FLOOR, 1, H - FLOOR, dark(ground, 0.1));
  R(g, 0, H - 5, W, 5, dark(ground, 0.18)); R(g, 0, H - 5, W, 1, lite(ground, 0.3)); // the curb
}

// The street: a row of house fronts, the pavement where people stand (feet around y 57) and the road in front,
// where a van parks (wheels on y 69). By day, dusk or night (lit windows).
export function street(g, { time = 'day', seed = 'street' } = {}) {
  const r = rng(seed), night = time === 'night';
  skyBands(g, time, r, 30);
  const fronts = [C.wood, C.woodL, dark(C.red, 0.25), C.sand, dark(C.teal, 0.15), lite(C.plum2, 0.1)];
  for (let x = -((r() * 12) | 0); x < W;) {
    const w = 24 + ((r() * 4) | 0) * 4, top = 4 + ((r() * 4) | 0) * 4, c = fronts[(r() * fronts.length) | 0];
    houseFront(g, x, top, w, 48 - top, night ? dark(c, 0.35) : c, time, r);
    x += w;
  }
  R(g, 0, 48, W, 10, C.pave); R(g, 0, 48, W, 1, dark(C.pave, 0.2));               // the pavement
  for (let x = 6; x < W; x += 14) R(g, x, 49, 1, 9, dark(C.pave, 0.08));
  R(g, 0, 58, W, 2, lite(C.pave, 0.4)); R(g, 0, 60, W, 1, dark(C.pave, 0.3));      // the curb
  R(g, 0, 61, W, H - 61, C.slate); R(g, 0, 61, W, 1, dark(C.slate, 0.2));          // the road
  for (let x = 4; x < W; x += 16) R(g, x, 67, 8, 1, night ? C.grey : C.mist);      // its middle line
}
function houseFront(g, x, top, w, h, c, time, r) {
  const pane = { day: C.sky, dusk: lite(C.orange, 0.3), night: C.night }[time], lights = { day: 0, dusk: 0.25, night: 0.55 }[time];
  R(g, x, top, w, h, c); R(g, x, top, 1, h, lite(c, 0.15)); R(g, x + w - 1, top, 1, h, dark(c, 0.2));
  R(g, x - 1, top - 2, w + 2, 2, dark(c, 0.3)); R(g, x - 1, top - 2, w + 2, 1, lite(c, 0.2)); // the cornice
  const door = (w >> 1) - 3 + x;
  for (let y = top + 4; y < top + h - 12; y += 10)
    for (let wx = x + 4; wx + 5 <= x + w - 3; wx += 8) {
      const lit = lights && r() < lights;
      R(g, wx, y, 5, 6, lit ? C.gold : pane); R(g, wx, y + 6, 5, 1, lite(c, 0.3));
      if (!lit && time !== 'night') R(g, wx, y, 2, 2, lite(pane, 0.5));
    }
  R(g, door, top + h - 10, 6, 10, dark(c, 0.5)); R(g, door + 4, top + h - 6, 1, 1, C.gold);
  R(g, door - 1, top + h - 1, 8, 1, C.mist);                                                   // the step
}

// The roof: the sky, the town's skyline beyond the parapet, and the roof's gravel deck, where feet stand around y 63.
export function roof(g, { time = 'day', seed = 'roof' } = {}) {
  const r = rng(seed), night = time === 'night';
  skyBands(g, time, r, 44);
  const far = { day: lite(C.slate, 0.45), dusk: C.plum2, night: C.plum }[time];
  for (let x = 0; x < W;) {
    const w = 6 + ((r() * 5) | 0) * 3, top = 24 + ((r() * 16) | 0);
    R(g, x, top, w, 44 - top, far);
    if (r() < 0.25) R(g, x + (w >> 1), top - 4, 1, 4, far);                    // an aerial
    for (let y = top + 3; y < 40; y += 4) for (let wx = x + 2; wx < x + w - 2; wx += 3)
      if (r() < (night ? 0.3 : 0.15)) P(g, wx, y, night ? C.gold : lite(far, 0.25));
    x += w;
  }
  R(g, 0, 40, W, 6, C.wood); R(g, 0, 40, W, 1, lite(C.sand, 0.2)); R(g, 0, 41, W, 1, C.sand); // the parapet and its coping
  for (let y = 42; y < 46; y += 2) for (let x = (y % 4) * 2; x < W; x += 8) R(g, x, y, 1, 2, dark(C.wood, 0.2));
  R(g, 0, 46, W, H - 46, C.grey); R(g, 0, 46, W, 2, dark(C.grey, 0.25));
  for (let i = 0; i < 90; i++) P(g, (r() * W) | 0, 48 + ((r() * (H - 48)) | 0), r() < 0.5 ? lite(C.grey, 0.25) : dark(C.grey, 0.15));
}

// The print floor: block walls under a row of high windows, hanging lamps, and a concrete floor with a painted
// walkway. Feet stand around y 63.
export function printFloor(g, { time = 'day', seed = 'print' } = {}) {
  const r = rng(seed), wall = C.mist;
  R(g, 0, 0, W, 50, wall);
  for (let y = 16; y < 48; y += 4) R(g, 0, y, W, 1, dark(wall, 0.08));
  for (let y = 16; y < 48; y += 4) for (let x = (y % 8) * 1.5; x < W; x += 12) R(g, x, y, 1, 4, dark(wall, 0.08));
  R(g, 0, 3, W, 11, dark(wall, 0.3));                                           // the strip of high windows
  for (let x = 2; x < W; x += 9) { R(g, x, 4, 8, 9, time === 'night' ? C.night : C.sky); if (time !== 'night') R(g, x, 4, 3, 2, lite(C.sky, 0.5)); }
  for (const x of [22, 64, 106]) {                                              // the lamps
    R(g, x, 14, 1, 6, C.slate); R(g, x - 4, 20, 9, 2, C.slate); R(g, x - 3, 22, 7, 1, C.gold);
    R(g, x - 2, 23, 5, 1, lite(C.gold, 0.6));
  }
  R(g, 0, 46, W, 4, C.mustard); for (let x = 0; x < W; x += 6) R(g, x, 46, 3, 4, C.ink); // the hazard stripe
  R(g, 0, 50, W, H - 50, C.sand); R(g, 0, 50, W, 1, dark(C.sand, 0.25));
  for (let x = (r() * 16) | 0; x < W; x += 32) line45(g, x, 51, dark(C.sand, 0.12));
  R(g, 0, 66, W, 2, C.mustard);                                                 // the walkway line
}
const line45 = (g, x, y, c) => { for (let i = 0; y + i < H; i++) P(g, x - (i >> 1), y + i, c); };

// The sky alone, filling the frame, with a low line of roofs along the bottom (no ground to stand on): for the moon,
// stars, birds or something flying. roofs: false leaves the whole frame to the sky.
export function sky(g, { time = 'night', seed = 'sky', roofs = true } = {}) {
  const r = rng(seed);
  skyBands(g, time, r, H, 5, roofs ? 62 : H);
  if (!roofs) return;
  const tone = time === 'day' ? C.slate : C.ink;
  for (let x = 0; x < W;) {
    const w = 8 + ((r() * 4) | 0) * 4, top = 58 + ((r() * 8) | 0);
    R(g, x, top, w, H - top, tone);
    if (r() < 0.4) R(g, x + 2, top - 3, 2, 3, tone);                             // a chimney
    if (time !== 'day' && r() < 0.6) R(g, x + 3 + ((r() * (w - 6)) | 0), top + 4, 2, 2, C.gold);
    x += w;
  }
}

// Seen from above: a surface filling the frame for things laid on it (a map, papers, a parcel, a mug).
// surface: desk (boards), mat (a cutting mat's grid), grass or floor (tiles).
export function above(g, { surface = 'desk', seed = 'above' } = {}) {
  const r = rng(seed);
  if (surface === 'desk') {
    R(g, 0, 0, W, H, C.woodL);
    for (let y = 0; y < H; y += 12) {
      R(g, 0, y + 11, W, 1, dark(C.woodL, 0.2));
      for (let i = 0; i < 6; i++) R(g, (r() * W) | 0, y + 2 + ((r() * 8) | 0), 6 + ((r() * 14) | 0), 1, dark(C.woodL, 0.08));
    }
  } else if (surface === 'mat') {
    R(g, 0, 0, W, H, C.leaf);
    for (let x = 4; x < W; x += 8) R(g, x, 0, 1, H, lite(C.leaf, x % 32 === 4 ? 0.3 : 0.12));
    for (let y = 4; y < H; y += 8) R(g, 0, y, W, 1, lite(C.leaf, y % 32 === 4 ? 0.3 : 0.12));
  } else if (surface === 'grass') {
    R(g, 0, 0, W, H, C.grass);
    for (let i = 0; i < 120; i++) { const x = (r() * W) | 0, y = (r() * H) | 0; P(g, x, y, C.leaf); P(g, x + 1, y - 1, lite(C.grass, 0.2)); }
  } else {
    R(g, 0, 0, W, H, C.pave);
    for (let x = 0; x < W; x += 16) R(g, x, 0, 1, H, dark(C.pave, 0.1));
    for (let y = 0; y < H; y += 16) R(g, 0, y, W, 1, dark(C.pave, 0.1));
  }
}

// The building cut open, a wide shot: the sky, the ground, and the building's floors in section, each split into
// rooms with their own wall colour. Returns the rooms ({ x, y, w, h, floor, room, foot }), floor 0 at the bottom,
// for small figures (feet on `foot`) and furniture. By night the rooms glow against a dark sky.
export function cutaway(g, { floors = 3, rooms = 2, width = 84, x = (W - width) >> 1, time = 'day', seed = 'cut' } = {}) {
  const r = rng(seed), ground = 66, storey = Math.floor((ground - 10) / floors);
  skyBands(g, time, r, ground);
  R(g, 0, ground, W, H - ground, C.grass); R(g, 0, ground, W, 1, lite(C.grass, 0.3));
  const top = ground - floors * storey, walls = [C.paper, C.cream, lite(C.sky, 0.45), lite(C.pink, 0.45), lite(C.green, 0.45), lite(C.mustard, 0.45)];
  R(g, x - 3, top - 5, width + 6, 3, C.plum); R(g, x - 3, top - 5, width + 6, 1, C.plum2); // the roof slab
  R(g, x + width - 14, top - 10, 5, 5, C.wood);                                           // a chimney
  const out = [];
  for (let f = 0; f < floors; f++) {
    const y = ground - (f + 1) * storey, inner = width - 4, each = Math.floor((inner - (rooms - 1) * 2) / rooms);
    for (let i = 0; i < rooms; i++) {
      const rx = x + 2 + i * (each + 2), c = walls[(f * rooms + i + ((r() * walls.length) | 0)) % walls.length];
      R(g, rx, y, each, storey - 2, c); R(g, rx, y + storey - 5, each, 3, C.woodL);       // the wall and its floorboards
      R(g, rx, y + storey - 5, each, 1, dark(C.woodL, 0.15));
      out.push({ x: rx, y, w: each, h: storey - 5, floor: f, room: i, foot: y + storey - 4 });
      if (i) R(g, rx - 2, y, 2, storey - 2, C.wood);                                     // the wall between
    }
    R(g, x, y + storey - 2, width, 2, C.slate);                                          // the floor slab
  }
  R(g, x, top - 2, 2, ground - top + 2, C.wood); R(g, x + width - 2, top - 2, 2, ground - top + 2, C.wood); // the outer walls
  R(g, x, top - 2, width, 2, C.slate);
  return out;
}

// A close-up's backdrop: a wall filling the frame behind one big thing. kind: plain, brick, cork or tiles.
export function wall(g, { kind = 'plain', c = kind === 'brick' ? C.wood : kind === 'cork' ? C.woodL : C.paper, seed = 'wall' } = {}) {
  const r = rng(seed);
  R(g, 0, 0, W, H, c);
  if (kind === 'brick') for (let y = 0; y < H; y += 6) {
    R(g, 0, y + 5, W, 1, lite(C.sand, 0.2));
    for (let x = (y / 6) % 2 ? -6 : 0; x < W; x += 12) { R(g, x + 11, y, 1, 5, lite(C.sand, 0.2)); R(g, x, y, 11, 1, lite(c, 0.12)); }
  }
  if (kind === 'cork') for (let i = 0; i < 260; i++) P(g, (r() * W) | 0, (r() * H) | 0, r() < 0.6 ? dark(c, 0.18) : lite(c, 0.25));
  if (kind === 'tiles') for (let y = 0; y < H; y += 10) { R(g, 0, y, W, 1, lite(c, 0.4)); for (let x = 0; x < W; x += 10) R(g, x, y, 1, 10, lite(c, 0.4)); }
  if (kind === 'plain') { R(g, 0, 0, W, 3, dark(c, 0.08)); R(g, 0, H - 3, W, 3, dark(c, 0.08)); }
}

// Details on a backdrop (no outline): a window, a cloud, the stars.
export function windowPane(g, x, y, w, h, { sky = C.sky, frame = C.cream, night = false } = {}) {
  R(g, x - 1, y - 1, w + 2, h + 2, frame); R(g, x, y, w, h, night ? C.night : sky);
  R(g, x + 1, y + 1, 2, h - 3, night ? C.plum : lite(sky, 0.5)); R(g, x + (w >> 1), y, 1, h, frame); R(g, x, y + (h >> 1), w, 1, frame);
  if (night) { P(g, x + w - 3, y + 2, C.gold); P(g, x + 3, y + h - 3, lite(C.plum, 0.5)); }
  R(g, x - 2, y + h + 1, w + 4, 1, dark(frame, 0.2));
}
export function cloud(g, x, y) { R(g, x + 3, y, 10, 3, C.cream); R(g, x, y + 3, 18, 3, C.cream); R(g, x + 1, y + 5, 16, 1, C.mist); }

// The sky behind every outdoor place: stepped bands from the top down to `bottom`, with clouds by day and stars by
// night. outdoors() keeps its three bands of FLOOR / 3, so the older covers draw as they did.
function skyBands(g, time, r, bottom, n = 3, end = bottom) {
  const bands = n === 3 ? {
    day: ['#bfe3ff', '#a9d8fb', C.sky], dusk: ['#9b72cf', '#ff8fab', C.orange], night: [C.ink, C.night, C.plum],
  }[time] : {
    day: [C.sky, '#a9d8fb', '#bfe3ff', lite('#bfe3ff', 0.3), lite('#bfe3ff', 0.55)], // darkest at the top, pale at the horizon
    dusk: [C.purple, lite(C.purple, 0.2), C.pink, C.orange, C.gold],
    night: [C.ink, C.night, C.plum, C.plum2, lite(C.plum2, 0.1)],
  }[time];
  const step = bottom === FLOOR && n === 3 ? FLOOR / 3 | 0 : Math.ceil(end / n);
  for (let i = 0; i < n; i++) R(g, 0, i * step, W, bottom, bands[i]);
  if (time === 'night') for (let i = 0; i < 26; i++) P(g, r() * W | 0, r() * (Math.min(bottom, end) - 16) | 0, i % 5 ? lite(C.plum, 0.5) : C.gold);
  else for (let i = 0; i < 3; i++) cloud(g, 8 + i * 44 + (r() * 16 | 0), 6 + (r() * 14 | 0));
}
