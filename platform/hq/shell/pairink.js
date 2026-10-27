// A second screen's ink on this one (pair.js): what the Pencil draws on HQ's page there shows here as it's drawn, on
// the same element wherever this screen's layout puts it, and the mark it makes stays drawn here while it's open, no
// longer: once it's in the book, let go, or the other screen is away, nothing of it is drawn here (rule zero). The lines
// go across as review mode's ink events (shared/watchalong/strokes.js's phases), each stroke with the anchor of
// what it began on (shared/review/anchor.js: the element's selector and box, the points in document px), so a phone's
// ring lands round the same button on a desktop's wider page.
// A line shows here only where it lands (anchor.js lands(): the same element, the line about all of it), never
// somewhere else on this screen's different layout; as it grows it's anchored to what it's round so far (anchor.js
// roundOf). One that can't land comes as the other screen's picture once it's a mark (handover.js).
//   ink  { phase: 'start', n, stroke, halo, anchor }  a line begins (its first points)
//        { phase: 'move', n, points, anchor? }        its points since the last (and what it's round now, if that changed)
//        { phase: 'end', n }                          it's lifted (the open mark's next 'mark' holds it from now)
//        { phase: 'cancel', n }                       it went (a palm, a second finger)
//   mark { mark: { anchor, words } | null }           the Pencil's open mark there (shared/review/handover.js)
import { draw, fit } from '/__review/ink.js';
import { anchorOf, landing, placer, roundOf } from '/__review/anchor.js';

// The lines go in batches, one a frame: a frame or two behind the other screen's pen
let send = null,
  canvas = null,
  queued = false;
const theirs = { strokes: new Map(), mark: null };
const mine = { n: 0, lines: new Map() };

// send(events): the pairing's way to the other screen
export function mountInk(sendEvents) {
  send = sendEvents;
  canvas = document.createElement('canvas');
  canvas.className = 'pair-ink';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.watchalongHide = '';
  document.documentElement.append(canvas);
  document.addEventListener('ink:stroke', e => told(e.detail));
  addEventListener('scroll', redraw, { capture: true, passive: true });
  addEventListener('resize', redraw);
}

// ---- this screen's lines, out
function told(d) {
  if (!send || !d?.stroke || !d.halo) return; // (the Pencil on HQ's page draws with a halo; the book's own pen doesn't)
  const [sx, sy] = d.scroll ?? [scrollX, scrollY],
    scroll = { x: sx, y: sy };
  const onPage = ([x, y, ...rest]) => [x + d.left + scroll.x, y + d.top + scroll.y, ...rest];
  if (d.phase === 'start') {
    const [x, y] = d.stroke.points[0] ?? [0, 0],
      el = under(x + d.left, y + d.top);
    if (!el) return; // (over the book, or nothing of the page)
    const n = ++mine.n,
      view = { w: innerWidth, h: innerHeight, x: Math.round(scroll.x), y: Math.round(scroll.y), dpr: devicePixelRatio };
    mine.lines.set(d.stroke, { n, sent: d.stroke.points.length, el, view });
    const { color, size, alpha } = d.stroke;
    send([
      {
        tag: 'ink',
        payload: {
          phase: 'start',
          n,
          halo: true,
          stroke: { color, size, alpha, points: d.stroke.points.map(onPage) },
          anchor: anchorOf(el, { url: location.href, view }),
        },
      },
    ]);
    return;
  }
  const line = mine.lines.get(d.stroke);
  if (!line) return;
  if (d.phase === 'move') {
    // (a rectangle's corners are redrawn whole: all of them again)
    const all = d.stroke.points.length < line.sent,
      points = d.stroke.points.slice(all ? 0 : line.sent).map(onPage);
    line.sent = d.stroke.points.length;
    const el = roundNow(d.stroke.points, d),
      anchor = el && el !== line.el ? anchorOf((line.el = el), { url: location.href, view: line.view }) : null;
    if (points.length)
      send([
        { tag: 'ink', payload: { phase: 'move', n: line.n, points, ...(all && { all }), ...(anchor && { anchor }) } },
      ]);
    return;
  }
  mine.lines.delete(d.stroke);
  send([{ tag: 'ink', payload: { phase: d.phase === 'end' ? 'end' : 'cancel', n: line.n } }]);
}
// What a line begins on: the page's own element there, never the book, this file's canvas or review mode's layer
function under(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === canvas || el.closest('#book') || !document.body.contains(el)) continue;
    if (el.localName === 'review-mode' || el === document.body) return document.body;
    return el;
  }
  return document.body;
}

// What a line is round so far (anchor.js roundOf; client px), or the page itself
function roundNow(points, d) {
  const xs = points.map(p => p[0] + d.left),
    ys = points.map(p => p[1] + d.top),
    area = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: 0 };
  area.h = Math.max(...ys) - area.y;
  return roundOf(under(area.x + area.w / 2, area.y + area.h / 2), area) ?? document.body;
}

// ---- the other screen's lines, in
export function heard({ tag, payload: p }) {
  if (tag === 'mark') theirs.mark = p.mark ?? null;
  else if (tag === 'ink') {
    const s = theirs.strokes.get(p.n);
    if (p.phase === 'start' && p.stroke && p.anchor)
      theirs.strokes.set(p.n, { anchor: p.anchor, halo: !!p.halo, stroke: p.stroke });
    else if (p.phase === 'move' && s && Array.isArray(p.points)) {
      s.stroke = { ...s.stroke, points: [...(p.all ? [] : s.stroke.points), ...p.points] };
      if (p.anchor) s.anchor = p.anchor;
    }
    // (a line lifted there shows here only in its open mark, the 'mark' that comes with it: one that made no mark, or
    // whose mark never comes, is gone at once. Rule zero)
    else if (p.phase === 'end' || p.phase === 'cancel') theirs.strokes.delete(p.n);
  } else return false;
  redraw();
  return true;
}
// The other screen gone (or a new pairing): nothing of its stays drawn
export function forget() {
  theirs.strokes.clear();
  theirs.mark = null;
  redraw();
}

function redraw() {
  if (queued || !canvas) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const g = fit(canvas),
      scroll = { x: scrollX, y: scrollY };
    const shown = (anchor, lines) => {
      const el = landing(anchor, document, scroll, lines);
      if (!el) return [];
      const at = placer(anchor, document, scroll, el);
      return lines.map(l => ({
        ...l,
        points: l.points.map(p => {
          const [x, y, ...rest] = at(p);
          return [x - scroll.x, y - scroll.y, ...rest];
        }),
      }));
    };
    const lines = [
      // (the open mark there, by what it's round: handover.js.)
      ...(theirs.mark ? shown({ el: theirs.mark.round }, theirs.mark.anchor.ink ?? []) : []),
      ...[...theirs.strokes.values()].flatMap(s => shown(s.anchor, [s.stroke])),
    ];
    if (lines.length) draw(g, lines, { halo: true });
  });
}
