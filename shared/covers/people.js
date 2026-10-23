// The cover kit's people: the team as HQ draws them (person), small in a wide shot (figure) and close up (bust), all in
// their own looks from org.yaml. Each draws its own outline. Guideline: README.md.
// (figure, bust)
import { spriteFrame, makeLook, drawProp, catFrame, FOOT } from '../../platform/hq/renderers/brownstone/sprites.js';
import { C, lite, dark, R, shadow, fg, sprite } from './paint.js';

let people = {};
export const setPeople = list => { people = list; };
const look = id => makeLook(people[id] ?? { id, name: id });

// An agent from company/org.yaml as HQ draws them: feet at `foot`. frame: stand | walk1 | walk2 | blink | sit | type1 | water.
export function agent(g, id, x, foot = 63, { frame = 'stand', front = true, right = true, item = '' } = {}) {
  g.drawImage(spriteFrame(id, look(id), frame, front, right, item), x, foot - FOOT);
}
export const prop = (g, name, x, y) => drawProp(g, name, x, y);
export const cat = (g, x, y, frame = 'sit', right = true) => g.drawImage(catFrame(frame, right), x, y);
// A team member standing (or sitting) in the scene: their shadow, the sprite, and the outline.
export function person(g, id, x, foot = 63, opts = {}) { shadow(g, x + 7, foot, 5); fg(g, t => agent(t, id, x, foot, opts)); }

// A team member small, for a wide shot or a cutaway: 5 pixels wide, 10 tall, in their hair, skin, shirt and trousers,
// feet on `foot`. frame: stand | walk | wave | carry (a parcel in front).
export function figure(g, id, x, foot, { frame = 'stand' } = {}) {
  const d = look(id), hat = d.has('beanie', 'hat', 'visor');
  const top = { curly: 'hhhhh', spiky: 'h.h.h' }[d.style] ?? '.hhh.';
  const rows = [
    d.style === 'bun' ? '..h..' : d.style === 'spiky' ? top : '.....',
    hat ? 'aaaaa' : d.style === 'spiky' ? '.hhh.' : top,
    ['long', 'bob', 'curly'].includes(d.style) ? 'hssh.' : '.sss.',
    ['long', 'bob'].includes(d.style) ? 'hssh.' : '.sss.',
    frame === 'wave' ? 'tttts' : 'ttttt',
    frame === 'carry' ? 'bbbbb' : frame === 'wave' ? 'tttt.' : 'ttttt',
    frame === 'carry' ? 'bbbbb' : 's.p.s',
    '.ppp.',
    frame === 'walk' ? 'p...p' : '.p.p.',
    frame === 'walk' ? 'o...o' : '.o.o.',
  ];
  if (frame === 'wave') rows[3] = rows[3].slice(0, 4) + 's';
  shadow(g, x + 2, foot, 3, 1);
  fg(g, t => sprite(t, rows, x, foot - 10, { h: d.hair, s: d.skin, t: d.shirt, p: d.pants, o: d.shoes, a: d.accent, b: C.woodL }));
}

// A team member close up, head and shoulders, for a portrait or an interview: 32 pixels wide, its top left at x, y,
// shoulders running down to the frame's foot. mouth: smile | open (talking) | flat.
export function bust(g, id, x, y, { mouth = 'smile' } = {}) {
  const d = look(id);
  fg(g, t => portrait(t, d, x, y, mouth));
}

