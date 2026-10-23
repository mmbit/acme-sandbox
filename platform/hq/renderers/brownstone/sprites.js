// Procedural characters: seeded by agent id, dressed by keywords in the free-text `look`,
// drawn as small isometric chibis in two views (front 3/4 and back 3/4). Left-facing frames are mirrors.
import { rng, pick, canvas, mix } from '../../util.js';
import { INK } from './iso.js';

export const CW = 14, CH = 28, FOOT = 25; // sprite canvas and the row the feet stand on
const OY = 5; // headroom for buns, hats and umbrellas
const SKINS = ['#ffd9b8', '#f5c49c', '#e0a878', '#c68a5c', '#9c6644', '#7a4b30'];
const HAIRS = ['#2b2230', '#5a3825', '#8b5a2b', '#d9a441', '#e8e0d0', '#c8553d', '#6b4c9a', '#3d6e70'];
const SHIRTS = ['#5b8def', '#e8505b', '#7bd389', '#ffb86b', '#9b72cf', '#4fb5a5', '#ff8fab', '#f2c14e'];
const PANTS = ['#34508f', '#3b3355', '#565a70', '#6e4029'];
const STYLES = ['short', 'bob', 'spiky', 'bun', 'long', 'curly'];
const COLORS = { green: '#5cc26a', red: '#e8505b', blue: '#5b8def', pink: '#ff8fab', yellow: '#f2c14e', purple: '#9b72cf', orange: '#ff9b4a', black: '#2b2230', white: '#f6f1e6', grey: '#8b8fa3', gold: '#ffd966' };

