// The tips book's little scenes (booktips.js): a few seconds of the book or HQ drawn in SVG, looping, with the pen, a
// finger or the mouse doing the thing the tip is about. Plain SMIL, so a scene plays with no script and stops where
// it's set (reduced motion: its last moment, still). A scene is 240 × 150; its parts take their times as parts of the
// loop (0 to 1), and the whole fades out at the loop's end to start again.

export const W = 240,
  H = 150,
  LOOP_S = 4;
// The moment a still scene (reduced motion) shows: everything done, nothing faded yet
export const STILL = 0.86;

const times = (...t) => t.map(n => +n.toFixed(3)).join(';');
const anim = (attr, values, keys, more = '') =>
  `<animate attributeName="${attr}" values="${values}" keyTimes="${keys}" dur="${LOOP_S}s" repeatCount="indefinite" ${more}/>`;

// The scene: its parts on the paper, all fading out together as the loop ends
export const scene = (...parts) =>
  `<svg class="tb-scene" viewBox="0 0 ${W} ${H}" aria-hidden="true"><g>${parts.join('')}${anim(
    'opacity',
    '1;1;0;0',
    times(0, 0.9, 0.97, 1),
  )}</g></svg>`;

// A part shown from one moment to another (to: 1 keeps it to the end)
export const during = (from, to, part) =>
  `<g opacity="0">${part}${anim('opacity', '0;0;1;1;0', times(0, from, Math.min(from + 0.03, to), to, Math.min(to + 0.001, 1)), 'calcMode="discrete"')}</g>`;
// A part moved (dx, dy) and scaled about (cx, cy) between two moments, and left there
export function moved(from, to, { dx = 0, dy = 0, scale = 1, cx = 0, cy = 0 }, part) {
  const at = times(0, from, to, 1),
    scaled =
      scale === 1
        ? part
        : `<g transform="translate(${cx} ${cy})"><g>${turn('scale', `1;1;${scale};${scale}`, at)}<g transform="translate(${-cx} ${-cy})">${part}</g></g></g>`;
  return `<g>${turn('translate', `0 0;0 0;${dx} ${dy};${dx} ${dy}`, at)}${scaled}</g>`;
}
const turn = (type, values, keys) =>
  `<animateTransform attributeName="transform" type="${type}" additive="sum" values="${values}" keyTimes="${keys}" calcMode="spline" keySplines="0 0 1 1;.3 0 .2 1;0 0 1 1" dur="${LOOP_S}s" repeatCount="indefinite"/>`;

// A line written between two moments, as the pen draws it
export const ink = (d, from, to, { cls = 'tb-ink', width = 2.6 } = {}) =>
  `<path class="${cls}" d="${d}" pathLength="1" stroke-width="${width}" stroke-dasharray="1 1" stroke-dashoffset="1">${anim(
    'stroke-dashoffset',
    '1;1;0;0',
    times(0, from, to, 1),
  )}</path>`;

// Something carried along a path between two moments (the pen, a finger), shown a little before and after
const along = (d, from, to, body) =>
  `<g opacity="0">${body}<animateMotion path="${d}" keyPoints="0;0;1;1" keyTimes="${times(0, from, to, 1)}" calcMode="linear" dur="${LOOP_S}s" repeatCount="indefinite"/>${anim(
    'opacity',
    '0;0;1;1;0;0',
    times(0, Math.max(from - 0.06, 0), from, to + 0.06, Math.min(to + 0.1, 1), 1),
  )}</g>`;
// The Pencil, its tip on the point
const PEN =
  '<g class="tb-pen" transform="rotate(-35)"><path d="M0 0l3-8h-6z" class="tb-pen-tip"/><rect x="-3" y="-44" width="6" height="36" rx="1.5"/></g>';
