// Hairlines: a sent note's ink kept on HQ's page, faint and thin, with no number (marks.js places them as it places
// open marks). A finger's tap on one opens a small card beside it: what was said, when it went, and the answers clipped
// onto it. The maths here is plain (hairline.test.js); the card lives in review mode's closed shadow root, as the post-it
// does. A mark's note becomes its hairline at once, with no fade.
// The answers are slips (slip.js): then and now, a tick box, a reply written under them; an open note answered on its
// sheet (a question) opens the same card from its number.
import { CSS as SLIP_CSS, slipHtml, wireSlips } from './slip.js';
import { draw } from './ink.js';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// How far from a hairline a fingertip still touches it (px), and the line's own width and strength
export const REACH = 12;
const WIDTH = 0.75,
  ALPHA = 0.3;
// the card's gap from the tap, and from the page's edges
const GAP = 14,
  EDGE = 8;

// ---- the maths

// How far a point is from the segment a–b
export function segmentDistance([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax,
    dy = by - ay,
    len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// How far a point is from a note's lines (ink.js strokes, in the same px): its nearest piece, or Infinity with none
export function distanceTo(lines, at) {
  let best = Infinity;
  for (const { points } of lines) {
    if (points.length === 1) best = Math.min(best, Math.hypot(at[0] - points[0][0], at[1] - points[0][1]));
    for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(at, points[i - 1], points[i]));
  }
  return best;
}
// The hairline a tap at a point lands on: the nearest within reach, or null. hairs: [{ note, lines }]
export function hairAt(hairs, at, reach = REACH) {
  let hit = null,
    best = reach;
  for (const h of hairs) {
    const d = distanceTo(h.lines, at);
    if (d <= best) [hit, best] = [h, d];
  }
  return hit;
}
// Where the card goes for a tap at `at`: beside it on the right, else on the left, its middle level with the tap, kept
// within the page's box { w, h }. size: the card's { w, h }
export function cardPlace(at, size, box) {
  const right = at[0] + GAP,
    left = at[0] - GAP - size.w;
  const x = right + size.w <= box.w - EDGE ? right : left >= EDGE ? left : (box.w - size.w) / 2;
  const y = Math.min(Math.max(EDGE, at[1] - size.h / 2), box.h - size.h - EDGE);
  return { x: Math.round(Math.max(EDGE, x)), y: Math.round(Math.max(EDGE, y)) };
}
// When it went, as the card says it: "Sent Mon 08:16" (the page's own time)
export function sentLabel(when) {
  const d = new Date(when ?? NaN);
  if (Number.isNaN(d.getTime())) return 'Sent';
  const two = n => String(n).padStart(2, '0');
  return `Sent ${DAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// ---- the lines

// The hairlines on a canvas: each line through its points, the ink's colour faint, at WIDTH px
export function drawHairlines(g, lines) {
  g.save();
  g.lineCap = g.lineJoin = 'round';
  g.lineWidth = WIDTH;
  g.globalAlpha = ALPHA;
  for (const { color, points } of lines) {
    g.strokeStyle = g.fillStyle = color ?? '#2b2230';
    g.beginPath();
    if (points.length === 1) {
      g.arc(points[0][0], points[0][1], WIDTH, 0, Math.PI * 2);
      g.fill();
      continue;
    }
    points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
  }
  g.restore();
}

// ---- the card

export const CSS = `
      .hair { pointer-events: auto; position: absolute; width: min(300px, calc(100cqw - 16px)); max-height: 60vh; overflow: auto;
        background: #fffaf0; color: #2a2352; border-radius: 6px; padding: 10px 12px 11px; font: 14px/1.4 system-ui, -apple-system, sans-serif;
        box-shadow: 0 0 0 1px rgba(42,35,82,.12), 0 8px 24px rgba(42,35,82,.18); transform: rotate(-.4deg); animation: pop-in .18s ease-out; }
      .hair[hidden] { display: none; }
      .hair p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .hair .bare { color: #5a5478; font-style: italic; }
      .hair time { display: block; margin-top: 6px; color: #5a5478; font-size: 12px; }
      .hair h3 { margin: 10px 0 2px; padding-top: 8px; border-top: 1px dashed rgba(42,35,82,.2); font-size: 12px; font-weight: 700;
        letter-spacing: .04em; text-transform: uppercase; color: #5a5478; }
${SLIP_CSS}`;
export const HTML = '<div class="hair" hidden role="dialog" aria-label="A note in the book"></div>';

// The card for a note in the book (note: the store's, with its slips), beside a tap at `at` (the screen's px). line:
// where it is ("For Lark, not sent", "Sent Tue 09:12"), or a promise of it. on: the slips' { tick, reply } (slip.js
// wireSlips). (line)
export function showCard(r, note, at, line, on) {
  const card = r.$('.hair');
  card.replaceChildren();
  const add = (tag, text, cls = '') =>
    card.appendChild(Object.assign(document.createElement(tag), { textContent: text, className: cls }));
  if (note.words?.trim()) add('p', note.words.trim());
  else add('p', 'No words: the mark says it', 'bare');
  // (where it is, as marks.js words it)
  const time = add('time', '');
  Promise.resolve(line).then(text => card.contains(time) && (time.textContent = text));
  const slips = note.slips ?? [];
  if (slips.length) {
    add('h3', 'Answer');
    card.insertAdjacentHTML('beforeend', slips.map(s => slipHtml(s, note)).join(''));
    wireSlips(card, on);
  }
  card.dataset.note = note.id;
  card.hidden = false;
  const ui = r.ui.getBoundingClientRect(),
    place = cardPlace(
      [at[0] - ui.left, at[1] - ui.top],
      { w: card.offsetWidth, h: card.offsetHeight },
      { w: ui.width, h: ui.height },
    );
  Object.assign(card.style, { left: `${place.x}px`, top: `${place.y}px` });
}
export const hideCard = r => {
  const card = r.$('.hair');
  if (card) card.hidden = true;
};
export const cardOpen = r => r.$('.hair')?.hidden === false;
