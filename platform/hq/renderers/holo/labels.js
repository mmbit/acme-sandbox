// The deck's writing, on a 2d canvas laid into the hologram: each room's name tag with its people as pips, the
// company's name engraved in the table's rim, words and hearts floating up, the ring round whoever is picked out,
// what people feel (their emotes); and the panels' portraits.
import { canvas } from '../../util.js';
import { EMOTES, fade } from '../../world/emotes.js';
import { TAU, add, polar } from './gl.js';
import { TABLE_Y, CORE, built, agentAt } from './deck.js';
import { area } from './camera.js';
import { ART } from './draw.js';

const FACE = "Rajdhani, 'DejaVu Sans', 'Segoe UI', sans-serif";
// the deck's lettering, from Google Fonts (the only fonts HQ's CSP allows), once per page; until it's there, the fallbacks
export function loadFont() {
  if (document.querySelector('link[data-holo]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=Rajdhani:wght@600&display=swap'; l.dataset.holo = '';
  document.head.append(l);
}
const rgba = (c, a) => `rgba(${c.map(v => Math.round(Math.min(1, v) * 255)).join(',')},${a})`;
const PIP = { working: [0.67, 0.93, 1], idle: [0.67, 0.93, 1], waiting: [1, 0.66, 0.3], sleeping: [0.62, 0.55, 1] };

// g: the labels' canvas; project: world → CSS px. Leaves S.tags, where the name tags are (CSS px), for taps.
export function drawLabels(g, S, { project, view, name, lit, t }) {
  const k = view.w < 600 ? 0.75 : 1, rs = view.rs, tags = [];
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, g.canvas.width, g.canvas.height); g.setTransform(rs, 0, 0, rs, 0, 0);
  const mid = project([0, 1.4, 0])?.x ?? view.w / 2;
  for (const r of S.rooms) {
    const np = built(S, r), A = project(add(r.pos, polar(r.rp * 1.45, r.a, 0)));
    if (!A || np < 0.3) continue;
    const full = (r.grown ? 'NEW · ' : '') + r.w.name.toUpperCase(), text = np < 1 ? full.slice(0, Math.ceil(Math.min(1, (np - 0.3) / 0.3) * full.length)) : r.w.name.toUpperCase();
    tags.push({ room: r, A, side: A.x >= mid ? 1 : -1, text, col: np < 1 ? [1, 0.47, 0.82] : r.w.asleep ? [0.6, 0.55, 1] : [0.67, 0.93, 1], alpha: np < 1 && Math.sin(t * 60) > 0.6 ? 0.4 : 1 });
  }
  const A = S.core && project(add(CORE, [0, 0.42, 0]));
  if (A) tags.push({ room: S.core, A, side: 1, text: S.core.w.name.toUpperCase(), col: [1, 0.93, 0.8], alpha: 1, sub: S.requests ? `${S.requests} WAITING ON YOU` : null });
  const shown = place(g, tags, k, area());
  for (const tg of shown) paint(g, S, tg, k);
  S.tags = shown.map(tg => ({ id: tg.room.id, ...tg.box }));
  engrave(g, project, view, name.toUpperCase());
  for (const p of S.parts) {
    if (p.k !== 'text' && p.k !== 'heart') continue;
    const at = project(p.p);
    if (!at) continue;
    g.globalAlpha = Math.min(1, p.life * 2); g.fillStyle = p.c; g.textAlign = 'center'; g.font = `600 ${(p.k === 'heart' ? 18 : 16) * k}px ${FACE}`;
    g.fillText(p.s, at.x, at.y); g.globalAlpha = 1;
  }
  for (const P of S.people.values()) if (P.hit && P.emote) emote(g, project(add(agentAt(S, P), [0, 0.05, 0])), P, t, k);
  const P = lit && S.people.get(lit.id), at = P && project(agentAt(S, P));
  if (at) { // a reticle, turning
    g.strokeStyle = 'rgba(220,250,255,0.9)'; g.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) { const a = t * 1.5 + i * TAU / 4; g.beginPath(); g.arc(at.x, at.y, 13, a, a + 0.9); g.stroke(); }
  }
}
const FONT = k => `600 ${13 * k}px ${FACE}`;
// An emote (world/emotes.js) projected over someone's light at `at`: its glyph in a hexagon of light, flickering in
// as it fades in, rising a little as it goes
function emote(g, at, P, t, k) {
  const a = fade(P.emote), e = EMOTES[P.emote.kind];
  if (!at || !a) return;
  const r = 11 * k, y = at.y - r - 4 * k - (1 - a) * 6 * k, on = a < 1 && Math.sin(t * 70 + P.yaw * 9) > 0.4 ? 0.35 : 1;
  g.save(); g.globalAlpha = a * on; g.shadowColor = e.color; g.shadowBlur = 8 * k;
  g.strokeStyle = e.color; g.lineWidth = 1.2; g.beginPath();
  for (let i = 0; i < 6; i++) g.lineTo(at.x + Math.cos(i * TAU / 6) * r, y + Math.sin(i * TAU / 6) * r);
  g.closePath(); g.stroke(); g.shadowBlur = 0; g.fillStyle = 'rgba(4,16,28,0.8)'; g.fill();
  g.fillStyle = e.color; g.font = `700 ${15 * k}px ${FACE}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(e.glyph, at.x, y + 1);
  g.restore();
}
// The tags that get a place, nearest first: each takes the nearest clear spot for its name (one whose box lies whole
// inside the area the chrome leaves free and covers no name placed before it). A tag with no clear spot isn't drawn
// this frame, and its room is still a tap on its platform.
function place(g, tags, k, area) {
  const placed = [];
  for (const tg of tags.sort((a, b) => a.A.w - b.A.w)) {
    measure(g, tg, k);
    const spot = spots(tg, k, area).find(s => clear(nameBox(tg, s, k), placed));
    if (!spot) continue;
    Object.assign(tg, spot, { box: nameBox(tg, spot, k) });
    placed.push(tg);
  }
  return placed;
}
// How wide a tag's writing runs from its elbow: the name, the line under it (sub) and its pips, whichever is widest
function measure(g, tg, k) {
  g.font = FONT(k); g.letterSpacing = `${2.4 * k}px`; tg.w = g.measureText(tg.text).width; g.letterSpacing = '0px';
  g.font = `600 ${10 * k}px ${FACE}`;
  tg.span = Math.max(tg.w, tg.sub ? g.measureText(tg.sub).width : 0, (tg.sub ? 0 : tg.room.w.agentIds.length) * 8 * k) + 8 * k;
}
// A name box reaches ABOVE and BELOW its elbow's height (at full size) and PAD px past its ends
const ABOVE = 20, BELOW = 12, PAD = 4;
// Where a tag's name can go inside the area, nearest first: its elbow up and out from A (24 and 28 px at full size),
// then a step (8 px) higher or lower, or further out, each step counted as one, and on A's other side FLIP more. Only
// elbows whose name box lies whole inside the area, so a side without room gives none.
const FLIP = 6;
function* spots(tg, k, area) {
  const step = 8 * k, y = tg.A.y - 28 * k;
  const sides = [tg.side, -tg.side].map((side, i) => ({ side, flip: i ? FLIP : 0, ...room(tg, side, k, area) }))
    .filter(r => r.out[0] <= r.out[1] && r.dy[0] <= r.dy[1]);
  if (!sides.length) return;
  // the fewest and most steps up or down each side allows
  for (const r of sides) {
    r.near = r.dy[0] > 0 ? r.dy[0] : r.dy[1] < 0 ? -r.dy[1] : 0;
    r.far = Math.max(-r.dy[0], r.dy[1]);
  }
  const first = Math.min(...sides.map(r => r.flip + r.out[0] + r.near));
  const last = Math.max(...sides.map(r => r.flip + r.out[1] + r.far));
  for (let cost = first; cost <= last; cost++)
    for (const r of sides) {
      const rest = cost - r.flip;
      for (let out = Math.max(r.out[0], rest - r.far); out <= Math.min(r.out[1], rest - r.near); out++) {
        const n = rest - out;
        for (const dy of n ? [-n, n] : [0])
          if (dy >= r.dy[0] && dy <= r.dy[1])
            yield { side: r.side, E: [tg.A.x + r.side * (24 * k + out * step), y + dy * step] };
      }
    }
}
// On one side of A, the steps out (out: fewest and most) and up or down (dy: negative up) at which the tag's name box
// lies whole inside the area: the elbow's x leaves PAD before the box's near end, and the span plus PAD before its
// far one
function room(tg, side, k, area) {
  const step = 8 * k, x = tg.A.x + side * 24 * k, y = tg.A.y - 28 * k;
  const lo = area.x0 + PAD + (side < 0 ? tg.span : 0), hi = area.x1 - PAD - (side > 0 ? tg.span : 0);
  const [from, to] = side > 0 ? [lo - x, hi - x] : [x - hi, x - lo];
  return {
    out: [Math.max(0, Math.ceil(from / step)), Math.floor(to / step)],
    dy: [Math.ceil((area.y0 + ABOVE * k - y) / step), Math.floor((area.y1 - BELOW * k - y) / step)],
  };
}
// The box a tag's writing covers from a spot (CSS px), its leader line left out: what taps on the name hit
function nameBox(tg, { side, E }, k) {
  const end = E[0] + side * tg.span;
  return { x0: Math.min(E[0], end) - PAD, x1: Math.max(E[0], end) + PAD, y0: E[1] - ABOVE * k, y1: E[1] + BELOW * k };
}
// Whether a name box covers no name placed
const clear = (b, placed) => placed.every(({ box: p }) => b.x0 >= p.x1 || b.x1 <= p.x0 || b.y0 >= p.y1 || b.y1 <= p.y0);
// A name tag: the leader line, the name, a pip for each person (hollow: idle; filled: working; amber: waiting;
// violet: asleep), or a line of its own (sub)
function paint(g, S, { room, A, E, w, side, text, col, alpha, sub }, k) {
  const c = rgba(col, 0.92 * alpha);
  g.strokeStyle = rgba(col, 0.45 * alpha); g.lineWidth = 1;
  g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(E[0], E[1]); g.lineTo(E[0] + side * (w + 8 * k), E[1]); g.stroke();
  g.fillStyle = c; g.beginPath(); g.arc(A.x, A.y, 2, 0, TAU); g.fill();
  g.font = FONT(k); g.letterSpacing = `${2.4 * k}px`; g.textAlign = side > 0 ? 'left' : 'right'; g.textBaseline = 'alphabetic';
  g.fillText(text, E[0] + side * 4 * k, E[1] - 5 * k);
  g.letterSpacing = '0px';
  let x = E[0] + side * 4 * k;
  if (sub) { g.font = `600 ${10 * k}px ${FACE}`; g.fillStyle = 'rgba(255,120,110,0.95)'; g.fillText(sub, x, E[1] + 12 * k); return; }
  for (const id of room.w.agentIds) {
    const P = S.people.get(id); if (!P) continue;
    const px = side > 0 ? x : x - 6 * k, pc = rgba(PIP[P.state] ?? PIP.idle, 0.95 * alpha);
    g.strokeStyle = pc; g.strokeRect(px + 0.5, E[1] + 5 * k, 5 * k, 3 * k);
    if (P.state !== 'idle') { g.fillStyle = pc; g.fillRect(px + 0.5, E[1] + 5 * k, 5 * k, 3 * k); }
    x += side * 8 * k;
  }
}
// the company's name round the table's rim, letter by letter, facing whoever's looking
function engrave(g, project, view, text) {
  const R = 2.44, F = 40, k = 0.085 / F, yaw = Math.atan2(view.eye[0], view.eye[2]);
  g.font = `600 ${F}px ${FACE}`; g.letterSpacing = '14px'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(150,235,255,0.85)';
  const widths = [...text].map(ch => g.measureText(ch).width), total = widths.reduce((a, b) => a + b, 0) * k;
  let ang = yaw - total / R / 2;
  for (const [i, ch] of [...text].entries()) {
    const wa = widths[i] * k / R, a = ang + wa / 2, P = polar(R, a, TABLE_Y + 0.001);
    ang += wa;
    const p0 = project(P), pt = project(add(P, [Math.cos(a) * 0.01, 0, -Math.sin(a) * 0.01])), po = project(add(P, polar(0.01, a, 0)));
    if (!p0 || !pt || !po) continue;
    const rs = view.rs, s = k / 0.01 * rs;
    g.setTransform((pt.x - p0.x) * s, (pt.y - p0.y) * s, (po.x - p0.x) * s, (po.y - p0.y) * s, p0.x * rs, p0.y * rs);
    g.fillText(ch, 0, 0);
  }
  g.setTransform(view.rs, 0, 0, view.rs, 0, 0); g.letterSpacing = '0px';
}
// ---- portraits for the panels (as the panel shows them): a person's own pixel avatar as a hologram (hologramOf), or a
// mascot's wireframe over a projector in its colour (56×112); null for a kind the deck has no wireframe of
export function portrait(col, kind, sprite) {
  if (sprite) return hologramOf(sprite, col);
  const c = canvas(56, 112), g = c.getContext('2d'), css = rgba(col, 1);
  g.lineWidth = 1.5; g.strokeStyle = css; g.shadowColor = css; g.shadowBlur = 6;
  const beam = g.createLinearGradient(0, 104, 0, 30);
  beam.addColorStop(0, rgba(col, 0.35)); beam.addColorStop(1, rgba(col, 0));
  g.fillStyle = beam; g.beginPath(); g.moveTo(22, 104); g.lineTo(34, 104); g.lineTo(52, 30); g.lineTo(4, 30); g.fill();
  g.beginPath(); g.ellipse(28, 104, 14, 3, 0, 0, TAU); g.stroke();
  if (kind === 'agent') {
    g.beginPath(); g.arc(28, 52, 9, 0, TAU); g.stroke();
    g.beginPath(); g.moveTo(10, 94); g.bezierCurveTo(10, 72, 18, 66, 28, 66); g.bezierCurveTo(38, 66, 46, 72, 46, 94); g.stroke();
  } else {
    const art = ART[kind];
    if (!art) return null;
    g.beginPath();
    for (const poly of art.lines({ data: { activity: 'sit' } }, 0)) poly.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](28 + x * 260, 100 - y * 260));
    g.stroke();
  }
  g.shadowBlur = 0; g.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = 0; y < 112; y += 3) g.fillRect(0, y, 56, 1);
  return c;
}
// A person: their pixel avatar (the brownstone's sprite, 14×28, so the same face in every look) at three times its size,
// 48×96 as the panel shows it, so it stays crisp: lit in their room's colour by its own light and dark (with some of its
// own colours, so a face stays theirs), every other row
// dimmed, a soft glow round it, over a projector's beam
function hologramOf(sprite, col) {
  const c = canvas(48, 96), g = c.getContext('2d'), s = canvas(42, 84), h = s.getContext('2d');
  h.imageSmoothingEnabled = false; h.drawImage(sprite, 0, 0, 42, 84);
  const px = h.getImageData(0, 0, 42, 84), d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const light = (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255;
    for (let k = 0; k < 3; k++) d[i + k] = Math.min(255, 255 * (0.62 * Math.min(1, col[k]) * (0.12 + 1.15 * light) + 0.38 * d[i + k] / 255));
    d[i + 3] = (i / 4 / 42 | 0) % 2 ? 150 : 235;
  }
  h.putImageData(px, 0, 0);
  const beam = g.createLinearGradient(0, 92, 0, 20);
  beam.addColorStop(0, rgba(col, 0.3)); beam.addColorStop(1, rgba(col, 0));
  g.fillStyle = beam; g.beginPath(); g.moveTo(17, 89); g.lineTo(31, 89); g.lineTo(46, 20); g.lineTo(2, 20); g.fill();
  g.strokeStyle = rgba(col, 0.9); g.lineWidth = 1.2; g.beginPath(); g.ellipse(24, 89, 12, 2.5, 0, 0, TAU); g.stroke();
  g.shadowColor = rgba(col, 0.9); g.shadowBlur = 5; g.drawImage(s, 3, 6);
  return c;
}