export function makeLook(agent) {
  const r = rng(agent.id || agent.name || '?');
  const t = (agent.look || '').toLowerCase();
  const has = (...w) => w.some(k => t.includes(k));
  const colorWord = Object.keys(COLORS).find(c => t.includes(c));
  const d = {
    skin: pick(r, SKINS), hair: pick(r, HAIRS), style: pick(r, STYLES), shirt: pick(r, SHIRTS), pants: pick(r, PANTS),
    accent: colorWord ? COLORS[colorWord] : pick(r, SHIRTS), shoes: '#3b3355', has, board: !!agent.board,
  };
  if (has('ponytail')) d.style = 'pony';
  if (has('beanie', 'hoodie', 'hat', 'visor')) d.style = 'short';
  if (has('hi-vis', 'vest')) d.shirt = '#d4f542';
  if (has('hoodie')) d.shirt = d.accent === d.shirt ? '#565a70' : d.accent;
  if (has('suit')) { d.shirt = '#2f3b63'; d.pants = '#2f3b63'; }
  if (has('sneaker')) d.shoes = '#ff8fab';
  // org.yaml's sprite: the look spelled out (colours as #rrggbb, a hair style), over what the id and the words pick
  const own = agent.sprite ?? {};
  for (const k of ['skin', 'hair', 'shirt', 'pants', 'shoes']) if (/^#[0-9a-f]{6}$/i.test(own[k] ?? '')) d[k] = own[k];
  if ([...STYLES, 'pony'].includes(own.style)) d.style = own.style;
  // an apron of a colour the look names just before it ("red darkroom apron")
  const apron = t.match(/\b([a-z]+) (?:[a-z]+ )?apron\b/), ac = [apron?.[1], apron?.[0].split(' ')[1]].find(w => COLORS[w]);
  d.apron = ac ? COLORS[ac] : null;
  d.props = deskProps(agent, has);
  return d;
}

function deskProps(agent, has) {
  const p = [];
  if (agent.board) p.push('phone');
  if (has('mug', 'coffee')) p.push(has('oversized') ? 'bigmug' : 'mug');
  const map = [['tea', 'tea'], ['synth', 'synth'], ['keyboard', 'synth'], ['abacus', 'abacus'], ['clipboard', 'clipboard'], ['binder', 'binders'], ['lamp', 'lamp'],
    ['parcel', 'parcels'], ['box', 'parcels'], ['gavel', 'gavel'], ['magnif', 'magnifier'], ['notebook', 'notebook'], ['quill', 'quill'], ['paint', 'palette'], ['cable', 'cables'], ['sticky', 'stickies']];
  for (const [k, v] of map) if (has(k) && !p.includes(v)) p.push(v);
  return p;
}

// frame: stand | walk1 | walk2 | blink | sit | type1 | type2 | sleep. front: facing the viewer. item: held thing.
function drawSprite(g, d, frame = 'stand', front = true, item = '') {
  const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y + OY, w, h); };
  const P = (x, y, c) => R(x, y, 1, 1, c);
  const { skin, hair, shirt, pants, accent, has } = d;
  const seated = frame === 'sit' || frame === 'type1' || frame === 'type2' || frame === 'sleep';
  const sy = seated ? 4 : 0, sleeping = frame === 'sleep';
  const arm = has('rolled') ? skin : shirt, dark = mix(shirt, INK, 0.25);
  // legs
  if (!seated) {
    const a = frame === 'walk1', b = frame === 'walk2';
    R(5, 15, 2, a ? 3 : 4, pants); R(7, 15, 2, b ? 3 : 4, pants);
    R(4, a ? 18 : 19, 3, 1, d.shoes); R(7, b ? 18 : 19, 3, 1, d.shoes);
  }
  // torso
  R(4, 10 + sy, 6, 5, shirt); R(4, 14 + sy, 6, 1, dark);
  // seated, facing us: the lap comes forward over the lower torso and the shins hang over the seat's edge
  if (seated && front) { R(4, 13 + sy, 6, 2, pants); R(4, 15 + sy, 2, 2, pants); R(8, 15 + sy, 2, 2, pants); R(4, 17 + sy, 2, 1, d.shoes); R(8, 17 + sy, 2, 1, d.shoes); }
  if (front) R(6, 10 + sy, 2, 1, mix(skin, INK, 0.1));
  if (has('toolbelt')) { R(4, 14 + sy, 6, 1, '#6e4029'); P(front ? 8 : 5, 14 + sy, '#ffd966'); }
  if (has('apron')) front ? (R(5, 11 + sy, 4, 4, '#f6e7c1'), P(5, 12 + sy, '#ff8fab'), P(7, 13 + sy, '#5b8def'), P(8, 11 + sy, '#7bd389')) : P(6, 12 + sy, '#f6e7c1');
  // an apron of a colour the look names is that colour, plain, down to the knees
  // (its bow at the back), and a camera hung round the neck on its strap sits on the chest (the strap across the neck
  // from behind)
  const ac = has('apron') && d.apron;
  if (ac && front) {
    R(5, 11 + sy, 4, seated ? 4 : 6, ac); R(5, 14 + sy, 4, 1, mix(ac, INK, 0.25)); R(5, 11 + sy, 1, seated ? 4 : 6, mix(ac, '#ffffff', 0.25));
  } else if (ac) { P(5, 12 + sy, ac); R(6, 12 + sy, 2, 2, ac); P(8, 12 + sy, ac); }
  const camera = has('camera on a strap', 'camera round the neck', 'camera around the neck');
  if (camera && front) {
    P(5, 10 + sy, '#3b3355'); P(8, 10 + sy, '#3b3355'); R(5, 11 + sy, 4, 2, '#2b2230'); P(5, 11 + sy, '#c9ccd8'); R(6, 12 + sy, 2, 1, '#8b8fa3'); P(7, 12 + sy, '#bfe3ff');
  } else if (camera) R(4, 10 + sy, 6, 1, '#3b3355');
  if (has('hi-vis', 'vest')) R(4, 12 + sy, 6, 1, '#f6f1e6');
  if (has('hoodie')) front ? (P(5, 11 + sy, '#f6f1e6'), P(8, 11 + sy, '#f6f1e6')) : R(5, 10 + sy, 4, 2, dark);
  if (has('suit') && front) { P(6, 10 + sy, '#fff'); P(7, 10 + sy, '#fff'); R(7, 11 + sy, 1, 2, '#e8505b'); }
  if (front && has('gold star', 'chess', 'flower pin')) P(5, 11 + sy, has('chess') ? '#f6f1e6' : '#ffd966');
  // arms
  if (frame === 'type1' || frame === 'type2') {
    const up = frame === 'type1';
    R(3, (up ? 10 : 11) + sy, 1, 2, arm); R(10, (up ? 11 : 10) + sy, 1, 2, arm);
    if (front) { P(4, 13 + sy, skin); P(9, 13 + sy, skin); }
  } else if (sleeping) { R(2, 11 + sy, 2, 1, arm); R(10, 11 + sy, 2, 1, arm); }
  else if (seated) { R(3, 10 + sy, 1, 3, arm); R(10, 10 + sy, 1, 3, arm); }
  else if (frame === 'water') { R(3, 10, 1, 4, arm); P(3, 14, skin); P(10, 10, arm); P(11, 9, arm); P(12, 8, skin); } // holding the can out
  else { R(3, 10, 1, 4, arm); R(10, 10, 1, 4, arm); P(3, 14, skin); P(10, 14, skin); }
  // head
  const hy = sy + (sleeping ? 3 : 0);
  const H = (x, y, w, h) => R(x, y + hy, w, h, hair);
  R(3, 3 + hy, 8, 7, skin);
  if (front) {
    switch (d.style) {
      case 'bob': H(3, 1, 8, 3); H(2, 2, 1, 6); H(11, 2, 1, 6); H(3, 4, 4, 1); break;
      case 'spiky': H(3, 1, 8, 3); H(4, 0, 1, 1); H(6, 0, 1, 1); H(8, 0, 1, 1); H(10, 0, 1, 1); H(3, 4, 1, 1); break;
      case 'bun': H(3, 1, 8, 3); H(6, -1, 3, 2); H(3, 4, 2, 1); break;
      case 'long': H(3, 1, 8, 3); H(2, 2, 1, 9); H(11, 2, 1, 7); H(3, 4, 3, 1); break;
      case 'curly': H(2, 1, 10, 3); H(2, 4, 1, 2); H(11, 4, 1, 2); H(4, 0, 1, 1); H(7, 0, 1, 1); H(10, 0, 1, 1); break;
      case 'pony': H(3, 1, 8, 3); H(2, 3, 1, 5); H(1, 5, 1, 4); break;
      default: H(3, 1, 8, 3); H(3, 4, 2, 1); H(10, 4, 1, 1);
    }
    const shut = sleeping || frame === 'blink';
    if (shut) { R(6, 6 + hy, 1, 1, mix(skin, INK, 0.45)); R(9, 6 + hy, 1, 1, mix(skin, INK, 0.45)); }
    else { P(6, 6 + hy, INK); P(9, 6 + hy, INK); P(6, 5 + hy, mix(skin, '#ffffff', 0.5)); }
    P(5, 8 + hy, '#ff9e9e'); P(10, 8 + hy, '#ff9e9e');
    P(8, 8 + hy, mix(skin, INK, 0.35));
    if (has('eyebrow')) { R(5, 4 + hy, 2, 1, INK); R(9, 4 + hy, 2, 1, INK); }
    if (has('glasses', 'spectacles')) { const f = '#6a5f80'; R(5, 5 + hy, 3, 1, f); R(8, 5 + hy, 3, 1, f); P(5, 6 + hy, f); P(7, 6 + hy, f); P(8, 6 + hy, f); P(10, 6 + hy, f); }
    if (has('goggles')) { R(3, 3 + hy, 8, 1, '#3b3355'); P(6, 3 + hy, '#ffb86b'); P(9, 3 + hy, '#ffb86b'); }
    if (has('headset')) { P(8, 9 + hy, '#3b3355'); P(9, 9 + hy, '#3b3355'); }
    if (has('negatives')) { R(11, 2 + hy, 1, 5, '#3b2a20'); P(11, 3 + hy, '#e0a050'); P(11, 5 + hy, '#e0a050'); } // a strip of film behind the ear
    if (has('pencil')) { P(11, 3 + hy, '#f2c14e'); P(11, 4 + hy, '#f2c14e'); P(11, 2 + hy, '#ff8fab'); }
    if (has('flower')) { P(9, 1 + hy, '#ff8fab'); P(10, 1 + hy, '#ff8fab'); P(10, 0 + hy, '#ffd966'); }
  } else {
    // back of the head: mostly hair, an ear on the left
    H(3, 1, 8, 8); H(4, 0, 6, 1); P(3, 6 + hy, skin); R(5, 9 + hy, 4, 1, mix(skin, INK, 0.1));
    if (has('negatives')) { R(2, 3 + hy, 1, 5, '#3b2a20'); P(2, 4 + hy, '#e0a050'); P(2, 6 + hy, '#e0a050'); } // (behind the ear)
    if (d.style === 'long') H(3, 9, 8, 3);
    if (d.style === 'bob') { H(2, 2, 1, 6); H(11, 2, 1, 6); }
    if (d.style === 'bun') H(5, -1, 4, 2);
    if (d.style === 'pony') { H(6, 9, 2, 4); P(6, 8 + hy, accent); }
    if (d.style === 'curly') { H(2, 1, 10, 7); H(4, 0, 1, 1); H(8, 0, 1, 1); }
    if (d.style === 'spiky') { H(4, -1, 1, 1); H(7, -1, 1, 1); H(9, -1, 1, 1); }
  }
  if (has('visor')) { R(3, 2 + hy, 8, 1, '#2b2230'); R(front ? 4 : 2, 3 + hy, 8, 1, accent); }
  if (has('beanie')) { R(3, 0 + hy, 8, 4, accent); R(3, 3 + hy, 8, 1, mix(accent, '#ffffff', 0.35)); P(6, -1 + hy, '#f6f1e6'); P(7, -1 + hy, '#f6f1e6'); }
  if (has('hat') && has('pen', 'tip')) { R(3, 1 + hy, 8, 1, INK); R(4, 0 + hy, 6, 1, INK); R(6, -2 + hy, 2, 2, INK); P(6, -2 + hy, '#ffd966'); }
  if (has('headphone', 'headset')) { R(3, 0 + hy, 8, 1, '#3b3355'); P(2, 1 + hy, '#3b3355'); P(11, 1 + hy, '#3b3355'); R(2, 4 + hy, 1, 3, accent); R(11, 4 + hy, 1, 3, accent); }
  if (d.party && !sleeping) { R(5, -1 + hy, 4, 1, '#ff8fab'); R(6, -2 + hy, 2, 1, '#5b8def'); P(6, -3 + hy, '#ffd966'); }
  if (item) drawItem(R, P, item, front, sy);
}