export const pen = (d, from, to) => along(d, from, to, PEN);
// A fingertip pressed down
const FINGER = '<circle class="tb-finger" r="9"/>';
export const finger = (d, from, to) => along(d, from, to, FINGER);
// The mouse's arrow
const ARROW = '<path class="tb-arrow" d="M0 0v15l4-4 3 7 3-1.4-3-6.6h5.6z"/>';
export const mouse = (d, from, to) => along(d, from, to, ARROW);
// A line written between two moments and what writes it (the pen, or the mouse or a finger: by), along the same path
export const written = (d, from, to, { by = pen, ...look } = {}) => ink(d, from, to, look) + by(d, from, to);
// A tap at a point: a fingertip, and a ring spreading from it
export const tap = (x, y, at) =>
  during(at - 0.05, at + 0.08, `<circle class="tb-finger" cx="${x}" cy="${y}" r="9"/>`) +
  `<circle class="tb-ring" cx="${x}" cy="${y}" r="9" opacity="0">${anim('r', '9;9;22;22', times(0, at, at + 0.12, 1))}${anim(
    'opacity',
    '0;0;.8;0;0',
    times(0, at, at + 0.01, at + 0.12, 1),
  )}</circle>`;

// ---- the things in a scene

// A page of HQ (an app, an artifact): its bar and a few cards
export const hqPage = (x = 8, y = 10, w = 150, h = 130) =>
  `<g class="tb-hq"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/><rect class="tb-hq-bar" x="${x}" y="${y}" width="${w}" height="14" rx="6"/>` +
  `<rect class="tb-card" x="${x + 10}" y="${y + 24}" width="${w * 0.55}" height="22" rx="3"/>` +
  `<rect class="tb-card" x="${x + 10}" y="${y + 54}" width="${w - 20}" height="30" rx="3"/>` +
  `<rect class="tb-card" x="${x + 10}" y="${y + 92}" width="${w * 0.4}" height="26" rx="3"/></g>`;
// A page of the book: its paper, a few faint lines
export const bookPage = (x = 20, y = 8, w = 200, h = 134) =>
  `<g class="tb-paper"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>${[1, 2, 3, 4, 5]
    .map(i => `<path class="tb-rule" d="M${x + 10} ${y + i * (h / 6)}h${w - 20}"/>`)
    .join('')}</g>`;
// The open book at the screen's right edge: its black cover round the paper
export const bookEdge = (x = 176, y = 6, w = 64, h = 138) =>
  `<g class="tb-mini"><rect class="tb-mini-cover" x="${x}" y="${y}" width="${w + 6}" height="${h}" rx="5"/><rect class="tb-mini-paper" x="${x + 4}" y="${y + 5}" width="${w - 4}" height="${h - 10}" rx="2"/></g>`;
// A note in the book: a little card of handwriting
export const note = (x, y, w = 92, h = 34) =>
  `<g class="tb-note"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/><path class="tb-scrawl" d="M${x + 8} ${y + 12}q6-5 12 0t12 0t12 0t12 0M${x + 8} ${y + 24}q6-5 12 0t12 0t12 0"/></g>`;
// An agent's face, round
export const face = (x, y, r = 11, cls = '') =>
  `<g class="tb-face ${cls}"><circle cx="${x}" cy="${y}" r="${r}"/><circle class="tb-face-eye" cx="${x - r * 0.35}" cy="${y - r * 0.1}" r="${r * 0.12}"/><circle class="tb-face-eye" cx="${x + r * 0.35}" cy="${y - r * 0.1}" r="${r * 0.12}"/><path class="tb-face-smile" d="M${x - r * 0.35} ${y + r * 0.3}q${r * 0.35} ${r * 0.3} ${r * 0.7} 0"/></g>`;
// A key on a keyboard, pressed at a moment
export const key = (x, y, label, at, w = 30) =>
  `<g class="tb-key"><rect x="${x}" y="${y}" width="${w}" height="28" rx="5">${anim(
    'y',
    `${y};${y};${y + 3};${y};${y}`,
    times(0, at, at + 0.04, at + 0.14, 1),
  )}</rect><text x="${x + w / 2}" y="${y + 19}" text-anchor="middle">${label}</text></g>`;