function portrait(g, d, x, y, mouth) {
  const { skin, hair, shirt, has } = d, Rr = (dx, dy, w, h, c) => R(g, x + dx, y + dy, w, h, c);
  const hoodie = has('hoodie'), suit = has('suit');
  if (d.style === 'long' || d.style === 'pony') Rr(4, 6, 24, d.style === 'long' ? 32 : 4, hair); // hair falling behind
  if (d.style === 'pony') Rr(27, 8, 4, 22, hair);
  // shoulders and neck
  Rr(1, 32, 30, 40, shirt); Rr(3, 30, 26, 2, shirt); Rr(0, 34, 1, 40, shirt); Rr(31, 34, 1, 40, shirt);
  Rr(1, 32, 1, 40, lite(shirt, 0.2)); Rr(3, 30, 26, 1, lite(shirt, 0.25)); Rr(27, 32, 4, 40, dark(shirt, 0.15));
  if (hoodie) { Rr(6, 29, 20, 4, dark(shirt, 0.2)); Rr(12, 34, 1, 6, C.cream); Rr(19, 34, 1, 6, C.cream); }
  Rr(12, 25, 8, 6, dark(skin, 0.15));
  if (has('hi-vis', 'vest')) Rr(1, 40, 31, 2, C.cream);
  if (suit) { Rr(12, 30, 8, 3, C.cream); Rr(15, 31, 2, 8, C.red); }
  else Rr(13, 30, 6, 2, dark(skin, 0.15));
  // the head
  Rr(4, 13, 2, 5, dark(skin, 0.08)); Rr(26, 13, 2, 5, dark(skin, 0.15));        // ears
  Rr(6, 5, 20, 21, skin); Rr(7, 26, 18, 1, skin); Rr(9, 27, 14, 1, dark(skin, 0.1));
  Rr(23, 6, 3, 20, dark(skin, 0.1)); Rr(7, 26, 18, 1, dark(skin, 0.08));
  // eyes, cheeks, nose and mouth
  for (const ex of [10, 19]) { Rr(ex, 14, 3, 4, C.ink); Rr(ex, 14, 1, 1, C.cream); }
  if (has('eyebrow')) { Rr(9, 11, 5, 1, C.ink); Rr(18, 11, 5, 1, C.ink); }
  Rr(8, 19, 3, 1, C.pink); Rr(21, 19, 3, 1, C.pink);
  Rr(16, 18, 1, 2, dark(skin, 0.3));
  const lips = dark(skin, 0.5);
  if (mouth === 'open') { Rr(14, 22, 5, 2, lips); Rr(15, 23, 3, 1, C.red); }
  else if (mouth === 'flat') Rr(14, 22, 5, 1, lips);
  else { Rr(14, 23, 5, 1, lips); Rr(13, 22, 1, 1, lips); Rr(19, 22, 1, 1, lips); }
  if (has('glasses', 'spectacles')) {
    const f = C.plum2;
    for (const ex of [8, 17]) { Rr(ex, 12, 7, 1, f); Rr(ex, 18, 7, 1, f); Rr(ex, 12, 1, 7, f); Rr(ex + 6, 12, 1, 7, f); }
    Rr(15, 14, 2, 1, f);
  }
  hairdo(Rr, d);
  // hats and things on the head
  if (has('beanie')) { Rr(5, 1, 22, 9, d.accent); Rr(5, 8, 22, 2, lite(d.accent, 0.35)); Rr(14, -1, 4, 2, C.cream); Rr(7, 2, 3, 1, lite(d.accent, 0.3)); }
  if (has('headphone', 'headset')) {
    Rr(5, 1, 22, 2, C.plum); Rr(3, 3, 2, 8, C.plum); Rr(27, 3, 2, 8, C.plum);
    Rr(2, 11, 4, 8, d.accent); Rr(26, 11, 4, 8, d.accent);
    if (has('headset')) { Rr(6, 19, 1, 3, C.plum); Rr(7, 22, 5, 1, C.plum); Rr(12, 21, 2, 2, C.plum); }
  }
  if (has('visor')) { Rr(5, 7, 22, 2, C.ink); Rr(4, 9, 24, 2, d.accent); Rr(4, 9, 24, 1, lite(d.accent, 0.35)); }
  if (has('pencil')) { Rr(27, 6, 2, 9, C.mustard); Rr(27, 5, 2, 1, C.pink); }
  if (has('flower')) { Rr(21, 2, 3, 3, C.pink); Rr(22, 3, 1, 1, C.gold); }
}

// The hair on a bust's head, by the look's style.
function hairdo(Rr, d) {
  const h = d.hair, hl = lite(h, 0.25);
  if (d.has('beanie')) { Rr(5, 9, 3, 5, h); Rr(24, 9, 3, 5, h); return; }
  const fringe = (w, ...sides) => { Rr(5, 2, 22, 7, h); Rr(7, 9, w, 1, h); for (const [sx, sw, sh] of sides) Rr(sx, 4, sw, sh, h); };
  switch (d.style) {
    case 'spiky': Rr(5, 3, 22, 6, h); for (let i = 0; i < 6; i++) Rr(6 + i * 4, 0, 2, 3, h); Rr(5, 9, 2, 4, h); Rr(25, 9, 2, 3, h); break;
    case 'curly':
      Rr(4, 1, 24, 8, h); Rr(3, 4, 3, 12, h); Rr(26, 4, 3, 12, h);
      for (let i = 0; i < 7; i++) Rr(4 + i * 4, 0, 3, 1, h);
      for (let i = 0; i < 3; i++) { Rr(2, 6 + i * 4, 1, 2, h); Rr(29, 6 + i * 4, 1, 2, h); }
      break;
    case 'bob': fringe(9, [3, 4, 20], [25, 4, 20]); Rr(7, 10, 6, 1, h); break;
    case 'long': fringe(6, [4, 3, 26], [25, 3, 26]); break;
    case 'bun': fringe(4, [5, 2, 9], [25, 2, 8]); Rr(11, -4, 10, 6, h); Rr(12, -5, 8, 1, h); break;
    default: fringe(5, [5, 2, 9], [25, 2, 8]); // short and pony (its tail hangs behind)
  }
  Rr(8, 3, 6, 1, hl); Rr(7, 4, 2, 2, hl);                                         // the light catching it, top left
}