// The cocktail bar's glasses, [x, y, w, h, colour] from the middle of the glass's foot: on its counter (rooms.js), and in
// the hand of whoever is having one there. A blue one with a cherry, a green one with lime, a mojito with mint and a straw
const GLASS = '#d6ecfb';
export const DRINKS = {
  blue: [[-1, 0, 3, 1, GLASS], [0, -2, 1, 2, GLASS], [0, -3, 1, 1, '#3f7fdc'], [-1, -4, 3, 1, '#5b8def'], [-2, -5, 5, 1, '#8fd3ff'], [2, -6, 1, 1, '#e8505b']],
  green: [[-1, 0, 3, 1, GLASS], [0, -1, 1, 1, GLASS], [-1, -2, 3, 1, '#3f9b5c'], [-2, -3, 5, 1, '#7bd389'], [2, -4, 1, 1, '#e6f27a']],
  mojito: [[-1, -5, 3, 6, GLASS], [-1, -4, 3, 4, '#c8efb8'], [-1, -2, 1, 1, '#3f9b5c'], [0, -3, 1, 1, '#3f9b5c'], [1, -1, 1, 1, '#5cc26a'], [1, -4, 1, 1, '#e6f27a'], [1, -7, 1, 3, '#e8505b']],
};
function drawItem(R, P, item, front, sy) {
  if (DRINKS[item]) { for (const [x, y, w, h, c] of DRINKS[item]) R(12 + x, 10 + sy + y, w, h, c); return; }
  switch (item) {
    case 'cup': front ? (R(10, 12, 2, 3, '#f6f1e6'), P(12, 13, '#f6f1e6'), P(10, 12, '#6e4029')) : R(10, 12, 2, 2, '#f6f1e6'); break;
    case 'paper': front ? (R(4, 10 + sy, 7, 4, '#f6f1e6'), R(5, 11 + sy, 3, 1, INK), R(5, 12 + sy, 5, 1, '#8b8fa3'), R(9, 11 + sy, 1, 1, '#e8505b')) : (R(2, 10 + sy, 1, 4, '#f6f1e6'), R(11, 10 + sy, 1, 4, '#f6f1e6')); break;
    case 'can': R(10, 12, 3, 3, '#f2c14e'); P(13, 11, '#f2c14e'); P(12, 12, '#d9a441'); break; // the watering can
    case 'box': R(4, 9, 6, 5, '#cf9460'); R(6, 9, 2, 5, '#f6e7c1'); R(4, 13, 6, 1, '#a8693f'); break;
    case 'umbrella': R(1, -3, 12, 2, '#e8505b'); R(3, -4, 8, 1, '#e8505b'); R(2, -1, 2, 1, '#e8505b'); R(6, -1, 2, 1, '#e8505b'); R(10, -1, 2, 1, '#e8505b'); R(7, -1, 1, 13, '#3b3355'); P(4, -3, '#fffaf0'); break;
  }
}

// Sprite frames are cached per agent, so drawing a character is one drawImage.
const cache = new Map();
export function spriteFrame(id, d, frame, front = true, right = true, item = '') {
  const k = `${id}|${frame}|${front}|${right}|${item}|${d.party ? 1 : 0}`;
  let c = cache.get(k);
  if (!c) {
    c = canvas(CW, CH);
    const g = c.getContext('2d');
    if (!right) { g.translate(CW, 0); g.scale(-1, 1); }
    drawSprite(g, d, frame, front, item);
    cache.set(k, c);
  }
  return c;
}
export const clearSpriteCache = () => cache.clear();

// ---- the rooftop cat: plum fur, gold eyes and a board-member collar ----
const CAT = '#3b3355', CAT2 = '#4f4670';
export function catFrame(frame, right) {
  const k = `cat|${frame}|${right}`;
  let c = cache.get(k);
  if (c) return c;
  c = canvas(14, 12);
  const g = c.getContext('2d');
  if (!right) { g.translate(14, 0); g.scale(-1, 1); }
  const R = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  if (frame === 'sleep') {
    R(3, 7, 8, 3, CAT); R(4, 6, 6, 1, CAT); R(9, 6, 3, 3, CAT2); R(2, 9, 5, 1, CAT2); R(9, 5, 1, 1, CAT); R(11, 5, 1, 1, CAT);
    R(10, 8, 1, 1, '#e8505b');
  } else if (frame === 'sit' || frame === 'loaf') {
    const loaf = frame === 'loaf';
    R(4, loaf ? 7 : 5, 5, loaf ? 3 : 5, CAT); R(8, loaf ? 4 : 2, 4, 4, CAT); R(8, loaf ? 3 : 1, 1, 1, CAT); R(11, loaf ? 3 : 1, 1, 1, CAT);
    R(2, 9, 3, 1, CAT2); R(1, loaf ? 8 : 7, 1, 2, CAT2);
    R(10, loaf ? 5 : 3, 1, 1, '#ffd966'); R(8, loaf ? 7 : 5, 4, 1, '#e8505b'); R(10, loaf ? 8 : 6, 1, 1, '#ffd966');
  } else {
    const step = frame === 'walk1' ? 1 : 0;
    R(3, 5, 6, 3, CAT); R(8, 3, 4, 3, CAT); R(8, 2, 1, 1, CAT); R(11, 2, 1, 1, CAT); R(2, 3 + step, 1, 3, CAT2);
    R(3, 8, 1, 2 - step, CAT); R(8, 8, 1, 2 - step, CAT); R(4, 8, 1, 1 + step, CAT); R(7, 8, 1, 1 + step, CAT);
    R(10, 4, 1, 1, '#ffd966'); R(8, 6, 3, 1, '#e8505b'); R(9, 7, 1, 1, '#ffd966');
  }
  cache.set(k, c);
  return c;
}

// ---- the rooftop penguin: the cat's plum on its back, a cream front, orange beak and feet, a board member's bow tie.
// Drawn from rows, one char a pixel ('.' clear), in the cat's 14×12, facing right.
const PENGUIN = { K: CAT, k: CAT2, W: '#fffaf0', E: '#fffaf0', O: '#ff9b4a', R: '#e8505b', Y: '#ffd966' };
const UPRIGHT = [
  '......KKKK....',
  '.....KKKKKK...',
  '.....KKKKEKOO.',
  '.....KKKKKWO..',
  '.....KKKRYRW..',
  '.....KkKWWWW..',
  '.....KkKWWWW..',
  '.....KKkWWWW..',
  '......KKWWW...',
  '.....OO..OO...',
];
const PENGUIN_ROWS = {
  sit: UPRIGHT,
  // flat on its front, head up, as if about to toboggan
  loaf: [
    '..............', '..............', '..............', '..............',
    '.........KKKK.',
    '........KKKEKO',
    '..KKKKKKKKKKO.',
    '.OKKkkkKRYRW..',
    '..WWWWWWWWWW..',
  ],
  // stood still, head sunk and beak tucked into its front, eyes shut
  sleep: [
    '..............',
    '......KKKK....',
    '.....KKKKKK...',
    '.....KKKKKKK..',
    '.....KkKKKOK..',
    '.....KkKWWWW..',
    '.....KKkWWWW..',
    '......KKWWW...',
    '.....OO..OO...',
  ],
};
// the waddle: the top half rocks forward and back, a flipper out for balance, the weight on one foot then the other
const waddle = (lean, foot) => UPRIGHT.map((row, y) => y < 5 ? (lean > 0 ? '.' + row.slice(0, -1) : row.slice(1) + '.')
  : y === 6 ? '....k' + row.slice(5) : y === 9 ? foot : row);
PENGUIN_ROWS.walk1 = waddle(1, '.....OO.......'); PENGUIN_ROWS.walk2 = waddle(-1, '.........OO...');
export function penguinFrame(frame, right) {
  const k = `penguin|${frame}|${right}`;
  let c = cache.get(k);
  if (c) return c;
  c = canvas(14, 12);
  const g = c.getContext('2d');
  if (!right) { g.translate(14, 0); g.scale(-1, 1); }
  PENGUIN_ROWS[frame].forEach((row, y) => [...row].forEach((ch, x) => { if (PENGUIN[ch]) { g.fillStyle = PENGUIN[ch]; g.fillRect(x, y, 1, 1); } }));
  cache.set(k, c);
  return c;
}

// Things on desks, from the look text. They are drawn front-on, which reads fine on iso desk tops.
export function drawProp(g, name, x, y) {
  const R = (a, b, w, h, c) => { g.fillStyle = c; g.fillRect(x + a, y + b, w, h); };
  switch (name) {
    case 'phone': R(0, -3, 4, 3, '#e8505b'); R(0, -4, 4, 1, '#8e2c35'); R(1, -2, 1, 1, '#fff'); break;
    case 'mug': R(0, -3, 2, 3, '#f6f1e6'); R(2, -2, 1, 1, '#f6f1e6'); break;
    case 'bigmug': R(0, -4, 3, 4, '#ffb86b'); R(3, -3, 1, 2, '#ffb86b'); R(1, -4, 1, 1, '#6e4029'); break;
    case 'tea': R(0, -2, 3, 2, '#7bd389'); R(3, -2, 1, 1, '#7bd389'); R(1, -4, 1, 1, '#c9ccd8'); break;
    case 'synth': R(-2, -2, 8, 2, '#2b2230'); for (let i = 0; i < 4; i++) R(-1 + i * 2, -2, 1, 1, '#f6f1e6'); break;
    case 'abacus': R(0, -5, 5, 5, '#a8693f'); R(1, -4, 3, 3, '#f6e7c1'); R(1, -4, 1, 1, '#e8505b'); R(3, -2, 1, 1, '#5b8def'); break;
    case 'clipboard': R(0, -4, 3, 4, '#a8693f'); R(0, -3, 3, 3, '#fff'); R(1, -5, 1, 1, '#8b8fa3'); break;
    case 'binders': R(0, -6, 2, 6, '#e8505b'); R(2, -6, 2, 6, '#5b8def'); R(4, -5, 1, 5, '#f2c14e'); break;
    case 'lamp': R(1, -6, 1, 6, '#3b3355'); R(0, -7, 4, 2, '#7bd389'); R(1, -5, 2, 1, '#ffd966'); break;
    case 'parcels': R(0, -3, 4, 3, '#cf9460'); R(1, -6, 3, 3, '#b07a4f'); R(2, -3, 1, 3, '#f6e7c1'); break;
    case 'gavel': R(0, -2, 4, 2, '#6e4029'); R(2, -4, 1, 2, '#a8693f'); break;
    case 'magnifier': R(0, -4, 3, 3, '#8b8fa3'); R(1, -3, 1, 1, '#bfe3ff'); R(3, -1, 1, 1, '#6e4029'); break;
    case 'notebook': R(0, -1, 4, 1, '#f6f1e6'); R(0, -2, 4, 1, '#ff8fab'); break;
    case 'quill': R(1, -5, 1, 4, '#f6f1e6'); R(2, -6, 1, 3, '#f6f1e6'); R(0, -1, 3, 1, '#2b2230'); break;
    case 'duck': R(0, -2, 4, 2, '#ffd966'); R(2, -4, 2, 2, '#ffd966'); R(4, -3, 1, 1, '#f2a65a'); R(3, -4, 1, 1, INK); break;
    case 'cactus': R(0, -2, 3, 2, '#e07a5f'); R(1, -5, 1, 3, '#3f9b5c'); R(0, -4, 1, 1, '#3f9b5c'); R(2, -5, 1, 1, '#ff8fab'); break;
    case 'photo': R(0, -4, 4, 4, '#d9a441'); R(1, -3, 2, 2, '#8fd3ff'); R(1, -2, 2, 1, '#7bd389'); break;
    case 'palette': R(0, -1, 4, 1, '#cf9460'); R(0, -2, 1, 1, '#e8505b'); R(2, -2, 1, 1, '#5b8def'); break;
  }
}
